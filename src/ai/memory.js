import { alivePlayers, getPlayer } from "../state.js";
import { Roles, Faction, Theme, roleMeta } from "../roles.js";
import { clamp, isHard, rolePriorCounts, getGamePhase, ensureAdvancedMemory } from "./utils.js";
import { analyzeVotingPatterns, analyzeChatBehavior, computeSelfThreat, publicRevealedRed, applyDeductionChains, factionProb } from "./analysis.js";

// ─── Enhanced Belief System ────────────────────────────────────────────────

export function ensureBeliefs(state) {
  const living = alivePlayers(state).map((p) => p.id);
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;
  const hard = isHard(state);
  // revealedRed is set per-player inside the loop via publicRevealedRed()
  const lastVoteHist = state.history?.votes?.[state.history.votes.length - 1] || null;
  const mentionMax = lastVoteHist?.mentions ? Math.max(1, ...Object.values(lastVoteHist.mentions)) : 1;
  const flipSet = new Set(lastVoteHist?.flips || []);
  const firstVoterId = lastVoteHist?.order?.[0]?.actorId ?? null;
  const lastVoterId = lastVoteHist?.order?.[lastVoteHist.order.length - 1]?.actorId ?? null;
  const lastTally = lastVoteHist?.tally || {};
  const rolePriors = rolePriorCounts(state.theme || Theme.GOOD_VS_EVIL.id);
  const allRoles = Object.keys(rolePriors);
  const totalPrior = Math.max(1, Object.values(rolePriors).reduce((a, b) => a + b, 0));

  // Hard+ behavioral analysis
  const votePatterns = hard ? analyzeVotingPatterns(state) : null;
  const chatBehavior = hard ? analyzeChatBehavior(state) : null;

  // Identify dead players and their death correlations
  const recentDeaths = state.players.filter((p) => !p.alive && p.deathCause);

  for (const p of alivePlayers(state)) {
    if (p.isHuman) continue;
    ensureAdvancedMemory(p);
    const revealedRed = publicRevealedRed(state, p);

    // Update self-threat
    if (hard) {
      p.aiMemory.selfThreat = computeSelfThreat(state, p);
    }

    // ── Improvement 1: Cross-round chat memory tracking ──
    if (hard) {
      const dayNum = state.dayNumber || 1;
      const alreadyParsedThisDay = p.aiMemory.chatMemory.some((m) => m.day === dayNum);
      if (!alreadyParsedThisDay) {
        const chats = state.dayChat || [];
        for (let line of chats) {
          // Skip vote-phase tagged lines — they're post-decision, not new evidence
          if (line.startsWith("[VOTE] ")) continue;
          // Strip [LAST] prefix — last words are valid evidence but from dead speakers
          if (line.startsWith("[LAST] ")) line = line.slice(7);
          for (const sp of state.players) {
            if (!sp || !line.startsWith(sp.name + ":")) continue;
            const entry = { day: dayNum, speakerId: sp.id, mentionedIds: [], accusedId: null, defendedId: null };
            for (const other of state.players) {
              if (!other || other.id === sp.id) continue;
              if (line.includes(other.name)) {
                entry.mentionedIds.push(other.id);
                // Detect accuse/defend keywords in both English (before ||) and Chinese (after ||)
                const enPart = line.split("||")[0] || line;
                const lowerEn = enPart.toLowerCase();
                const zhPart = line.includes("||") ? line.split("||")[1] : line;
                if (
                  lowerEn.includes("suspicious") || lowerEn.includes("killer") || lowerEn.includes("vote") || lowerEn.includes("doesn't add up") || lowerEn.includes("acting weird") || lowerEn.includes("don't trust") ||
                  zhPart.includes("可疑") || zhPart.includes("殺手") || zhPart.includes("投") || zhPart.includes("矛盾") || zhPart.includes("奇怪") || zhPart.includes("不信任") || zhPart.includes("有問題") || zhPart.includes("不對勁") || zhPart.includes("懷疑")
                ) {
                  entry.accusedId = other.id;
                }
                if (
                  lowerEn.includes("on our side") || lowerEn.includes("seems fine") || lowerEn.includes("leave") || lowerEn.includes("helpful") || lowerEn.includes("clean") || lowerEn.includes("innocent") || lowerEn.includes("confirmed blue") || lowerEn.includes("protect") || lowerEn.includes("don't vote") || lowerEn.includes("wrong about") || lowerEn.includes("ganging up") || lowerEn.includes("no proof") ||
                  zhPart.includes("沒問題") || zhPart.includes("清白") || zhPart.includes("無辜") || zhPart.includes("好人") || zhPart.includes("保護") || zhPart.includes("別投") || zhPart.includes("不要投") || zhPart.includes("站同邊") || zhPart.includes("冤枉") || zhPart.includes("沒證據") || zhPart.includes("相信")
                ) {
                  entry.defendedId = other.id;
                }
              }
            }
            p.aiMemory.chatMemory.push(entry);
            break; // only one speaker per line
          }
        }
      }

      // ── Parse faction chat from human teammates as reasoning input ──
      const factionChat =
        p.role === Roles.KILLER.id ? (state.killerChat || []) :
        p.role === Roles.POLICE.id ? (state.policeChat || []) :
        p.role === Roles.GRUDGE_BEAST.id ? (state.grudgeChat || []) : [];
      for (const line of factionChat) {
        // Skip lines already parsed (AI-generated lines are usually in dayChat too)
        let speakerFound = false;
        for (const sp of state.players) {
          if (!sp || !line.startsWith(sp.name + ":") || !sp.isHuman) continue;
          speakerFound = true;
          const entry = { day: dayNum, speakerId: sp.id, mentionedIds: [], accusedId: null, defendedId: null, source: "faction" };
          for (const other of state.players) {
            if (!other || other.id === sp.id) continue;
            if (line.includes(other.name)) {
              entry.mentionedIds.push(other.id);
              const enPart = line.split("||")[0] || line;
              const lowerEn = enPart.toLowerCase();
              const zhPart = line.includes("||") ? line.split("||")[1] : line;
              if (
                lowerEn.includes("target") || lowerEn.includes("kill") || lowerEn.includes("suspicious") || lowerEn.includes("vote") ||
                zhPart.includes("目標") || zhPart.includes("殺") || zhPart.includes("可疑") || zhPart.includes("投")
              ) {
                entry.accusedId = other.id;
              }
              if (
                lowerEn.includes("protect") || lowerEn.includes("safe") || lowerEn.includes("trust") || lowerEn.includes("skip") ||
                zhPart.includes("保護") || zhPart.includes("安全") || zhPart.includes("相信") || zhPart.includes("跳過") || zhPart.includes("別動")
              ) {
                entry.defendedId = other.id;
              }
            }
          }
          if (entry.mentionedIds.length > 0) p.aiMemory.chatMemory.push(entry);
          break;
        }
      }
    }

    // ── Improvement 4: Emotion system ──
    if (hard) {
      const lastVotes = state.history?.votes?.[state.history.votes.length - 1];
      const myVotesReceived = lastVotes?.tally?.[p.id] || 0;
      const aliveCount = alivePlayers(state).length || 1;
      const voteRatio = myVotesReceived / aliveCount;
      const selfThreat = p.aiMemory.selfThreat || 0;
      // Was saved by doctor? Check lastNightSavedIds for this player
      const wasSaved = (state.lastNightSavedIds || []).includes(p.id);

      if (wasSaved) {
        p.aiMemory.emotion = "grateful";
      } else if (voteRatio > 0.3) {
        p.aiMemory.emotion = state.rng() < 0.5 ? "angry" : "defensive";
      } else if (selfThreat > 0.5) {
        p.aiMemory.emotion = "anxious";
      } else {
        p.aiMemory.emotion = "neutral";
      }
    }

    for (const targetId of living) {
      if (targetId === p.id) continue;
      // 初始化或衰減到先驗
      if (!p.aiMemory.roleProbs[targetId]) p.aiMemory.roleProbs[targetId] = {};
      const decay = 0.9;
      for (const role of allRoles) {
        const prior = (rolePriors[role] || 0) / totalPrior;
        const prev = p.aiMemory.roleProbs[targetId][role] ?? prior;
        const blended = prior * (1 - decay) + prev * decay;
        p.aiMemory.roleProbs[targetId][role] = blended;
      }
      // likelihood bumps
      let redBoost = 0;
      let blueBoost = 0;
      if (lastVoteHist?.mentions && lastVoteHist.mentions[targetId]) {
        const weight = (lastVoteHist.mentions[targetId] || 0) / mentionMax;
        redBoost += 0.05 * weight * diffScale;
      }
      if (flipSet.has(targetId)) redBoost += 0.15 * diffScale;
      if (targetId === lastVoterId) redBoost += 0.15 * diffScale;
      if (targetId === firstVoterId) redBoost -= 0.05 * diffScale;
      const tallyScore = lastTally[targetId] || 0;
      const maxTally = Math.max(1, ...Object.values(lastTally || {}));
      if (tallyScore && maxTally > 0) {
        const bandwagon = tallyScore / maxTally;
        redBoost += 0.08 * bandwagon * diffScale;
      }
      if (revealedRed && targetId === revealedRed && p.faction === Faction.BLUE) {
        redBoost += 0.6 * diffScale;
      }

      // ── Hard+ behavioral signals (no cheating, purely observable) ──

      if (hard && votePatterns) {
        // Signal 1: Vote consistency — someone who always votes the same person is suspicious
        const targetVoteGraph = votePatterns.voteGraph[targetId];
        if (targetVoteGraph && votePatterns.rounds >= 2) {
          const targets = Object.keys(targetVoteGraph);
          const totalVotes = Object.values(targetVoteGraph).reduce((a, b) => a + b, 0);
          // If they always vote the same person, slight blue boost (consistent = less suspicious)
          if (targets.length === 1 && totalVotes >= 2) {
            blueBoost += 0.03 * diffScale;
          }
        }

        // Signal 2: Mutual voting pairs — two people never voting each other = potential allies
        const togetherCount = votePatterns.votedTogether[targetId]?.[p.id] || 0;
        if (votePatterns.rounds >= 2 && togetherCount >= 2) {
          // They vote with me a lot — could be same faction
          blueBoost += 0.05 * diffScale;
        }

        // Signal 3: Someone who voted for a player who turned out innocent (died blue) — less reliable
        for (const dead of recentDeaths) {
          if (dead.faction === Faction.BLUE && dead.deathCause === "VOTE_EXECUTION") {
            const votedForInnocent = votePatterns.voteGraph[targetId]?.[dead.id] || 0;
            if (votedForInnocent > 0) {
              redBoost += 0.1 * diffScale;
            }
          }
          // Someone who defended a dead red player — suspicious
          if (dead.faction === Faction.RED) {
            const defenseCount = p.aiMemory.defenseHistory[targetId]?.[dead.id] || 0;
            if (defenseCount > 0) {
              redBoost += 0.12 * diffScale;
            }
          }
        }
      }

      if (hard && chatBehavior) {
        // Signal 4: Silence analysis — people who never speak are slightly more suspicious
        const spoken = chatBehavior.speakCount[targetId] || 0;
        const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount));
        if (spoken === 0 && maxSpoken > 0) {
          redBoost += 0.04 * diffScale;
        }
      }

      // ── Improvement 2: Statement contradiction detection ──
      if (hard && p.aiMemory.chatMemory.length > 0) {
        const targetEntries = p.aiMemory.chatMemory.filter((m) => m.speakerId === targetId);
        const accusedSet = new Set();
        const defendedSet = new Set();
        for (const entry of targetEntries) {
          if (entry.accusedId !== null) accusedSet.add(entry.accusedId + ":" + entry.day);
          if (entry.defendedId !== null) defendedSet.add(entry.defendedId + ":" + entry.day);
        }
        // Check for contradiction: accused X in one round, defended X in another
        for (const entry of targetEntries) {
          if (entry.accusedId !== null) {
            const hasDefended = targetEntries.some(
              (e) => e.defendedId === entry.accusedId && e.day !== entry.day
            );
            if (hasDefended) {
              redBoost += 0.08 * diffScale; // contradiction signal
            }
          }
        }
      }

      // ── Improvement 3: Death attribution analysis ──
      if (hard && p.aiMemory.chatMemory.length > 0) {
        for (const dead of recentDeaths) {
          if (dead.faction === Faction.BLUE && dead.deathCause !== "VOTE_EXECUTION") {
            // Night-killed blue: who accused them most in chat?
            const prevDayEntries = p.aiMemory.chatMemory.filter(
              (m) => m.accusedId === dead.id && m.speakerId === targetId
            );
            // Someone who aggressively pushed against the victim is slightly more likely blue (genuine suspicion)
            if (prevDayEntries.length > 0) {
              blueBoost += 0.03 * prevDayEntries.length * diffScale;
            }
            // Check if target deflected attention away from the victim (mentioned others, not victim)
            const targetDayEntries = p.aiMemory.chatMemory.filter(
              (m) => m.speakerId === targetId && m.day === (dead.deathDay || state.dayNumber - 1)
            );
            const mentionedVictim = targetDayEntries.some(
              (m) => m.mentionedIds.includes(dead.id)
            );
            const totalEntries = targetDayEntries.length;
            if (totalEntries > 0 && !mentionedVictim) {
              // Spoke but never mentioned the eventual victim — mildly suspicious
              redBoost += 0.03 * diffScale;
            }
          }
        }
      }

      // 不使用真實陣營偏置，避免作弊。
      // 應用到角色分布
      for (const role of allRoles) {
        const meta = roleMeta(role);
        let mult = 1;
        if (meta.faction === Faction.RED) mult += redBoost;
        if (meta.faction === Faction.BLUE) mult += blueBoost;
        p.aiMemory.roleProbs[targetId][role] = clamp(p.aiMemory.roleProbs[targetId][role] * Math.max(0.01, mult), 0.0001, 1);
      }
      // normalize
      const sum = Object.values(p.aiMemory.roleProbs[targetId]).reduce((a, b) => a + b, 0) || 1;
      for (const role of allRoles) {
        p.aiMemory.roleProbs[targetId][role] = p.aiMemory.roleProbs[targetId][role] / sum;
      }
      // 對舊邏輯的兼容：用紅方機率總和作為 suspicion。
      const redProb = Object.entries(p.aiMemory.roleProbs[targetId]).reduce(
        (acc, [r, prob]) => acc + (roleMeta(r).faction === Faction.RED ? prob : 0),
        0
      );
      p.aiMemory.suspicion[targetId] = clamp(redProb, 0.01, 0.99);
    }

    // ── Advanced: Night result inference ──
    if (hard) {
      const dayNum = state.dayNumber || 1;
      const lastInferDay = p.aiMemory.nightResultInference.length > 0
        ? p.aiMemory.nightResultInference[p.aiMemory.nightResultInference.length - 1].day
        : 0;
      if (dayNum > lastInferDay) {
        const hasSave = (state.lastNightSavedIds || []).length > 0;
        const nightDeaths = state.players.filter(
          (pl) => !pl.alive && pl.deathCause && pl.deathCause !== "VOTE_EXECUTION" && (pl.deathDay || 0) >= dayNum - 1
        );
        if (hasSave) {
          // Someone was saved — boost doctor/agent probability for protector candidates
          const chatInfo = analyzeChatBehavior(state);
          const maxSp = Math.max(1, ...Object.values(chatInfo.speakCount || {}));
          for (const tid of living) {
            if (tid === p.id) continue;
            const doctorProb = p.aiMemory.roleProbs[tid]?.[Roles.DOCTOR.id] ?? 0;
            const agentProb = p.aiMemory.roleProbs[tid]?.[Roles.AGENT?.id] ?? 0;
            if (doctorProb > 0.1 || agentProb > 0.1) {
              // Boost protector probability slightly
              if (p.aiMemory.roleProbs[tid]) {
                if (p.aiMemory.roleProbs[tid][Roles.DOCTOR.id] !== undefined)
                  p.aiMemory.roleProbs[tid][Roles.DOCTOR.id] *= 1.1;
                if (Roles.AGENT && p.aiMemory.roleProbs[tid][Roles.AGENT.id] !== undefined)
                  p.aiMemory.roleProbs[tid][Roles.AGENT.id] *= 1.1;
              }
            }
          }
          p.aiMemory.nightResultInference.push({ day: dayNum, type: "save_detected" });
        } else if (nightDeaths.length > 0) {
          // Someone died — analyze if they were quiet or active
          const chatInfo = analyzeChatBehavior(state);
          const maxSp = Math.max(1, ...Object.values(chatInfo.speakCount || {}));
          for (const dead of nightDeaths) {
            const deadSpeak = (chatInfo.speakCount[dead.id] || 0) / maxSp;
            p.aiMemory.nightResultInference.push({
              day: dayNum, type: "death", targetId: dead.id, wasActive: deadSpeak > 0.5
            });
          }
        }
      }
    }

    // ── Police investigation results → hard belief update ──
    // Police who have investigated know the faction for certain — override suspicion
    if (hard && p.role === Roles.POLICE.id && p.aiMemory.investigationResults) {
      for (const r of p.aiMemory.investigationResults) {
        const tid = r.targetId;
        if (!p.aiMemory.roleProbs[tid]) continue;
        const allRolesLocal = Object.keys(p.aiMemory.roleProbs[tid]);
        if (r.result === "red") {
          // Hard-set: crush blue probs, boost red probs
          for (const role of allRolesLocal) {
            const meta = roleMeta(role);
            if (meta.faction === Faction.RED) {
              p.aiMemory.roleProbs[tid][role] = Math.max(p.aiMemory.roleProbs[tid][role], 0.15);
            } else {
              p.aiMemory.roleProbs[tid][role] *= 0.05;
            }
          }
        } else if (r.result === "blue") {
          // Hard-set: crush red probs, boost blue probs
          for (const role of allRolesLocal) {
            const meta = roleMeta(role);
            if (meta.faction === Faction.BLUE) {
              p.aiMemory.roleProbs[tid][role] = Math.max(p.aiMemory.roleProbs[tid][role], 0.15);
            } else {
              p.aiMemory.roleProbs[tid][role] *= 0.05;
            }
          }
        } else if (r.result === "green") {
          // Green faction (zombie, grudge beast)
          for (const role of allRolesLocal) {
            const meta = roleMeta(role);
            if (meta.faction === Faction.GREEN) {
              p.aiMemory.roleProbs[tid][role] = Math.max(p.aiMemory.roleProbs[tid][role], 0.15);
            } else {
              p.aiMemory.roleProbs[tid][role] *= 0.05;
            }
          }
        }
        // Re-normalize
        const sumLocal = Object.values(p.aiMemory.roleProbs[tid]).reduce((a, b) => a + b, 0) || 1;
        for (const role of allRolesLocal) {
          p.aiMemory.roleProbs[tid][role] /= sumLocal;
        }
        // Update suspicion to match
        const redProbLocal = Object.entries(p.aiMemory.roleProbs[tid]).reduce(
          (acc, [role, prob]) => acc + (roleMeta(role).faction === Faction.RED ? prob : 0), 0
        );
        p.aiMemory.suspicion[tid] = clamp(redProbLocal, 0.01, 0.99);
      }
    }

    // ── Advanced: Read other players' role claims ──
    if (hard && state.roleClaims) {
      for (const [claimerId, claimedRole] of Object.entries(state.roleClaims)) {
        const cid = Number(claimerId);
        if (cid === p.id) continue;
        p.aiMemory.otherClaims[cid] = claimedRole;
        // If someone claims a role, slightly boost that role probability
        if (p.aiMemory.roleProbs[cid] && p.aiMemory.roleProbs[cid][claimedRole] !== undefined) {
          p.aiMemory.roleProbs[cid][claimedRole] *= 1.15;
        }
        // If two people claim the same role, one is lying — boost suspicion on both
        for (const [otherId, otherRole] of Object.entries(state.roleClaims)) {
          const oid = Number(otherId);
          if (oid === cid || oid === p.id) continue;
          if (otherRole === claimedRole) {
            // Duplicate claim — one is lying, mild red boost for both
            if (p.aiMemory.roleProbs[cid]) {
              for (const role of Object.keys(p.aiMemory.roleProbs[cid])) {
                if (roleMeta(role).faction === Faction.RED) {
                  p.aiMemory.roleProbs[cid][role] *= 1.08;
                }
              }
            }
          }
        }
      }
    }

    // ── Advanced: Apply deduction chains ──
    applyDeductionChains(state, p);
  }
}
