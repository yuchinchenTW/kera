import { getPlayer, alivePlayers, factionCounts } from "./state.js";
import { Roles, Faction, Theme, roleListFromTheme, roleMeta } from "./roles.js";

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function rolePriorCounts(themeId) {
  const list = roleListFromTheme(themeId);
  const counts = {};
  for (const r of list) counts[r] = (counts[r] || 0) + 1;
  return counts;
}

function isHard(state) {
  return state.difficulty === "hard" || state.difficulty === "nightmare";
}

// ─── Behavioral Analysis ───────────────────────────────────────────────────

function ensureAdvancedMemory(p) {
  if (!p.aiMemory) p.aiMemory = { suspicion: {}, roleProbs: {} };
  if (!p.aiMemory.roleProbs) p.aiMemory.roleProbs = {};
  if (!p.aiMemory.suspicion) p.aiMemory.suspicion = {};
  if (!p.aiMemory.voteHistory) p.aiMemory.voteHistory = {};
  if (!p.aiMemory.defenseHistory) p.aiMemory.defenseHistory = {};
  if (!p.aiMemory.selfThreat) p.aiMemory.selfThreat = 0;
  if (!p.aiMemory.chatActivity) p.aiMemory.chatActivity = {};
  // Improvement 1: Cross-round memory tracking
  if (!p.aiMemory.chatMemory) p.aiMemory.chatMemory = [];
  // Improvement 4: Emotion system
  if (!p.aiMemory.emotion) p.aiMemory.emotion = "neutral";
  // Improvement 7: Red silence tracking
  if (p.aiMemory.silentRounds === undefined) p.aiMemory.silentRounds = 0;
  // Improvement 11: Doctor anti-pattern
  if (p.aiMemory.lastProtected === undefined) p.aiMemory.lastProtected = null;
  // Improvement 13: Fake police claim tracking
  if (p.aiMemory.fakePoliceClaimUsed === undefined) p.aiMemory.fakePoliceClaimUsed = false;
  // Advanced: Role claiming system
  if (p.aiMemory.claimedRole === undefined) p.aiMemory.claimedRole = null;
  if (!p.aiMemory.otherClaims) p.aiMemory.otherClaims = {};
  // Advanced: Night result inference
  if (!p.aiMemory.nightResultInference) p.aiMemory.nightResultInference = [];
  // Advanced: Police investigation results tracking
  if (!p.aiMemory.investigationResults) p.aiMemory.investigationResults = [];
  // Advanced: Personality system (deterministic based on player id)
  if (!p.aiMemory.personality) {
    const seed = (p.id * 7 + 13) % 100;
    if (seed < 25) p.aiMemory.personality = "aggressive";
    else if (seed < 50) p.aiMemory.personality = "cautious";
    else if (seed < 75) p.aiMemory.personality = "social";
    else p.aiMemory.personality = "quiet";
  }
}

// ─── Advanced Helper: Role Name (Chinese) ────────────────────────────────
function roleNameZh(roleId) {
  const map = { POLICE: "警察", DOCTOR: "醫生", AGENT: "特務", CIVILIAN: "平民", KILLER: "殺手", SNIPER: "狙擊手", COWBOY: "牛仔", PURIFIER: "淨化者", RIOT_POLICE: "鎮暴警察", EXORCIST: "驅魔師" };
  return map[roleId] || roleId;
}

// ─── Advanced Helper: Game Phase Detection ────────────────────────────────
function getGamePhase(state) {
  const day = state.dayNumber || 1;
  const alive = alivePlayers(state).length;
  const total = state.players.length;
  const ratio = alive / total;
  if (day <= 2 && ratio > 0.7) return "early";
  if (day <= 4 && ratio > 0.4) return "mid";
  return "late";
}

/**
 * Analyze voting patterns across all historical rounds.
 * Returns per-player signals: consistency, mutual voting pairs, etc.
 */
function analyzeVotingPatterns(state) {
  const voteHist = state.history?.votes || [];
  // who voted for whom, how many times
  const voteGraph = {}; // voteGraph[actorId][targetId] = count
  const votedTogether = {}; // votedTogether[a][b] = times a and b voted for the same target
  const beenVotedFor = {}; // beenVotedFor[targetId] = total times targeted

  for (const round of voteHist) {
    const targetByActor = {};
    for (const entry of round.order || []) {
      const { actorId, targetId } = entry;
      if (!voteGraph[actorId]) voteGraph[actorId] = {};
      voteGraph[actorId][targetId] = (voteGraph[actorId][targetId] || 0) + 1;
      beenVotedFor[targetId] = (beenVotedFor[targetId] || 0) + 1;
      targetByActor[actorId] = targetId;
    }
    // Detect vote-together pairs (actors who voted for the same target)
    const actors = Object.keys(targetByActor);
    for (let i = 0; i < actors.length; i++) {
      for (let j = i + 1; j < actors.length; j++) {
        const a = actors[i], b = actors[j];
        if (targetByActor[a] === targetByActor[b]) {
          if (!votedTogether[a]) votedTogether[a] = {};
          if (!votedTogether[b]) votedTogether[b] = {};
          votedTogether[a][b] = (votedTogether[a][b] || 0) + 1;
          votedTogether[b][a] = (votedTogether[b][a] || 0) + 1;
        }
      }
    }
  }

  return { voteGraph, votedTogether, beenVotedFor, rounds: voteHist.length };
}

/**
 * Track chat activity: who mentions whom, who defends/accuses whom.
 */
function analyzeChatBehavior(state) {
  const chats = state.dayChat || [];
  const speakCount = {};
  const mentionedBy = {}; // mentionedBy[targetId] = [speakerId, ...]

  for (const line of chats) {
    for (const p of state.players) {
      if (!p) continue;
      if (line.startsWith(p.name + ":")) {
        speakCount[p.id] = (speakCount[p.id] || 0) + 1;
      }
      // Track mentions
      if (line.includes(p.name) && !line.startsWith(p.name + ":")) {
        if (!mentionedBy[p.id]) mentionedBy[p.id] = [];
        for (const speaker of state.players) {
          if (speaker && line.startsWith(speaker.name + ":") && speaker.id !== p.id) {
            mentionedBy[p.id].push(speaker.id);
          }
        }
      }
    }
  }
  return { speakCount, mentionedBy };
}

/**
 * Compute self-threat level: how suspicious am I to others?
 */
function computeSelfThreat(state, actor) {
  let threat = 0;
  const voteHist = state.history?.votes || [];
  const lastRound = voteHist[voteHist.length - 1];
  if (lastRound) {
    // How many votes did I receive last round?
    const tally = lastRound.tally || {};
    const myVotes = tally[actor.id] || 0;
    const maxVotes = Math.max(1, ...Object.values(tally));
    threat += (myVotes / maxVotes) * 0.4;
    // Was I mentioned a lot in chat?
    const mentions = lastRound.mentions || {};
    const myMentions = mentions[actor.id] || 0;
    const maxMention = Math.max(1, ...Object.values(mentions));
    threat += (myMentions / maxMention) * 0.2;
  }
  // Am I the police-revealed red?
  if (state.policeRevealedRed === actor.id) threat += 0.5;
  return clamp(threat, 0, 1);
}

// ─── Advanced: Logical Deduction Chains ──────────────────────────────────

function applyDeductionChains(state, p) {
  const hard = isHard(state);
  if (!hard) return;
  ensureAdvancedMemory(p);
  const living = alivePlayers(state).map((pl) => pl.id);
  const votePatterns = analyzeVotingPatterns(state);
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;

  // Trust propagation: If police confirmed A is blue, and A consistently defends B, B gets blue boost
  const confirmedBlues = new Set();
  const confirmedReds = new Set();
  if (state.policeRevealedRed !== null) confirmedReds.add(state.policeRevealedRed);
  // Scan chat memory for defense patterns from confirmed blues
  for (const targetId of living) {
    if (targetId === p.id) continue;
    // Check if this target is confirmed blue via police clearing in chat
    const playerObj = getPlayer(state, targetId);
    if (!playerObj) continue;
    // A player we are >80% sure is blue counts as confirmed for trust propagation
    const blueProb = factionProb(p, targetId, Faction.BLUE) ?? 0.5;
    if (blueProb > 0.8) confirmedBlues.add(targetId);
    const redProb = factionProb(p, targetId, Faction.RED) ?? 0.5;
    if (redProb > 0.8) confirmedReds.add(targetId);
  }

  for (const targetId of living) {
    if (targetId === p.id) continue;
    let trustBoost = 0;
    let suspBoost = 0;

    // Trust propagation from confirmed blues
    for (const blueId of confirmedBlues) {
      if (blueId === targetId) continue;
      const defenses = p.aiMemory.chatMemory.filter(
        (m) => m.speakerId === blueId && m.defendedId === targetId
      );
      if (defenses.length > 0) {
        trustBoost += 0.04 * defenses.length * diffScale;
      }
    }

    // Suspicion propagation from confirmed reds
    for (const redId of confirmedReds) {
      if (redId === targetId) continue;
      const togetherCount = votePatterns.votedTogether[targetId]?.[redId] || 0;
      if (togetherCount > 0) {
        suspBoost += 0.06 * togetherCount * diffScale;
      }
      // Also check if target defended the confirmed red
      const redDefenses = p.aiMemory.chatMemory.filter(
        (m) => m.speakerId === targetId && m.defendedId === redId
      );
      if (redDefenses.length > 0) {
        suspBoost += 0.05 * redDefenses.length * diffScale;
      }
    }

    // Death pattern analysis: if killers target active speakers, boost protection instinct
    const chatBehavior = analyzeChatBehavior(state);
    const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
    const recentDeaths = state.players.filter((pl) => !pl.alive && pl.deathCause && pl.deathCause !== "VOTE_EXECUTION");
    let killersTargetActive = 0;
    let killersTargetQuiet = 0;
    for (const dead of recentDeaths) {
      if (dead.faction === Faction.BLUE) {
        const deadSpeak = (chatBehavior.speakCount[dead.id] || 0) / maxSpoken;
        if (deadSpeak > 0.5) killersTargetActive++;
        else killersTargetQuiet++;
      }
    }
    const targetSpeak = (chatBehavior.speakCount[targetId] || 0) / maxSpoken;
    if (killersTargetActive > killersTargetQuiet && targetSpeak > 0.5) {
      // Active speakers are targeted — slightly boost blue (they're threats to red)
      trustBoost += 0.02 * diffScale;
    }

    // Elimination logic: if few killer slots remain and someone is highly suspected
    const rolePriors = rolePriorCounts(state.theme || "GOOD_VS_EVIL");
    const killerSlots = rolePriors[Roles.KILLER.id] || 2;
    const deadReds = state.players.filter((pl) => !pl.alive && pl.faction === Faction.RED).length;
    const remainingKillers = Math.max(0, killerSlots - deadReds);
    if (remainingKillers <= 1) {
      const redProb = factionProb(p, targetId, Faction.RED) ?? 0.5;
      if (redProb > 0.7) {
        suspBoost += 0.1 * diffScale; // Focus votes on the likely last killer
      }
    }

    // Apply boosts to role probs
    if (trustBoost > 0 || suspBoost > 0) {
      const allRoles = Object.keys(p.aiMemory.roleProbs[targetId] || {});
      for (const role of allRoles) {
        const meta = roleMeta(role);
        let mult = 1;
        if (meta.faction === Faction.BLUE) mult += trustBoost;
        if (meta.faction === Faction.RED) mult += suspBoost;
        p.aiMemory.roleProbs[targetId][role] = clamp(
          p.aiMemory.roleProbs[targetId][role] * Math.max(0.01, mult), 0.0001, 1
        );
      }
      // re-normalize
      const sum = Object.values(p.aiMemory.roleProbs[targetId]).reduce((a, b) => a + b, 0) || 1;
      for (const role of allRoles) {
        p.aiMemory.roleProbs[targetId][role] = p.aiMemory.roleProbs[targetId][role] / sum;
      }
      // re-compute suspicion
      const newRedProb = Object.entries(p.aiMemory.roleProbs[targetId]).reduce(
        (acc, [r, prob]) => acc + (roleMeta(r).faction === Faction.RED ? prob : 0), 0
      );
      p.aiMemory.suspicion[targetId] = clamp(newRedProb, 0.01, 0.99);
    }
  }
}

// ─── Enhanced Belief System ────────────────────────────────────────────────

