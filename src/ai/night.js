import { alivePlayers, getPlayer, factionCounts } from "../state.js";
import { Roles, Faction } from "../roles.js";
import { clamp, isHard, randomChoice, shuffled, getGamePhase, ensureAdvancedMemory } from "./utils.js";
import { analyzeChatBehavior, analyzeVotingPatterns, factionProb, publicPoliceConfirmed } from "./analysis.js";
import { ensureBeliefs } from "./memory.js";
import { pickTargetBySuspicion, pickGroupTarget, pickKillerSmartTarget, pickPoliceSmartTarget, pickCowboySmartTarget, pickSniperSmartTarget, pickTerroristSmartTarget, pickZombieTarget } from "./targeting.js";

// ─── Night Actions ─────────────────────────────────────────────────────────

export async function buildAiNightActions(state, opts = {}) {
  const includeHuman = opts.includeHuman === true;
  const humanChoice = opts.humanChoice || null;
  const humanActionsRaw = opts.humanActions || null;
  const human = state.players.find((p) => p.isHuman);
  const hard = isHard(state);
  ensureBeliefs(state);

  const actions = [];

  const humanActionList = [];
  if (Array.isArray(humanActionsRaw)) {
    for (const a of humanActionsRaw) {
      if (a && typeof a.actorId === "number") humanActionList.push(a);
    }
  } else if (humanActionsRaw && typeof humanActionsRaw === "object") {
    for (const [actorIdStr, a] of Object.entries(humanActionsRaw)) {
      if (!a) continue;
      const actorId = a.actorId ?? Number(actorIdStr);
      humanActionList.push({ ...a, actorId });
    }
  }

  const pickHumanTarget = (actionType) => {
    const candidates = humanActionList.filter(
      (a) => a.type === actionType && typeof a.targetId === "number"
    );
    if (!candidates.length) return null;
    const choiceIdx = Math.floor(state.rng() * candidates.length);
    return getPlayer(state, candidates[choiceIdx].targetId) || null;
  };

  // Pre-pick a shared killer target to avoid split votes.
  const killerActors = alivePlayers(state).filter((p) => p.role === Roles.KILLER.id && (!p.isHuman || includeHuman));
  const humanKillerTarget = pickHumanTarget("KILLER_VOTE");
  let sharedKillerTarget = humanKillerTarget;
  if (!sharedKillerTarget) {
    // If night faction chat already coordinated a target, use it for consistency
    if (hard && state._killerChatTarget !== undefined) {
      sharedKillerTarget = getPlayer(state, state._killerChatTarget);
      if (sharedKillerTarget && !sharedKillerTarget.alive) sharedKillerTarget = null;
    }
    if (!sharedKillerTarget) {
      // Hard+: each killer picks a target, then majority vote decides
      if (hard && killerActors.length > 0) {
        const killerPicks = {};
        for (const k of killerActors) {
          const pick = pickKillerSmartTarget(state, k);
          if (pick) {
            killerPicks[pick.id] = (killerPicks[pick.id] || 0) + 1;
          }
        }
        // Majority target among all killers' individual picks
        let bestTarget = null;
        let bestCount = 0;
        for (const [tid, cnt] of Object.entries(killerPicks)) {
          if (cnt > bestCount || (cnt === bestCount && state.rng() < 0.5)) {
            bestCount = cnt;
            bestTarget = getPlayer(state, Number(tid));
          }
        }
        sharedKillerTarget = bestTarget;
      } else {
        sharedKillerTarget =
          state.rng() < 0.6
            ? pickGroupTarget(state, killerActors, (t) => t.role !== Roles.KILLER.id)
            : null;
      }
    }
  }
  // Pre-pick a shared police target to avoid split votes.
  const policeActors = alivePlayers(state).filter((p) => p.role === Roles.POLICE.id && (!p.isHuman || includeHuman));
  const humanPoliceTarget = pickHumanTarget("POLICE_INVESTIGATE");
  // Hard+: use smart targeting for group consensus instead of raw suspicion
  let sharedPoliceTarget = humanPoliceTarget;
  if (!sharedPoliceTarget) {
    // If night faction chat already coordinated a target, use it for consistency
    if (hard && state._policeChatTarget !== undefined) {
      sharedPoliceTarget = getPlayer(state, state._policeChatTarget);
      if (sharedPoliceTarget && !sharedPoliceTarget.alive) sharedPoliceTarget = null;
    }
  }
  if (!sharedPoliceTarget && policeActors.length > 0) {
    if (hard) {
      const policePicks = {};
      for (const p of policeActors) {
        const pick = pickPoliceSmartTarget(state, p);
        if (pick) policePicks[pick.id] = (policePicks[pick.id] || 0) + 1;
      }
      let bestTarget = null;
      let bestCount = 0;
      for (const [tid, cnt] of Object.entries(policePicks)) {
        if (cnt > bestCount || (cnt === bestCount && state.rng() < 0.5)) {
          bestCount = cnt;
          bestTarget = getPlayer(state, Number(tid));
        }
      }
      sharedPoliceTarget = bestTarget;
    } else {
      sharedPoliceTarget = pickGroupTarget(state, policeActors, (t) => t.role !== Roles.POLICE.id);
    }
  }
  if (!sharedPoliceTarget) {
    sharedPoliceTarget = randomChoice(
      alivePlayers(state).filter((t) => t.role !== Roles.POLICE.id),
      state.rng
    );
  }
  if (
    humanChoice &&
    human?.role === Roles.POLICE.id &&
    typeof humanChoice.targetId === "number" &&
    state.rng() < 0.75
  ) {
    sharedPoliceTarget = getPlayer(state, humanChoice.targetId) || sharedPoliceTarget;
  }
  // Pre-pick shared grudge target (follow human if present, else group).
  const grudgeActors = alivePlayers(state).filter((p) => p.role === Roles.GRUDGE_BEAST.id && (!p.isHuman || includeHuman));
  const humanGrudgeTarget =
    pickHumanTarget("GRUDGE_JUDGE") ||
    pickHumanTarget("GRUDGE_KILL_VOTE");
  let sharedGrudgeTarget = humanGrudgeTarget;
  if (
    !sharedGrudgeTarget &&
    humanChoice &&
    human?.role === Roles.GRUDGE_BEAST.id &&
    typeof humanChoice.targetId === "number"
  ) {
    sharedGrudgeTarget = getPlayer(state, humanChoice.targetId) || null;
  }
  if (!sharedGrudgeTarget) {
    sharedGrudgeTarget = pickGroupTarget(
      state,
      grudgeActors,
      (t) => t.role !== Roles.GRUDGE_BEAST.id
    );
  }

  for (const actor of alivePlayers(state)) {
    if (actor.isHuman && !includeHuman) continue;
    switch (actor.role) {
      case Roles.POLICE.id: {
        const target =
          sharedPoliceTarget ||
          pickPoliceSmartTarget(state, actor) ||
          pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.POLICE.id);
        if (target) actions.push({ actorId: actor.id, type: "POLICE_INVESTIGATE", targetId: target.id });
        break;
      }
      case Roles.KILLER.id: {
        let target = sharedKillerTarget;
        // ── Improvement 12: Killer target rotation ──
        // If hard and shared target was saved last night, 80% chance to skip them
        if (hard && target && state.killerLastTarget !== undefined && target.id === state.killerLastTarget) {
          const wasSaved = (state.lastNightSavedIds || []).includes(target.id);
          if (wasSaved && state.rng() < 0.8) {
            target = null; // force re-pick
          }
        }
        if (!target) {
          if (hard) {
            target = pickKillerSmartTarget(state, actor);
          }
          if (!target) {
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              if (t.role === Roles.KILLER.id) continue;
              const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0;
              const priority = blueProb + (actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
              if (priority > bestScore || (priority === bestScore && state.rng() < 0.5)) {
                bestScore = priority;
                best = t;
              }
            }
            target = best;
          }
        }
        if (target) {
          actions.push({ actorId: actor.id, type: "KILLER_VOTE", targetId: target.id });
          // Track last target for rotation
          if (hard) state.killerLastTarget = target.id;
        }
        break;
      }
      case Roles.DOCTOR.id: {
        if (state.usage.doctorInjections < (Roles.DOCTOR.maxInjections || 0)) {
          let target = actor;
          const dayNum = state.dayNumber || 1;
          // Safety: never self-inject if already at overdose risk (emptyInjections >= 1)
          const selfOverdoseRisk = actor.emptyInjections >= 1;
          // Hard+: self-protect decision based on self-threat level + game phase
          const selfThreat = actor.aiMemory?.selfThreat ?? 0;
          let selfProtectChance;
          if (hard) {
            // Day 1: killers don't know who doctor is, almost never self-protect
            if (dayNum === 1) {
              selfProtectChance = 0.05;
            } else {
              selfProtectChance = clamp(0.1 + selfThreat * 0.7, 0.1, 0.75);
              // Doctor is irreplaceable — late game self-protect more
              const injectionsLeftSelf = (Roles.DOCTOR.maxInjections || 6) - state.usage.doctorInjections;
              if (injectionsLeftSelf >= 2 && getGamePhase(state) === "late") {
                selfProtectChance = clamp(selfProtectChance + 0.15, 0.1, 0.8);
              }
              // If accused by reds or heavily voted, killers may target us
              const selfAccusedByRed = (state.players || []).some((p) => {
                if (!p.aiMemory?.chatMemory) return false;
                return p.aiMemory.chatMemory.some((m) => {
                  if (m.accusedId !== actor.id) return false;
                  const sp = getPlayer(state, m.speakerId);
                  return sp && ((!sp.alive && sp.faction === Faction.RED) || publicPoliceConfirmed(state, actor)?.[m.speakerId] === true);
                });
              });
              if (selfAccusedByRed) selfProtectChance = clamp(selfProtectChance + 0.1, 0.1, 0.8);
            }
          } else {
            selfProtectChance = 0.3;
          }
          if (selfOverdoseRisk || state.rng() > selfProtectChance) {
            // Protect someone else (forced if self-inject would cause overdose)
            let best = null;
            let bestScore = -Infinity;
            // Pre-compute chat behavior once (not per candidate)
            const chatBehavior = hard ? analyzeChatBehavior(state) : null;
            const maxSpoken = chatBehavior ? Math.max(1, ...Object.values(chatBehavior.speakCount || {})) : 1;

            // Injection budget awareness: how cautious should we be?
            const injectionsLeft = (Roles.DOCTOR.maxInjections || 6) - state.usage.doctorInjections;
            const alive = alivePlayers(state);
            // Estimate remaining nights: ~(aliveCount / 2) more nights of game
            const estNightsLeft = Math.max(1, Math.ceil(alive.length / 3));
            // If injections are scarce relative to remaining game, require higher confidence
            const budgetTight = injectionsLeft <= estNightsLeft;

            // Detect killer target-switching pattern: if last kill was active speaker,
            // killer likely switches to quiet target next (and vice versa)
            let killerPreferQuiet = false;
            let killerPreferActive = false;
            if (hard) {
              const recentDeads = state.players.filter(
                (p) => !p.alive && p.deathCause && p.faction === Faction.BLUE
              );
              const lastDead = recentDeads[recentDeads.length - 1];
              if (lastDead && chatBehavior) {
                const deadSpeak = (chatBehavior.speakCount[lastDead.id] || 0) / maxSpoken;
                if (deadSpeak > 0.5) killerPreferQuiet = true;
                if (deadSpeak < 0.3) killerPreferActive = true;
              }
            }

            // Identify who was saved last night
            const savedLastNight = new Set(hard ? (state.lastNightSavedIds || []) : []);
            const publicPoliceClaimIds = new Set(
              hard
                ? Object.entries(state.roleClaims || {})
                    .filter(([_, role]) => role === Roles.POLICE.id)
                    .map(([id]) => Number(id))
                : []
            );
            const publicClearedBlueIds = new Set(hard ? (state.policePublicClearedBlueIds || []) : []);

            // Multi-night attack trend: count blue deaths by speaking pattern
            let nightDeathActive = 0;
            let nightDeathQuiet = 0;
            if (hard && chatBehavior) {
              for (const p of state.players) {
                if (!p.alive && p.deathCause && p.deathCause !== "VOTE_EXECUTION" && p.faction === Faction.BLUE) {
                  const sr = (chatBehavior.speakCount[p.id] || 0) / maxSpoken;
                  if (sr > 0.4) nightDeathActive++;
                  else nightDeathQuiet++;
                }
              }
            }

            // Pre-compute vote info once
            const voteHist = state.history?.votes || [];
            const lastRound = voteHist.length > 0 ? voteHist[voteHist.length - 1] : null;
            const lastTally = lastRound ? (lastRound.tally || {}) : {};
            const maxVotes = Math.max(1, ...Object.values(lastTally));

            // Mirror killer signals: who correctly voted to execute reds (killer wants them dead)
            const correctVoterIds = new Set();
            if (hard) {
              const voteExecReds = state.players.filter((p) => !p.alive && p.deathCause === "VOTE_EXECUTION" && p.faction === Faction.RED);
              for (const dead of voteExecReds) {
                for (const round of (state.history?.votes || [])) {
                  if (!round.order || !round.tally) continue;
                  const tv = round.tally[dead.id] || 0;
                  const mv = Math.max(0, ...Object.values(round.tally));
                  if (tv > 0 && tv === mv) {
                    for (const entry of round.order) {
                      if (entry.targetId === dead.id) correctVoterIds.add(entry.actorId);
                    }
                  }
                }
              }
            }

            // Mirror killer signals: who accused reds in chat (killer wants them dead)
            const redAccuserCount = {};
            if (hard) {
              const knownDeadReds = new Set();
              for (const p of state.players) {
                if (!p.alive && p.faction === Faction.RED) knownDeadReds.add(p.id);
              }
              if ((state.policePublicRevealedRed ?? null) !== null) knownDeadReds.add((state.policePublicRevealedRed ?? null));
              for (const p of state.players) {
                if (!p.aiMemory?.chatMemory) continue;
                for (const m of p.aiMemory.chatMemory) {
                  if (m.accusedId !== null && knownDeadReds.has(m.accusedId)) {
                    redAccuserCount[m.speakerId] = (redAccuserCount[m.speakerId] || 0) + 1;
                  }
                }
              }
            }

            // Mirror killer signals: arson-marked = blue (killer avoids them)
            const arsonMarkedIds = new Set();
            if (hard) {
              for (const p of state.players) {
                if (p.alive && p.status.arsonMarked) arsonMarkedIds.add(p.id);
              }
            }

            // Accused by known reds = likely blue (killer targets them)
            const accusedByRedIds = new Set();
            if (hard) {
              for (const p of state.players) {
                if (!p.aiMemory?.chatMemory) continue;
                for (const m of p.aiMemory.chatMemory) {
                  if (m.accusedId === null) continue;
                  const speaker = getPlayer(state, m.speakerId);
                  if (!speaker) continue;
                  const isKnownRed = (!speaker.alive && speaker.faction === Faction.RED) ||
                    (publicPoliceConfirmed(state, actor)?.[m.speakerId] === true);
                  if (isKnownRed) accusedByRedIds.add(m.accusedId);
                }
              }
            }

            for (const t of shuffled(alive, state.rng)) {
              if (t.id === actor.id) continue;
              const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
              const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
              const specialProb =
                (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0) +
                (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0) +
                (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0);
              let score = blueProb + specialProb;

              if (hard) {
                // Mirror killer targeting: killers prefer blue + police + active speakers
                const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
                score += policeProb * 0.35;
                if (publicPoliceClaimIds.has(t.id)) score += 1.0;
                if (publicClearedBlueIds.has(t.id)) score += 0.35;
                if (savedLastNight.has(t.id)) score += 0.2;

                const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
                score += speakRatio * 0.2;

                // Killer target-switching prediction
                if (killerPreferQuiet && speakRatio < 0.3) score += 0.15;
                if (killerPreferActive && speakRatio > 0.5) score += 0.15;

                // Multi-night trend: if killers consistently target active speakers, boost active
                if (nightDeathActive > nightDeathQuiet + 1 && speakRatio > 0.5) score += 0.1;
                if (nightDeathQuiet > nightDeathActive + 1 && speakRatio < 0.3) score += 0.1;

                // Mirror: correct voters are killer targets — protect them
                if (correctVoterIds.has(t.id) && blueProb > 0.4) score += 0.2;

                // Mirror: red accusers are killer targets — protect them
                if (redAccuserCount[t.id] && blueProb > 0.4) {
                  score += Math.min(redAccuserCount[t.id] * 0.1, 0.25);
                }

                // Mirror: arson-marked = confirmed blue, killer avoids but still valuable to protect
                if (arsonMarkedIds.has(t.id)) score += 0.1;

                // Mirror: accused by reds = likely blue, killer may target them
                if (accusedByRedIds.has(t.id)) score += 0.15;

                // Penalty: likely red — don't waste injection (and risk overdose)
                score -= redProb * 0.4;

                // Budget-tight penalty: if injections are running low, need higher blue confidence
                if (budgetTight && blueProb < 0.5) score -= 0.2;

                // Penalty: overdose risk — emptyInjections=1 means next empty = death
                const targetPlayer = getPlayer(state, t.id);
                if (targetPlayer && targetPlayer.emptyInjections >= 1) {
                  score -= 1.5; // nearly always avoid (emptyKillsAt=2, next empty kills them)
                }

                // Bonus: received many votes last round → killers see them as threat
                if (lastRound) {
                  const tVotes = lastTally[t.id] || 0;
                  if (tVotes > 0 && blueProb > 0.5) {
                    score += (tVotes / maxVotes) * 0.15;
                  }
                }

                // Agent overlap avoidance: if an agent is likely alive and protecting,
                // slightly penalize the most obvious protection target to spread coverage
                if (Roles.AGENT) {
                  const agentAlive = alive.some((p) => {
                    const ap = actor.aiMemory?.roleProbs?.[p.id]?.[Roles.AGENT.id] ?? 0;
                    return p.id !== actor.id && ap > 0.3;
                  });
                  if (agentAlive) {
                    const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
                    if (agentProb > 0.3) {
                      score -= 0.15;
                    }
                  }
                }
              }

              // Doctor anti-pattern: don't repeat same target unless we saved them
              if (hard) {
                ensureAdvancedMemory(actor);
                const lastProt = actor.aiMemory.lastProtected;
                if (lastProt !== null && t.id === lastProt) {
                  if (savedLastNight.has(t.id)) {
                    // Saved successfully! But killer has 80% chance to switch target
                    // Only re-protect with moderate bonus (not guaranteed re-target)
                    score += 0.15;
                  } else {
                    // Wasn't attacked — killer likely targets someone else, switch protection
                    score -= 0.8;
                  }
                }
                // Bonus: someone ELSE was saved last night — killer will switch away from them
                // so protect the next likely target instead (already handled by base scoring)
              }
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            target = best || (selfOverdoseRisk ? null : actor);
          }
          if (target) {
            actions.push({ actorId: actor.id, type: "DOCTOR_INJECT", targetId: target.id });
            if (hard) {
              ensureAdvancedMemory(actor);
              actor.aiMemory.lastProtected = target.id;
            }
          }
        }
        break;
      }
      case Roles.SNIPER.id: {
        if (state.usage.sniperShots < (Roles.SNIPER.maxShots || 0)) {
          // Hard+: conservative early, aggressive late (more info = better aim)
          let activateChance = 0.6;
          if (hard) {
            const sniperPhase = getGamePhase(state);
            const dayNum = state.dayNumber || 1;
            // Day 1: 30%, Day 2: 45%, Day 3+: 65%+
            activateChance = clamp(0.15 + dayNum * 0.15, 0.2, 0.75);
            // Advanced: Late game boost
            if (sniperPhase === "late") activateChance = clamp(activateChance + 0.15, 0.2, 0.85);
          }
          if (state.rng() < activateChance) {
            const target = hard
              ? pickSniperSmartTarget(state, actor)
              : pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "SNIPER_SHOT", targetId: target.id });
          }
        }
        break;
      }
      case Roles.AGENT.id: {
        if (hard) {
          const selfThreat = actor.aiMemory?.selfThreat ?? 0;
          const chatInfo = analyzeChatBehavior(state);
          const maxSpoken = Math.max(1, ...Object.values(chatInfo.speakCount || {}));
          const votePatterns = analyzeVotingPatterns(state);
          const dayNum = state.dayNumber || 1;

          // CRITICAL: If agent is likely to be killed tonight, protecting someone
          // will ALSO kill that person (AGENT_LINK). Consider not protecting.
          const agentInDanger = selfThreat > 0.7;

          // Pre-compute: known reds, saved targets
          const knownReds = new Set();
          if ((state.policePublicRevealedRed ?? null) !== null) knownReds.add((state.policePublicRevealedRed ?? null));
          for (const dp of state.players) {
            if (!dp.alive && dp.faction === Faction.RED) knownReds.add(dp.id);
          }

          const savedLastNight = new Set(state.lastNightSavedIds || []);

          // KEY INSIGHT: Mirror the KILLER's scoring logic to predict their target.
          // Killer logic: blueProb + policeProb×0.5 + speakRatio×0.3
          //   - penalty for doctorProb/agentProb (protected)
          //   - STRONG penalty for saved last night (-0.8)
          //   - skip saved+same target 80%
          // Agent should protect whoever the KILLER would score highest.

          let best = null;
          let bestScore = -Infinity;
          for (const t of alivePlayers(state)) {
            if (t.id === actor.id) continue;

            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
            const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;

            // Skip: don't protect known/likely reds
            if (publicPoliceConfirmed(state, actor)?.[t.id]) continue;
            if (redProb > 0.7) continue;

            // Simulate killer's view of this target (how attractive to kill?)
            // This is the agent's estimate of killer targeting probability
            const speakRatio = (chatInfo.speakCount[t.id] || 0) / maxSpoken;
            let killerAttraction = blueProb + policeProb * 0.5 + speakRatio * 0.3;

            // Killers strongly avoid saved targets — so agent should too
            if (savedLastNight.has(t.id)) {
              killerAttraction -= 0.7; // killer won't re-target saved players
            }

            // Killers avoid doctor/agent-protected targets
            killerAttraction -= doctorProb * 0.25;

            // Protection value = killerAttraction × blueValue
            // (only worth protecting if killer WILL target AND target is blue)
            let score = killerAttraction * blueProb;

            // Extra value for high-importance roles
            score += policeProb * 0.4;
            score += doctorProb * 0.35;

            // Red ally pattern: voted with known reds = risky to protect
            if (votePatterns) {
              let redAllyCount = 0;
              for (const redId of knownReds) {
                redAllyCount += votePatterns.votedTogether[t.id]?.[redId] || 0;
              }
              score -= Math.min(redAllyCount * 0.1, 0.25);
            }

            // Chat accusation: targets accused by many are less likely to be
            // night-killed (killers let votes handle them)
            const chatMem = actor.aiMemory?.chatMemory || [];
            let accusedCount = 0;
            for (const m of chatMem) {
              if (m.accusedId === t.id) accusedCount++;
            }
            if (accusedCount >= 3) score -= 0.15;

            // Agent in danger: flatten scores to minimize AGENT_LINK damage
            if (agentInDanger) score *= 0.3;

            score += (state.rng() - 0.5) * 0.08;
            if (score > bestScore) {
              bestScore = score;
              best = t;
            }
          }

          // If agent is in extreme danger, small chance to skip (15%)
          if (agentInDanger && state.rng() < 0.15) break;

          const target = best;
          if (target) {
            actions.push({ actorId: actor.id, type: "AGENT_PROTECT", targetId: target.id });
            if (hard) {
              ensureAdvancedMemory(actor);
              actor.aiMemory.lastProtected = target.id;
            }
          }
        } else {
          // Non-hard: pick highest blue prob target
          let best = null;
          let bestScore = -Infinity;
          for (const t of alivePlayers(state)) {
            if (t.id === actor.id) continue;
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const score = blueProb - redProb + (state.rng() - 0.5) * 0.2;
            if (score > bestScore) { bestScore = score; best = t; }
          }
          if (best) {
            actions.push({ actorId: actor.id, type: "AGENT_PROTECT", targetId: best.id });
            ensureAdvancedMemory(actor);
            actor.aiMemory.lastProtected = best.id;
          }
        }
        break;
      }
      case Roles.HEAVENLY_FIEND.id: {
        if (actor.status.fiendMode === "ABSORB") {
          // Hard+: same logic as agent — predict killer targets
          let best = null;
          let bestScore = -Infinity;
          const fiendChat = hard ? analyzeChatBehavior(state) : null;
          const fiendMaxSpoken = fiendChat ? Math.max(1, ...Object.values(fiendChat.speakCount || {})) : 1;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id) continue;
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            let score = blueProb - redProb;
            if (hard) {
              const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
              score += policeProb * 0.4;
              const speakRatio = (fiendChat?.speakCount[t.id] || 0) / fiendMaxSpoken;
              score += speakRatio * 0.25;
            }
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "FIEND_PROTECT", targetId: target.id });
        } else {
          // CHARGE mode: Hard+ pick highest red-prob, not just suspicion
          let best = null;
          let bestScore = -Infinity;
          for (const t of alivePlayers(state)) {
            if (t.id === actor.id) continue;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
            const score = hard ? (killerProb * 2 + redProb) : redProb;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "FIEND_SHOOT", targetId: target.id });
        }
        break;
      }
      case Roles.TERRORIST.id: {
        if (hard) {
          const selfThreat = actor.aiMemory?.selfThreat ?? 0;
          const alive = alivePlayers(state);
          const aliveCount = alive.length;

          // Estimate red/blue counts from AI beliefs (no cheating — use roleProbs)
          let estRedAlive = 0;
          let estBlueAlive = 0;
          for (const p of alive) {
            if (p.id === actor.id) continue; // self is red, don't count
            const rp = factionProb(actor, p.id, Faction.RED) ?? 0.5;
            estRedAlive += rp;
            estBlueAlive += (1 - rp);
          }
          const redAlive = Math.round(estRedAlive);
          const blueAlive = Math.round(estBlueAlive);

          // Trigger conditions:
          // 0. Day 1: almost never bomb (too little info, high friendly-fire risk)
          // 1. policeRevealedRed points at me → must bomb NOW (will be voted out)
          // 2. High self-threat → about to die, use bomb before it's wasted
          // 3. Late game + killers losing → desperate bomb
          // 4. Red has numbers advantage → hold bomb (don't waste a body)
          let triggerChance;
          const dayNum = state.dayNumber || 1;

          if (dayNum <= 1 && selfThreat < 0.5) {
            // Day 1: beliefs are unreliable, hold bomb (5% emergency only)
            triggerChance = 0.05;
          } else if (selfThreat > 0.7) {
            // About to be voted out — desperate bomb (terrorist appears BLUE to police,
            // so policeRevealedRed won't point at us; use selfThreat as the trigger instead)
            triggerChance = clamp(0.6 + selfThreat * 0.3, 0.7, 0.95);
          } else if (selfThreat > 0.6) {
            // High threat — likely to be voted out
            triggerChance = clamp(0.5 + selfThreat * 0.4, 0.5, 0.9);
          } else if (redAlive <= 2 && blueAlive >= 4) {
            // Red team losing — more aggressive bombing to even the odds
            triggerChance = clamp(0.3 + selfThreat * 0.5, 0.3, 0.8);
          } else if (redAlive > blueAlive) {
            // Red has advantage — hold bomb, keep the body count
            triggerChance = clamp(0.05 + selfThreat * 0.3, 0.05, 0.3);
          } else {
            // Neutral — moderate trigger based on threat
            triggerChance = clamp(0.1 + selfThreat * 0.6, 0.1, 0.7);
          }

          if (state.rng() < triggerChance) {
            const target = pickTerroristSmartTarget(state, actor);
            if (target) {
              // Final safety: don't bomb if target is very likely red (>70%)
              const targetRedProb = factionProb(actor, target.id, Faction.RED) ?? 0;
              if (targetRedProb < 0.7) {
                actions.push({ actorId: actor.id, type: "TERROR_BOMB", targetId: target.id });
              }
            }
          }
        } else {
          // Non-hard: original random behavior but target low-suspicion (blue) players
          if (state.rng() < 0.65) {
            // Pick least suspicious = most likely blue
            let best = null;
            let bestScore = Infinity;
            for (const t of alivePlayers(state)) {
              if (t.id === actor.id) continue;
              const s = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
              if (s < bestScore || (s === bestScore && state.rng() < 0.5)) {
                bestScore = s;
                best = t;
              }
            }
            if (best) actions.push({ actorId: actor.id, type: "TERROR_BOMB", targetId: best.id });
          }
        }
        break;
      }
      case Roles.COWBOY.id: {
        // Hard+: smart targeting + EV-based shoot decision + self-threat awareness
        if (hard) {
          const bestTarget = pickCowboySmartTarget(state, actor);
          if (bestTarget) {
            const confidence = actor.aiMemory?.suspicion?.[bestTarget.id] ?? 0.5;
            const dayNum = state.dayNumber || 1;

            // Base threshold: starts 0.65 day 1, drops 0.07/day, floor 0.35
            let threshold = clamp(0.65 - (dayNum - 1) * 0.07, 0.35, 0.65);

            // Late game: more info available, lower threshold
            if (getGamePhase(state) === "late") threshold = clamp(threshold - 0.1, 0.3, 0.65);

            // Self-threat awareness: if cowboy is in danger, shoot more aggressively
            const selfSusp = actor.aiMemory?.suspicion?.[actor.id] ?? 0;
            // Count how many players have voted for us recently
            let votesAgainstMe = 0;
            for (const round of (state.history?.votes || [])) {
              for (const entry of (round.order || [])) {
                if (entry.targetId === actor.id) votesAgainstMe++;
              }
            }
            const underPressure = selfSusp > 0.5 || votesAgainstMe >= 2;
            // About to die → lower threshold significantly (use it or lose it)
            if (underPressure) threshold = clamp(threshold - 0.15, 0.25, 0.65);

            // Backfire risk assessment: when blue outnumbers red among alive,
            // backfire's random kill is more likely to hit a blue ally
            const alive = alivePlayers(state);
            const aliveCount = alive.length;
            const blueAlive = alive.filter((p) => p.id !== actor.id && p.id !== bestTarget.id)
              .reduce((sum, p) => sum + (factionProb(actor, p.id, Faction.BLUE) ?? 0.5), 0);
            const othersCount = Math.max(1, aliveCount - 2); // exclude self and target
            const blueRatio = blueAlive / othersCount;
            // More blue bystanders = backfire hurts blue more = raise threshold
            if (blueRatio > 0.6 && !underPressure) threshold = clamp(threshold + 0.06, 0.3, 0.75);
            if (aliveCount <= 5 && !underPressure) threshold = clamp(threshold + 0.1, 0.3, 0.75);

            // Police confirmed red: override threshold — shoot with near certainty
            if ((state.policePublicRevealedRed ?? null) === bestTarget.id) threshold = 0.15;

            // EV check: P(hit red) × value - P(backfire) × cost
            // 2/6 kill, 3/6 nothing, 1/6 wild (target + bystander + self die)
            // Only skip if EV is clearly negative (confidence is very low)
            const hitChance = 2 / 6;
            const backfireChance = 1 / 6;
            const ev = confidence * hitChance - (1 - confidence) * backfireChance * blueRatio;
            // If EV is positive and confidence meets threshold, shoot
            if (confidence >= threshold || (ev > 0.05 && confidence >= 0.3)) {
              actions.push({ actorId: actor.id, type: "COWBOY_GAMBLE", targetId: bestTarget.id });
            }
          }
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "COWBOY_GAMBLE", targetId: target.id });
        }
        break;
      }
      case Roles.KIDNAPPER.id: {
        // Hard+: kidnap high-value blue targets to disable them (doctor, police, agent)
        // instead of targeting high-suspicion (which is red-leaning = your own team)
        let best = null;
        let bestScore = -Infinity;
        for (const t of shuffled(alivePlayers(state), state.rng)) {
          if (t.id === actor.id) continue;
          // Avoid kidnapping likely red/green allies (kidnapper can't see identities)
          if (actor.lastKidnapTarget !== null && t.id === actor.lastKidnapTarget) continue;
          let score;
          if (hard) {
            ensureAdvancedMemory(actor);
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
            const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
            const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
            // Core: prefer confirmed blue targets, strongly penalize red probability
            score = blueProb - redProb * 2.0
              + doctorProb * 0.8 + policeProb * 0.6 + agentProb * 0.4;
          } else {
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            score = redProb + (actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
          }
          if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
            bestScore = score;
            best = t;
          }
        }
        const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "KIDNAP", targetId: target.id });
        break;
      }
      case Roles.ZOMBIE.id: {
        // Hard+: prioritize finishing pending conversions (bite count tracking)
        // and avoid likely-protected targets
        if (hard) {
          ensureAdvancedMemory(actor);
          // Track own bite history (zombie's private knowledge)
          if (!actor.aiMemory.biteTargets) actor.aiMemory.biteTargets = {};

          // Count how many conversions have happened (from public log)
          const conversionCount = (state.publicLog || []).filter(
            (e) => typeof e === "string" && e.includes("turned into a zombie")
          ).length;
          // All zombies on the field: original (1) + conversions
          // The more zombies exist, the more cautious we must be about biting
          const estimatedZombieCount = 1 + conversionCount;

          // Track own bite targets — hard skip anyone we've bitten before
          const myBittenTargets = new Set(
            Object.keys(actor.aiMemory.biteTargets).map(Number).filter((id) => actor.aiMemory.biteTargets[id] > 0)
          );
          // Parse dead zombie last words for bite target reveals ("I bit X, Y...")
          // This helps converted zombies avoid re-biting targets other zombies already bit
          for (const line of (state.dayChat || [])) {
            const stripped = line.startsWith("[LAST] ") ? line.slice(7) : null;
            if (!stripped || !stripped.includes("I bit ")) continue;
            for (const p of state.players) {
              if (p?.alive && stripped.includes(p.name)) {
                myBittenTargets.add(p.id);
              }
            }
          }
          // Also check publicLog for last words with bite reveals
          for (const entry of (state.publicLog || [])) {
            if (typeof entry !== "string" || !entry.includes("I bit ")) continue;
            for (const p of state.players) {
              if (p?.alive && entry.includes(p.name)) {
                myBittenTargets.add(p.id);
              }
            }
          }

          let best = null;
          let bestScore = -Infinity;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id) continue;

            // Hard skip: anyone we've bitten before (likely already converted)
            if (myBittenTargets.has(t.id)) continue;

            // Avoid likely zombies — biting a zombie kills the biter
            const zombieProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.ZOMBIE.id] ?? 0;
            // Dynamic threshold: as more zombies exist, more players could be zombies
            // Start at 0.3, lower as zombie count grows (more cautious)
            const zombieThreshold = Math.max(0.15, 0.3 - estimatedZombieCount * 0.03);
            if (zombieProb > zombieThreshold) continue;

            let score = 1 - zombieProb; // prefer non-zombies
            // Penalty: likely protected by agent/doctor — bite would be wasted
            const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
            const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
            score -= (doctorProb + agentProb) * 0.4;
            // Bonus: prefer non-red targets (more useful as zombie allies than red)
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            score += blueProb * 0.3;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickZombieTarget(state, actor);
          if (target) {
            actions.push({ actorId: actor.id, type: "ZOMBIE_BITE", targetId: target.id });
            // Record bite in private memory for future targeting
            actor.aiMemory.biteTargets[target.id] = (actor.aiMemory.biteTargets[target.id] || 0) + 1;
          }
        } else {
          const target = pickZombieTarget(state, actor);
          if (target) actions.push({ actorId: actor.id, type: "ZOMBIE_BITE", targetId: target.id });
        }
        break;
      }
      case Roles.RIOT_POLICE.id: {
        if (state.usage.riotGrenades < (Roles.RIOT_POLICE.maxGrenades || 0)) {
          if (hard) {
            // Hard+: multi-role scoring + arson urgency + self-threat awareness
            const remaining = (Roles.RIOT_POLICE.maxGrenades || 0) - state.usage.riotGrenades;
            const dayNum = state.dayNumber || 1;
            const counts = factionCounts(state);
            const bluePressure = counts.red >= counts.blue;
            const selfThreat = actor.aiMemory?.selfThreat ?? 0;

            // Detect arson marks (public info — "Someone splashed fuel on X")
            let arsonMarkCount = 0;
            for (const p of state.players) {
              if (p.alive && p.status.arsonMarked) arsonMarkCount++;
            }

            let best = null;
            let bestScore = -Infinity;

            for (const t of alivePlayers(state)) {
              if (t.id === actor.id) continue;
              const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
              const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
              const sniperProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.SNIPER.id] ?? 0;
              const terroristProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.TERRORIST.id] ?? 0;
              const arsonistProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.ARSONIST.id] ?? 0;

              // Score by action-blocking value: killer > sniper > arsonist > terrorist
              let score = killerProb * 2.0 + sniperProb * 1.8 + arsonistProb * 1.2 + terroristProb * 1.0;
              score += redProb * 0.3;

              // ARSON URGENCY: if marks exist, blocking arsonist ignition is critical
              if (arsonMarkCount > 0) {
                score += arsonistProb * arsonMarkCount * 0.5;
              }

              // Police-confirmed red: very high priority
              if ((state.policePublicRevealedRed ?? null) === t.id) score += 1.0;

              // Late-game urgency
              if (bluePressure && dayNum >= 3) score *= 1.2;

              score += (state.rng() - 0.5) * 0.1;
              if (score > bestScore) { bestScore = score; best = t; }
            }

            // Dynamic grenade conservation + self-threat
            let confThreshold;
            if (dayNum <= 1) confThreshold = 0.6;
            else if (selfThreat > 0.6) confThreshold = 0.2;
            else if (remaining <= 1) confThreshold = 0.25;
            else if (bluePressure) confThreshold = 0.3;
            else confThreshold = 0.45;

            if (best && bestScore >= confThreshold) {
              actions.push({ actorId: actor.id, type: "RIOT_SMOKE", targetId: best.id });
            }
          } else {
            const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "RIOT_SMOKE", targetId: target.id });
          }
        }
        break;
      }
      case Roles.ARSONIST.id: {
        const marked = state.players.filter((p) => p.status.arsonMarked && p.alive).length;
        if (hard) {
          // Hard+: be patient — mark more before igniting for bigger impact
          // Ignite when 3+ marked, or 2+ if self-threat is high (about to die)
          const selfThreat = actor.aiMemory?.selfThreat ?? 0;
          const igniteThreshold = selfThreat > 0.5 ? 2 : 3;
          if (marked >= igniteThreshold) {
            actions.push({ actorId: actor.id, type: "ARSON_IGNITE" });
          } else if (state.usage.arsonMarks < (Roles.ARSONIST.maxMarks || 4)) {
            // Mark high-value blue targets (police, doctor, agent)
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              if (t.id === actor.id || t.role === Roles.KILLER.id) continue;
              if (t.status.arsonMarked) continue; // already marked
              const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
              const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
              const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
              const score = blueProb + policeProb * 0.5 + doctorProb * 0.4;
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id && !t.status.arsonMarked);
            if (target) actions.push({ actorId: actor.id, type: "ARSON_MARK", targetId: target.id });
          } else {
            // All marks used, ignite whatever we have
            if (marked > 0) actions.push({ actorId: actor.id, type: "ARSON_IGNITE" });
          }
        } else {
          const doIgnite = marked >= 2 || state.rng() > 0.65;
          if (doIgnite) {
            actions.push({ actorId: actor.id, type: "ARSON_IGNITE" });
          } else {
            const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "ARSON_MARK", targetId: target.id });
          }
        }
        break;
      }
      case Roles.VINE_DEMON.id: {
        // Hard+: seed targets most likely to be touched by blue actions
        // (police investigation target, agent protection target, etc.)
        if (hard) {
          let best = null;
          let bestScore = -Infinity;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id || t.role === Roles.KILLER.id) continue;
            // High suspicion targets are likely to be investigated by police
            const suspicion = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
            // High blue prob targets are likely to be protected by agent
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            // Best seed target: someone both suspicious AND likely blue (police will investigate)
            const score = suspicion * 0.6 + blueProb * 0.4;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "VINE_SEED", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "VINE_SEED", targetId: target.id });
        }
        break;
      }
      case Roles.NIGHTMARE_DEMON.id: {
        // Hard+: prioritize unknown roles for intel, avoid re-scouting known roles
        // Attack civilians/brats for kills, attack unknowns for role info
        if (hard) {
          let best = null;
          let bestScore = -Infinity;
          const knownRoles = actor.aiMemory?.grudgeKnownRole || {};
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id || t.role === Roles.KILLER.id) continue;
            const civProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.CIVILIAN.id] ?? 0;
            const bratProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.BRAT.id] ?? 0;
            // Civilians/brats die instantly — high value kill
            let score = (civProb + bratProb) * 1.5;
            // Unknown role intel is also valuable
            const maxRoleProb = Math.max(...Object.values(actor.aiMemory?.roleProbs?.[t.id] || {}), 0);
            const uncertainty = 1 - maxRoleProb; // high uncertainty = more info gain
            score += uncertainty * 0.4;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "NIGHTMARE_ATTACK", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "NIGHTMARE_ATTACK", targetId: target.id });
        }
        break;
      }
      case Roles.EXORCIST.id: {
        if ((actor.exorcistMistakes || 0) >= 3) break;
        const maxChains = Math.max(0, actor.maxChains ?? Roles.EXORCIST.maxChain);
        if (maxChains <= 0) break;
        if (hard) {
          const mistakes = actor.exorcistMistakes || 0;
          const dayNum = state.dayNumber || 1;
          const exPhase = getGamePhase(state);

          // Pre-compute behavioral signals
          const exChatBehavior = analyzeChatBehavior(state);
          const exMaxSpoken = Math.max(1, ...Object.values(exChatBehavior.speakCount || {}));
          const exVotePatterns = analyzeVotingPatterns(state);

          // Confirmed reds (dead + revealed)
          const exKnownReds = new Set();
          if ((state.policePublicRevealedRed ?? null) !== null) exKnownReds.add((state.policePublicRevealedRed ?? null));
          for (const p of state.players) {
            if (!p.alive && p.faction === Faction.RED) exKnownReds.add(p.id);
          }

          // Saved last night = confirmed blue
          const exSavedIds = new Set(state.lastNightSavedIds || []);

          // Arson-marked = confirmed blue
          const exArsonIds = new Set();
          for (const p of state.players) {
            if (p.alive && p.status.arsonMarked) exArsonIds.add(p.id);
          }

          // Accused by known reds = likely blue
          const exAccusedByRed = new Set();
          for (const p of state.players) {
            if (!p.aiMemory?.chatMemory) continue;
            for (const m of p.aiMemory.chatMemory) {
              if (m.accusedId === null) continue;
              const sp = getPlayer(state, m.speakerId);
              if (!sp) continue;
              if ((!sp.alive && sp.faction === Faction.RED) || publicPoliceConfirmed(state, actor)?.[m.speakerId] === true) {
                exAccusedByRed.add(m.accusedId);
              }
            }
          }

          // Purified by purifier = suspected red by another blue (public log signal)
          const exPurifiedIds = new Set();
          for (const entry of state.publicLog || []) {
            if (typeof entry === "string" && entry.includes("cleansed")) {
              for (const p of state.players) {
                if (p.alive && entry.includes(p.name)) exPurifiedIds.add(p.id);
              }
            }
          }

          // Red execution opposers
          const exRedOpposers = {};
          const exVoteExecReds = state.players.filter((p) => !p.alive && p.deathCause === "VOTE_EXECUTION" && p.faction === Faction.RED);
          for (const dead of exVoteExecReds) {
            for (const round of (state.history?.votes || [])) {
              if (!round.order || !round.tally) continue;
              const tv = round.tally[dead.id] || 0;
              const mv = Math.max(0, ...Object.values(round.tally));
              if (tv > 0 && tv === mv) {
                for (const entry of round.order) {
                  if (entry.targetId !== dead.id) {
                    exRedOpposers[entry.actorId] = (exRedOpposers[entry.actorId] || 0) + 1;
                  }
                }
              }
            }
          }

          // Score all candidates
          const candidates = shuffled(alivePlayers(state), state.rng)
            .filter((t) => t.id !== actor.id)
            .map((t) => {
              const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
              const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
              const sniperProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.SNIPER?.id] ?? 0;
              const necroProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.NECROMANCER?.id] ?? 0;
              const nightmareProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.NIGHTMARE_DEMON?.id] ?? 0;

              // Base: red probability
              let score = redProb;

              // Bonus: dangerous red roles (exorcist wants to eliminate threats)
              score += killerProb * 1.5;
              score += sniperProb * 0.8;
              score += necroProb * 0.6;
              score += nightmareProb * 0.5;

              // Bonus: police revealed this target as red — guaranteed hit
              if ((state.policePublicRevealedRed ?? null) === t.id) score += 2.0;

              // Bonus: voted with known reds
              if (exVotePatterns) {
                let redAllyScore = 0;
                for (const redId of exKnownReds) {
                  redAllyScore += exVotePatterns.votedTogether[t.id]?.[redId] || 0;
                }
                score += Math.min(redAllyScore * 0.08, 0.2);
              }

              // Bonus: defended known reds
              const chatMem = actor.aiMemory?.chatMemory || [];
              for (const m of chatMem) {
                if (m.speakerId === t.id && exKnownReds.has(m.defendedId)) {
                  score += 0.12;
                  break;
                }
              }

              // Bonus: red execution opposers
              if (exRedOpposers[t.id]) {
                score += Math.min(exRedOpposers[t.id] * 0.1, 0.25);
              }

              // Bonus: quiet + red-leaning
              const speakRatio = (exChatBehavior.speakCount[t.id] || 0) / exMaxSpoken;
              if (speakRatio < 0.2 && redProb > 0.4) score += 0.1;

              // Bonus: purified by purifier = another blue suspected them
              // Public log: "Someone cleansed X" — observable information
              if (exPurifiedIds.has(t.id)) score += 0.2;

              // Penalty: confirmed blue signals — hitting blue is catastrophic
              if (exSavedIds.has(t.id)) score -= 1.5;
              if (exArsonIds.has(t.id)) score -= 1.0;
              if (exAccusedByRed.has(t.id)) score -= 0.5;

              return { player: t, redProb, score };
            })
            .sort((a, b) => b.score - a.score);

          // Graduated confidence thresholds: each subsequent pick requires MORE confidence
          // because a miss stops the chain AND permanently costs a chain slot
          // Base: 0.4 / 0.5 / 0.6 for 1st / 2nd / 3rd pick
          // + mistake penalty: each past mistake adds 0.08
          // Killing a red is a FREE KILL (no vote cost), so moderate confidence is acceptable
          const mistakePenalty = mistakes * 0.08;
          const thresholds = [
            clamp(0.4 + mistakePenalty, 0.4, 0.8),
            clamp(0.5 + mistakePenalty, 0.5, 0.85),
            clamp(0.6 + mistakePenalty, 0.6, 0.9),
          ];
          // Late game: lower thresholds (more info + more urgency)
          if (exPhase === "late") {
            for (let i = 0; i < thresholds.length; i++) {
              thresholds[i] = clamp(thresholds[i] - 0.1, 0.3, 0.85);
            }
          }

          // Day 1: max 2 picks (limited info but still worth trying top targets)
          const maxPicksThisNight = dayNum <= 1 ? Math.min(2, maxChains) : maxChains;

          const picks = [];
          for (const c of candidates) {
            if (picks.length >= maxPicksThisNight) break;
            const threshold = thresholds[picks.length] ?? 0.9;
            // Police revealed red: always strike (override threshold)
            if ((state.policePublicRevealedRed ?? null) === c.player.id) {
              picks.push(c.player);
              continue;
            }
            // Allow score to also trigger strike: behavioral signals matter
            // Score threshold ~2× redProb threshold (score includes redProb + role weights + signals)
            if (c.redProb >= threshold || c.score >= threshold * 2.2) {
              picks.push(c.player);
            }
          }
          // Fallback: always strike at least 1 target if possible
          // Exorcist with unused chains is wasted potential — even moderate confidence
          // is worth attempting since killing a red is a free elimination
          if (picks.length === 0 && candidates.length > 0) {
            const top = candidates[0];
            if (top.redProb > 0.28 || top.score > 0.8 || (state.policePublicRevealedRed ?? null) === top.player.id) {
              picks.push(top.player);
            }
          }
          for (const t of picks) {
            actions.push({ actorId: actor.id, type: "EXORCIST_STRIKE", targetId: t.id });
          }
        } else {
          const ordered = shuffled(alivePlayers(state), state.rng)
            .filter((t) => t.id !== actor.id)
            .sort((a, b) => {
              const sa = actor.aiMemory?.suspicion?.[a.id] ?? 0.5;
              const sb = actor.aiMemory?.suspicion?.[b.id] ?? 0.5;
              return sb - sa;
            });
          const picks = ordered.slice(0, maxChains);
          for (const t of picks) {
            actions.push({ actorId: actor.id, type: "EXORCIST_STRIKE", targetId: t.id });
          }
        }
        break;
      }
      case Roles.NECROMANCER.id: {
        if (actor.souls >= 2) {
          if (hard) {
            // Hard+: save souls for 3+ when possible (instant kill, harder to block)
            // Only use at 2 if self-threat is high (about to die, use it now)
            const selfThreat = actor.aiMemory?.selfThreat ?? 0;
            const useAt2 = selfThreat > 0.4 || state.rng() < 0.25;
            if (actor.souls >= 3 || useAt2) {
              // Target high-value blue: police > doctor > agent
              let best = null;
              let bestScore = -Infinity;
              for (const t of alivePlayers(state)) {
                if (t.id === actor.id || t.role === Roles.KILLER.id) continue;
                const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
                const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
                const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
                const score = policeProb * 0.5 + doctorProb * 0.4 + blueProb;
                if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                  bestScore = score;
                  best = t;
                }
              }
              const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
              if (target) actions.push({ actorId: actor.id, type: "NECROMANCER_CURSE", targetId: target.id });
            }
            // else: hold souls, wait for 3+
          } else {
            const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "NECROMANCER_CURSE", targetId: target.id });
          }
        }
        break;
      }
      case Roles.PURIFIER.id: {
        if (hard) {
          // Hard+: prioritize cleansing necromancers (wipe souls) and high-threat red
          let best = null;
          let bestScore = -Infinity;
          for (const t of alivePlayers(state)) {
            if (t.id === actor.id) continue;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const necroProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.NECROMANCER.id] ?? 0;
            const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
            const nightmareProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.NIGHTMARE_DEMON?.id] ?? 0;
            let score = killerProb * 1.5 + redProb + necroProb * 1.0;
            // Nightmare demon: blocking their civilian kills is high value
            score += nightmareProb * 0.8;
            // Bonus: revealed red — cleanse to block their night action
            if ((state.policePublicRevealedRed ?? null) === t.id) score += 0.6;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "PURIFY", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "PURIFY", targetId: target.id });
        }
        break;
      }
      case Roles.GRUDGE_BEAST.id: {
        const leaderChoice = sharedGrudgeTarget && sharedGrudgeTarget.alive ? sharedGrudgeTarget : null;
        if (state.grudgeState.berserk) {
          // Berserk: vote to kill
          if (hard && !leaderChoice) {
            // Hard+: prioritize killing the faction that triggered berserk
            // If killers triggered it, hunt killers; if police triggered it, hunt police
            const triggerFaction = state.grudgeState.triggerFaction;
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              if (t.role === Roles.GRUDGE_BEAST.id) continue;
              let score = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
              if (triggerFaction === Faction.RED) {
                // Hunt killers — boost killer probability
                const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
                score += killerProb * 1.0;
              } else if (triggerFaction === Faction.BLUE) {
                // Hunt police — boost police probability
                const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
                score += policeProb * 1.0;
              }
              // Also factor in chat activity — active talkers are more threatening
              const chatInfo = analyzeChatBehavior(state);
              const maxSpoken = Math.max(1, ...Object.values(chatInfo.speakCount || {}));
              const speakRatio = (chatInfo.speakCount[t.id] || 0) / maxSpoken;
              score += speakRatio * 0.2;
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            const target = best || pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.GRUDGE_BEAST.id);
            if (target) actions.push({ actorId: actor.id, type: "GRUDGE_KILL_VOTE", targetId: target.id });
          } else {
            const target =
              leaderChoice ||
              pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.GRUDGE_BEAST.id);
            if (target) actions.push({ actorId: actor.id, type: "GRUDGE_KILL_VOTE", targetId: target.id });
          }
        } else {
          // Judging mode: pick who to judge
          if (hard && !leaderChoice) {
            // Hard+: strategically judge RED targets (reveals info to police, safe for grudge)
            // Avoid judging civilians (random grudge beast dies!)
            // Prefer high red-prob targets (judging red = info to police, no penalty)
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              if (t.id === actor.id || t.role === Roles.GRUDGE_BEAST.id) continue;
              const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
              const civProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.CIVILIAN.id] ?? 0;
              // Judging red = safe + useful; judging civilian = grudge beast dies
              let score = redProb * 1.5 - civProb * 1.0;
              // Blue non-civilian is medium risk (info goes to killers)
              const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
              score -= blueProb * 0.3;
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "GRUDGE_JUDGE", targetId: target.id });
          } else {
            const target =
              leaderChoice ||
              pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
            if (target) actions.push({ actorId: actor.id, type: "GRUDGE_JUDGE", targetId: target.id });
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return actions;
}
