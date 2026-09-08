import { buildAiNightActions, buildAiVoteActions, generateChatLines, generateLastWords, generateFactionChat, generateNightFactionChat, mentionedPlayerIds } from "./ai/index.js";
import {
  addPrivateLog,
  addPublicLog,
  alivePlayers,
  createInitialState,
  factionCounts,
  getPlayer,
  markDeath,
} from "./state.js";
import { DeathCause, Phase, Roles, Faction, Theme } from "./roles.js";

function majorityTarget(votes, needed) {
  let best = null;
  let bestCount = 0;
  for (const [targetId, count] of Object.entries(votes)) {
    if (count > bestCount) {
      best = Number(targetId);
      bestCount = count;
    }
  }
  if (bestCount >= needed) return { targetId: best, count: bestCount };
  return null;
}

const UnblockableCauses = new Set([
  DeathCause.TERROR_BOMB,
  DeathCause.ARSON_BURN,
  DeathCause.ZOMBIE_FATAL,
  DeathCause.SMOKE_OVERDOSE,
]);

function isUntargetable(player) {
  return !player?.alive || player.status.smoked > 0;
}

function actorBlocked(actor) {
  return (
    !actor?.alive ||
    actor.status.cannotAct ||
    actor.status.smoked > 0 ||
    actor.status.kidnapped ||
    actor.status.purified
  );
}

function trackBlueTarget(targetedByBlue, targetId, actor) {
  if (!actor || actor.faction !== Faction.BLUE) return;
  if (actor.role === Roles.CIVILIAN.id) return;
  if (!targetedByBlue.has(targetId)) targetedByBlue.set(targetId, []);
  targetedByBlue.get(targetId).push(actor.id);
}

function updateWinrateHint(state) {
  const counts = factionCounts(state);
  const totalAlive = alivePlayers(state).length || 1;
  const contesting = Math.max(1, counts.red + counts.blue);
  const redPct = Math.max(0, Math.min(1, counts.red / contesting));
  const bluePct = Math.max(0, Math.min(1, counts.blue / contesting));
  state.winrateHint = { red: redPct, blue: bluePct, alive: totalAlive };
}

export class GameEngine {
  constructor(seed = Date.now(), themeId = Theme.GOOD_VS_EVIL.id, difficulty = "normal", opts = {}) {
    this.state = createInitialState(seed, themeId, difficulty, opts);
    this.state.lastNightSummary = [];
    updateWinrateHint(this.state);
  }

  human() {
    return this.state.players.find((p) => p.isHuman);
  }

  startNight() {
    this.state.phase = Phase.NIGHT;
    this.state.lastNightSummary = [];
    this.state.lastNightSavedIds = [];

    // Convert pending zombie infections before actions.
    let pendingZombieCount = 0;
    for (const p of this.state.players) {
      if (p.alive && p.status.pendingZombieConversion) {
        p.status.pendingZombieConversion = false;
        p.role = Roles.ZOMBIE.id;
        p.faction = Faction.GREEN;
        pendingZombieCount += 1;
      }
    }
    if (pendingZombieCount > 0) {
      addPublicLog(this.state, `Someone turned into a zombie overnight.`);
    }

    // Reset nightly transient flags.
    for (const p of this.state.players) {
      p.status.smoked = 0;
      p.status.kidnapped = false;
      p.status.purified = false;
      p.status.protectedByAgent = false;
      p.status.protectedByFiend = false;
      p.status.protectionSource = null;
      p.status.cannotAct = false;
      p.status.zombieBites = 0;
      p.status.exorcistChainsUsed = 0;
      // "Same target on consecutive nights" only looks one night back.
      p.lastKidnapTarget = p.kidnapTargetTonight ?? null;
      p.kidnapTargetTonight = null;
    }

    // AI faction chat: night-phase strategic discussion before actions
    // In multiplayer, this is called before scheduleNightTimer for immediate display.
    // Skip if already generated for this night (nightFactionChatDay tracks last generated day).
    if (this.state.nightFactionChatDay !== this.state.dayNumber) {
      this.state.nightFactionChatDay = this.state.dayNumber;
      generateNightFactionChat(this.state);
    }
  }