function ensureBeliefs(state) {
  const living = alivePlayers(state).map((p) => p.id);
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;
  const hard = isHard(state);
  const revealedRed = state.policeRevealedRed;
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
        for (const line of chats) {
          for (const sp of state.players) {
            if (!sp || !line.startsWith(sp.name + ":")) continue;
            const entry = { day: dayNum, speakerId: sp.id, mentionedIds: [], accusedId: null, defendedId: null };
            for (const other of state.players) {
              if (!other || other.id === sp.id) continue;
              if (line.includes(other.name)) {
                entry.mentionedIds.push(other.id);
                // Detect accuse/defend keywords in the English portion (before ||)
                const enPart = line.split("||")[0] || line;
                const lowerEn = enPart.toLowerCase();
                if (lowerEn.includes("suspicious") || lowerEn.includes("killer") || lowerEn.includes("vote") || lowerEn.includes("doesn't add up") || lowerEn.includes("acting weird") || lowerEn.includes("don't trust")) {
                  entry.accusedId = other.id;
                }
                if (lowerEn.includes("on our side") || lowerEn.includes("seems fine") || lowerEn.includes("leave") || lowerEn.includes("helpful") || lowerEn.includes("clean") || lowerEn.includes("innocent") || lowerEn.includes("confirmed blue")) {
                  entry.defendedId = other.id;
                }
              }
            }
            p.aiMemory.chatMemory.push(entry);
            break; // only one speaker per line
          }
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
      // Was saved by doctor? Check lastNightSummary for mention of this player being saved
      const wasSaved = (state.lastNightSummary || []).some(
        (e) => typeof e === "string" && e.includes(p.name) && e.includes("saved")
      );

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
        const nightSummary = state.lastNightSummary || [];
        const hasSave = nightSummary.some(
          (e) => typeof e === "string" && e.includes("saved")
        );
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

// ─── Target Selection Helpers ──────────────────────────────────────────────

function pickTargetBySuspicion(state, actor, filterFn = () => true) {
  let best = null;
  let bestScore = -1;
  for (const target of alivePlayers(state)) {
    if (target.id === actor.id) continue;
    if (!filterFn(target)) continue;
    const score = actor.aiMemory?.suspicion?.[target.id] ?? 0.5;
    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = target;
    }
  }
  return best;
}

function factionProb(actor, targetId, faction) {
  const probs = actor.aiMemory?.roleProbs?.[targetId];
  if (!probs) return null;
  let sum = 0;
  for (const [role, prob] of Object.entries(probs)) {
    if (roleMeta(role).faction === faction) sum += prob;
  }
  return sum;
}

function pickPoliceSmartTarget(state, actor) {
  let best = null;
  let bestScore = -Infinity;
  const hard = isHard(state);
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;

  // Hard+: gather contextual info for smarter investigation
  const chatBehavior = hard ? analyzeChatBehavior(state) : null;
  const maxSpoken = chatBehavior ? Math.max(1, ...Object.values(chatBehavior.speakCount || {})) : 1;
  const votePatterns = hard ? analyzeVotingPatterns(state) : null;

  // Track confirmed reds (dead reds + currently revealed red)
  const knownReds = new Set();
  if (state.policeRevealedRed !== null) knownReds.add(state.policeRevealedRed);
  for (const p of state.players) {
    if (!p.alive && p.faction === Faction.RED) knownReds.add(p.id);
  }

  // Hard+: use investigation history to skip already-investigated targets
  const investigatedIds = new Set();
  if (hard) {
    const results = actor.aiMemory?.investigationResults || [];
    for (const r of results) investigatedIds.add(r.targetId);
  }

  // Hard+: survival analysis — count how many nights each player has survived
  const dayNum = state.dayNumber || 1;
  const blueNightDeaths = state.players.filter(
    (p) => !p.alive && p.deathCause && p.deathCause !== "VOTE_EXECUTION" && p.faction === Faction.BLUE
  ).length;

  // Hard+: identify saved players (confirmed blue by action)
  const savedIds = new Set();
  if (hard) {
    for (const entry of (state.lastNightSummary || [])) {
      if (typeof entry === "string" && entry.includes("saved")) {
        for (const p of state.players) {
          if (p.alive && entry.includes(p.name)) savedIds.add(p.id);
        }
      }
    }
  }

  // Hard+: count remaining reds for urgency scaling
  const rolePriors = hard ? rolePriorCounts(state.theme || "GOOD_VS_EVIL") : null;
  const totalRedSlots = rolePriors
    ? Object.entries(rolePriors).reduce((sum, [r, c]) => sum + (roleMeta(r).faction === Faction.RED ? c : 0), 0)
    : 6;
  const deadReds = state.players.filter((p) => !p.alive && p.faction === Faction.RED).length;
  const redsRemaining = Math.max(0, totalRedSlots - deadReds);
  // Urgency multiplier: finding the last red is critical
  const urgency = hard && redsRemaining <= 2 ? 1.3 : 1.0;

  // Hard+: accusation reversal — targets accused by known reds may be blue
  const accusedByRed = new Set();
  if (hard) {
    const chatMem = actor.aiMemory?.chatMemory || [];
    for (const m of chatMem) {
      if (knownReds.has(m.speakerId) && m.accusedId !== undefined) {
        accusedByRed.add(m.accusedId);
      }
    }
  }

  for (const t of alivePlayers(state)) {
    if (t.id === actor.id || t.role === Roles.POLICE.id) continue;

    // Skip already-revealed red — no need to investigate again
    if (state.policeRevealedRed === t.id) continue;

    // Skip already confirmed by police
    if (state.policeConfirmed?.[t.id]) continue;

    // Skip already investigated (we know their result)
    if (hard && investigatedIds.has(t.id)) continue;

    const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0;
    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0;

    const likelyBluePower =
      (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0) > 0.6 ||
      (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0) > 0.6;
    if (likelyBluePower && state.rng() < 0.8) continue;

    let score = killerProb * 2 + redProb;

    if (hard) {
      // Information value: investigating uncertain targets (40-70% red) is more
      // valuable than near-certain ones (>85% red already known to everyone)
      if (redProb > 0.4 && redProb < 0.7) score += 0.15;

      // Bonus: voted together with known reds — suspicious alliance pattern
      if (votePatterns) {
        let redAllyCount = 0;
        for (const redId of knownReds) {
          redAllyCount += votePatterns.votedTogether[t.id]?.[redId] || 0;
        }
        score += Math.min(redAllyCount * 0.08, 0.2);
      }

      // Bonus: defended a known red in chat
      const chatMem = actor.aiMemory?.chatMemory || [];
      for (const m of chatMem) {
        if (m.speakerId === t.id && knownReds.has(m.defendedId)) {
          score += 0.12;
          break;
        }
      }

      // Bonus: silent players may hide red identity
      if (chatBehavior) {
        const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
        if (speakRatio < 0.15 && redProb > 0.35) score += 0.1;
      }

      // Sniper/kidnapper probability — also high-value red targets to expose
      const sniperProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.SNIPER?.id] ?? 0;
      const kidnapProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KIDNAPPER?.id] ?? 0;
      score += sniperProb * 0.8 + kidnapProb * 0.5;

      // Survival analysis: active players who survive many nights are suspicious.
      // Killers don't kill their own team, so red players survive longer on average.
      if (dayNum >= 3 && chatBehavior) {
        const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
        // Active speakers who haven't been night-killed despite being visible
        if (speakRatio > 0.4 && blueNightDeaths >= 2) {
          score += 0.12; // survived while blue allies died = suspicious
        }
      }

      // Post-reveal red ally priority: if we just found a red, investigate
      // people who were closest allies of that red (voted together most)
      if (knownReds.size > 0 && votePatterns) {
        let maxAllyScore = 0;
        for (const redId of knownReds) {
          const together = votePatterns.votedTogether[t.id]?.[redId] || 0;
          maxAllyScore = Math.max(maxAllyScore, together);
        }
        if (maxAllyScore >= 2) score += 0.15; // strong ally pattern
      }

      // Saved target avoidance: doctor-saved players are confirmed blue
      if (savedIds.has(t.id)) score -= 0.3;

      // Accusation reversal: targets accused by known reds are likely blue
      if (accusedByRed.has(t.id)) score -= 0.1;

      // Urgency: when few reds remain, amplify scores to prioritize high-value targets
      score *= urgency;
    }

    // Day 1: more jitter since we have less info
    const jitter = dayNum <= 1 ? 0.18 : 0.1;
    score = clamp(score + (state.rng() - 0.5) * jitter * diffScale, 0, 4);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function randomChoice(list, rng) {
  if (!list.length) return null;
  const idx = Math.floor(rng() * list.length);
  return list[idx];
}

function shuffled(list, rng) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickGroupTarget(state, actors, filterFn = () => true) {
  const candidates = alivePlayers(state).filter((p) => filterFn(p));
  let best = null;
  let bestScore = -Infinity;
  for (const target of candidates) {
    let total = 0;
    let count = 0;
    for (const actor of actors) {
      if (!actor.aiMemory || actor.id === target.id) continue;
      const s = actor.aiMemory.suspicion?.[target.id];
      if (s !== undefined) {
        total += s;
        count += 1;
      }
    }
    if (count === 0) continue;
    const avg = total / count;
    if (avg > bestScore || (avg === bestScore && state.rng() < 0.5)) {
      bestScore = avg;
      best = target;
    }
  }
  return best;
}

function pickZombieTarget(state, actor) {
  let best = null;
  let bestScore = -Infinity;
  for (const t of shuffled(alivePlayers(state), state.rng)) {
    if (t.id === actor.id) continue;
    const zombieProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.ZOMBIE.id] ?? 0;
    const notZombieProb = 1 - zombieProb;
    const score = notZombieProb;
    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

// ─── Hard+ Terrorist Smart Targeting ──────────────────────────────────────

/**
 * Hard+ terrorist target selection: pick the highest-value BLUE target.
 * - Terrorist is RED, suicide bomb kills self + target (if target is blue).
 * - Bombing a red = only self dies (net loss). Must avoid red targets.
 * - Prioritize police > doctor > agent > active blue civilians.
 */
function pickTerroristSmartTarget(state, actor) {
  const chatBehavior = analyzeChatBehavior(state);
  const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
  const votePatterns = analyzeVotingPatterns(state);
  let best = null;
  let bestScore = -Infinity;

  // Terrorist does NOT know who other reds are (different role = no shared info).
  // Use public info only: policeRevealedRed, dead player factions, AI suspicion.
  const knownReds = new Set();
  if (state.policeRevealedRed !== null) knownReds.add(state.policeRevealedRed);
  for (const p of state.players) {
    if (!p.alive && p.faction === Faction.RED) knownReds.add(p.id);
  }

  // Estimate likely killer target tonight (avoid overlap — both killing same blue is wasteful)
  // Use observable signals: high blue prob + active speaker = likely killer target
  let likelyKillerTarget = null;
  let likelyKillerScore = -Infinity;
  for (const t of alivePlayers(state)) {
    if (t.id === actor.id) continue;
    const bp = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    const rp = factionProb(actor, t.id, Faction.RED) ?? 0.5;
    if (rp > 0.6) continue; // likely red, killers won't target
    const sr = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    const ks = bp + sr * 0.3;
    if (ks > likelyKillerScore) { likelyKillerScore = ks; likelyKillerTarget = t.id; }
  }

  for (const t of alivePlayers(state)) {
    if (t.id === actor.id) continue;

    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
    const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
    const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
    const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;

    // Base: prefer blue targets (bombing red = only self dies)
    let score = blueProb * 1.5;

    // Heavy penalty for uncertain targets — bombing unknown is risky
    score -= redProb * 2.0;

    // High-value role bonuses — police are the biggest threat to red team
    score += policeProb * 1.2;
    score += doctorProb * 0.8;
    score += agentProb * 0.6;

    // Active speakers who are blue = high-influence targets worth bombing
    const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    if (blueProb > 0.5) score += speakRatio * 0.3;

    // Police-confirmed red? NEVER bomb — guaranteed only self dies
    if (state.policeConfirmed?.[t.id]) score -= 3.0;

    // Voted together with known reds = possibly red ally, avoid
    if (votePatterns) {
      let redAllyCount = 0;
      for (const redId of knownReds) {
        redAllyCount += votePatterns.votedTogether[t.id]?.[redId] || 0;
      }
      score -= Math.min(redAllyCount * 0.1, 0.3);
    }

    // Saved by doctor last night = confirmed blue, high-value target
    const lastSummary = state.lastNightSummary || [];
    for (const entry of lastSummary) {
      if (typeof entry === "string" && entry.includes(t.name) && entry.includes("saved")) {
        score += 0.4; // confirmed blue = very worth bombing
      }
    }

    // Avoid overlap with killer's likely target — don't waste 2 red actions on 1 blue
    if (t.id === likelyKillerTarget) {
      score -= 0.35;
    }

    // Bonus: target who accused known reds in chat (actively hunting red team)
    const chatMem = actor.aiMemory?.chatMemory || [];
    for (const m of chatMem) {
      if (m.speakerId === t.id) {
        for (const redId of knownReds) {
          if (m.accusedId === redId) { score += 0.15; break; }
        }
      }
    }

    score += (state.rng() - 0.5) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

// ─── Hard+ Killer Smart Targeting ──────────────────────────────────────────

/**
 * Hard+ killer target selection: avoid likely protected targets, prioritize threats.
 * - Avoids players likely protected by doctor (high blue prob + high police/doctor prob)
 * - Prioritizes active speakers (threats who influence votes)
 * - Considers who is most dangerous to red team
 */
function pickKillerSmartTarget(state, actor) {
  const chatBehavior = analyzeChatBehavior(state);
  const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
  let best = null;
  let bestScore = -Infinity;

  for (const t of shuffled(alivePlayers(state), state.rng)) {
    if (t.role === Roles.KILLER.id) continue;
    if (t.id === actor.id) continue;

    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
    const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
    const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;

    // Base: prefer blue targets
    let score = blueProb;

    // Bonus: police are high-value targets
    score += policeProb * 0.5;

    // Bonus: active speakers are threats (they influence votes)
    const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    score += speakRatio * 0.3;

    // Penalty: likely protected by doctor/agent — avoid wasting a kill
    const protectionLikelihood = doctorProb * 0.4 + agentProb * 0.3;
    score -= protectionLikelihood * 0.6;

    // Penalty: same person was killed last night and survived → likely protected
    // Improvement 12: much stronger penalty — 80% skip saved targets
    const lastSummary = state.lastNightSummary || [];
    let wasSavedLastNight = false;
    for (const entry of lastSummary) {
      if (typeof entry === "string" && entry.includes(t.name) && entry.includes("saved")) {
        wasSavedLastNight = true;
        score -= 0.8; // stronger penalty (was 0.4)
      }
    }
    // Improvement 12: If same target as last night and was saved, near-skip
    if (state.killerLastTarget !== undefined && t.id === state.killerLastTarget && wasSavedLastNight) {
      if (state.rng() < 0.8) continue; // 80% chance to skip entirely
    }
    // Improvement 12: If last target died, switch target TYPE (if killed active speaker, target quiet one)
    if (state.killerLastTarget !== undefined && t.id !== state.killerLastTarget) {
      const lastTargetPlayer = getPlayer(state, state.killerLastTarget);
      if (lastTargetPlayer && !lastTargetPlayer.alive) {
        // Last target died — switch to different activity level
        const lastSpeakRatio = (chatBehavior.speakCount[state.killerLastTarget] || 0) / maxSpoken;
        if (lastSpeakRatio > 0.5 && speakRatio < 0.3) score += 0.15; // killed talker, now target quiet
        if (lastSpeakRatio < 0.3 && speakRatio > 0.5) score += 0.15; // killed quiet, now target talker
      }
    }

    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function pickCowboySmartTarget(state, actor) {
  const chatBehavior = analyzeChatBehavior(state);
  const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
  const votePatterns = analyzeVotingPatterns(state);
  let best = null;
  let bestScore = -Infinity;

  // Identify who was saved last night (likely blue — doctor protects blue)
  const savedLastNight = new Set();
  for (const entry of (state.lastNightSummary || [])) {
    if (typeof entry === "string" && entry.includes("saved")) {
      for (const p of state.players) {
        if (p.alive && entry.includes(p.name)) savedLastNight.add(p.id);
      }
    }
  }

  // Identify confirmed reds for vote-pattern cross-referencing
  const confirmedReds = new Set();
  if (state.policeRevealedRed !== null) confirmedReds.add(state.policeRevealedRed);
  for (const p of state.players) {
    if (!p.alive && p.faction === Faction.RED) confirmedReds.add(p.id);
  }

  for (const t of shuffled(alivePlayers(state), state.rng)) {
    if (t.id === actor.id) continue;

    // Base: prefer high-suspicion (red) targets
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
    let score = redProb;

    // Bonus: killer is the highest-value target for blue team
    const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
    score += killerProb * 0.5;

    // Bonus: sniper is also high-value (kills blue every night)
    const sniperProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.SNIPER?.id] ?? 0;
    score += sniperProb * 0.3;

    // Penalty: high blue probability — avoid friendly fire (backfire kills random too)
    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    score -= blueProb * 0.3;

    // Bonus: quiet players may be hiding red identity
    const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    if (speakRatio < 0.2 && redProb > 0.4) score += 0.1;

    // Bonus: police revealed this player as red — confirmed target
    if (state.policeRevealedRed === t.id) score += 0.4;

    // Penalty: saved by doctor last night — very likely blue, don't waste bullet
    if (savedLastNight.has(t.id)) score -= 0.5;

    // Bonus: voted together with confirmed reds — suspicious ally pattern
    let redAllyScore = 0;
    for (const redId of confirmedReds) {
      const together = votePatterns.votedTogether[t.id]?.[redId] || 0;
      if (together > 0) redAllyScore += 0.08 * together;
    }
    score += Math.min(redAllyScore, 0.25); // cap to avoid over-weighting

    // Bonus: defended a confirmed red in chat — suspicious
    const chatMem = actor.aiMemory?.chatMemory || [];
    for (const m of chatMem) {
      if (m.speakerId === t.id && confirmedReds.has(m.defendedId)) {
        score += 0.12;
        break; // only count once
      }
    }

    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function pickSniperSmartTarget(state, actor) {
  const chatBehavior = analyzeChatBehavior(state);
  const maxSpoken = Math.max(1, ...Object.values(chatBehavior.speakCount || {}));
  let best = null;
  let bestScore = -Infinity;

  for (const t of shuffled(alivePlayers(state), state.rng)) {
    // Never shoot fellow red teammates
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
    if (t.id === actor.id) continue;

    // Base: prefer blue targets (opposite of suspicion — sniper wants to kill blue)
    const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
    let score = blueProb;

    // Bonus: police are the biggest threat to red team
    const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
    score += policeProb * 0.6;

    // Bonus: active speakers influence votes against red — prioritize silencing them
    const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
    score += speakRatio * 0.25;

    // Penalty: likely protected by doctor/agent — don't waste precious bullets
    const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
    const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
    score -= (doctorProb * 0.4 + agentProb * 0.3) * 0.5;

    // Penalty: high red probability — don't shoot potential allies
    score -= redProb * 0.4;

    // Penalty: target was saved last night — likely still protected
    const lastSummary = state.lastNightSummary || [];
    for (const entry of lastSummary) {
      if (typeof entry === "string" && entry.includes(t.name) && entry.includes("saved")) {
        score -= 0.7;
      }
    }

    if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

// ─── Night Actions ─────────────────────────────────────────────────────────

export function buildAiNightActions(state, opts = {}) {
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
    // Hard+: use smart targeting instead of simple group suspicion
    if (hard && killerActors.length > 0) {
      sharedKillerTarget = pickKillerSmartTarget(state, killerActors[0]);
    } else {
      sharedKillerTarget =
        state.rng() < 0.6
          ? pickGroupTarget(state, killerActors, (t) => t.role !== Roles.KILLER.id)
          : null;
    }
  }
  // Pre-pick a shared police target to avoid split votes.
  const policeActors = alivePlayers(state).filter((p) => p.role === Roles.POLICE.id && (!p.isHuman || includeHuman));
  const humanPoliceTarget = pickHumanTarget("POLICE_INVESTIGATE");
  // Hard+: use smart targeting for group consensus instead of raw suspicion
  let sharedPoliceTarget = humanPoliceTarget;
  if (!sharedPoliceTarget && policeActors.length > 0) {
    sharedPoliceTarget = hard
      ? pickPoliceSmartTarget(state, policeActors[0])
      : pickGroupTarget(state, policeActors, (t) => t.role !== Roles.POLICE.id);
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
          const wasSaved = (state.lastNightSummary || []).some(
            (e) => typeof e === "string" && e.includes(target.name) && e.includes("saved")
          );
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
          // Hard+: self-protect decision based on self-threat level + game phase
          const selfThreat = actor.aiMemory?.selfThreat ?? 0;
          let selfProtectChance;
          if (hard) {
            // Day 1: killers don't know who doctor is, almost never self-protect
            if (dayNum === 1) {
              selfProtectChance = 0.05;
            } else {
              selfProtectChance = clamp(0.1 + selfThreat * 0.7, 0.1, 0.75);
            }
          } else {
            selfProtectChance = 0.3;
          }
          if (state.rng() > selfProtectChance) {
            // Protect someone else
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
            const savedLastNight = new Set();
            if (hard) {
              for (const entry of (state.lastNightSummary || [])) {
                if (typeof entry === "string" && entry.includes("saved")) {
                  for (const p of state.players) {
                    if (p.alive && entry.includes(p.name)) savedLastNight.add(p.id);
                  }
                }
              }
            }

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

                const speakRatio = (chatBehavior.speakCount[t.id] || 0) / maxSpoken;
                score += speakRatio * 0.2;

                // Killer target-switching prediction
                if (killerPreferQuiet && speakRatio < 0.3) score += 0.15;
                if (killerPreferActive && speakRatio > 0.5) score += 0.15;

                // Multi-night trend: if killers consistently target active speakers, boost active
                if (nightDeathActive > nightDeathQuiet + 1 && speakRatio > 0.5) score += 0.1;
                if (nightDeathQuiet > nightDeathActive + 1 && speakRatio < 0.3) score += 0.1;

                // Penalty: likely red — don't waste injection (and risk overdose)
                score -= redProb * 0.4;

                // Budget-tight penalty: if injections are running low, need higher blue confidence
                if (budgetTight && blueProb < 0.5) score -= 0.2;

                // Penalty: high empty injection count — overdose risk
                const targetPlayer = getPlayer(state, t.id);
                if (targetPlayer && targetPlayer.emptyInjections >= 1) {
                  score -= 0.6;
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
                    // Agent tends to protect highest blueProb; if this target is the
                    // most obvious blue, slight penalty to diversify protection
                    const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
                    if (agentProb > 0.3) {
                      // This person IS likely the agent — they protect themselves indirectly
                      score -= 0.15;
                    }
                  }
                }
              }

              // ── Improvement 11: Doctor anti-pattern ──
              if (hard) {
                ensureAdvancedMemory(actor);
                const lastProt = actor.aiMemory.lastProtected;
                if (lastProt !== null && t.id === lastProt) {
                  if (savedLastNight.has(t.id)) {
                    score += 0.3;
                  } else {
                    if (state.rng() >= 0.1) {
                      score -= 0.8;
                    }
                  }
                }
              }
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            target = best || actor;
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
          if (state.policeRevealedRed !== null) knownReds.add(state.policeRevealedRed);
          for (const dp of state.players) {
            if (!dp.alive && dp.faction === Faction.RED) knownReds.add(dp.id);
          }

          const lastSummary = state.lastNightSummary || [];
          const savedLastNight = new Set();
          for (const entry of lastSummary) {
            if (typeof entry !== "string") continue;
            for (const p of state.players) {
              if (entry.includes(p.name) && entry.includes("saved")) savedLastNight.add(p.id);
            }
          }

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
            if (state.policeConfirmed?.[t.id]) continue;
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
          if (target) actions.push({ actorId: actor.id, type: "AGENT_PROTECT", targetId: target.id });
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
          if (best) actions.push({ actorId: actor.id, type: "AGENT_PROTECT", targetId: best.id });
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

          if (dayNum <= 1 && state.policeRevealedRed !== actor.id) {
            // Day 1: beliefs are unreliable, hold bomb (5% emergency only)
            triggerChance = 0.05;
          } else if (state.policeRevealedRed === actor.id) {
            // Exposed — 95% trigger (last chance before vote execution)
            triggerChance = 0.95;
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
        // Hard+: smart targeting + confidence threshold + backfire EV
        if (hard) {
          const bestTarget = pickCowboySmartTarget(state, actor);
          if (bestTarget) {
            const confidence = actor.aiMemory?.suspicion?.[bestTarget.id] ?? 0.5;
            // Day 1: need 70% confidence, Day 3+: 50% is enough
            let threshold = clamp(0.75 - (state.dayNumber || 1) * 0.08, 0.4, 0.75);
            // Late game = lower threshold (more info available)
            if (getGamePhase(state) === "late") threshold = clamp(threshold - 0.1, 0.3, 0.75);

            // Backfire risk assessment: when blue outnumbers red among alive,
            // backfire's random kill is more likely to hit a blue ally
            const alive = alivePlayers(state);
            const aliveCount = alive.length;
            const blueAlive = alive.filter((p) => p.id !== actor.id && p.id !== bestTarget.id)
              .reduce((sum, p) => sum + (factionProb(actor, p.id, Faction.BLUE) ?? 0.5), 0);
            const othersCount = Math.max(1, aliveCount - 2); // exclude self and target
            const blueRatio = blueAlive / othersCount;
            // More blue bystanders = backfire hurts blue more = raise threshold
            if (blueRatio > 0.6) threshold = clamp(threshold + 0.08, 0.3, 0.85);
            if (aliveCount <= 5) threshold = clamp(threshold + 0.12, 0.3, 0.85);

            // Police confirmed red: override threshold — shoot with near certainty
            if (state.policeRevealedRed === bestTarget.id) threshold = 0.2;
            if (confidence >= threshold) {
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
          if (t.role === Roles.KILLER.id) continue; // never kidnap allies
          if (actor.lastKidnapTarget !== null && t.id === actor.lastKidnapTarget) continue;
          let score;
          if (hard) {
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            const policeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
            const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
            const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
            // Prioritize disabling doctor (prevents saves) and police (prevents investigation)
            score = blueProb + doctorProb * 0.8 + policeProb * 0.6 + agentProb * 0.4;
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
          let best = null;
          let bestScore = -Infinity;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id) continue;
            if (t.role === Roles.ZOMBIE.id) continue; // biting zombie = death
            const zombieProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.ZOMBIE.id] ?? 0;
            let score = 1 - zombieProb; // prefer non-zombies
            // Huge bonus: if target has pending conversion, finish them off
            if (t.status?.pendingZombieConversion) score += 1.0;
            // Bonus: if target was bitten before (zombieBites > 0), easier to convert
            if ((t.status?.zombieBites || 0) > 0) score += 0.5;
            // Penalty: likely protected by agent/doctor
            const doctorProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0;
            const agentProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0;
            score -= (doctorProb + agentProb) * 0.3;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickZombieTarget(state, actor);
          if (target) actions.push({ actorId: actor.id, type: "ZOMBIE_BITE", targetId: target.id });
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
              if (state.policeRevealedRed === t.id) score += 1.0;

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
          const igniteThreshold = selfThreat > 0.5 ? 1 : 3;
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
          // Hard+: be careful with chains — only strike high-confidence red targets
          // Mistakes reduce maxChains, so avoid uncertain targets
          const mistakes = actor.exorcistMistakes || 0;
          const cautionLevel = mistakes * 0.15; // more mistakes = more cautious
          const candidates = shuffled(alivePlayers(state), state.rng)
            .filter((t) => t.id !== actor.id)
            .map((t) => ({
              player: t,
              redProb: factionProb(actor, t.id, Faction.RED) ?? 0.5,
              killerProb: actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0,
            }))
            .sort((a, b) => (b.killerProb * 2 + b.redProb) - (a.killerProb * 2 + a.redProb));
          const minConfidence = 0.4 + cautionLevel; // 0.4 base, up to 0.85 with 3 mistakes
          const picks = [];
          for (const c of candidates) {
            if (picks.length >= maxChains) break;
            if (c.redProb >= minConfidence) {
              picks.push(c.player);
            }
          }
          // If no confident targets, still strike the top 1 (use it or lose it)
          if (picks.length === 0 && candidates.length > 0 && candidates[0].redProb > 0.3) {
            picks.push(candidates[0].player);
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
          // Also consider cleansing arsonist-marked allies to protect them
          let best = null;
          let bestScore = -Infinity;
          for (const t of alivePlayers(state)) {
            if (t.id === actor.id) continue;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const necroProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.NECROMANCER.id] ?? 0;
            const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
            let score = killerProb * 1.5 + redProb + necroProb * 1.0;
            // Bonus: revealed red — cleanse to block their night action
            if (state.policeRevealedRed === t.id) score += 0.6;
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

// ─── Voting ────────────────────────────────────────────────────────────────

export function buildAiVoteActions(state, humanVoteTargetId = null, opts = {}) {
  const includeHuman = opts.includeHuman === true;
  const hard = isHard(state);
  ensureBeliefs(state);
  const chatMentions = {};
  const chats = state.dayChat || [];
  for (const line of chats) {
    for (const player of state.players) {
      if (!player) continue;
      const name = player.name;
      if (line.includes(name)) {
        chatMentions[player.id] = (chatMentions[player.id] || 0) + 1;
      }
    }
  }
  const maxMention = Math.max(1, ...Object.values(chatMentions));
  const chatWeight = (id) => (chatMentions[id] || 0) / maxMention;

  // Hard+: behavioral analysis for vote scoring
  const votePatterns = hard ? analyzeVotingPatterns(state) : null;

  const votes = [];
  const aiVoters = alivePlayers(state).filter(
    (p) => (includeHuman || !p.isHuman) && !(p.role === Roles.BRAT.id && p.status.bratRevived)
  );
  const randomVoteChance = { easy: 0.8, normal: 0.6, hard: 0.2, nightmare: 0.05 };
  const chaosVoteChance = randomVoteChance[state.difficulty || "normal"] ?? 0.6;

  // Hard+: Killers pre-coordinate to scatter votes (avoid all voting the same target)
  const killerVoteTargets = new Set();

  // Hard+: identify saved players (confirmed blue by doctor action)
  const voteSavedIds = new Set();
  if (hard) {
    for (const entry of (state.lastNightSummary || [])) {
      if (typeof entry === "string" && entry.includes("saved")) {
        for (const p of state.players) {
          if (p.alive && entry.includes(p.name)) voteSavedIds.add(p.id);
        }
      }
    }
  }

  // Hard+: collect police-confirmed reds (policeConfirmed stores only reds)
  const confirmedRedIds = new Set();
  if (hard && state.policeConfirmed) {
    for (const [id, result] of Object.entries(state.policeConfirmed)) {
      if (result === true) confirmedRedIds.add(Number(id));
    }
  }

  // Hard+: identify players who correctly voted to kill reds (good judgement = likely blue)
  const correctVoterIds = new Set();
  // Hard+: identify players who voted to kill blues (bad judgement or red misdirection)
  const wrongVoterIds = new Set();
  if (hard) {
    // Find vote-executed players and who voted for them
    const voteExecuted = state.players.filter((p) => !p.alive && p.deathCause === "VOTE_EXECUTION");
    for (const dead of voteExecuted) {
      // Find rounds where this player got the most votes (likely the execution round)
      for (const round of (state.history?.votes || [])) {
        if (!round.order || !round.tally) continue;
        // Check if this player had the most votes in this round
        const theirVotes = round.tally[dead.id] || 0;
        const maxVotes = Math.max(0, ...Object.values(round.tally));
        if (theirVotes > 0 && theirVotes === maxVotes) {
          for (const entry of round.order) {
            if (entry.targetId === dead.id) {
              if (dead.faction === Faction.RED) correctVoterIds.add(entry.actorId);
              else if (dead.faction === Faction.BLUE) wrongVoterIds.add(entry.actorId);
            }
          }
        }
      }
    }
  }

  // Hard+: survival suspicion — vocal players who survive many nights while blues die
  const chatBehaviorVote = hard ? analyzeChatBehavior(state) : null;
  const maxSpokenVote = chatBehaviorVote ? Math.max(1, ...Object.values(chatBehaviorVote.speakCount || {})) : 1;
  const blueNightDeathsVote = hard ? state.players.filter(
    (p) => !p.alive && p.deathCause && p.deathCause !== "VOTE_EXECUTION" && p.faction === Faction.BLUE
  ).length : 0;

  aiVoters.forEach((actor, idx) => {
    // force at least one vote by making the last AI always vote
    const abstainChance = idx === aiVoters.length - 1 ? 0 : 0.05;
    if (state.rng() < abstainChance) return;

    // ── Improvement 9: Strategic abstaining (blue AI only) ──
    if (hard && actor.faction === Faction.BLUE && idx !== aiVoters.length - 1) {
      ensureAdvancedMemory(actor);
      // Find the actor's top suspicion target
      let topSusp = 0;
      for (const t of alivePlayers(state)) {
        if (t.id === actor.id) continue;
        const s = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
        if (s > topSusp) topSusp = s;
      }
      // Advanced: Game phase + personality affect abstain rate
      const votePhase = getGamePhase(state);
      let abstainChance = 0.15;
      if (votePhase === "early") abstainChance = 0.25;
      if (votePhase === "late") abstainChance = 0.05;
      if (actor.aiMemory.personality === "cautious") abstainChance += 0.1;
      if (actor.aiMemory.personality === "aggressive") abstainChance -= 0.08;
      if (topSusp < 0.35 && state.policeRevealedRed === null && state.rng() < abstainChance) {
        // Abstain — low confidence, no police intel
        return;
      }
    }

    // Hard+: Brat strategy — follow the majority, don't stand out
    // Before revealed: blend in by voting with the crowd
    if (hard && actor.role === Roles.BRAT.id && !actor.status.bratRevealed) {
      // Follow police reveal if available
      if (state.policeRevealedRed !== null) {
        const redTarget = getPlayer(state, state.policeRevealedRed);
        if (redTarget?.alive) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redTarget.id });
          return;
        }
      }
      // Otherwise vote with whoever has the most votes so far in this round
      if (votes.length > 0) {
        const tally = {};
        for (const v of votes) tally[v.targetId] = (tally[v.targetId] || 0) + 1;
        let topTarget = null;
        let topCount = 0;
        for (const [tid, cnt] of Object.entries(tally)) {
          if (cnt > topCount) { topCount = cnt; topTarget = Number(tid); }
        }
        if (topTarget !== null && topTarget !== actor.id) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: topTarget });
          return;
        }
      }
      // Fallback: random safe vote
    }

    const roll = state.rng();
    const jitter = (val) => clamp(val + (state.rng() - 0.5) * 0.3, 0, 1);
    const everyone = alivePlayers(state).filter((t) => t.id !== actor.id && t.alive && t.id !== humanVoteTargetId);
    // if police found a red, only police use it to focus vote
    if (state.policeRevealedRed !== null && actor.role === Roles.POLICE.id) {
      const redTarget = getPlayer(state, state.policeRevealedRed);
      if (redTarget?.alive) {
        votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redTarget.id });
        return;
      }
    }
    if (state.policeRevealedRed !== null && actor.faction === Faction.BLUE && actor.role !== Roles.POLICE.id) {
      const redTarget = getPlayer(state, state.policeRevealedRed);
      const followPoliceChance = { easy: 0.5, normal: 0.7, hard: 0.95, nightmare: 0.98 };
      const chance = followPoliceChance[state.difficulty || "normal"] ?? 0.7;
      if (redTarget?.alive && state.rng() < chance) {
        votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redTarget.id });
        return;
      }
    }
    const pruned =
      actor.role === Roles.KILLER.id
        ? everyone.filter((t) => t.role !== Roles.KILLER.id)
        : everyone;
    const candidates = pruned.length ? pruned : everyone;

    // Hard+ 紅方策略投票
    if (hard && actor.faction === Faction.RED) {
      const redTargetId = state.policeRevealedRed;
      const exposedRed =
        redTargetId !== null ? getPlayer(state, redTargetId) : null;

      // Only sell out exposed teammates (police-confirmed), not hidden allies
      if (exposedRed?.alive && exposedRed.id !== actor.id) {
        // Check if teammate is likely to die anyway (many votes against them)
        const lastTally = state.history?.votes?.[state.history.votes.length - 1]?.tally || {};
        const exposedVotes = lastTally[exposedRed.id] || 0;
        const aliveCount = alivePlayers(state).length;
        const likelyToDie = exposedVotes >= aliveCount * 0.3;
        // Sell out when they're likely dead anyway (ride the wave), or occasionally to build trust
        const sellChance = likelyToDie ? 0.7 : 0.3;
        if (state.rng() < sellChance) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: exposedRed.id });
          return;
        }
      }

      // Hard+ killer vote scatter: avoid all killers voting same non-exposed target
      if (actor.role === Roles.KILLER.id && killerVoteTargets.size > 0) {
        const scatterCandidates = candidates.filter((t) => !killerVoteTargets.has(t.id));
        if (scatterCandidates.length > 0 && state.rng() < 0.6) {
          const target = randomChoice(scatterCandidates, state.rng);
          if (target) {
            killerVoteTargets.add(target.id);
            votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: target.id });
            return;
          }
        }
      }
    }

    let target = null;
    // Hard+: blue civilians vote more deliberately (10% random vs 20% for others)
    const effectiveChaos = (hard && actor.faction === Faction.BLUE) ? chaosVoteChance * 0.5 : chaosVoteChance;
    if (roll < effectiveChaos) {
      target = randomChoice(candidates, state.rng);
    } else {
      let best = null;
      let bestScore = -Infinity;
      for (const t of candidates) {
        const redProb = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
        const base = jitter(redProb);
        const chatBonus = actor.role !== Roles.POLICE.id ? chatWeight(t.id) * 0.05 : 0;
        let s = clamp(base + chatBonus, 0, 1);

        // Hard+: behavioral voting bonuses
        if (hard && votePatterns) {
          // Bonus: players who voted together with known-dead reds are suspicious
          for (const dead of state.players.filter((dp) => !dp.alive && dp.faction === Faction.RED)) {
            const togetherCount = votePatterns.votedTogether[t.id]?.[dead.id] || 0;
            if (togetherCount > 0) {
              s += 0.08 * togetherCount;
            }
          }
          // Penalty: players who voted together with me are less suspicious
          const withMe = votePatterns.votedTogether[t.id]?.[actor.id] || 0;
          if (withMe > 0 && actor.faction === Faction.BLUE) {
            s -= 0.05 * withMe;
          }
        }

        // Hard+: saved-target penalty — doctor-saved players are confirmed blue
        if (hard && voteSavedIds.has(t.id)) {
          s -= 0.25;
        }

        // Hard+: correct voter reward — players who voted to execute reds have good judgement
        if (hard && correctVoterIds.has(t.id)) {
          s -= 0.12; // less suspicious (likely blue)
        }
        // Hard+: wrong voter penalty — players who voted to execute blues are suspicious
        if (hard && wrongVoterIds.has(t.id)) {
          s += 0.08;
        }

        // Hard+: survival suspicion — vocal players surviving while blues die at night
        if (hard && chatBehaviorVote && (state.dayNumber || 1) >= 3 && blueNightDeathsVote >= 2) {
          const speakRatio = (chatBehaviorVote.speakCount[t.id] || 0) / maxSpokenVote;
          if (speakRatio > 0.4) {
            s += 0.08; // active + surviving = suspicious
          }
        }

        // Hard+: late-game sharpening — less jitter, more decisive
        if (hard && alivePlayers(state).length <= 6) {
          // Amplify the score difference from 0.5 baseline
          s = 0.5 + (s - 0.5) * 1.3;
        }

        // Advanced: Personality affects vote confidence
        if (hard) {
          ensureAdvancedMemory(actor);
          if (actor.aiMemory.personality === "cautious") {
            // Cautious: more suspicion-based, less jitter
            s = clamp(s * 1.1, 0, 1);
          } else if (actor.aiMemory.personality === "quiet") {
            // Quiet: heavily suspicion-based
            s = clamp(s * 1.15, 0, 1);
          }
        }

        s = clamp(s, 0, 1);
        if (s > bestScore || (s === bestScore && state.rng() < 0.5)) {
          bestScore = s;
          best = t;
        }
      }
      target = best || randomChoice(candidates, state.rng);
    }
    if (target) {
      if (hard && actor.role === Roles.KILLER.id) killerVoteTargets.add(target.id);
      votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: target.id });
    }
  });

  // ── Improvement 8: Vote timing awareness (second pass for hard AI) ──
  if (hard && votes.length > 1) {
    // Build current vote tally
    const tally = {};
    for (const v of votes) tally[v.targetId] = (tally[v.targetId] || 0) + 1;
    // Find the consensus target (most votes)
    let consensusTarget = null;
    let consensusCount = 0;
    for (const [tid, cnt] of Object.entries(tally)) {
      if (cnt > consensusCount) { consensusCount = cnt; consensusTarget = Number(tid); }
    }
    // For each voter, consider switching to consensus if they agree
    // Don't bandwagon onto confirmed-blue or saved targets
    const consensusIsSafe = voteSavedIds.has(consensusTarget) || correctVoterIds.has(consensusTarget);
    for (let i = 0; i < votes.length; i++) {
      const v = votes[i];
      if (v.targetId === consensusTarget) continue; // already voting consensus
      const actor = getPlayer(state, v.actorId);
      if (!actor || actor.isHuman) continue;
      if (actor.faction === Faction.RED) continue; // red AI has its own strategy
      if (consensusIsSafe) continue; // don't bandwagon onto known blues
      if (state.rng() >= 0.45) continue; // 45% chance to bandwagon (up from 40%)

      // Only switch if they have real suspicion on the consensus target
      ensureAdvancedMemory(actor);
      const consensusSusp = actor.aiMemory?.suspicion?.[consensusTarget] ?? 0.5;
      const currentSusp = actor.aiMemory?.suspicion?.[v.targetId] ?? 0.5;
      // Switch if consensus target is genuinely suspicious (≥0.4) and their current target is isolated
      const currentVotes = tally[v.targetId] || 0;
      if (consensusSusp >= 0.4 && currentVotes <= 1 && consensusCount >= 2) {
        tally[v.targetId] = (tally[v.targetId] || 0) - 1;
        v.targetId = consensusTarget;
        tally[consensusTarget] = (tally[consensusTarget] || 0) + 1;
      }
    }
  }

  if (votes.length === 0 && aiVoters.length > 0) {
    const actor = aiVoters[0];
    const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id && t.alive);
    if (target) votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: target.id });
  }

  // ── Improvement 10: Vote explanation chat ──
  if (hard && votes.length > 0) {
    if (!state.dayChat) state.dayChat = [];
    const explainCount = Math.min(3, Math.floor(state.rng() * 3) + 1);
    const shuffledVotes = shuffled(votes, state.rng);
    let explained = 0;
    for (const v of shuffledVotes) {
      if (explained >= explainCount) break;
      const actor = getPlayer(state, v.actorId);
      if (!actor || actor.isHuman) continue;
      const target = getPlayer(state, v.targetId);
      if (!target) continue;
      if (state.rng() < 0.4) continue; // not everyone explains
      const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.voteExplain);
      state.dayChat.push(tmpl(actor.name, target.name));
      explained++;
    }
  }

  return votes;
}

