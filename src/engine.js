import { buildAiNightActions, buildAiVoteActions, generateChatLines } from "./ai.js";
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
  DeathCause.SNIPER_HEADSHOT,
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

    // Convert pending zombie infections before actions.
    for (const p of this.state.players) {
      if (p.alive && p.status.pendingZombieConversion) {
        p.status.pendingZombieConversion = false;
        p.role = Roles.ZOMBIE.id;
        p.faction = Faction.GREEN;
        addPublicLog(this.state, `${p.name} turned into a zombie overnight.`);
      }
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
    }
  }

  resolveNight(humanAction = null, opts = {}) {
    this.startNight();
    const actions = buildAiNightActions(this.state, {
      includeHuman: opts.includeHuman === true,
      humanChoice: humanAction,
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
          const actorId = entry.actorId ?? Number(actorIdStr);
          humanActionsList.push({ ...entry, actorId });
        }
      }
    }
    for (const ha of humanActionsList) {
      if (ha && typeof ha.actorId === "number") actions.push(ha);
    }

    const controlActions = [];
    const otherActions = [];
    for (const action of actions) {
      if (["RIOT_SMOKE", "PURIFY", "KIDNAP"].includes(action.type)) controlActions.push(action);
      else otherActions.push(action);
    }

    const killerVotes = {};
    const policeVotes = {};
    const grudgeKillVotes = {};
    const kidnapMap = {};
    const agentLinks = {};
    const fiendProtectMap = {};
    const vineSeeds = {};
    const targetedByBlue = new Map();
    const pendingKills = [];
    const delayedKills = [];
    const convertNow = [];
    const biteBacklash = [];
    const nightDeaths = [];
    let doctorAction = null;
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
          target.status.smoked += 1;
          target.status.cannotAct = true;
          if (target.status.smoked >= 2) {
            addKill(target.id, DeathCause.SMOKE_OVERDOSE, { unstoppable: true, noLastWords: true });
          } else {
          addPublicLog(this.state, `Someone deployed smoke on ${target.name}.`);
          }
          break;
        }
        case "PURIFY": {
          target.status.purified = true;
          target.status.cannotAct = true;
          if (target.role === Roles.NECROMANCER.id) target.souls = 0;
          addPublicLog(this.state, `Someone cleansed ${target.name}.`);
          break;
        }
        case "KIDNAP": {
          if (actor.lastKidnapTarget === target.id) break;
          kidnapMap[actor.id] = target.id;
          actor.lastKidnapTarget = target.id;
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
          policeVotes[action.targetId] = (policeVotes[action.targetId] || 0) + 1;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          break;
        case "KILLER_VOTE":
          if (isUntargetable(target) || target?.status.purified) break;
          killerVotes[action.targetId] = (killerVotes[action.targetId] || 0) + 1;
          break;
        case "GRUDGE_KILL_VOTE":
          if (isUntargetable(target)) break;
          grudgeKillVotes[action.targetId] = (grudgeKillVotes[action.targetId] || 0) + 1;
          break;
        case "DOCTOR_INJECT":
          doctorAction = action;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          break;
        case "SNIPER_SHOT":
          if (this.state.usage.sniperShots >= (Roles.SNIPER.maxShots || 0)) break;
          if (isUntargetable(target)) break;
          this.state.usage.sniperShots += 1;
          addKill(target.id, DeathCause.SNIPER_HEADSHOT, { killerId: actor.id, unstoppable: true, noLastWords: true });
          addPublicLog(this.state, `Someone fired a sniper shot.`);
          break;
        case "AGENT_PROTECT":
          if (isUntargetable(target)) break;
          target.status.protectedByAgent = true;
          target.status.protectionSource = actor.id;
          agentLinks[actor.id] = target.id;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          break;
        case "FIEND_PROTECT":
          if (actor.status.fiendMode !== "ABSORB") break;
          if (isUntargetable(target)) break;
          target.status.protectedByFiend = true;
          target.status.protectionSource = actor.id;
          fiendProtectMap[actor.id] = target.id;
          trackBlueTarget(targetedByBlue, action.targetId, actor);
          break;
        case "FIEND_SHOOT":
          if (actor.status.fiendMode !== "CHARGE") break;
          if (isUntargetable(target)) break;
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
          const roll = this.state.rng();
          if (roll < 2 / 6) {
            delayedKills.push({ targetId: target.id, cause: DeathCause.COWBOY_SHOT, killerId: actor.id });
            addPublicLog(this.state, `Someone fired a risky shot at ${target.name}.`);
          } else if (roll < 5 / 6) {
            addPublicLog(this.state, `A cowboy's chamber clicked on ${target.name}.`);
          } else {
            addKill(target.id, DeathCause.COWBOY_SHOT, { killerId: actor.id });
            const others = alivePlayers(this.state).filter((p) => p.id !== actor.id && p.id !== target.id && p.alive);
            const extra = others[Math.floor(this.state.rng() * (others.length || 1))];
            if (extra) addKill(extra.id, DeathCause.COWBOY_BACKFIRE, { killerId: actor.id });
            addKill(actor.id, DeathCause.COWBOY_BACKFIRE, { killerId: actor.id });
            addPublicLog(this.state, `A cowboy drew a wild bullet. Chaos ensued.`);
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
          if (target && target.alive) {
            target.status.arsonMarked = true;
            arsonMarkedTargets.add(target.id);
            addPublicLog(this.state, `Someone splashed fuel on ${target.name}.`);
          }
          break;
        case "ARSON_IGNITE":
          arsonIgnite = true;
          addPublicLog(this.state, `Someone prepared to ignite marked targets.`);
          break;
        case "VINE_SEED":
          if (actor.status.vineActive && target && target.alive) {
            target.status.vineSeededBy = actor.id;
            vineSeeds[actor.id] = target.id;
          }
          break;
        case "NIGHTMARE_ATTACK":
          if (!target || isUntargetable(target)) break;
          if (target.role === Roles.CIVILIAN.id || target.role === Roles.BRAT.id) {
            addKill(target.id, DeathCause.NIGHTMARE_STRIKE, { killerId: actor.id });
          } else {
            addPrivateLog(this.state, "killer", `${actor.name} learned ${target.name} is ${target.role}.`);
          }
          break;
        case "EXORCIST_STRIKE":
          if (!target || isUntargetable(target)) break;
          if (actor.chainsLeft <= 0) break;
          addKill(target.id, DeathCause.EXORCIST_PETRIFY, { killerId: actor.id, blockable: false });
          if (target.faction !== Faction.RED && target.role !== Roles.ZOMBIE.id) {
            actor.chainsLeft = Math.max(0, actor.chainsLeft - 1);
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
            delayedKills.push({
              targetId: target.id,
              cause: DeathCause.NECROMANCER_CURSE,
              killerId: actor.id,
              requiresAliveActor: actor.id,
            });
          }
          break;
        case "PURIFY":
          break;
        case "GRUDGE_JUDGE":
          if (!target || isUntargetable(target)) break;
          if (target.faction === Faction.RED) {
            addPrivateLog(this.state, "police", `Grudge intel: ${target.name} is ${target.role}.`);
          } else if (target.faction === Faction.BLUE && target.role !== Roles.CIVILIAN.id) {
            addPrivateLog(this.state, "killer", `Grudge intel: ${target.name} is ${target.role}.`);
          } else if (target.role === Roles.CIVILIAN.id) {
            addKill(actor.id, DeathCause.GRUDGE_PUNISH, { killerId: actor.id });
          }
          break;
        default:
          break;
      }
    }

    // Vine demon triggers on blue actions.
    for (const [actorId, targetId] of Object.entries(vineSeeds)) {
      const demon = getPlayer(this.state, Number(actorId));
      const target = getPlayer(this.state, targetId);
      if (!demon?.alive || !target?.alive) continue;
      const blues = targetedByBlue.get(targetId);
      if (blues && blues.length) {
        addKill(target.id, DeathCause.VINE_SWAP, { killerId: demon.id });
        const blueActorId = blues[0];
        addKill(blueActorId, DeathCause.VINE_SWAP, { killerId: demon.id });
        demon.status.vineActive = false;
      }
    }

    // Majority decisions.
    const killersAlive = alivePlayers(this.state).filter((p) => p.role === Roles.KILLER.id && !actorBlocked(p)).length;
    const killerNeeded = Math.floor(killersAlive / 2) + 1;
    let killerDecision = majorityTarget(killerVotes, killerNeeded);
    if (!killerDecision && Object.keys(killerVotes).length > 0) {
      // allow plurality kill if no majority
      let bestId = null;
      let bestCount = -1;
      for (const [tid, cnt] of Object.entries(killerVotes)) {
        const numId = Number(tid);
        if (cnt > bestCount || (cnt === bestCount && numId < (bestId ?? numId + 1))) {
          bestId = numId;
          bestCount = cnt;
        }
      }
      if (bestId !== null) killerDecision = { targetId: bestId, count: bestCount };
    }
    if (!killerDecision && killersAlive > 0 && this.state.rng() < 0.5) {
      const pool = alivePlayers(this.state).filter(
        (p) => p.faction !== Faction.RED && p.role !== Roles.KILLER.id && !isUntargetable(p) && !p.status.purified
      );
      if (pool.length) {
        killerDecision = { targetId: pool[0].id, count: killerNeeded };
      }
    }
    if (!killerDecision && killersAlive > 0 && this.state.rng() < 0.5) {
      const pool = alivePlayers(this.state).filter((p) => p.faction !== Faction.RED && p.role !== Roles.KILLER.id);
      if (pool.length) killerDecision = { targetId: pool[0].id, count: killerNeeded };
    }
    if (!killerDecision && killersAlive > 0 && this.state.rng() < 0.2) {
      const pool = alivePlayers(this.state).filter(
        (p) => p.faction !== Faction.RED && p.role !== Roles.KILLER.id && !isUntargetable(p) && !p.status.purified
      );
      if (pool.length) {
        killerDecision = { targetId: pool[0].id, count: killerNeeded };
      }
    }
    if (!killerDecision && killersAlive > 0 && this.state.rng() < 0.2) {
      const pool = alivePlayers(this.state).filter((p) => p.faction !== Faction.RED && p.role !== Roles.KILLER.id);
      if (pool.length) killerDecision = { targetId: pool[0].id, count: killerNeeded };
    }
    if (killerDecision) {
      const tgt = getPlayer(this.state, killerDecision.targetId);
      if (tgt && !tgt.status.purified && !isUntargetable(tgt)) {
        addKill(tgt.id, DeathCause.KILLER_MURDER, { killerId: null });
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
    }

    const policeAlive = alivePlayers(this.state).filter((p) => p.role === Roles.POLICE.id && !actorBlocked(p)).length;
    const policeNeeded = Math.floor(policeAlive / 2) + 1;
    let policeDecision = majorityTarget(policeVotes, policeNeeded);
    if (!policeDecision && policeAlive > 0) {
      const pool = alivePlayers(this.state).filter(
        (p) => p.role !== Roles.POLICE.id && !isUntargetable(p) && !p.status.purified
      );
      if (pool.length) policeDecision = { targetId: pool[0].id, count: policeNeeded };
    }
    if (!policeDecision && policeAlive > 0) {
      const pool = alivePlayers(this.state).filter((p) => p.role !== Roles.POLICE.id);
      if (pool.length) policeDecision = { targetId: pool[0].id, count: policeNeeded };
    }
    if (policeDecision) {
      const target = getPlayer(this.state, policeDecision.targetId);
      if (target) {
        addPrivateLog(
          this.state,
          "police",
          `Investigation result: ${target.name} is ${target.faction === Faction.RED ? "RED" : target.faction === Faction.GREEN ? "GREEN" : "BLUE"}`
        );
        if (target.faction === Faction.RED && target.alive) {
          this.state.policeRevealedRed = target.id;
        }
        // Kidnapper ransom kill
        const kidnapVictim = kidnapMap[target.id];
        if (kidnapVictim !== undefined) {
          addKill(kidnapVictim, DeathCause.KIDNAP_EXECUTION, { killerId: target.id, blockable: true });
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
          addKill(target.id, DeathCause.ARSON_BURN, { unstoppable: true, noLastWords: true });
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
    for (const k of pendingKills) {
      const target = getPlayer(this.state, k.targetId);
      if (!target?.alive) continue;
      if (!k.unstoppable) {
        if (target.status.protectedByAgent) {
          continue;
        }
        if (target.status.protectedByFiend) {
          const sourceId = target.status.protectionSource;
          fiendAbsorbed.add(sourceId);
          continue;
        }
      }
      filteredKills.push(k);
    }

    for (const fiendId of fiendAbsorbed) {
      const fiend = getPlayer(this.state, fiendId);
      if (fiend) fiend.status.fiendMode = "CHARGE";
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
            blockable: false,
            unstoppable: false,
            noLastWords: false,
            requiresAliveActor: null,
          });
          target.status.vineActive = false;
          delete vineSeeds[target.id];
        }
      }
    }

    // Apply immediate kills.
    for (const k of filteredKills) {
      if (k.timing !== "instant") continue;
      const target = getPlayer(this.state, k.targetId);
      const actorAlive = k.requiresAliveActor ? survivors(k.requiresAliveActor) : true;
      if (target?.alive && actorAlive) {
        markDeath(this.state, target.id, k.cause);
        nightDeaths.push({ targetId: target.id, killerId: k.killerId, cause: k.cause });
      }
    }

    // Apply delayed kills.
    for (const k of delayedKills) {
      const target = getPlayer(this.state, k.targetId);
      const actorAlive = k.requiresAliveActor ? survivors(k.requiresAliveActor) : true;
      if (target?.alive && actorAlive) {
        markDeath(this.state, target.id, k.cause);
        nightDeaths.push({ targetId: target.id, killerId: k.killerId, cause: k.cause });
      }
    }

    for (const k of filteredKills) {
      if (k.timing === "instant") continue;
      const target = getPlayer(this.state, k.targetId);
      const actorAlive = k.requiresAliveActor ? survivors(k.requiresAliveActor) : true;
      if (target?.alive && actorAlive) {
        markDeath(this.state, target.id, k.cause);
        nightDeaths.push({ targetId: target.id, killerId: k.killerId, cause: k.cause });
      }
    }

    // Agent death links.
    for (const [agentId, targetId] of Object.entries(agentLinks)) {
      const agent = getPlayer(this.state, Number(agentId));
      const target = getPlayer(this.state, targetId);
      if (agent && !agent.alive && target?.alive) {
        markDeath(this.state, target.id, DeathCause.AGENT_LINK);
        nightDeaths.push({ targetId: target.id, killerId: agent.id, cause: DeathCause.AGENT_LINK });
      }
    }

    // Convert zombies.
    for (const targetId of convertNow) {
      const target = getPlayer(this.state, targetId);
      if (target?.alive) {
        target.role = Roles.ZOMBIE.id;
        target.faction = Faction.GREEN;
        addPublicLog(this.state, `${target.name} was overwhelmed and turned into a zombie immediately.`);
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
    const grudgeDeath = nightDeaths.some((d) => {
      const player = getPlayer(this.state, d.targetId);
      return player?.role === Roles.GRUDGE_BEAST.id;
    });
    if (grudgeDeath) {
      this.state.grudgeState.berserk = true;
      addPublicLog(this.state, "Grudge Beasts entered berserk rage.");
    }

    // Necromancer soul gain: any alive necromancer gains souls per death not caused by them.
    for (const necro of this.state.players) {
      if (!necro.alive || necro.role !== Roles.NECROMANCER.id) continue;
      let gained = 0;
      for (const d of nightDeaths) {
        if (d.killerId === necro.id) continue;
        gained += 1;
      }
      necro.souls += gained;
    }

    this.state.phase = Phase.DAY;
    this.state.dayChat = generateChatLines(this.state);
    this.state.chatLoggedForDay = this.state.dayNumber;
    for (const line of this.state.dayChat) {
      this.state.publicLog.push(line);
    }
    updateWinrateHint(this.state);

    const victory = checkVictory(this.state);
    if (victory) this.state.phase = Phase.END;
  }

  resolveVote(humanVoteTargetId = null, humanLastWords = "", opts = {}) {
    this.state.phase = Phase.VOTE;
    const votes = {};
    const votePairs = [];
    const voteOrder = [];

    const aliveCount = alivePlayers(this.state).length;
    const needed = Math.floor(aliveCount / 2) + 1;

    const mentionCounts = {};
    const chats = this.state.dayChat || [];
    for (const line of chats) {
      for (const p of this.state.players) {
        if (line.includes(p.name)) {
          mentionCounts[p.id] = (mentionCounts[p.id] || 0) + 1;
        }
      }
    }

    const lastWordsByPlayer = opts.lastWordsByPlayer || {};
    const humanVotesList = [];
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

    for (const hv of humanVotesList) {
      if (hv.targetId === null || hv.targetId === undefined) continue;
      votes[hv.targetId] = (votes[hv.targetId] || 0) + 1;
      const actor = getPlayer(this.state, hv.actorId);
      const target = getPlayer(this.state, hv.targetId);
      if (actor && target) {
        votePairs.push(`${actor.name} -> ${target.name}`);
        voteOrder.push({ actorId: actor.id, targetId: target.id });
      }
    }

    const aiVotes = buildAiVoteActions(this.state, null, { includeHuman: opts.includeHuman === true });
    for (const v of aiVotes) {
      votes[v.targetId] = (votes[v.targetId] || 0) + 1;
      const actor = getPlayer(this.state, v.actorId);
      const target = getPlayer(this.state, v.targetId);
      if (actor && target) {
        votePairs.push(`${actor.name} -> ${target.name}`);
        voteOrder.push({ actorId: actor.id, targetId: target.id });
      }
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
          target.status.bratRevived = true;
          target.status.bratRevealed = true;
          addPublicLog(this.state, `${target.name} revealed as Brat and revived (loses voting power).`);
        } else if (target.isHuman) {
          const candidate = lastWordsByPlayer[target.id] ?? humanLastWords;
          if (typeof candidate === "string" && candidate.trim() && target.deathCause !== DeathCause.TERROR_BOMB) {
            target.lastWords = candidate.trim().slice(0, 64);
            addPublicLog(this.state, `Last words: "${target.lastWords}"`);
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
    }
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

  // 1) Grudge Beast precedence
  if (counts.grudge > 0) {
    if (state.grudgeState.berserk) {
      if (counts.killers === 0 || counts.police === 0) {
        state.victory = { winner: "GRUDGE", reason: "Grudge Beasts finished their rage condition." };
        return state.victory;
      }
    } else {
      state.victory = { winner: "GRUDGE", reason: "Grudge Beasts survive without berserk." };
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
    state.victory = { winner: "RED", reason: "Red faction satisfied elimination condition." };
    return state.victory;
  }

  // 4) Blue victory
  if (counts.killers === 0) {
    state.victory = { winner: "BLUE", reason: "All killers eliminated." };
    return state.victory;
  }

  return null;
}