  async resolveNight(humanAction = null, opts = {}) {
    this.startNight();
    // Share grudge team info each night to their private channel.
    const grudgeTeam = alivePlayers(this.state).filter((p) => p.role === Roles.GRUDGE_BEAST.id);
    if (grudgeTeam.length) {
      addPrivateLog(
        this.state,
        "grudge",
        `Grudge team (${grudgeTeam.length}): ${grudgeTeam.map((p) => p.name).join(", ")}`
      );
    }
    // Apply any souls gained from daytime deaths so necromancer can use them tonight.
    for (const necro of this.state.players) {
      if (!necro.alive || necro.role !== Roles.NECROMANCER.id) continue;
      if (necro.pendingSoulsFromDay && necro.pendingSoulsFromDay > 0) {
        necro.souls = Math.min(4, necro.souls + necro.pendingSoulsFromDay);
        necro.pendingSoulsFromDay = 0;
      }
    }

    const actions = await buildAiNightActions(this.state, {
      includeHuman: opts.includeHuman === true,
      humanChoice: humanAction,
      humanActions: opts.humanActions,
    });

    const humanActionsList = [];
    if (humanAction) {
      const singleHuman = this.human();
      const actorId = humanAction.actorId ?? singleHuman?.id;
      if (actorId !== undefined && actorId !== null) {
        humanActionsList.push({ ...humanAction, actorId });
      }
    }
    if (opts.humanActions) {
      if (Array.isArray(opts.humanActions)) {
        for (const entry of opts.humanActions) {
          if (!entry) continue;
          const actorId = entry.actorId ?? null;
          if (actorId !== null && actorId !== undefined) {
            humanActionsList.push({ ...entry, actorId });
          }
        }
      } else {
        for (const [actorIdStr, entry] of Object.entries(opts.humanActions)) {
          if (!entry) continue;
          const actorId = Number(actorIdStr);
          if (!Number.isInteger(actorId)) continue;
          humanActionsList.push({ ...entry, actorId }); // the map key is the authority
        }
      }
    }
    const humanActionByActor = new Map();
    for (const ha of humanActionsList) {
      if (!ha || typeof ha.actorId !== "number") continue;
      const actor = getPlayer(this.state, ha.actorId);
      // A seat the AI controls (disconnect / AFK takeover) already has an AI action.
      if (actor && actor.isHuman === false && opts.includeHuman !== true) continue;
      humanActionByActor.set(ha.actorId, ha); // last submission wins
    }
    actions.push(...humanActionByActor.values());

    const controlActions = [];
    let otherActions = [];
    const roleAllow = {
      POLICE: ["POLICE_INVESTIGATE"],
      KILLER: ["KILLER_VOTE"],
      DOCTOR: ["DOCTOR_INJECT"],
      SNIPER: ["SNIPER_SHOT"],
      AGENT: ["AGENT_PROTECT"],
      HEAVENLY_FIEND: ["FIEND_PROTECT", "FIEND_SHOOT"],
      TERRORIST: ["TERROR_BOMB"],
      COWBOY: ["COWBOY_GAMBLE"],
      KIDNAPPER: ["KIDNAP"],
      ZOMBIE: ["ZOMBIE_BITE"],
      RIOT_POLICE: ["RIOT_SMOKE"],
      ARSONIST: ["ARSON_MARK", "ARSON_IGNITE"],
      VINE_DEMON: ["VINE_SEED"],
      NIGHTMARE_DEMON: ["NIGHTMARE_ATTACK"],
      EXORCIST: ["EXORCIST_STRIKE"],
      NECROMANCER: ["NECROMANCER_CURSE"],
      PURIFIER: ["PURIFY"],
      GRUDGE_BEAST: ["GRUDGE_JUDGE", "GRUDGE_KILL_VOTE"],
    };
    for (const action of actions) {
      const actor = getPlayer(this.state, action.actorId);
      if (!actor) continue;
      const allowedList = roleAllow[actor.role] || [];
      if (!allowedList.includes(action.type)) continue; // drop spoofed or invalid action
      if (["RIOT_SMOKE", "PURIFY", "KIDNAP"].includes(action.type)) controlActions.push(action);
      else otherActions.push(action);
    }

    // Expand human exorcist chains: a human exorcist may submit several strikes (up to maxChains).
    const expandedOther = [];
    for (const action of otherActions) {
      if (action.type === "EXORCIST_STRIKE") {
        const actor = getPlayer(this.state, action.actorId);
        if (actor?.isHuman && actor.role === Roles.EXORCIST.id) {
          const maxChains = Math.max(1, actor.maxChains ?? Roles.EXORCIST.maxChain);
          const targetIds = [
            action.targetId,
            ...(Array.isArray(action.extraTargets) ? action.extraTargets : []),
          ];
          const seen = new Set();
          let added = 0;
          for (const tid of targetIds) {
            const t = getPlayer(this.state, tid);
            if (!t?.alive || t.id === actor.id) continue;
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            expandedOther.push({ actorId: actor.id, type: "EXORCIST_STRIKE", targetId: t.id });
            added += 1;
            if (added >= maxChains) break;
          }
          continue; // skip default push; we've added expanded strikes
        }
      }
      expandedOther.push(action);
    }
    otherActions = expandedOther;
    // Shields resolve first: a shield that clears smoke must restore the target's action
    // regardless of the order actions were submitted in.
    const protectTypes = new Set(["AGENT_PROTECT", "FIEND_PROTECT"]);
    otherActions = [
      ...otherActions.filter((a) => protectTypes.has(a.type)),
      ...otherActions.filter((a) => !protectTypes.has(a.type)),
    ];

    const killerVotes = {};
    const policeVotes = {};
    const grudgeKillVotes = {};
    const kidnapMap = {};
    const agentLinks = {};
    const fiendProtectMap = {};
    const vineSeeds = {};
    const targetedByBlue = new Map();
    const pendingKills = [];
    const convertNow = [];
    const biteBacklash = [];
    const nightDeaths = [];
    let doctorAction = null;
    let arsonIgniterId = null;
    const arsonMarkedTargets = new Set(this.state.players.filter((p) => p.status.arsonMarked).map((p) => p.id));
    let arsonIgnite = false;

    const addKill = (targetId, cause, opts = {}) => {
      pendingKills.push({
        targetId,
        cause,
        killerId: opts.killerId ?? null,
        timing: opts.timing ?? "instant",
        blockable: opts.blockable !== false,
        unstoppable: opts.unstoppable || UnblockableCauses.has(cause),
        noLastWords: opts.noLastWords || UnblockableCauses.has(cause),
        requiresAliveActor: opts.requiresAliveActor ?? null,
      });
    };

    // Stage 1: resolve control actions (smoke/purify/kidnap) to set cannotAct/untargetable.
    for (const action of controlActions) {
      const actor = getPlayer(this.state, action.actorId);
      const target = getPlayer(this.state, action.targetId);
      if (!actor?.alive || !target?.alive) continue;
      switch (action.type) {
        case "RIOT_SMOKE": {
          if (this.state.usage.riotGrenades >= (Roles.RIOT_POLICE.maxGrenades || 0)) break;
          this.state.usage.riotGrenades += 1;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          target.status.smoked += 1;
          target.status.cannotAct = true;
          if (target.status.smoked >= 2) {
            addKill(target.id, DeathCause.SMOKE_OVERDOSE, { unstoppable: false, blockable: true, noLastWords: true });
          } else {
          addPublicLog(this.state, `Someone deployed smoke on ${target.name}.`);
          }
          break;
        }
        case "PURIFY": {
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          target.status.purified = true;
          target.status.cannotAct = true;
          if (target.role === Roles.NECROMANCER.id) {
            target.souls = 0;
            target.pendingSoulsFromDay = 0;
          }
          addPublicLog(this.state, `Someone cleansed ${target.name}.`);
          break;
        }
        case "KIDNAP": {
          if (actor.lastKidnapTarget === target.id) break; // same target two nights in a row
          kidnapMap[actor.id] = target.id;
          actor.kidnapTargetTonight = target.id;
          target.status.kidnapped = true;
          target.status.cannotAct = true;
          addPublicLog(this.state, `Someone kidnapped ${target.name}.`);
          break;
        }
        default:
          break;
      }
    }

    // Stage 2: remaining actions.
    for (const action of otherActions) {
      const actor = getPlayer(this.state, action.actorId);
      const target = getPlayer(this.state, action.targetId);
      if (actorBlocked(actor)) continue;

      switch (action.type) {
        case "POLICE_INVESTIGATE":
          if (isUntargetable(target) || target?.status.purified) break;
          if (this.state.policeConfirmed?.[action.targetId]) break;
          policeVotes[action.targetId] = (policeVotes[action.targetId] || 0) + 1;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          break;
        case "KILLER_VOTE":
          if (isUntargetable(target) || target?.status.purified) break;
          killerVotes[action.targetId] = (killerVotes[action.targetId] || 0) + 1;
          break;
        case "GRUDGE_KILL_VOTE":
          if (!this.state.grudgeState?.berserk) break;
          if (isUntargetable(target)) break;
          grudgeKillVotes[action.targetId] = (grudgeKillVotes[action.targetId] || 0) + 1;
          addPrivateLog(this.state, "grudge", `${actor.name} voted to punish ${target.name}.`);
          break;
        case "DOCTOR_INJECT":
          doctorAction = action;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          break;
        case "SNIPER_SHOT":
          if (this.state.usage.sniperShots >= (Roles.SNIPER.maxShots || 0)) break;
          if (isUntargetable(target)) break;
          this.state.usage.sniperShots += 1;
          addKill(target.id, DeathCause.SNIPER_HEADSHOT, { killerId: actor.id, unstoppable: false, noLastWords: true });
          addPublicLog(this.state, `Someone fired a sniper shot.`);
          break;
        case "AGENT_PROTECT":
          if (!target || !target.alive) break;
          if (target.status.smoked > 0) {
            target.status.smoked = 0;
            target.status.cannotAct = false;
          }
          target.status.protectedByAgent = true;
          target.status.protectionSource = actor.id;
          agentLinks[actor.id] = target.id;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          break;
        case "FIEND_PROTECT":
          if (actor.status.fiendMode !== "ABSORB") break;
          if (!target || !target.alive) break;
          if (target.id === actor.id) break; // cannot absorb attacks on self
          if (target.status.smoked > 0) {
            target.status.smoked = 0;
            target.status.cannotAct = false;
          }
          target.status.protectedByFiend = true;
          target.status.protectionSource = actor.id;
          fiendProtectMap[actor.id] = target.id;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          break;
        case "FIEND_SHOOT":
          if (actor.status.fiendMode !== "CHARGE") break;
          if (isUntargetable(target)) break;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          addKill(target.id, DeathCause.FIEND_SHOT, { killerId: actor.id, blockable: true });
          actor.status.fiendMode = "ABSORB";
          break;
        case "TERROR_BOMB":
          if (!target || isUntargetable(target)) break;
          if (target.faction === Faction.RED) {
            addKill(actor.id, DeathCause.TERROR_BOMB, { killerId: actor.id, unstoppable: true, noLastWords: true });
            addPublicLog(this.state, `A bomb went off but failed on an ally; the bomber died.`);
          } else {
            addKill(actor.id, DeathCause.TERROR_BOMB, { killerId: actor.id, unstoppable: true, noLastWords: true });
            addKill(target.id, DeathCause.TERROR_BOMB, { killerId: actor.id, unstoppable: true, noLastWords: true });
            addPublicLog(this.state, `A bomb detonated on ${target.name}.`);
          }
          break;
        case "COWBOY_GAMBLE": {
          if (!target || isUntargetable(target)) break;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          const roll = this.state.rng();
          this.state.usage.cowboyShots++;
          if (roll < 2 / 6) {
            addKill(target.id, DeathCause.COWBOY_SHOT, { killerId: actor.id, timing: "delayed" });
            addPublicLog(this.state, `Someone fired a risky shot at ${target.name}.`);
            this.state.usage.cowboyHits++;
          } else if (roll < 5 / 6) {
            addPublicLog(this.state, `A cowboy's chamber clicked on ${target.name}.`);
            this.state.usage.cowboyMisses++;
          } else {
            addKill(target.id, DeathCause.COWBOY_SHOT, { killerId: actor.id });
            const others = alivePlayers(this.state).filter((p) => p.id !== actor.id && p.id !== target.id && p.alive);
            const extra = others[Math.floor(this.state.rng() * (others.length || 1))];
            if (extra) addKill(extra.id, DeathCause.COWBOY_BACKFIRE, { killerId: actor.id });
            addKill(actor.id, DeathCause.COWBOY_BACKFIRE, { killerId: actor.id });
            addPublicLog(this.state, `A cowboy drew a wild bullet. Chaos ensued.`);
            this.state.usage.cowboyBackfires++;
          }
          break;
        }
        case "KIDNAP":
          // already processed
          break;
        case "ZOMBIE_BITE":
          if (!target || isUntargetable(target)) break;
          target.status.zombieBites += 1;
          if (target.role === Roles.ZOMBIE.id) {
            biteBacklash.push(actor.id);
          } else if (target.status.zombieBites >= 3) {
            addKill(target.id, DeathCause.ZOMBIE_FATAL, { killerId: actor.id, unstoppable: true, noLastWords: true });
          } else if (target.status.zombieBites >= 2) {
            convertNow.push(target.id);
          }
          break;
        case "RIOT_SMOKE":
          break; // handled
        case "ARSON_MARK":
          if (target && target.alive && this.state.usage.arsonMarks < (Roles.ARSONIST.maxMarks || 0)) {
            this.state.usage.arsonMarks += 1;
            if (target.status.protectedByAgent) {
              addPublicLog(this.state, `An agent shield blocked a gasoline bottle on ${target.name}.`);
              break;
            }
            if (target.status.protectedByFiend) {
              addPublicLog(this.state, `A guardian absorbed a gasoline bottle on ${target.name}.`);
              break;
            }
            target.status.arsonMarked = true;
            arsonMarkedTargets.add(target.id);
            addPublicLog(this.state, `Someone splashed fuel on ${target.name}.`);
          }
          break;
        case "ARSON_IGNITE":
          arsonIgnite = true;
          arsonIgniterId = actor.id;
          addPublicLog(this.state, `Someone prepared to ignite marked targets.`);
          break;
        case "VINE_SEED":
          if (!actor.status.vineActive) break;
          actor.status.vineActive = false; // ability is single-use, consumed even if blocked
          if (target && target.alive) {
            if (target.status.protectedByAgent) {
              addPublicLog(this.state, `An agent shield blocked a vine seed on ${target.name}.`);
              break;
            }
            if (target.status.protectedByFiend) {
              addPublicLog(this.state, `A guardian absorbed a vine seed on ${target.name}.`);
              break;
            }
            target.status.vineSeededBy = actor.id;
            vineSeeds[actor.id] = target.id;
          }
          break;
        case "NIGHTMARE_ATTACK":
          if (!target || isUntargetable(target)) break;
          if (target.role === Roles.CIVILIAN.id || target.role === Roles.BRAT.id) {
            addKill(target.id, DeathCause.NIGHTMARE_STRIKE, { killerId: actor.id });
          } else {
            addPrivateLog(this.state, "nightmare", `${actor.name} learned ${target.name} is ${target.role}.`);
          }
          break;
        case "EXORCIST_STRIKE":
          if (!target || isUntargetable(target)) break;
          if ((actor.exorcistMistakes || 0) >= 3) break;
          const maxChains = Math.max(0, actor.maxChains ?? Roles.EXORCIST.maxChain);
          if (actor.status.exorcistChainsUsed >= maxChains) break;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          addKill(target.id, DeathCause.EXORCIST_PETRIFY, { killerId: actor.id, blockable: true });
          actor.status.exorcistChainsUsed += 1;
          const isRed = target.faction === Faction.RED;
          if (!isRed) {
            actor.exorcistMistakes = (actor.exorcistMistakes || 0) + 1;
            actor.maxChains = Math.max(0, maxChains - 1);
            actor.status.cannotAct = true; // stop further chains this night
            if (actor.exorcistMistakes >= 3) actor.maxChains = 0;
          }
          break;
        case "NECROMANCER_CURSE":
          if (!target || isUntargetable(target)) break;
          if (actor.souls < 2) break;
          const souls = Math.min(actor.souls, 4);
          actor.souls = 0;
          if (souls >= 4) {
            addKill(target.id, DeathCause.NECROMANCER_CURSE, { killerId: actor.id, blockable: false, unstoppable: true, noLastWords: true });
          } else if (souls === 3) {
            addKill(target.id, DeathCause.NECROMANCER_CURSE, { killerId: actor.id, blockable: false });
          } else {
            addKill(target.id, DeathCause.NECROMANCER_CURSE, {
              killerId: actor.id,
              timing: "delayed",
              requiresAliveActor: actor.id,
            });
          }
          break;
        case "PURIFY":
          break;
        case "GRUDGE_JUDGE":
          if (!target || isUntargetable(target)) break;
          // Non-berserk: use judge as a vote; resolution happens later via majority.
          grudgeKillVotes[action.targetId] = (grudgeKillVotes[action.targetId] || 0) + 1;
          addPrivateLog(this.state, "grudge", `${actor.name} wants to judge ${target.name}.`);
          break;
        default:
          break;
      }
    }

    // Vine demon triggers on blue-side actions against seeded targets.
    for (const [actorId, targetId] of Object.entries(vineSeeds)) {
      const demon = getPlayer(this.state, Number(actorId));
      const target = getPlayer(this.state, targetId);
      if (!demon?.alive || !target?.alive) continue;
      const blues = targetedByBlue.get(targetId);
      if (!blues || blues.length === 0) continue;
      const triggeringBlueId = blues.find((bid) => {
        const b = getPlayer(this.state, bid);
        return b && b.faction === Faction.BLUE;
      });
      if (triggeringBlueId !== undefined) {
          addKill(target.id, DeathCause.VINE_SWAP, { killerId: demon.id, blockable: true, unstoppable: false });
          addKill(triggeringBlueId, DeathCause.VINE_SWAP, { killerId: demon.id, blockable: true, unstoppable: false });
        }
      }
    // Majority decisions.
    const killersAlive = alivePlayers(this.state).filter((p) => p.role === Roles.KILLER.id && !actorBlocked(p)).length;
    const killerNeeded = Math.floor(killersAlive / 2) + 1;
    // Rule: the kill needs a majority of acting killers; otherwise it is invalid.
    const killerDecision = majorityTarget(killerVotes, killerNeeded);
    if (killerDecision) {
      const tgt = getPlayer(this.state, killerDecision.targetId);
      if (tgt && !tgt.status.purified && !isUntargetable(tgt)) {
        // Attribute the murder to an acting killer so faction-based triggers (grudge rage) work.
        const killerRep = alivePlayers(this.state).find((p) => p.role === Roles.KILLER.id && !actorBlocked(p));
        addKill(tgt.id, DeathCause.KILLER_MURDER, { killerId: killerRep?.id ?? null });
        addPrivateLog(this.state, "killer", `Killers targeted ${tgt.name}.`);
      }
    } else if (killersAlive > 0) {
      addPrivateLog(this.state, "killer", "Killers failed to agree on a target.");
    }

    if (this.state.grudgeState.berserk) {
      const grudgeAlive = alivePlayers(this.state).filter((p) => p.role === Roles.GRUDGE_BEAST.id && !actorBlocked(p)).length;
      const needed = Math.floor(grudgeAlive / 2) + 1;
      const decision = majorityTarget(grudgeKillVotes, needed);
      if (decision) {
        const tgt = getPlayer(this.state, decision.targetId);
        if (tgt && !isUntargetable(tgt)) addKill(tgt.id, DeathCause.GRUDGE_PUNISH, { killerId: null });
      }
    } else {
      // Non-berserk: allow only one collective judge via majority of judge intents.
      const grudgeAlive = alivePlayers(this.state).filter((p) => p.role === Roles.GRUDGE_BEAST.id && !actorBlocked(p)).length;
      const needed = Math.floor(grudgeAlive / 2) + 1;
      const decision = majorityTarget(grudgeKillVotes, needed);
      if (decision) {
        const tgt = getPlayer(this.state, decision.targetId);
        if (tgt && !isUntargetable(tgt)) {
          // Execute a single judge action on the chosen target
          if (tgt.faction === Faction.RED) {
            addPrivateLog(this.state, "police", `Grudge intel: ${tgt.name} is ${tgt.role}.`);
            this.state.policeConfirmed = this.state.policeConfirmed || {};
            this.state.policeConfirmed[tgt.id] = true;
            this.state.policeRevealedRed = this.state.policeRevealedRed ?? tgt.id;
            addPrivateLog(this.state, "grudge", `Judged ${tgt.name}: RED (${tgt.role}).`);
          } else if (tgt.faction === Faction.BLUE && tgt.role !== Roles.CIVILIAN.id) {
            addPrivateLog(this.state, "killer", `Grudge intel: ${tgt.name} is ${tgt.role}.`);
            addPrivateLog(this.state, "grudge", `Judged ${tgt.name}: BLUE (${tgt.role}).`);
          } else if (tgt.role === Roles.CIVILIAN.id) {
            const beasts = alivePlayers(this.state).filter((p) => p.role === Roles.GRUDGE_BEAST.id);
            const victim = beasts.length ? beasts[Math.floor(this.state.rng() * beasts.length)] : null;
            if (victim) addKill(victim.id, DeathCause.GRUDGE_PUNISH, { killerId: null });
            addPrivateLog(this.state, "grudge", `Judged ${tgt.name}: CIVILIAN. A grudge beast was sacrificed.`);
          }
        }
      } else if (grudgeAlive > 0) {
        addPrivateLog(this.state, "grudge", "Grudge beasts could not agree on a judgment target.");
      }
    }

    const policeAlive = alivePlayers(this.state).filter((p) => p.role === Roles.POLICE.id && !actorBlocked(p)).length;
    const policeNeeded = Math.floor(policeAlive / 2) + 1;
    // Rule: the investigation needs a majority of acting police; otherwise it is invalid.
    const policeDecision = majorityTarget(policeVotes, policeNeeded);
    if (policeDecision) {
      const target = getPlayer(this.state, policeDecision.targetId);
      if (target) {
        const apparentFaction =
          target.role === Roles.TERRORIST.id ? Faction.BLUE : target.faction;
        addPrivateLog(
          this.state,
          "police",
          `Investigation result: ${target.name} is ${apparentFaction === Faction.RED ? "RED" : apparentFaction === Faction.GREEN ? "GREEN" : "BLUE"} (${target.role})`
        );
        const resultLabel =
          apparentFaction === Faction.RED ? "red" :
          apparentFaction === Faction.GREEN ? "green" :
          "blue";
        for (const police of alivePlayers(this.state).filter((p) => p.role === Roles.POLICE.id)) {
          police.aiMemory = police.aiMemory || { suspicion: {}, roleProbs: {} };
          police.aiMemory.investigationResults = police.aiMemory.investigationResults || [];
          if (!police.aiMemory.investigationResults.some((r) => r.targetId === target.id)) {
            police.aiMemory.investigationResults.push({
              targetId: target.id,
              result: resultLabel,
              day: this.state.dayNumber || 1,
            });
          }
        }
        if (apparentFaction === Faction.RED && target.alive) {
          this.state.policeRevealedRed = target.id;
          this.state.policeConfirmed = this.state.policeConfirmed || {};
          this.state.policeConfirmed[target.id] = true;
        }
        // Kidnapper ransom kill: if police investigate a kidnapper, hostage dies (one execution per kidnapper).
        const hostageId = kidnapMap[target.id];
        const kidnapper = getPlayer(this.state, target.id);
        if (hostageId !== undefined && kidnapper && !kidnapper.kidnapExecutionUsed) {
          addKill(hostageId, DeathCause.KIDNAP_EXECUTION, { killerId: target.id, blockable: true });
          kidnapper.kidnapExecutionUsed = true;
        }
      }
    } else if (policeAlive > 0) {
      addPrivateLog(this.state, "police", "Police could not agree on a target.");
    }

    // Arson ignition resolves now.
    if (arsonIgnite && arsonMarkedTargets.size) {
      for (const targetId of arsonMarkedTargets) {
        const target = getPlayer(this.state, targetId);
        if (target?.alive) {
          addKill(target.id, DeathCause.ARSON_BURN, { killerId: arsonIgniterId, unstoppable: true, noLastWords: true });
        }
      }
      for (const t of this.state.players) t.status.arsonMarked = false;
    }

    // Bite backlash for zombies biting zombies.
    for (const biterId of biteBacklash) {
      const biter = getPlayer(this.state, biterId);
      if (biter?.alive) addKill(biter.id, DeathCause.ZOMBIE_FATAL, { unstoppable: true });
    }

    // Apply protections (agent/fiend).
    const survivors = (id) => getPlayer(this.state, id)?.alive;
    const filteredKills = [];
    const fiendAbsorbed = new Set();
    const agentImmuneCauses = new Set([DeathCause.VINE_SWAP]);
    for (const k of pendingKills) {
      const target = getPlayer(this.state, k.targetId);
      if (!target?.alive) continue;
      // Agent can now intercept sniper headshots even though they are normally unstoppable.
      const agentInterceptsSniper =
        target.status.protectedByAgent && k.cause === DeathCause.SNIPER_HEADSHOT;
      if (agentInterceptsSniper) {
        this.state.lastNightSummary.push(`Agent shield saved ${target.name} from sniper.`);
        this.state.usage.agentBlocks++;
        if (!this.state.lastNightSavedIds.includes(target.id)) this.state.lastNightSavedIds.push(target.id);
        continue;
      }
      const fiendImmuneCauses = new Set([
        DeathCause.TERROR_BOMB,
        DeathCause.ARSON_BURN,
        DeathCause.VINE_SWAP,
        DeathCause.ZOMBIE_BITE,
        DeathCause.ZOMBIE_FATAL,
        DeathCause.KIDNAP_EXECUTION,
        DeathCause.SMOKE_OVERDOSE,
      ]);
      if (!k.unstoppable) {
        if (target.status.protectedByAgent && !agentImmuneCauses.has(k.cause)) {
          this.state.lastNightSummary.push(`Agent shield saved ${target.name} from attack.`);
          this.state.usage.agentBlocks++;
          if (!this.state.lastNightSavedIds.includes(target.id)) this.state.lastNightSavedIds.push(target.id);
          continue;
        }
        if (target.status.protectedByFiend) {
          const sourceId = target.status.protectionSource;
          if (!fiendImmuneCauses.has(k.cause)) {
            fiendAbsorbed.add(sourceId);
            this.state.lastNightSummary.push(`Fiend absorbed attack on ${target.name}.`);
            this.state.usage.agentBlocks++;
            if (!this.state.lastNightSavedIds.includes(target.id)) this.state.lastNightSavedIds.push(target.id);
            continue;
          }
        }
      }
      filteredKills.push(k);
    }

    for (const fiendId of fiendAbsorbed) {
      const fiend = getPlayer(this.state, fiendId);
      if (fiend) fiend.status.fiendMode = "CHARGE";
    }

    // Agent link kills (blockable, doctor-revivable): if agent dies, protected target dies too.
    for (const [agentIdStr, targetId] of Object.entries(agentLinks)) {
      const agentId = Number(agentIdStr);
      const agent = getPlayer(this.state, agentId);
      const target = getPlayer(this.state, targetId);
      if (!agent || !target) continue;
      const agentHasIncoming = filteredKills.some((k) => k.targetId === agentId);
      if (!agentHasIncoming) continue;
      filteredKills.push({
        targetId,
        cause: DeathCause.AGENT_LINK,
        killerId: agentId,
        timing: "instant",
        blockable: true,
        unstoppable: false,
        noLastWords: false,
        requiresAliveActor: null,
        requiresDeadAgent: agentId,
      });
    }

    // Doctor resolution (after protections gathered).
    const doctor = this.state.players.find((p) => p.role === Roles.DOCTOR.id && p.alive);
    if (
      doctor &&
      doctorAction &&
      this.state.usage.doctorInjections < Roles.DOCTOR.maxInjections &&
      !doctor.status.cannotAct
    ) {
      const target = getPlayer(this.state, doctorAction.targetId);
      this.state.usage.doctorInjections += 1;
      if (target?.alive) {
        if (target.status.protectedByAgent) {
          addPublicLog(this.state, `An agent shield blocked a syringe on ${target.name}.`);
        } else {
        const allowedCauses = Roles.DOCTOR.revivableCauses || [];
        const nonRevivable = new Set(Roles.DOCTOR.nonRevivableCauses || []);
        const remaining = [];
        let overdoseKill = null;
        for (const k of filteredKills) {
          if (k.targetId === target.id && k.blockable && allowedCauses.includes(k.cause) && !nonRevivable.has(k.cause)) {
            // cancelled by doctor
          } else {
            remaining.push(k);
          }
        }
        if (remaining.length !== filteredKills.length) {
          addPublicLog(this.state, `Someone saved ${target.name} from death.`);
          this.state.usage.doctorSaves++;
          if (!this.state.lastNightSavedIds.includes(target.id)) this.state.lastNightSavedIds.push(target.id);
        } else {
          target.emptyInjections += 1;
          if (target.emptyInjections >= Roles.DOCTOR.emptyKillsAt) {
            overdoseKill = {
              targetId: target.id,
              cause: DeathCause.EMPTY_INJECTION,
              killerId: doctor.id,
              timing: "instant",
              blockable: false,
              unstoppable: true,
              noLastWords: false,
              requiresAliveActor: null,
            };
          }
          addPublicLog(
            this.state,
            `Someone injected ${target.name} (dose ${target.emptyInjections}/${Roles.DOCTOR.emptyKillsAt}).`
          );
        }
        filteredKills.splice(0, filteredKills.length, ...remaining);
        if (overdoseKill) filteredKills.push(overdoseKill);
        if (overdoseKill && target?.role === Roles.TERRORIST.id && doctor.alive) {
          filteredKills.push({
            targetId: doctor.id,
            cause: DeathCause.TERROR_BOMB,
            killerId: target.id,
            timing: "instant",
            blockable: false,
            unstoppable: true,
            noLastWords: true,
            requiresAliveActor: null,
          });
          addPublicLog(this.state, `${doctor.name} was caught in a bomb backlash.`);
        }
        }
      }
    }

    // Vine swap protection if demon would die.
    for (const k of filteredKills.slice()) {
      const target = getPlayer(this.state, k.targetId);
      if (target?.role === Roles.VINE_DEMON.id) {
        const seedTargetId = vineSeeds[target.id];
        const seedTarget = seedTargetId !== undefined ? getPlayer(this.state, seedTargetId) : null;
        if (seedTarget?.alive) {
          filteredKills.splice(filteredKills.indexOf(k), 1);
          filteredKills.push({
            targetId: seedTarget.id,
            cause: DeathCause.VINE_SWAP,
            killerId: target.id,
            timing: "instant",
            blockable: true,
            unstoppable: false,
            noLastWords: false,
            requiresAliveActor: null,
          });
          target.status.vineActive = false;
          delete vineSeeds[target.id];
        }
      }
    }

    // Apply immediate kills (supporting conditional agent-link deaths).
    const applyKills = (killList) => {
      const pending = [...killList];
      const appliedKills = [];
      let progress = true;
      while (progress) {
        progress = false;
        for (let i = 0; i < pending.length; i++) {
          const k = pending[i];
          const target = getPlayer(this.state, k.targetId);
          const actorAlive = k.requiresAliveActor ? survivors(k.requiresAliveActor) : true;
          const agentAlive =
            k.requiresDeadAgent !== undefined ? getPlayer(this.state, k.requiresDeadAgent)?.alive === true : false;
          if (!target?.alive) {
            pending.splice(i, 1);
            i -= 1;
            continue;
          }
          if (!actorAlive) {
            pending.splice(i, 1);
            i -= 1;
            continue;
          }
          if (k.requiresDeadAgent !== undefined && agentAlive) {
            continue;
          }
          markDeath(this.state, target.id, k.cause, { noLastWords: !!k.noLastWords });
          // AI generates last words for night deaths (if allowed)
          if (!k.noLastWords && !target.isHuman) {
            const aiLastWords = generateLastWords(this.state, target.id);
            if (aiLastWords) this.submitLastWords(target.id, aiLastWords);
          }
          appliedKills.push({ targetId: target.id, killerId: k.killerId, cause: k.cause });
          pending.splice(i, 1);
          i -= 1;
          progress = true;
        }
      }
      return appliedKills;
    };

    nightDeaths.push(...applyKills(filteredKills.filter((k) => k.timing !== "delayed")));
    nightDeaths.push(...applyKills(filteredKills.filter((k) => k.timing === "delayed")));

    // Convert zombies.
    for (const targetId of convertNow) {
      const target = getPlayer(this.state, targetId);
      if (target?.alive) {
        target.role = Roles.ZOMBIE.id;
        target.faction = Faction.GREEN;
        addPublicLog(this.state, `Someone was overwhelmed and turned into a zombie immediately.`);
        target.status.zombieBites = 0;
      }
    }
    for (const p of this.state.players) {
      if (p.alive && p.status.zombieBites === 1) {
        p.status.pendingZombieConversion = true;
      }
      p.status.zombieBites = 0;
    }

    // Grudge berserk trigger if any beast died at night.
    const grudgeDeath = nightDeaths.find((d) => {
      const player = getPlayer(this.state, d.targetId);
      return player?.role === Roles.GRUDGE_BEAST.id && d.cause !== DeathCause.GRUDGE_PUNISH;
    });
    if (grudgeDeath) {
      this.state.grudgeState.berserk = true;
      if (!this.state.grudgeState.triggerFaction) {
        const killer = grudgeDeath.killerId !== null ? getPlayer(this.state, grudgeDeath.killerId) : null;
        this.state.grudgeState.triggerFaction = killer?.faction || null;
      }
      addPublicLog(this.state, "Grudge Beasts entered berserk rage.");
    }

    // Necromancer soul gain: any alive necromancer gains souls per death not caused by them (day + night).
    for (const necro of this.state.players) {
      if (!necro.alive || necro.role !== Roles.NECROMANCER.id) continue;
      let gained = necro.pendingSoulsFromDay || 0;
      for (const d of nightDeaths) {
        if (d.killerId === necro.id) continue;
        gained += 1;
      }
      necro.pendingSoulsFromDay = 0;
      necro.souls = Math.min(4, necro.souls + gained);
    }

    this.state.phase = Phase.DAY;
    // Preserve any human messages already in dayChat (e.g. from night chat)
    const priorHumanChat = (this.state.dayChat || []).slice();
    this.state.dayChat = generateChatLines(this.state);
    if (priorHumanChat.length) {
      this.state.dayChat = [...priorHumanChat, ...this.state.dayChat];
    }
    generateFactionChat(this.state);
    this.state.chatLoggedForDay = this.state.dayNumber;
    // Only push AI-generated lines to publicLog (human lines are already there)
    const newLines = this.state.dayChat.slice(priorHumanChat.length);
    for (const line of newLines) {
      this.state.publicLog.push(line);
    }
    const countsNow = factionCounts(this.state);
    const aliveTotalNow = alivePlayers(this.state).length || 1;
    if (countsNow.zombies > aliveTotalNow / 3) {
      addPublicLog(this.state, "The place is surrounded by zombies.");
      addPublicLog(this.state, "這地方被殭屍包圍。");
    }
    updateWinrateHint(this.state);

    const victory = checkVictory(this.state);
    if (victory) this.state.phase = Phase.END;
  }