// ─── Chat Generation ───────────────────────────────────────────────────────

// Bilingual chat templates. Each returns "EN||ZH" so the client can pick by locale.
const CHAT_TEMPLATES = {
  accuse: [
    (s, t) => `${s}: I think ${t} is suspicious.||${s}：我覺得 ${t} 很可疑。`,
    (s, t) => `${s}: ${t} feels off to me.||${s}：${t} 給我的感覺不太對勁。`,
    (s, t) => `${s}: Something about ${t} doesn't add up.||${s}：${t} 的行為有矛盾。`,
    (s, t) => `${s}: We should look into ${t}.||${s}：我們應該注意 ${t}。`,
    (s, t) => `${s}: ${t} has been acting weird.||${s}：${t} 一直表現得很奇怪。`,
    (s, t) => `${s}: I don't trust ${t} at all.||${s}：我完全不信任 ${t}。`,
  ],
  defend: [
    (s, t) => `${s}: I think ${t} is on our side.||${s}：我覺得 ${t} 是自己人。`,
    (s, t) => `${s}: ${t} seems fine to me.||${s}：${t} 看起來沒問題。`,
    (s, t) => `${s}: Leave ${t} alone, they're not the problem.||${s}：別針對 ${t} 了，問題不在他。`,
    (s, t) => `${s}: ${t} has been helpful so far.||${s}：${t} 到目前為止一直有在幫忙。`,
  ],
  wonder: [
    (s, t) => `${s}: What does everyone think about ${t}?||${s}：大家覺得 ${t} 怎麼樣？`,
    (s, t) => `${s}: I'm not sure about ${t} yet.||${s}：我對 ${t} 還拿不定主意。`,
    (s, t) => `${s}: Anyone have thoughts on ${t}?||${s}：有人注意到 ${t} 嗎？`,
    (s, t) => `${s}: ${t} is hard to read...||${s}：${t} 讓人看不透⋯`,
  ],
  voteRef: [
    (s, t, extra) => `${s}: ${t} voted for ${extra} last time, that's suspicious.||${s}：${t} 上次投了 ${extra}，很可疑。`,
    (s, t, extra) => `${s}: Why did ${t} switch their vote to ${extra}?||${s}：${t} 為什麼臨時改投 ${extra}？`,
    (s, t, extra) => `${s}: ${t} keeps targeting ${extra}, are they allies?||${s}：${t} 一直針對 ${extra}，他們是同夥嗎？`,
  ],
  deathRef: [
    (s, t, dead) => `${s}: ${t} defended ${dead} before they died... think about that.||${s}：${t} 在 ${dead} 死前幫他說話⋯大家想想。`,
    (s, t, dead) => `${s}: Ever since ${dead} died, ${t} has been quiet.||${s}：自從 ${dead} 死了之後，${t} 就不太說話了。`,
    (s, t, dead) => `${s}: After ${dead} died, I started watching ${t} more closely.||${s}：${dead} 死後我就一直在觀察 ${t}。`,
  ],
  bluff: [
    (s, t) => `${s}: I'm pretty sure ${t} is the killer.||${s}：我很確定 ${t} 就是殺手。`,
    (s, t) => `${s}: ${t} is definitely suspicious, I've been watching them.||${s}：${t} 絕對有問題，我一直在觀察他。`,
    (s, t) => `${s}: We need to vote ${t} out today!||${s}：今天一定要把 ${t} 投出去！`,
    (s, t) => `${s}: Trust me on this, ${t} is not who they seem.||${s}：相信我，${t} 不是表面看起來那樣。`,
  ],
  deflect: [
    (s) => `${s}: I'm not sure who to suspect right now.||${s}：我現在還不確定該懷疑誰。`,
    (s) => `${s}: Let's think about this carefully.||${s}：大家冷靜想想吧。`,
    (s) => `${s}: I want to hear what others think first.||${s}：我想先聽聽其他人的想法。`,
    (s) => `${s}: This is getting complicated...||${s}：事情越來越複雜了⋯`,
  ],
  policeReveal: [
    (s, t) => `${s}: I investigated ${t} and they're RED!||${s}：我查了 ${t}，他是紅方！`,
    (s, t) => `${s}: ${t} is confirmed red, we need to vote them out.||${s}：${t} 確認是紅方，必須投掉。`,
  ],
  policeClear: [
    (s, t) => `${s}: I checked ${t}, they're clean.||${s}：我查了 ${t}，他是好人。`,
    (s, t) => `${s}: ${t} is confirmed blue, leave them alone.||${s}：${t} 確認是藍方，別投他。`,
  ],
  // Improvement 4: Emotion-specific chat
  emotionChat: {
    angry: [
      (s) => `${s}: Why did you all vote for me?! I'm NOT the killer!||${s}：為什麼都投我？！我不是殺手！`,
      (s) => `${s}: You're wasting time on me while the real killer is still out there!||${s}：你們浪費時間在我身上，真正的殺手還在外面！`,
      (s, t) => `${s}: ${t}, you voted for me — explain yourself!||${s}：${t}，你投了我，給個解釋！`,
    ],
    defensive: [
      (s) => `${s}: I've been helping the team from the start, check my record.||${s}：我從頭到尾都在幫大家，看看我的紀錄。`,
      (s) => `${s}: If I was the killer, why would I accuse known reds?||${s}：如果我是殺手，我為什麼會指控已知的紅方？`,
    ],
    grateful: [
      (s) => `${s}: Thanks for saving me last night, I owe you one.||${s}：謝謝昨晚救了我，我欠你一次。`,
      (s) => `${s}: Someone protected me... I'll repay the favor by finding the killer.||${s}：有人保護了我⋯我會找出殺手來報答的。`,
    ],
    anxious: [
      (s) => `${s}: I have a bad feeling about tonight...||${s}：我對今晚有不好的預感⋯`,
      (s) => `${s}: I think they're coming for me next.||${s}：我覺得他們下一個就是要殺我。`,
      (s, t) => `${s}: If I die tonight, look into ${t}.||${s}：如果我今晚死了，去查 ${t}。`,
    ],
  },
  // Improvement 5: Responsive reply chat
  replyChat: {
    agree: [
      (s, t, target) => `${s}: I agree with ${t}, ${target} is suspicious.||${s}：我同意 ${t} 的看法，${target} 很可疑。`,
      (s, t) => `${s}: ${t} has a point, we should listen.||${s}：${t} 說得有道理，大家應該聽。`,
    ],
    disagree: [
      (s, t, target) => `${s}: ${t}, I disagree — ${target} seems fine to me.||${s}：${t}，我不同意，${target} 看起來沒問題。`,
      (s, t) => `${s}: ${t}, that doesn't make sense, think again.||${s}：${t}，那說不通，再想想。`,
    ],
    question: [
      (s, t) => `${s}: ${t}, why do you think that?||${s}：${t}，你為什麼這麼想？`,
      (s, t) => `${s}: ${t}, what evidence do you have?||${s}：${t}，你有什麼證據？`,
    ],
  },
  // Improvement 6: Bandwagon & counter
  bandwagon: [
    (s, t) => `${s}: Everyone's right about ${t}, let's vote them out.||${s}：大家說的對，${t} 有問題，投他。`,
    (s, t) => `${s}: Yeah, ${t} is definitely the one.||${s}：對，${t} 一定是。`,
  ],
  counter: [
    (s, t) => `${s}: Hold on, you're all wrong about ${t}!||${s}：等等，你們都搞錯了，${t} 不是！`,
    (s, t) => `${s}: Stop ganging up on ${t}, there's no proof.||${s}：別圍攻 ${t} 了，沒有證據。`,
  ],
  // Improvement 10: Vote explanation chat
  voteExplain: [
    (s, t) => `${s}: I'm voting ${t} because their behavior has been suspicious.||${s}：我投 ${t}，因為他行為一直很可疑。`,
    (s, t) => `${s}: ${t} has to go — look at who they've been defending.||${s}：${t} 必須出去，看看他一直在幫誰說話。`,
    (s, t) => `${s}: My vote goes to ${t}, I've been watching them.||${s}：我投 ${t}，我一直在觀察他。`,
    (s, t) => `${s}: I'm voting ${t} based on last night's results.||${s}：根據昨晚的結果，我投 ${t}。`,
    (s) => `${s}: I'm not confident in anyone... abstaining for now.||${s}：我對誰都沒把握⋯先棄票。`,
  ],
  // Improvement 13: Fake police claim
  fakePoliceClaim: [
    (s, t) => `${s}: I'm the police. I investigated ${t} last night — they're RED.||${s}：我是警察。我昨晚查了 ${t}，他是紅方。`,
    (s, t) => `${s}: Police report: ${t} is confirmed RED. Vote them out!||${s}：警察報告：${t} 確認紅方。投掉他！`,
  ],
  // Improvement 14: Trust building chat
  trustBuild: [
    (s, t) => `${s}: I've been thinking about it — ${t} voted against the killer last round.||${s}：我想了一下，${t} 上回合投了殺手的票。`,
    (s, t) => `${s}: ${t} can't be the killer, their behavior is too consistent.||${s}：${t} 不可能是殺手，他行為太一致了。`,
    (s) => `${s}: I just want to help the team find the truth.||${s}：我只是想幫大家找出真相。`,
    (s, t) => `${s}: Let me share my analysis — ${t} has been helpful, probably blue.||${s}：讓我分享我的分析，${t} 一直在幫忙，應該是藍方。`,
  ],
  // Advanced: Role claiming system
  roleClaim: {
    blueClaim: [
      (s, role, roleZh) => `${s}: I'm the ${role}, don't vote me!||${s}：我是${roleZh}，別投我！`,
      (s, role, roleZh) => `${s}: I need to reveal — I'm the ${role}.||${s}：我必須公開了，我是${roleZh}。`,
    ],
    redFakeClaim: [
      (s, role, roleZh) => `${s}: I'm the ${role}, trust me.||${s}：我是${roleZh}，相信我。`,
      (s, role, roleZh) => `${s}: I haven't said this before, but I'm the ${role}.||${s}：我之前沒說過，但我是${roleZh}。`,
    ],
    challenge: [
      (s, t, role, roleZh) => `${s}: ${t} can't be the ${role} — I'm the ${role}!||${s}：${t} 不可能是${roleZh}，我才是${roleZh}！`,
      (s, t) => `${s}: I don't believe ${t}'s claim, it's suspicious.||${s}：我不相信 ${t} 的宣告，很可疑。`,
    ],
    support: [
      (s, t) => `${s}: I believe ${t}'s claim, their behavior matches.||${s}：我相信 ${t} 的宣告，行為吻合。`,
      (s, t, role, roleZh) => `${s}: ${t} is probably telling the truth about being ${role}.||${s}：${t} 說自己是${roleZh}應該是真的。`,
    ],
  },
  // Advanced: Self-defense when accused
  selfDefense: [
    (s, accuser) => `${s}: ${accuser}, you're wrong about me. Check my voting record.||${s}：${accuser}，你搞錯了，看看我的投票紀錄。`,
    (s, accuser) => `${s}: ${accuser}, I voted against the killer last round — did you?||${s}：${accuser}，我上回合投了殺手，你呢？`,
    (s, accuser) => `${s}: ${accuser}, if I was the killer, why would I speak up?||${s}：${accuser}，如果我是殺手，我為什麼要發言？`,
    (s, accuser) => `${s}: ${accuser}, stop pointing fingers without evidence!||${s}：${accuser}，沒證據別亂指！`,
    (s, accuser) => `${s}: ${accuser}, you're deflecting — maybe YOU should be investigated.||${s}：${accuser}，你在轉移焦點吧？也許該查的是你。`,
  ],
  // Advanced: Police timed reveal
  policeTimedReveal: [
    (s, t) => `${s}: I've been waiting for the right time — ${t} is RED.||${s}：我等到了正確時機，${t} 是紅方。`,
    (s, t) => `${s}: I'll reveal now: ${t} is confirmed blue, protect them.||${s}：我現在公開：${t} 確認是藍方，保護他。`,
    (s) => `${s}: I'm the police. I'm revealing now because I might not survive tonight.||${s}：我是警察。我現在公開因為我可能活不過今晚。`,
  ],
  policeDeathDump: [
    (s, info) => `${s}: Before I die — here's everything I know: ${info}||${s}：在我死之前，這是我知道的一切：${info}`,
  ],
};

function pickTemplate(rng, templates) {
  return templates[Math.floor(rng() * templates.length)];
}

export function generateChatLines(state, maxLines = 6) {
  const lines = [];
  const living = alivePlayers(state).filter((p) => !p.isHuman);
  const hard = isHard(state);
  const redFound = state.policeRevealedRed !== null ? getPlayer(state, state.policeRevealedRed) : null;
  const voteHist = state.history?.votes || [];
  const lastRound = voteHist[voteHist.length - 1];
  const recentDeaths = state.players.filter((p) => !p.alive && p.deathCause);

  // Shuffle speakers for natural order variety
  const speakers = shuffled(living, state.rng);

  // Track who accused whom in this round for bandwagon detection (improvement 6)
  const accuseCounts = {}; // accuseCounts[targetId] = count of accuse lines

  // Advanced: Game phase for chat tone adjustment
  const gamePhase = hard ? getGamePhase(state) : "mid";

  for (const speaker of speakers) {
    if (lines.length >= maxLines) break;
    ensureAdvancedMemory(speaker);

    // Hard+: some speakers skip (not everyone talks every round)
    // Advanced: Personality affects skip chance
    let skipChance = 0.15;
    if (hard && speaker.aiMemory.personality === "quiet") skipChance = 0.45;
    else if (hard && speaker.aiMemory.personality === "aggressive") skipChance = 0.05;
    else if (hard && speaker.aiMemory.personality === "social") skipChance = 0.05;
    if (hard && state.rng() < skipChance) {
      if (hard) speaker.aiMemory.silentRounds = (speaker.aiMemory.silentRounds || 0) + 1;
      continue;
    }

    const allCandidates = alivePlayers(state).filter((t) => t.id !== speaker.id);
    const isRedSpeaker = speaker.faction === Faction.RED;

    // ── Improvement 7: Red silence strategy ──
    if (hard && isRedSpeaker) {
      const silentRounds = speaker.aiMemory.silentRounds || 0;
      if (silentRounds < 2 && state.rng() < 0.2) {
        // 20% chance to say nothing (stay silent)
        speaker.aiMemory.silentRounds = silentRounds + 1;
        continue;
      }
      // If silent 2+ rounds, force speech with deflect
      if (silentRounds >= 2) {
        speaker.aiMemory.silentRounds = 0;
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.deflect);
        lines.push(tmpl(speaker.name));
        continue;
      }
    }
    // Reset silent rounds for speakers who do speak
    if (hard) speaker.aiMemory.silentRounds = 0;

    // ── Improvement 4: Emotion-driven chat (30% chance for hard AI) ──
    if (hard && speaker.aiMemory.emotion !== "neutral" && state.rng() < 0.3) {
      const emotionTemplates = CHAT_TEMPLATES.emotionChat[speaker.aiMemory.emotion];
      if (emotionTemplates && emotionTemplates.length > 0) {
        const tmpl = pickTemplate(state.rng, emotionTemplates);
        // Some emotion templates take (s), some (s, t)
        const target = randomChoice(allCandidates, state.rng);
        const tName = target?.name ?? "someone";
        lines.push(tmpl(speaker.name, tName));
        continue;
      }
    }

    // ── Improvement 13: Fake police claim (8% chance, once per game, killer only) ──
    if (hard && isRedSpeaker && speaker.role === Roles.KILLER.id &&
        !speaker.aiMemory.fakePoliceClaimUsed &&
        state.policeRevealedRed === null &&
        (state.dayNumber || 1) >= 2 &&
        state.rng() < 0.08) {
      const blueTargets = allCandidates.filter((t) => t.faction === Faction.BLUE);
      const frameTarget = randomChoice(blueTargets.length ? blueTargets : allCandidates, state.rng);
      if (frameTarget) {
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.fakePoliceClaim);
        lines.push(tmpl(speaker.name, frameTarget.name));
        speaker.aiMemory.fakePoliceClaimUsed = true;
        continue;
      }
    }

    // ── Improvement 14: Trust building chat (15% chance for hard RED AI) ──
    if (hard && isRedSpeaker && state.rng() < 0.15) {
      // Defend genuinely blue players (not allies) to seem credible
      const blueTargets = allCandidates.filter((t) => t.faction === Faction.BLUE);
      const trustTarget = randomChoice(blueTargets.length ? blueTargets : allCandidates, state.rng);
      if (trustTarget) {
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.trustBuild);
        lines.push(tmpl(speaker.name, trustTarget.name));
        continue;
      }
    }

    // ── Advanced: Role claiming system ──
    if (hard && (state.dayNumber || 1) >= 2) {
      const selfThreat = speaker.aiMemory.selfThreat || 0;
      const powerRoles = new Set([Roles.POLICE.id, Roles.DOCTOR.id, Roles.AGENT?.id, Roles.PURIFIER.id, Roles.EXORCIST.id, Roles.RIOT_POLICE.id]);

      // Blue claiming: power role, high threat, hasn't claimed
      if (speaker.faction === Faction.BLUE && powerRoles.has(speaker.role) &&
          !speaker.aiMemory.claimedRole && selfThreat > 0.5) {
        // Personality affects claim chance
        let claimChance = 0.4;
        if (speaker.aiMemory.personality === "aggressive") claimChance = 0.55;
        if (speaker.aiMemory.personality === "cautious") claimChance = 0.25;
        if (gamePhase === "late") claimChance += 0.2;
        if (state.rng() < claimChance) {
          speaker.aiMemory.claimedRole = speaker.role;
          state.roleClaims = state.roleClaims || {};
          state.roleClaims[speaker.id] = speaker.role;
          const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.roleClaim.blueClaim);
          lines.push(tmpl(speaker.name, speaker.role, roleNameZh(speaker.role)));
          continue;
        }
      }

      // Red fake-claiming: killer, high threat, hasn't claimed
      if (speaker.faction === Faction.RED && speaker.role === Roles.KILLER.id &&
          !speaker.aiMemory.claimedRole && selfThreat > 0.6) {
        let fakeClaimChance = 0.15;
        if (gamePhase === "late") fakeClaimChance = 0.3;
        if (speaker.aiMemory.personality === "aggressive") fakeClaimChance += 0.1;
        if (state.rng() < fakeClaimChance) {
          const fakeRole = state.rng() < 0.5 ? Roles.CIVILIAN.id : Roles.DOCTOR.id;
          speaker.aiMemory.claimedRole = fakeRole;
          state.roleClaims = state.roleClaims || {};
          state.roleClaims[speaker.id] = fakeRole;
          const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.roleClaim.redFakeClaim);
          lines.push(tmpl(speaker.name, fakeRole, roleNameZh(fakeRole)));
          continue;
        }
      }

      // Counter-claim: someone claimed MY real role
      if (state.roleClaims && !speaker.aiMemory.claimedRole) {
        for (const [claimerId, claimedRole] of Object.entries(state.roleClaims)) {
          const cid = Number(claimerId);
          if (cid === speaker.id) continue;
          if (claimedRole === speaker.role && speaker.faction === Faction.BLUE) {
            // Someone claimed my role — counter-claim!
            speaker.aiMemory.claimedRole = speaker.role;
            state.roleClaims[speaker.id] = speaker.role;
            const claimer = getPlayer(state, cid);
            if (claimer?.alive) {
              const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.roleClaim.challenge);
              lines.push(tmpl(speaker.name, claimer.name, speaker.role, roleNameZh(speaker.role)));
              continue;
            }
          }
        }
      }

      // Support or challenge other claims
      if (state.roleClaims && state.rng() < 0.2) {
        for (const [claimerId, claimedRole] of Object.entries(state.roleClaims)) {
          const cid = Number(claimerId);
          if (cid === speaker.id) continue;
          const claimer = getPlayer(state, cid);
          if (!claimer?.alive) continue;
          const claimerSusp = speaker.aiMemory?.suspicion?.[cid] ?? 0.5;
          if (claimerSusp > 0.6 && state.rng() < 0.4) {
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.roleClaim.challenge);
            lines.push(tmpl(speaker.name, claimer.name, claimedRole, roleNameZh(claimedRole)));
            break;
          } else if (claimerSusp < 0.35 && state.rng() < 0.3) {
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.roleClaim.support);
            lines.push(tmpl(speaker.name, claimer.name, claimedRole, roleNameZh(claimedRole)));
            break;
          }
        }
        if (lines.length > 0 && lines[lines.length - 1].includes(speaker.name + ":")) continue;
      }

      // Late game: blue players who haven't claimed should claim
      if (gamePhase === "late" && speaker.faction === Faction.BLUE &&
          !speaker.aiMemory.claimedRole && powerRoles.has(speaker.role) && state.rng() < 0.5) {
        speaker.aiMemory.claimedRole = speaker.role;
        state.roleClaims = state.roleClaims || {};
        state.roleClaims[speaker.id] = speaker.role;
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.roleClaim.blueClaim);
        lines.push(tmpl(speaker.name, speaker.role, roleNameZh(speaker.role)));
        continue;
      }
    }

    // ── Advanced: Strategic police timed reveal ──
    if (hard && speaker.role === Roles.POLICE.id) {
      const selfThreat = speaker.aiMemory.selfThreat || 0;
      const dayNum = state.dayNumber || 1;

      // Track investigation results from private logs
      const privateLogs = state.privateLogs?.police || [];
      for (const log of privateLogs) {
        if (typeof log !== "string") continue;
        const redMatch = log.match(/Investigation result: (.+) is RED/);
        const blueMatch = log.match(/Investigation result: (.+) is BLUE/);
        if (redMatch) {
          const targetName = redMatch[1];
          const targetPlayer = state.players.find((pl) => pl && pl.name === targetName);
          if (targetPlayer && !speaker.aiMemory.investigationResults.some((r) => r.targetId === targetPlayer.id)) {
            speaker.aiMemory.investigationResults.push({ targetId: targetPlayer.id, result: "red", day: dayNum });
          }
        }
        if (blueMatch) {
          const targetName = blueMatch[1];
          const targetPlayer = state.players.find((pl) => pl && pl.name === targetName);
          if (targetPlayer && !speaker.aiMemory.investigationResults.some((r) => r.targetId === targetPlayer.id)) {
            speaker.aiMemory.investigationResults.push({ targetId: targetPlayer.id, result: "blue", day: dayNum });
          }
        }
      }

      const results = speaker.aiMemory.investigationResults;
      const redResults = results.filter((r) => r.result === "red");
      const blueResults = results.filter((r) => r.result === "blue");

      // Day 1: NEVER reveal
      if (dayNum >= 2) {
        // About to die: dump all info
        if (selfThreat > 0.6 && results.length > 0) {
          const infoParts = results.map((r) => {
            const tp = getPlayer(state, r.targetId);
            return tp ? `${tp.name}=${r.result.toUpperCase()}` : "";
          }).filter(Boolean);
          if (infoParts.length > 0) {
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeDeathDump);
            lines.push(tmpl(speaker.name, infoParts.join(", ")));
            continue;
          }
        }
        // Day 2: reveal only if confirmed red AND selfThreat > 0.3
        if (dayNum === 2 && redResults.length > 0 && selfThreat > 0.3) {
          const redTarget = getPlayer(state, redResults[0].targetId);
          if (redTarget?.alive) {
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeTimedReveal);
            lines.push(tmpl(speaker.name, redTarget.name));
            continue;
          }
        }
        // Day 3+: reveal if confirmed red exists
        if (dayNum >= 3 && redResults.length > 0 && state.rng() < 0.8) {
          const redTarget = getPlayer(state, redResults[0].targetId);
          if (redTarget?.alive) {
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeTimedReveal);
            lines.push(tmpl(speaker.name, redTarget.name));
            continue;
          }
        }
        // Also share blue confirmations in mid/late game
        if (gamePhase !== "early" && blueResults.length > 0 && state.rng() < 0.3) {
          const blueTarget = getPlayer(state, blueResults[0].targetId);
          if (blueTarget?.alive) {
            const tmpl = CHAT_TEMPLATES.policeTimedReveal[1]; // "confirmed blue, protect them"
            lines.push(tmpl(speaker.name, blueTarget.name));
            continue;
          }
        }
      }
    }

    // ── Police strategic reveal (legacy, kept for non-timed reveals) ──
    if (speaker.role === Roles.POLICE.id && redFound?.alive && state.rng() < 0.8) {
      const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeReveal);
      lines.push(tmpl(speaker.name, redFound.name));
      continue;
    }

    // ── Improvement 6: Bandwagon & counter ──
    if (hard) {
      // Check if 3+ lines already accuse the same person
      let bandwagonTarget = null;
      for (const [tid, cnt] of Object.entries(accuseCounts)) {
        if (cnt >= 3) { bandwagonTarget = Number(tid); break; }
      }
      if (bandwagonTarget !== null) {
        const bTarget = getPlayer(state, bandwagonTarget);
        if (bTarget?.alive && bTarget.id !== speaker.id) {
          const suspOfTarget = speaker.aiMemory?.suspicion?.[bandwagonTarget] ?? 0.5;
          if (suspOfTarget > 0.4 && state.rng() < 0.6) {
            // Pile on — agree with the crowd
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.bandwagon);
            lines.push(tmpl(speaker.name, bTarget.name));
            accuseCounts[bandwagonTarget] = (accuseCounts[bandwagonTarget] || 0) + 1;
            continue;
          } else if (suspOfTarget <= 0.4 && state.rng() < 0.3) {
            // Counter — defend the accused
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.counter);
            lines.push(tmpl(speaker.name, bTarget.name));
            continue;
          }
        }
      }
    }

    // ── Hard+ RED deception strategies ──
    if (hard && isRedSpeaker) {
      const deceptionRoll = state.rng();

      // Advanced: Game phase adjusts red strategy
      // Early: more deflect, less bluff; Late: more bluff, more fake claims
      const deflectThreshold = gamePhase === "early" ? 0.3 : gamePhase === "late" ? 0.1 : 0.2;
      const bluffThreshold = deflectThreshold + (gamePhase === "late" ? 0.35 : 0.25);

      // Strategic deflection
      if (deceptionRoll < deflectThreshold) {
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.deflect);
        lines.push(tmpl(speaker.name));
        continue;
      }

      // Bluff — aggressively accuse an innocent
      if (deceptionRoll < bluffThreshold) {
        const innocents = allCandidates.filter((t) => t.faction !== Faction.RED);
        const bluffTarget = randomChoice(innocents.length ? innocents : allCandidates, state.rng);
        if (bluffTarget) {
          const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.bluff);
          lines.push(tmpl(speaker.name, bluffTarget.name));
          accuseCounts[bluffTarget.id] = (accuseCounts[bluffTarget.id] || 0) + 1;
          continue;
        }
      }

      // Defend a red ally subtly
      if (deceptionRoll < bluffThreshold + 0.15) {
        const allies = allCandidates.filter((t) => t.role === Roles.KILLER.id);
        const defendAlly = randomChoice(allies, state.rng);
        if (defendAlly) {
          const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.defend);
          lines.push(tmpl(speaker.name, defendAlly.name));
          continue;
        }
      }
      // else: fall through to normal chat
    }

    // ── Hard+ vote/death references ──
    if (hard && state.rng() < 0.35 && lastRound) {
      // Reference someone's voting behavior
      const flips = lastRound.flips || [];
      if (flips.length > 0 && state.rng() < 0.5) {
        const flipperId = randomChoice(flips, state.rng);
        const flipper = getPlayer(state, flipperId);
        if (flipper?.alive) {
          const voteTarget = lastRound.order?.find((e) => e.actorId === flipperId);
          const votedFor = voteTarget ? getPlayer(state, voteTarget.targetId) : null;
          if (votedFor) {
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.voteRef);
            lines.push(tmpl(speaker.name, flipper.name, votedFor.name));
            continue;
          }
        }
      }
      // Reference a recent death
      if (recentDeaths.length > 0 && state.rng() < 0.4) {
        const dead = randomChoice(recentDeaths, state.rng);
        const suspect = randomChoice(allCandidates, state.rng);
        if (dead && suspect) {
          const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.deathRef);
          // Some templates use 2 args, some 3
          lines.push(tmpl(speaker.name, suspect.name, dead.name));
          continue;
        }
      }
    }

    // ── Standard chat (improved with template variety + game phase + personality) ──
    const target =
      state.rng() < 0.5
        ? randomChoice(allCandidates, state.rng)
        : pickTargetBySuspicion(
            state,
            speaker,
            (t) => t.alive && t.id !== speaker.id
          );
    const useTarget = target;
    const suspicion = speaker.aiMemory?.suspicion?.[useTarget?.id] ?? 0.5;
    let tone = suspicion > 0.7 ? "accuse" : suspicion < 0.3 ? "defend" : "wonder";
    // Advanced: Game phase adjusts tone
    if (hard) {
      if (gamePhase === "early") {
        // Early game: more wonder, fewer accusations
        if (tone === "accuse" && state.rng() < 0.4) tone = "wonder";
      } else if (gamePhase === "late") {
        // Late game: more aggressive
        if (tone === "wonder" && state.rng() < 0.4) tone = "accuse";
      }
      // Advanced: Personality adjusts tone
      const personality = speaker.aiMemory.personality;
      if (personality === "aggressive" && tone === "wonder" && state.rng() < 0.35) tone = "accuse";
      if (personality === "cautious" && tone === "accuse" && state.rng() < 0.3) tone = "wonder";
      if (personality === "social" && tone !== "wonder" && state.rng() < 0.2) tone = "wonder";
    }
    const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES[tone]);
    const tName = (tone === "defend" && !useTarget)
      ? randomChoice(allCandidates, state.rng)?.name ?? "someone"
      : useTarget?.name ?? "someone";
    lines.push(tmpl(speaker.name, tName));
    // Track accuse lines for bandwagon detection
    if (tone === "accuse" && useTarget) {
      accuseCounts[useTarget.id] = (accuseCounts[useTarget.id] || 0) + 1;
    }
  }

  // ── Improvement 5: Responsive chat (reply to accusation lines) ──
  if (hard && lines.length > 0) {
    const replyLines = [];
    for (const line of lines) {
      if (replyLines.length + lines.length >= maxLines + 3) break; // don't add too many
      // Find if this line accuses someone (check for accusation keywords)
      const enPart = line.split("||")[0] || line;
      const lowerEn = enPart.toLowerCase();
      const isAccusation = lowerEn.includes("suspicious") || lowerEn.includes("killer") || lowerEn.includes("vote them") || lowerEn.includes("doesn't add up") || lowerEn.includes("acting weird") || lowerEn.includes("don't trust");
      if (!isAccusation) continue;
      if (state.rng() >= 0.4) continue; // 40% chance to respond

      // Find who spoke and who was accused
      let speakerName = null;
      let accusedName = null;
      for (const p of state.players) {
        if (!p) continue;
        if (enPart.startsWith(p.name + ":")) speakerName = p.name;
        else if (enPart.includes(p.name)) accusedName = p.name;
      }
      if (!speakerName || !accusedName) continue;

      // Pick a responder (different from speaker and accused)
      const responders = living.filter(
        (p) => p.name !== speakerName && p.name !== accusedName
      );
      const responder = randomChoice(responders, state.rng);
      if (!responder) continue;
      ensureAdvancedMemory(responder);

      // Decide response based on responder's beliefs about the accused
      const accusedPlayer = state.players.find((p) => p && p.name === accusedName);
      const accusedSusp = accusedPlayer ? (responder.aiMemory?.suspicion?.[accusedPlayer.id] ?? 0.5) : 0.5;

      const roll = state.rng();
      if (accusedSusp > 0.5 && roll < 0.5) {
        // Agree
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.replyChat.agree);
        replyLines.push(tmpl(responder.name, speakerName, accusedName));
      } else if (accusedSusp <= 0.4 && roll < 0.5) {
        // Disagree
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.replyChat.disagree);
        replyLines.push(tmpl(responder.name, speakerName, accusedName));
      } else {
        // Question
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.replyChat.question);
        replyLines.push(tmpl(responder.name, speakerName));
      }
    }
    for (const rl of replyLines) lines.push(rl);
  }

  // ── Advanced: Self-defense when accused ──
  if (hard && lines.length > 0) {
    const defenseLines = [];
    let defenseCount = 0;
    for (const line of lines) {
      if (defenseCount >= 2) break;
      const enPart = line.split("||")[0] || line;
      const lowerEn = enPart.toLowerCase();
      const isAccusation = lowerEn.includes("suspicious") || lowerEn.includes("killer") ||
        lowerEn.includes("vote them") || lowerEn.includes("doesn't add up") ||
        lowerEn.includes("acting weird") || lowerEn.includes("don't trust");
      if (!isAccusation) continue;

      // Find who was accused
      let accuserName = null;
      let accusedPlayer = null;
      for (const p of state.players) {
        if (!p) continue;
        if (enPart.startsWith(p.name + ":")) accuserName = p.name;
      }
      for (const p of state.players) {
        if (!p) continue;
        if (p.name === accuserName) continue;
        if (enPart.includes(p.name) && p.alive && !p.isHuman) {
          accusedPlayer = p;
          break;
        }
      }
      if (!accuserName || !accusedPlayer) continue;
      if (state.rng() >= 0.5) continue; // 50% chance to defend

      ensureAdvancedMemory(accusedPlayer);
      const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.selfDefense);
      defenseLines.push(tmpl(accusedPlayer.name, accuserName));
      defenseCount++;
    }
    for (const dl of defenseLines) lines.push(dl);
  }

  return lines;
}