  async resolveVote(humanVoteTargetId = null, humanLastWords = "", opts = {}) {
    this.state.phase = Phase.VOTE;
    const votes = {};
    const votePairs = [];
    const voteOrder = [];

    const eligibleVoters = alivePlayers(this.state).filter(
      (p) => !(p.role === Roles.BRAT.id && p.status.bratRevived) && !p.status.purified
    );
    const aliveCount = eligibleVoters.length;
    const needed = Math.floor(aliveCount / 2) + 1;

    const mentionCounts = {};
    const chats = this.state.dayChat || [];
    for (const line of chats) {
      if (line.startsWith("[VOTE] ") || line.startsWith("[LAST] ")) continue;
      for (const id of mentionedPlayerIds(line, this.state.players)) {
        mentionCounts[id] = (mentionCounts[id] || 0) + 1;
      }
    }

    const lastWordsByPlayer = opts.lastWordsByPlayer || {};
    let humanVotesList = [];
    const human = this.human();
    if (human?.alive && humanVoteTargetId !== null) {
      humanVotesList.push({ actorId: human.id, targetId: humanVoteTargetId });
    }
    if (opts.humanVotes) {
      if (Array.isArray(opts.humanVotes)) {
        for (const v of opts.humanVotes) {
          if (v && typeof v.actorId === "number" && v.targetId !== undefined) {
            humanVotesList.push({ actorId: v.actorId, targetId: v.targetId });
          }
        }
      } else {
        for (const [actorIdStr, targetId] of Object.entries(opts.humanVotes)) {
          const actorId = Number(actorIdStr);
          if (!Number.isNaN(actorId)) {
            humanVotesList.push({ actorId, targetId });
          }
        }
      }
    }

    const humanVoteByActor = new Map();
    for (const hv of humanVotesList) {
      const actor = getPlayer(this.state, hv.actorId);
      if (actor && actor.isHuman === false && opts.includeHuman !== true) continue;
      humanVoteByActor.set(hv.actorId, hv); // last submission wins
    }
    humanVotesList = Array.from(humanVoteByActor.values());

    for (const hv of humanVotesList) {
      if (hv.targetId === null || hv.targetId === undefined) continue;
      const actor = getPlayer(this.state, hv.actorId);
      if (!actor?.alive || (actor.role === Roles.BRAT.id && actor.status.bratRevived) || actor.status.purified) continue;
      const target = getPlayer(this.state, hv.targetId);
      if (target?.alive && !target.status.purified) {
        votes[hv.targetId] = (votes[hv.targetId] || 0) + 1;
        votePairs.push(`${actor.name} -> ${target.name}`);
        voteOrder.push({ actorId: actor.id, targetId: target.id });
      }
    }

    // Pass current human vote distribution so AI can coordinate with human allies
    const humanVoteDist = {};
    for (const hv of humanVotesList) {
      if (hv.targetId !== null && hv.targetId !== undefined) {
        humanVoteDist[hv.targetId] = (humanVoteDist[hv.targetId] || 0) + 1;
      }
    }
    const aiVotes = await buildAiVoteActions(this.state, null, { includeHuman: opts.includeHuman === true, humanVoteDist });
    for (const v of aiVotes) {
      const actor = getPlayer(this.state, v.actorId);
      const target = getPlayer(this.state, v.targetId);
      if (!actor?.alive || actor.status.purified || !target?.alive || target.status.purified) continue;
      votes[v.targetId] = (votes[v.targetId] || 0) + 1;
      votePairs.push(`${actor.name} -> ${target.name}`);
      voteOrder.push({ actorId: actor.id, targetId: target.id });
    }

    const flips = [];
    const newLastVote = {};
    for (const entry of voteOrder) {
      const prev = this.state.lastVoteTargetByActor?.[entry.actorId];
      if (prev !== undefined && prev !== entry.targetId) flips.push(entry.actorId);
      newLastVote[entry.actorId] = entry.targetId;
    }
    this.state.lastVoteTargetByActor = newLastVote;
    if (!this.state.history) this.state.history = { votes: [] };
    this.state.history.votes.push({
      day: this.state.dayNumber,
      order: voteOrder,
      flips,
      mentions: mentionCounts,
      tally: { ...votes },
    });

    if (votePairs.length) {
      addPublicLog(this.state, `Votes:\n${votePairs.map((v) => `- ${v}`).join("\n")}`);
    }

    let result = majorityTarget(votes, needed);
    let plurality = false;
    if (!result && Object.keys(votes).length > 0) {
      // fallback to highest votes (plurality) to avoid stalemate
      let bestId = null;
      let bestCount = -1;
      for (const [tid, cnt] of Object.entries(votes)) {
        const numId = Number(tid);
        if (cnt > bestCount || (cnt === bestCount && numId < (bestId ?? numId + 1))) {
          bestId = numId;
          bestCount = cnt;
        }
      }
      if (bestId !== null) {
        result = { targetId: bestId, count: bestCount };
        plurality = true;
      }
    }

    if (result) {
      const target = getPlayer(this.state, result.targetId);
      if (target?.alive) {
        markDeath(this.state, target.id, DeathCause.VOTE_EXECUTION);
        addPublicLog(
          this.state,
          plurality
            ? `${target.name} was executed by highest votes (${result.count}).`
            : `${target.name} was executed by vote (${result.count}/${aliveCount}).`
        );
        if (target.role === Roles.BRAT.id && !target.status.bratRevived) {
          target.alive = true;
          target.deathCause = null;
          target.deathDay = null;
          target.status.bratRevived = true;
          target.status.bratRevealed = true;
          this.state.aliveIds = this.state.players.filter((p) => p.alive).map((p) => p.id);
          this.state.deadIds = this.state.deadIds.filter((id) => id !== target.id);
          addPublicLog(this.state, `${target.name} revealed as Brat and revived (loses voting power).`);
        } else {
          const candidate = lastWordsByPlayer[target.id] ?? humanLastWords;
          if (typeof candidate === "string" && candidate.trim()) {
            this.submitLastWords(target.id, candidate);
          } else if (!target.isHuman) {
            // AI generates strategic last words
            const aiLastWords = generateLastWords(this.state, target.id);
            if (aiLastWords) this.submitLastWords(target.id, aiLastWords);
          }
          for (const necro of this.state.players) {
            if (necro.alive && necro.role === Roles.NECROMANCER.id && necro.id !== target.id) {
              necro.pendingSoulsFromDay = (necro.pendingSoulsFromDay || 0) + 1;
            }
          }
        }
      }
    } else {
      addPublicLog(this.state, "No majority reached. Nobody was executed.");
    }

    updateWinrateHint(this.state);

    const victory = checkVictory(this.state);
    if (victory) {
      this.state.phase = Phase.END;
    } else {
      this.state.phase = Phase.NIGHT;
      this.state.dayNumber += 1;
      // Clear dayChat so only messages added during this night carry into the next day
      this.state.dayChat = [];
      // Clear faction chat coordination flags for the new round
      delete this.state._killerChatTarget;
      delete this.state._policeChatTarget;
    }
  }