// ─── Faction Private Chat Generation ───────────────────────────────────────

const FACTION_CHAT = {
  killer: {
    // Discuss who to kill tonight
    targetPlan: [
      (s, t) => `${s}: Let's go for ${t} tonight.||${s}：今晚殺 ${t} 吧。`,
      (s, t) => `${s}: I think we should take out ${t}.||${s}：我覺得該除掉 ${t}。`,
      (s, t) => `${s}: ${t} is getting dangerous, target them.||${s}：${t} 越來越危險了，鎖定他。`,
    ],
    // Warn about threats
    threat: [
      (s, t) => `${s}: Watch out for ${t}, they might be police.||${s}：小心 ${t}，可能是警察。`,
      (s, t) => `${s}: ${t} is asking too many questions...||${s}：${t} 問太多問題了⋯`,
      (s, t) => `${s}: I think ${t} is onto us.||${s}：我覺得 ${t} 懷疑我們了。`,
    ],
    // Coordinate voting strategy
    voteStrategy: [
      (s, t) => `${s}: Vote separately today, don't all target the same person.||${s}：今天分散投票，別都投同一個人。`,
      (s, t) => `${s}: Let's frame ${t} in chat and vote them out.||${s}：白天帶風向指控 ${t}，把他投出去。`,
      (s, t) => `${s}: If they suspect one of us, the others should defend.||${s}：如果有人被懷疑，其他人幫忙辯護。`,
    ],
    // React to events
    react: [
      (s) => `${s}: We need to be careful, they're getting close.||${s}：要小心了，他們越來越接近真相。`,
      (s) => `${s}: Good, that went well last night.||${s}：不錯，昨晚很順利。`,
      (s) => `${s}: Things are getting tight, stay calm.||${s}：局勢越來越緊，大家冷靜。`,
      (s, t) => `${s}: ${t} is protected, don't waste a kill on them.||${s}：${t} 有人保護，別浪費機會。`,
    ],
    // Avoid doctor
    avoidProtected: [
      (s, t) => `${s}: ${t} was saved last night, skip them.||${s}：${t} 昨晚被救了，跳過他。`,
      (s, t) => `${s}: Someone is protecting ${t}, pick another target.||${s}：有人在保 ${t}，換目標吧。`,
    ],
  },
  police: {
    // Share investigation results
    shareIntel: [
      (s, t) => `${s}: I checked ${t}, they're RED.||${s}：我查了 ${t}，是紅方。`,
      (s, t) => `${s}: ${t} is confirmed blue, they're clean.||${s}：${t} 確認是藍方，沒問題。`,
      (s, t) => `${s}: Investigation result: ${t} is suspicious.||${s}：查驗結果：${t} 有嫌疑。`,
    ],
    // Discuss who to investigate
    investigatePlan: [
      (s, t) => `${s}: Let's check ${t} tonight.||${s}：今晚查 ${t} 吧。`,
      (s, t) => `${s}: We should investigate ${t}, they've been quiet.||${s}：應該查查 ${t}，他一直很安靜。`,
      (s, t) => `${s}: ${t} voted strangely, worth checking.||${s}：${t} 投票很奇怪，值得查。`,
    ],
    // Coordinate vote
    voteCoordinate: [
      (s, t) => `${s}: We all vote ${t} today, agreed?||${s}：今天大家都投 ${t}，同意嗎？`,
      (s, t) => `${s}: Focus fire on ${t}, don't split votes.||${s}：集火投 ${t}，別分散。`,
      (s) => `${s}: Let's not reveal too much in public chat.||${s}：公開發言別透露太多。`,
    ],
    // Analysis
    analysis: [
      (s, t) => `${s}: ${t} defended a known red last round.||${s}：${t} 上回合幫已知紅方說話。`,
      (s, t) => `${s}: ${t} keeps voting with the killers.||${s}：${t} 一直跟殺手投一樣的人。`,
      (s) => `${s}: We're losing people, need to be more aggressive.||${s}：我們一直在死人，要積極一點。`,
      (s) => `${s}: Who should we protect tonight?||${s}：今晚要保護誰？`,
    ],
  },
  grudge: {
    // Discuss judgment target
    judgePlan: [
      (s, t) => `${s}: Let's judge ${t}, I think they're red.||${s}：審判 ${t} 吧，我覺得他是紅方。`,
      (s, t) => `${s}: Don't judge ${t}, might be civilian — dangerous for us.||${s}：別審判 ${t}，可能是平民，會害到我們。`,
      (s, t) => `${s}: ${t} is worth judging, could reveal useful info.||${s}：${t} 值得審判，可能有有用的情報。`,
    ],
    // Berserk coordination
    berserkPlan: [
      (s, t) => `${s}: We're berserk now. Target ${t}.||${s}：我們狂暴了，鎖定 ${t}。`,
      (s, t) => `${s}: Let's hunt down ${t} tonight.||${s}：今晚獵殺 ${t}。`,
      (s) => `${s}: Focus on one faction, don't split.||${s}：專注打一個陣營，別分散。`,
    ],
    // Survival strategy
    survival: [
      (s) => `${s}: We need to stay alive, be careful with judgments.||${s}：我們要活下去，審判要謹慎。`,
      (s) => `${s}: If we judge wrong, one of us dies.||${s}：如果審判錯了，我們會死一個。`,
      (s) => `${s}: Let's lay low in public and not draw attention.||${s}：公開場合低調點，別引起注意。`,
    ],
  },
};

// ── Night-specific faction chat templates ──
const NIGHT_FACTION_CHAT = {
  killer: {
    planKill: [
      (s, t) => `${s}: Kill ${t} tonight, they're the biggest threat.||${s}：今晚殺 ${t}，他威脅最大。`,
      (s, t) => `${s}: ${t} is exposed, let's finish them off.||${s}：${t} 暴露了，解決掉他。`,
      (s, t) => `${s}: I'll handle ${t} tonight.||${s}：今晚我來處理 ${t}。`,
      (s, t) => `${s}: Let's take out ${t} before they expose us.||${s}：趁 ${t} 揭發我們之前先下手。`,
    ],
    avoidWarn: [
      (s, t) => `${s}: Don't touch ${t}, doctor might be guarding them.||${s}：別動 ${t}，醫生可能在守他。`,
      (s, t) => `${s}: ${t} survived last time, someone is protecting them.||${s}：${t} 上次沒死，有人在保他。`,
      (s, t) => `${s}: Skip ${t}, too risky tonight.||${s}：跳過 ${t}，今晚太危險了。`,
    ],
    tomorrowPlan: [
      (s, t) => `${s}: After the kill, we frame ${t} tomorrow in chat.||${s}：殺完之後，明天帶風向指控 ${t}。`,
      (s) => `${s}: Stay calm tomorrow, vote separately.||${s}：明天保持冷靜，分散投票。`,
      (s) => `${s}: If one of us gets suspected, the others play dumb.||${s}：如果有人被懷疑，其他人裝傻。`,
      (s, t) => `${s}: Tomorrow let's push suspicion toward ${t}.||${s}：明天把嫌疑引向 ${t}。`,
    ],
    urgency: [
      (s) => `${s}: We're running out of time, need big kills now.||${s}：時間不多了，必須殺關鍵的人。`,
      (s) => `${s}: They're closing in, pick carefully tonight.||${s}：他們快查到了，今晚要選好目標。`,
      (s) => `${s}: Only a few rounds left, make this count.||${s}：剩沒幾回合了，要殺對人。`,
    ],
  },
  police: {
    planInvestigate: [
      (s, t) => `${s}: I'll investigate ${t} tonight, they're suspicious.||${s}：今晚我查 ${t}，他很可疑。`,
      (s, t) => `${s}: ${t} has been too quiet, checking them tonight.||${s}：${t} 太安靜了，今晚查他。`,
      (s, t) => `${s}: Let me verify ${t}, their voting is off.||${s}：讓我驗一下 ${t}，他的投票很奇怪。`,
      (s, t) => `${s}: Focus on ${t} tonight, could be a killer.||${s}：今晚查 ${t}，可能是殺手。`,
    ],
    shareResult: [
      (s, t) => `${s}: Last check confirmed ${t} is RED — be careful.||${s}：上次查驗確認 ${t} 是紅方，小心。`,
      (s, t) => `${s}: Good news, ${t} is blue. One less to worry about.||${s}：好消息，${t} 是藍方，少一個要擔心的。`,
      (s, t) => `${s}: ${t} is clean, I verified them already.||${s}：${t} 是好人，我已經查過了。`,
    ],
    protectAdvice: [
      (s, t) => `${s}: We should keep an eye on ${t}, they might be targeted.||${s}：注意 ${t}，他可能被殺手盯上了。`,
      (s, t) => `${s}: Hope the doctor protects ${t} tonight.||${s}：希望醫生今晚保 ${t}。`,
      (s) => `${s}: Stay safe tonight everyone, killers will be aggressive.||${s}：今晚大家小心，殺手會很積極。`,
    ],
    tomorrowPlan: [
      (s, t) => `${s}: If ${t} is red, we reveal them tomorrow and vote.||${s}：如果 ${t} 是紅方，明天就公開投他。`,
      (s) => `${s}: Let's coordinate tomorrow — don't split votes.||${s}：明天要協調好，別分散投票。`,
      (s, t) => `${s}: Tomorrow we push for voting out ${t}, everyone agree?||${s}：明天大家一起投 ${t}，同意嗎？`,
    ],
  },
  grudge: {
    planJudge: [
      (s, t) => `${s}: Let's judge ${t} tonight, I have a feeling.||${s}：今晚審判 ${t} 吧，我有預感。`,
      (s, t) => `${s}: ${t} is suspicious, worth judging tonight.||${s}：${t} 很可疑，今晚審他。`,
      (s, t) => `${s}: If we judge ${t} and they're red, we gain a lot.||${s}：如果審 ${t} 是紅方，我們賺到了。`,
    ],
    caution: [
      (s) => `${s}: Be careful tonight, a wrong judgment kills one of us.||${s}：今晚小心，審判錯了我們要死人。`,
      (s, t) => `${s}: Not sure about ${t}, maybe skip judging tonight.||${s}：不確定 ${t}，今晚或許別審判。`,
      (s) => `${s}: Let's observe one more round before judging.||${s}：再觀察一回合再審判吧。`,
    ],
    berserkHunt: [
      (s, t) => `${s}: We're berserk! Go for ${t} tonight!||${s}：狂暴了！今晚衝 ${t}！`,
      (s, t) => `${s}: Hunt ${t} down, no mercy.||${s}：追殺 ${t}，不留情。`,
      (s) => `${s}: Berserk mode — eliminate as many as we can!||${s}：狂暴模式，盡量多殺！`,
    ],
  },
};