  submitLastWords(playerId, text) {
    const player = getPlayer(this.state, playerId);
    if (!player || player.alive) return false;
    if (player.noLastWords) return false;
    if (player.lastWords && player.lastWords.trim()) return false;
    if (this.state.phase !== Phase.DAY && this.state.phase !== Phase.VOTE && this.state.phase !== Phase.NIGHT) return false;
    const trimmed = (text || "").trim().slice(0, 300);
    if (!trimmed) return false;
    player.lastWords = trimmed;
    // Bilingual last words use "EN||ZH" format — wrap entire thing for client translateLine
    const logEntry = trimmed.includes("||")
      ? `Last words: "${trimmed.split("||")[0]}"||遺言：「${trimmed.split("||")[1]}」`
      : `Last words: "${trimmed}"`;
    addPublicLog(this.state, logEntry);
    // Also add to dayChat so AI chat memory can parse last words for accusations/defenses
    if (!this.state.dayChat) this.state.dayChat = [];
    // Tag with [LAST] so chat behavior analysis skips dead speakers but AI keyword parser can still read
    const chatLine = trimmed.includes("||")
      ? `[LAST] ${player.name}: ${trimmed.split("||")[0]}||${player.name}：${trimmed.split("||")[1]}`
      : `[LAST] ${player.name}: ${trimmed}`;
    this.state.dayChat.push(chatLine);
    return true;
  }
}