/**
 * Generate night-phase private faction chat lines for AI players.
 * Hard+: pre-action strategy discussions about tonight's plans.
 */
export function generateNightFactionChat(state) {
  if (!isHard(state)) return;

  const alive = alivePlayers(state);

  // ── Killer Night Chat ──
  const killers = alive.filter((p) => p.role === Roles.KILLER.id && !p.isHuman);
  if (killers.length > 0) {
    state.killerChat = state.killerChat || [];
    const speaker = randomChoice(killers, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonKillers = alive.filter((t) => t.role !== Roles.KILLER.id);

      // Check if a target was saved recently
      const savedRecently = (state.lastNightSummary || []).some(
        (e) => typeof e === "string" && e.includes("saved")
      );

      const roll = state.rng();
      let line = null;

      // Pick high-value target
      let bestTarget = null;
      let bestScore = -Infinity;
      for (const t of nonKillers) {
        const blueProb = factionProb(speaker, t.id, Faction.BLUE) ?? 0.5;
        const policeProb = speaker.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
        const score = blueProb + policeProb * 0.5;
        if (score > bestScore) { bestScore = score; bestTarget = t; }
      }
      const target = bestTarget || randomChoice(nonKillers, state.rng);

      if (savedRecently && target && roll < 0.3) {
        const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.killer.avoidWarn);
        line = tmpl(speaker.name, target.name);
      } else if (roll < 0.5 && target) {
        const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.killer.planKill);
        line = tmpl(speaker.name, target.name);
      } else if (roll < 0.75 && target) {
        const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.killer.tomorrowPlan);
        line = tmpl(speaker.name, target.name);
      } else {
        const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.killer.urgency);
        line = tmpl(speaker.name);
      }

      if (line) {
        state.killerChat.push(line);
        state.privateLogs.killer = state.privateLogs.killer || [];
        state.privateLogs.killer.push(line);
      }

      // Second killer responds
      const otherKillers = killers.filter((k) => k.id !== speaker.id);
      if (otherKillers.length > 0 && state.rng() < 0.5) {
        const responder = randomChoice(otherKillers, state.rng);
        const t2 = randomChoice(nonKillers, state.rng);
        const r2 = state.rng();
        let reply = null;
        if (r2 < 0.4 && t2) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.killer.planKill);
          reply = tmpl(responder.name, t2.name);
        } else if (r2 < 0.7) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.killer.tomorrowPlan);
          reply = t2 ? tmpl(responder.name, t2.name) : tmpl(responder.name);
        } else {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.killer.urgency);
          reply = tmpl(responder.name);
        }
        if (reply) {
          state.killerChat.push(reply);
          state.privateLogs.killer.push(reply);
        }
      }
    }
  }

  // ── Police Night Chat ──
  const police = alive.filter((p) => p.role === Roles.POLICE.id && !p.isHuman);
  if (police.length > 0) {
    state.policeChat = state.policeChat || [];
    const speaker = randomChoice(police, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonPolice = alive.filter((t) => t.role !== Roles.POLICE.id);
      const roll = state.rng();
      let line = null;

      // Share last investigation result if available
      const revealedRed = state.policeRevealedRed !== null ? getPlayer(state, state.policeRevealedRed) : null;
      if (revealedRed?.alive && state.rng() < 0.4) {
        const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.police.shareResult);
        line = tmpl(speaker.name, revealedRed.name);
      }

      if (!line) {
        // Pick most suspicious to investigate
        let suspect = null;
        let highSusp = -1;
        for (const t of nonPolice) {
          const s = speaker.aiMemory?.suspicion?.[t.id] ?? 0.5;
          if (s > highSusp) { highSusp = s; suspect = t; }
        }
        const target = suspect || randomChoice(nonPolice, state.rng);

        if (roll < 0.4 && target) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.police.planInvestigate);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.65 && target) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.police.tomorrowPlan);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.85 && target) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.police.protectAdvice);
          line = tmpl(speaker.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.police.protectAdvice);
          line = tmpl(speaker.name);
        }
      }

      if (line) {
        state.policeChat.push(line);
        state.privateLogs.police = state.privateLogs.police || [];
        state.privateLogs.police.push(line);
      }

      // Second police responds
      const otherPolice = police.filter((p) => p.id !== speaker.id);
      if (otherPolice.length > 0 && state.rng() < 0.5) {
        const responder = randomChoice(otherPolice, state.rng);
        const target = randomChoice(nonPolice, state.rng);
        let reply = null;
        const r2 = state.rng();
        if (r2 < 0.5 && target) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.police.planInvestigate);
          reply = tmpl(responder.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.police.protectAdvice);
          reply = target ? tmpl(responder.name, target.name) : tmpl(responder.name);
        }
        if (reply) {
          state.policeChat.push(reply);
          state.privateLogs.police.push(reply);
        }
      }
    }
  }

  // ── Grudge Night Chat ──
  const grudge = alive.filter((p) => p.role === Roles.GRUDGE_BEAST.id && !p.isHuman);
  if (grudge.length > 0) {
    state.grudgeChat = state.grudgeChat || [];
    const speaker = randomChoice(grudge, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonGrudge = alive.filter((t) => t.role !== Roles.GRUDGE_BEAST.id);
      const target = randomChoice(nonGrudge, state.rng);
      const roll = state.rng();
      let line = null;

      if (state.grudgeState.berserk) {
        if (target && roll < 0.6) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.grudge.berserkHunt);
          line = tmpl(speaker.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.grudge.berserkHunt);
          line = tmpl(speaker.name);
        }
      } else {
        if (target && roll < 0.4) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.grudge.planJudge);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.7) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.grudge.caution);
          line = target ? tmpl(speaker.name, target.name) : tmpl(speaker.name);
        } else if (target) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.grudge.planJudge);
          line = tmpl(speaker.name, target.name);
        }
      }

      if (line) {
        state.grudgeChat.push(line);
        state.privateLogs.grudge = state.privateLogs.grudge || [];
        state.privateLogs.grudge.push(line);
      }
    }
  }
}