export function checkVictory(state) {
  const counts = factionCounts(state);
  const aliveTotal = alivePlayers(state).length;
  const civilianWipeAutoWinThemes = new Set([
    Theme.GOOD_VS_EVIL.id,
    Theme.COUNTER_TERROR.id,
    Theme.WILD_WEST.id,
  ]);
  const civilianAutoWin = civilianWipeAutoWinThemes.has(state.theme) && counts.civilians === 0;

  const grudgeAlive = counts.grudge > 0;
  // 1) Grudge Beast berserk precedence (only if rage condition met)
  if (grudgeAlive && state.grudgeState.berserk) {
    if (counts.killers === 0 || counts.police === 0) {
      state.victory = { winner: "GRUDGE", reason: "Grudge Beasts finished their rage condition." };
      return state.victory;
    }
  }

  // 2) Zombie majority
  if (counts.zombies > aliveTotal / 2) {
    state.victory = { winner: "ZOMBIE", reason: "Zombies outnumber the living." };
    return state.victory;
  }

  // 3) Red victory conditions
  const hasOtherSpecials = state.players.some(
    (p) =>
      p.alive &&
      ![Roles.POLICE.id, Roles.KILLER.id, Roles.CIVILIAN.id, Roles.ZOMBIE.id, Roles.GRUDGE_BEAST.id].includes(p.role)
  );
  if ((counts.killers >= counts.blue && !hasOtherSpecials) || counts.police === 0 || civilianAutoWin) {
    if (grudgeAlive && !state.grudgeState?.berserk) {
      state.victory = { winner: "GRUDGE", reason: "Grudge Beasts survive without berserk (overriding red win)." };
      return state.victory;
    }
    const blueTriggered = state.grudgeState?.triggerFaction === Faction.BLUE;
    if (blueTriggered && state.grudgeState?.berserk) {
      state.victory = { winner: "GRUDGE", reason: "Grudge co-win after berserk triggered by BLUE; RED cleared police." };
      return state.victory;
    }
    state.victory = { winner: "RED", reason: "Red faction satisfied elimination condition." };
    return state.victory;
  }

  // 4) Blue victory
  if (counts.killers === 0) {
    if (grudgeAlive && !state.grudgeState?.berserk) {
      state.victory = { winner: "GRUDGE", reason: "Grudge Beasts survive without berserk (overriding blue win)." };
      return state.victory;
    }
    const redTriggered = state.grudgeState?.triggerFaction === Faction.RED;
    if (redTriggered && state.grudgeState?.berserk) {
      state.victory = { winner: "GRUDGE", reason: "Grudge co-win after berserk triggered by RED; BLUE cleared killers." };
      return state.victory;
    }
    state.victory = { winner: "BLUE", reason: "All killers eliminated." };
    return state.victory;
  }

  // 5) Grudge non-berserk survival win (only after primary factions resolved)
  return null;
}