/**
 * Generate day-phase private faction chat lines for AI players.
 * Hard+: strategic discussions about targets, threats, coordination.
 * Normal/Easy: no faction chat.
 */
export function generateFactionChat(state) {
  if (!isHard(state)) return;

  const alive = alivePlayers(state);

  // ── Killer Chat ──
  const killers = alive.filter((p) => p.role === Roles.KILLER.id && !p.isHuman);
  if (killers.length > 0) {
    state.killerChat = state.killerChat || [];
    const speaker = randomChoice(killers, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonKillers = alive.filter((t) => t.role !== Roles.KILLER.id);

      // Check if someone was saved last night
      const savedTarget = (state.lastNightSummary || []).find(
        (e) => typeof e === "string" && e.includes("saved")
      );

      const roll = state.rng();
      let line = null;

      if (savedTarget && state.rng() < 0.5) {
        // Warn about protected target
        const protectedName = nonKillers.find((t) =>
          typeof savedTarget === "string" && savedTarget.includes(t.name)
        );
        if (protectedName) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.avoidProtected);
          line = tmpl(speaker.name, protectedName.name);
        }
      }

      if (!line) {
        // Pick highest-value target to discuss
        let bestTarget = null;
        let bestScore = -Infinity;
        for (const t of nonKillers) {
          const blueProb = factionProb(speaker, t.id, Faction.BLUE) ?? 0.5;
          const policeProb = speaker.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0;
          const score = blueProb + policeProb * 0.5;
          if (score > bestScore) { bestScore = score; bestTarget = t; }
        }
        const target = bestTarget || randomChoice(nonKillers, state.rng);

        if (roll < 0.35 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.targetPlan);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.55 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.threat);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.75 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.voteStrategy);
          line = tmpl(speaker.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.react);
          line = target ? tmpl(speaker.name, target.name) : tmpl(speaker.name);
        }
      }

      if (line) {
        state.killerChat.push(line);
        state.privateLogs.killer = state.privateLogs.killer || [];
        state.privateLogs.killer.push(line);
      }

      // Second killer may respond (50% chance)
      const otherKillers = killers.filter((k) => k.id !== speaker.id);
      if (otherKillers.length > 0 && state.rng() < 0.5) {
        const responder = randomChoice(otherKillers, state.rng);
        const target = randomChoice(nonKillers, state.rng);
        const roll2 = state.rng();
        let reply = null;
        if (roll2 < 0.4 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.targetPlan);
          reply = tmpl(responder.name, target.name);
        } else if (roll2 < 0.7) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.react);
          reply = target ? tmpl(responder.name, target.name) : tmpl(responder.name);
        } else if (target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.killer.threat);
          reply = tmpl(responder.name, target.name);
        }
        if (reply) {
          state.killerChat.push(reply);
          state.privateLogs.killer.push(reply);
        }
      }
    }
  }

  // ── Police Chat ──
  const police = alive.filter((p) => p.role === Roles.POLICE.id && !p.isHuman);
  if (police.length > 0) {
    state.policeChat = state.policeChat || [];
    const speaker = randomChoice(police, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonPolice = alive.filter((t) => t.role !== Roles.POLICE.id);
      const roll = state.rng();
      let line = null;

      // If police have revealed a red, coordinate around it
      const revealedRed = state.policeRevealedRed !== null ? getPlayer(state, state.policeRevealedRed) : null;
      if (revealedRed?.alive && state.rng() < 0.5) {
        const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.voteCoordinate);
        line = tmpl(speaker.name, revealedRed.name);
      }

      if (!line) {
        // Find most suspicious target to discuss
        let suspect = null;
        let highSusp = -1;
        for (const t of nonPolice) {
          const s = speaker.aiMemory?.suspicion?.[t.id] ?? 0.5;
          if (s > highSusp) { highSusp = s; suspect = t; }
        }
        const target = suspect || randomChoice(nonPolice, state.rng);

        if (roll < 0.3 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.shareIntel);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.55 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.investigatePlan);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.75 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.voteCoordinate);
          line = tmpl(speaker.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.analysis);
          line = target ? tmpl(speaker.name, target.name) : tmpl(speaker.name);
        }
      }

      if (line) {
        state.policeChat.push(line);
        state.privateLogs.police = state.privateLogs.police || [];
        state.privateLogs.police.push(line);
      }

      // Second police may respond
      const otherPolice = police.filter((p) => p.id !== speaker.id);
      if (otherPolice.length > 0 && state.rng() < 0.5) {
        const responder = randomChoice(otherPolice, state.rng);
        const target = randomChoice(nonPolice, state.rng);
        let reply = null;
        const roll2 = state.rng();
        if (roll2 < 0.4 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.investigatePlan);
          reply = tmpl(responder.name, target.name);
        } else if (roll2 < 0.7 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.analysis);
          reply = tmpl(responder.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.police.analysis);
          reply = tmpl(responder.name);
        }
        if (reply) {
          state.policeChat.push(reply);
          state.privateLogs.police.push(reply);
        }
      }
    }
  }

  // ── Grudge Chat ──
  const grudge = alive.filter((p) => p.role === Roles.GRUDGE_BEAST.id && !p.isHuman);
  if (grudge.length > 0) {
    state.grudgeChat = state.grudgeChat || [];
    const speaker = randomChoice(grudge, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonGrudge = alive.filter((t) => t.role !== Roles.GRUDGE_BEAST.id);
      const roll = state.rng();
      let line = null;

      const target = randomChoice(nonGrudge, state.rng);

      if (state.grudgeState.berserk) {
        if (roll < 0.6 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.berserkPlan);
          line = tmpl(speaker.name, target.name);
        } else {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.berserkPlan);
          line = tmpl(speaker.name);
        }
      } else {
        if (roll < 0.4 && target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.judgePlan);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.7) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.survival);
          line = tmpl(speaker.name);
        } else if (target) {
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.judgePlan);
          line = tmpl(speaker.name, target.name);
        }
      }

      if (line) {
        state.grudgeChat.push(line);
        state.privateLogs.grudge = state.privateLogs.grudge || [];
        state.privateLogs.grudge.push(line);
      }
    }
  }
}

// ─── Last Words Generation ─────────────────────────────────────────────────

const LAST_WORDS_TEMPLATES = {
  // Blue player dies — try to leave useful intel
  blueAccuse: [
    (name, t) => `Watch out for ${t}...||小心 ${t}⋯`,
    (name, t) => `I'm sure ${t} is the killer.||我確定 ${t} 是殺手。`,
    (name, t) => `${t} did this to me. Don't let them get away.||是 ${t} 害我的，別放過他。`,
    (name, t) => `Vote ${t} next, trust me.||下次投 ${t}，相信我。`,
    (name, t) => `I've been watching ${t}... they're not clean.||我一直在觀察 ${t}⋯他不乾淨。`,
  ],
  blueDefend: [
    (name, t) => `Protect ${t}, they're one of us.||保護 ${t}，他是自己人。`,
    (name, t) => `${t} is innocent, I'm certain.||${t} 是無辜的，我很確定。`,
    (name, t) => `Don't vote ${t}, I checked them.||別投 ${t}，我查過了。`,
  ],
  blueGeneral: [
    (name) => `Don't trust the quiet ones...||別相信那些沉默的人⋯`,
    (name) => `Think about who voted for me.||想想誰投了我。`,
    (name) => `The truth will come out.||真相會大白的。`,
    (name) => `I did my best for the team.||我為大家盡力了。`,
  ],
  // Police dies — reveal investigation results
  policeReveal: [
    (name, t) => `I confirmed ${t} is RED!||我確認 ${t} 是紅方！`,
    (name, t) => `My investigation: ${t} is suspicious.||我的調查結果：${t} 有問題。`,
    (name, t) => `${t} is clean, protect them.||${t} 是好人，保護他。`,
  ],
  // Red player dies — mislead or frame innocents
  redBluff: [
    (name, t) => `I know ${t} is the killer...||我知道 ${t} 是殺手⋯`,
    (name, t) => `${t} betrayed me.||${t} 出賣了我。`,
    (name, t) => `Look into ${t}, something's off.||去查 ${t} 吧，有問題。`,
    (name, t) => `Don't trust ${t}.||別相信 ${t}。`,
  ],
  redProtectAlly: [
    (name, t) => `${t} is definitely clean.||${t} 絕對沒問題。`,
    (name, t) => `I trust ${t} with my life.||我用命擔保 ${t}。`,
  ],
  redDeflect: [
    (name) => `I was wrongly accused...||我是被冤枉的⋯`,
    (name) => `You got the wrong person.||你們抓錯人了。`,
    (name) => `This was a mistake, you'll see.||這是個錯誤，你們會明白的。`,
    (name) => `I'm innocent...||我是無辜的⋯`,
  ],
  // Green player dies
  greenGrudge: [
    (name) => `You'll pay for this...||你們會付出代價的⋯`,
    (name) => `The beasts will avenge me.||怨獸們會替我報仇。`,
    (name, t) => `${t} will regret this.||${t} 會後悔的。`,
  ],
  greenZombie: [
    (name) => `The infection spreads...||感染在蔓延⋯`,
    (name) => `It's too late to stop it.||已經來不及阻止了。`,
  ],
  // Generic (any role, low-info fallback)
  generic: [
    (name) => `...||⋯`,
    (name) => `Good luck everyone.||大家加油吧。`,
    (name) => `I have nothing to say.||我沒什麼好說的。`,
  ],
};

/**
 * Generate strategic last words for a dying AI player.
 * Hard+: uses role knowledge and suspicion to leave impactful messages.
 * Normal/Easy: generic or simple messages.
 */
export function generateLastWords(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player || player.alive) return "";
  if (player.noLastWords) return "";
  if (player.isHuman) return "";
  const hard = isHard(state);

  // Easy/Normal: mostly generic, occasionally accuse highest suspicion
  if (!hard) {
    if (state.rng() < 0.5) return "";  // 50% say nothing
    const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.generic);
    return tmpl(player.name);
  }

  // ── Hard+ strategic last words ──
  const alive = alivePlayers(state).filter((p) => p.id !== player.id);
  ensureAdvancedMemory(player);

  // Find highest suspicion target
  let mostSuspicious = null;
  let highestSusp = -1;
  // Find most trusted target (lowest suspicion)
  let mostTrusted = null;
  let lowestSusp = 2;
  for (const t of alive) {
    const s = player.aiMemory?.suspicion?.[t.id] ?? 0.5;
    if (s > highestSusp) { highestSusp = s; mostSuspicious = t; }
    if (s < lowestSusp) { lowestSusp = s; mostTrusted = t; }
  }

  // ── BLUE faction dying ──
  if (player.faction === Faction.BLUE) {
    // Police: reveal investigation intel
    if (player.role === Roles.POLICE.id) {
      // If there's a revealed red, reinforce it
      if (state.policeRevealedRed !== null) {
        const redTarget = getPlayer(state, state.policeRevealedRed);
        if (redTarget?.alive) {
          const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.policeReveal);
          return tmpl(player.name, redTarget.name);
        }
      }
      // Otherwise accuse most suspicious
      if (mostSuspicious && highestSusp > 0.5) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.policeReveal);
        return tmpl(player.name, mostSuspicious.name);
      }
    }

    // Doctor/Agent: defend who they were protecting or accuse likely killer
    if (player.role === Roles.DOCTOR.id || player.role === Roles.AGENT.id) {
      if (mostTrusted && state.rng() < 0.4) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.blueDefend);
        return tmpl(player.name, mostTrusted.name);
      }
    }

    // General blue: accuse most suspicious if confidence is high
    if (mostSuspicious && highestSusp > 0.55) {
      const roll = state.rng();
      if (roll < 0.6) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.blueAccuse);
        return tmpl(player.name, mostSuspicious.name);
      }
      if (roll < 0.8) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.blueGeneral);
        return tmpl(player.name);
      }
    }
    // Low confidence: generic
    const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.blueGeneral);
    return tmpl(player.name);
  }

  // ── RED faction dying ──
  if (player.faction === Faction.RED) {
    const roll = state.rng();
    // 35%: frame an innocent blue player
    if (roll < 0.35) {
      const innocents = alive.filter((t) => t.faction !== Faction.RED);
      const frameTarget = innocents.length > 0
        ? randomChoice(innocents, state.rng)
        : mostSuspicious;
      if (frameTarget) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.redBluff);
        return tmpl(player.name, frameTarget.name);
      }
    }
    // 20%: subtly defend a killer ally
    if (roll < 0.55) {
      const allies = alive.filter((t) => t.role === Roles.KILLER.id);
      if (allies.length > 0) {
        const ally = randomChoice(allies, state.rng);
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.redProtectAlly);
        return tmpl(player.name, ally.name);
      }
    }
    // 45%: deflect (claim innocence)
    const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.redDeflect);
    return tmpl(player.name);
  }

  // ── GREEN faction dying ──
  if (player.faction === Faction.GREEN) {
    if (player.role === Roles.GRUDGE_BEAST.id) {
      if (mostSuspicious && state.rng() < 0.5) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.greenGrudge);
        return tmpl(player.name, mostSuspicious.name);
      }
      const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.greenGrudge);
      return tmpl(player.name);
    }
    if (player.role === Roles.ZOMBIE.id) {
      const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.greenZombie);
      return tmpl(player.name);
    }
  }

  // Fallback
  const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.generic);
  return tmpl(player.name);
}
