import { alivePlayers, getPlayer } from "../state.js";
import { Roles, Faction, roleMeta, roleListFromTheme } from "../roles.js";
import { clamp, isHard, randomChoice, shuffled, getGamePhase, ensureAdvancedMemory, pickTemplate } from "./utils.js";
import { analyzeVotingPatterns, analyzeChatBehavior, factionProb, publicPoliceConfirmed } from "./analysis.js";
import { ensureBeliefs } from "./memory.js";
import { pickTargetBySuspicion } from "./targeting.js";
import { CHAT_TEMPLATES } from "./templates.js";

// ─── Voting ────────────────────────────────────────────────────────────────

export function buildAiVoteActions(state, humanVoteTargetId = null, opts = {}) {
  const includeHuman = opts.includeHuman === true;
  const humanVoteDist = opts.humanVoteDist || {};
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

  // Check if police publicly revealed a red in this round's dayChat
  // Non-police should only follow the reveal if it was actually announced
  const revealedRedTarget = (state.policePublicRevealedRed ?? null) !== null ? getPlayer(state, (state.policePublicRevealedRed ?? null)) : null;
  const policePubliclyRevealed = revealedRedTarget && chats.some((line) => {
    if (line.startsWith("[VOTE] ") || line.startsWith("[LAST] ")) return false;
    // Check if any police speaker mentioned the revealed red with accusation keywords
    const en = (line.split("||")[0] || "").toLowerCase();
    return line.includes(revealedRedTarget.name) &&
      (en.includes("red") || en.includes("confirmed") || en.includes("investigation"));
  });

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
  const voteSavedIds = new Set(hard ? (state.lastNightSavedIds || []) : []);

  // Hard+: collect police-confirmed reds — only if publicly revealed
  const confirmedRedIds = new Set();
  if (hard && state.policePublicRevealedRed != null && state.policeConfirmed) {
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

  // Hard+: arson-marked players are likely blue (arsonist is red, targets suspected blues)
  const voteArsonMarkedIds = new Set();
  if (hard) {
    for (const p of state.players) {
      if (p.alive && p.status.arsonMarked) voteArsonMarkedIds.add(p.id);
    }
  }

  // Hard+: players accused by confirmed/dead reds are likely blue (reds target threats)
  const accusedByRedIds = new Set();
  if (hard) {
    for (const p of state.players) {
      if (!p.alive || !p.aiMemory?.chatMemory) continue;
      for (const m of p.aiMemory.chatMemory) {
        if (m.accusedId === null) continue;
        // Check if the accuser is a known red (dead red or police-confirmed)
        const speaker = getPlayer(state, m.speakerId);
        if (!speaker) continue;
        const isKnownRed = (!speaker.alive && speaker.faction === Faction.RED) ||
          (state.policePublicRevealedRed != null && state.policeConfirmed?.[m.speakerId] === true);
        if (isKnownRed) accusedByRedIds.add(m.accusedId);
      }
    }
  }

  // Hard+: red execution opposers — who voted for someone else when a red was executed?
  const redExecOpposerCount = {};
  if (hard) {
    const voteExecutedReds = state.players.filter((p) => !p.alive && p.deathCause === "VOTE_EXECUTION" && p.faction === Faction.RED);
    for (const dead of voteExecutedReds) {
      for (const round of (state.history?.votes || [])) {
        if (!round.order || !round.tally) continue;
        const theirVotes = round.tally[dead.id] || 0;
        const maxVotes = Math.max(0, ...Object.values(round.tally));
        if (theirVotes > 0 && theirVotes === maxVotes) {
          // This round executed this red — who voted for someone ELSE?
          for (const entry of round.order) {
            if (entry.targetId !== dead.id) {
              redExecOpposerCount[entry.actorId] = (redExecOpposerCount[entry.actorId] || 0) + 1;
            }
          }
        }
      }
    }
  }

  // Hard+: red defenders — who defended players later revealed as red?
  const redDefenderIds = new Set();
  // Hard+: blue-defended players — who was defended by police or confirmed-blue speakers?
  const blueDefendedIds = new Set();
  if (hard) {
    const deadReds = state.players.filter((p) => !p.alive && p.faction === Faction.RED);
    for (const p of state.players) {
      if (!p.aiMemory?.chatMemory) continue;
      for (const m of p.aiMemory.chatMemory) {
        if (m.defendedId === null) continue;
        if (deadReds.some((dr) => dr.id === m.defendedId)) {
          redDefenderIds.add(m.speakerId);
        }
        // Track players defended by publicly-known police or confirmed-blue speakers
        const speaker = getPlayer(state, m.speakerId);
        if (speaker) {
          // Only treat as police if they publicly claimed the role (no hidden role access)
          const claimedPolice = state.roleClaims?.[speaker.id] === Roles.POLICE.id;
          const isKnownBlue = speaker.alive &&
            (voteSavedIds.has(speaker.id) || correctVoterIds.has(speaker.id));
          if (claimedPolice || isKnownBlue) {
            blueDefendedIds.add(m.defendedId);
          }
        }
      }
    }
  }

  // Hard+: red count awareness — how many reds remain vs total expected?
  const themeRoles = roleListFromTheme(state.theme);
  const totalExpectedRed = hard ? themeRoles.filter((r) => roleMeta(r).faction === Faction.RED).length : 0;
  const deadRedCount = hard ? state.players.filter((p) => !p.alive && p.faction === Faction.RED).length : 0;
  const remainingRedEstimate = totalExpectedRed - deadRedCount;

  // Hard+: grudge beast awareness — both blue and red benefit from vote-executing grudge beasts
  // Vote execution is SAFE (doesn't trigger berserk), night-killing is DANGEROUS
  // If any grudge beast survives, they steal victory via survival override
  const totalExpectedGreen = hard ? themeRoles.filter((r) => roleMeta(r).faction === Faction.GREEN).length : 0;
  const hasGrudgeInTheme = totalExpectedGreen > 0;
  // Estimate alive grudge beasts from beliefs, not real roles (avoid info leak)
  // Dead players' roles are public, so subtract confirmed dead grudge beasts from expected count
  const deadGrudgeCount = hasGrudgeInTheme ? state.players.filter(
    (p) => !p.alive && p.role === Roles.GRUDGE_BEAST.id
  ).length : 0;
  const aliveGrudgeEstimate = Math.max(0, totalExpectedGreen - deadGrudgeCount);

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
      if (topSusp < 0.35 && (state.policePublicRevealedRed ?? null) === null && state.rng() < abstainChance) {
        // Abstain — low confidence, no police intel
        return;
      }
    }

    // Hard+: Brat strategy — follow the majority, don't stand out
    // Before revealed: blend in by voting with the crowd
    if (hard && actor.role === Roles.BRAT.id && !actor.status.bratRevealed) {
      // Follow police reveal if available
      if ((state.policePublicRevealedRed ?? null) !== null) {
        const redTarget = getPlayer(state, (state.policePublicRevealedRed ?? null));
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

    // ── Zombie voting strategy: blend in by voting like blue (high suspicion targets) ──
    // Zombies want the game to last long enough to snowball conversions.
    // Best strategy: vote out killers (reduces red threat) and blend with blue voters.
    if (hard && actor.role === Roles.ZOMBIE.id) {
      // Follow police reveal like blue would — blending in
      if (policePubliclyRevealed) {
        const redTarget = getPlayer(state, (state.policePublicRevealedRed ?? null));
        if (redTarget?.alive && state.rng() < 0.9) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redTarget.id });
          return;
        }
      }
      // Vote for whoever has the highest suspicion (mimic blue behavior to avoid detection)
      const zombieCandidates = alivePlayers(state).filter((t) => t.id !== actor.id && t.role !== Roles.ZOMBIE.id);
      if (zombieCandidates.length > 0) {
        let bestTarget = null;
        let bestSusp = -1;
        for (const t of zombieCandidates) {
          const s = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
          // Prefer voting killers out — they kill zombie's conversion targets
          const killerBonus = (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0) * 0.3;
          const totalScore = s + killerBonus + (state.rng() - 0.5) * 0.1;
          if (totalScore > bestSusp) { bestSusp = totalScore; bestTarget = t; }
        }
        if (bestTarget) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: bestTarget.id });
          return;
        }
      }
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
    // Non-police blue: only follow reveal if police actually announced it in public chat
    // Hard+: skepticism — doubt claims from "police" who haven't shown prior investigation behavior
    if (policePubliclyRevealed && actor.faction === Faction.BLUE && actor.role !== Roles.POLICE.id) {
      const redTarget = getPlayer(state, state.policeRevealedRed);
      let followPoliceChance = { easy: 0.5, normal: 0.7, hard: 0.95, nightmare: 0.98 };
      let chance = followPoliceChance[state.difficulty || "normal"] ?? 0.7;

      // Hard+: check if the claimer is trustworthy
      if (hard) {
        // Find who claimed police in roleClaims
        const policeClaimer = Object.entries(state.roleClaims || {}).find(
          ([_, role]) => role === Roles.POLICE.id
        );
        if (policeClaimer) {
          const claimerId = Number(policeClaimer[0]);
          ensureAdvancedMemory(actor);
          const claimerSusp = actor.aiMemory?.suspicion?.[claimerId] ?? 0.5;

          // If the claimer is already suspicious, doubt them
          if (claimerSusp > 0.5) {
            chance *= 0.4; // heavily reduced follow rate
          }

          // If someone else already claimed police (duplicate claim), doubt both
          const policeClaimers = Object.entries(state.roleClaims || {}).filter(
            ([_, role]) => role === Roles.POLICE.id
          );
          if (policeClaimers.length >= 2) {
            chance *= 0.3; // two "police" = one is lying
          }

          // If this is a late-game claim (day 4+) with no prior police chat, doubt it
          if ((state.dayNumber || 1) >= 4) {
            const priorPoliceChat = chats.some(line => {
              const en = (line.split("||")[0] || "").toLowerCase();
              return en.includes("investigation") || en.includes("confirmed") || en.includes("checked");
            });
            if (!priorPoliceChat) {
              chance *= 0.5; // sudden late claim with no history
            }
          }
        }
      }

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
      // Red only knows about exposed teammate if police publicly announced it
      const redTargetId = policePubliclyRevealed ? state.policeRevealedRed : null;
      const exposedRed =
        redTargetId !== null ? getPlayer(state, redTargetId) : null;

      // Sell out exposed teammates — blue penalizes "red execution opposers"
      // 60% sell out early game, 85% late game (blending matters more late)
      if (exposedRed?.alive && exposedRed.id !== actor.id) {
        const sellOutRate = (state.dayNumber || 1) >= 4 ? 0.85 : 0.60;
        if (state.rng() < sellOutRate) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: exposedRed.id });
          return;
        }
      }

      // Hard+: red faction also wants to vote-execute grudge beasts (safe, prevents override)
      if (hasGrudgeInTheme && aliveGrudgeEstimate > 0 && state.rng() < 0.6) {
        let bestGrudge = null;
        let bestGrudgeProb = 0;
        for (const t of candidates) {
          const gp = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.GRUDGE_BEAST?.id] ?? 0;
          if (gp > bestGrudgeProb) { bestGrudgeProb = gp; bestGrudge = t; }
        }
        if (bestGrudge && bestGrudgeProb > 0.3) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: bestGrudge.id });
          return;
        }
      }

      // Hard+ killer vote scatter: strategically target dangerous blues instead of random
      if (actor.role === Roles.KILLER.id && killerVoteTargets.size > 0) {
        const scatterCandidates = candidates.filter((t) => !killerVoteTargets.has(t.id));
        if (scatterCandidates.length > 0 && state.rng() < 0.6) {
          // Prefer targeting confirmed/effective blues: saved players, correct voters
          let scatterTarget = null;
          let scatterBest = -Infinity;
          for (const t of scatterCandidates) {
            let ts = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
            // Invert: killers want to vote AGAINST blues (low suspicion = blue = target)
            ts = 1.0 - ts;
            if (voteSavedIds.has(t.id)) ts += 0.3;
            if (correctVoterIds.has(t.id)) ts += 0.2;
            ts += (state.rng() - 0.5) * 0.2;
            if (ts > scatterBest) { scatterBest = ts; scatterTarget = t; }
          }
          if (scatterTarget) {
            killerVoteTargets.add(scatterTarget.id);
            votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: scatterTarget.id });
            return;
          }
        }
      }

      // Hard+: killer vote mimicry — sometimes vote like blue to blend in
      // Pick the highest-suspicion target (same as blue would) to avoid detection
      if (actor.role === Roles.KILLER.id && state.rng() < 0.35) {
        let mimicBest = null;
        let mimicBestScore = -Infinity;
        for (const t of candidates) {
          const susp = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
          let ms = susp; // vote like blue: high suspicion = vote target
          if (correctVoterIds.has(t.id)) ms -= 0.1; // blue wouldn't vote correct voters
          if (voteSavedIds.has(t.id)) ms -= 0.15; // blue wouldn't vote saved players
          ms += (state.rng() - 0.5) * 0.15;
          if (ms > mimicBestScore) { mimicBestScore = ms; mimicBest = t; }
        }
        if (mimicBest) {
          if (killerVoteTargets) killerVoteTargets.add(mimicBest.id);
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: mimicBest.id });
          return;
        }
      }

      // Non-killer reds: also strategically target effective blues
      if (actor.role !== Roles.KILLER.id && state.rng() < 0.5) {
        let redVoteBest = null;
        let redVoteBestScore = -Infinity;
        for (const t of candidates) {
          let ts = 1.0 - (actor.aiMemory?.suspicion?.[t.id] ?? 0.5); // target blues
          if (voteSavedIds.has(t.id)) ts += 0.25;
          if (correctVoterIds.has(t.id)) ts += 0.15;
          ts += (state.rng() - 0.5) * 0.25;
          if (ts > redVoteBestScore) { redVoteBestScore = ts; redVoteBest = t; }
        }
        if (redVoteBest) {
          votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redVoteBest.id });
          return;
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

      // Hard+: progressive jitter reduction — less random as info accumulates
      const dayNum = state.dayNumber || 1;
      const aliveCount = alivePlayers(state).length;
      const jitterScale = hard ? clamp(1.0 - (dayNum - 1) * 0.1 - (18 - aliveCount) * 0.02, 0.4, 1.0) : 1.0;
      const voteJitter = (val) => clamp(val + (state.rng() - 0.5) * 0.3 * jitterScale, 0, 1);

      for (const t of candidates) {
        const redProb = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
        const base = hard ? voteJitter(redProb) : jitter(redProb);
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

        // Hard+: arson-marked = likely blue (arsonist targets suspected blues)
        if (hard && voteArsonMarkedIds.has(t.id)) {
          s -= 0.15;
        }

        // Hard+: accused by known reds = likely blue (reds target threats)
        if (hard && accusedByRedIds.has(t.id)) {
          s -= 0.1;
        }

        // Hard+: opposed red execution = suspicious (voted for someone else when red was killed)
        if (hard && redExecOpposerCount[t.id]) {
          s += Math.min(redExecOpposerCount[t.id] * 0.1, 0.25);
        }

        // Hard+: defended dead reds in chat = suspicious (red allies cover each other)
        if (hard && redDefenderIds.has(t.id)) {
          s += 0.1;
        }

        // Hard+: defended by police/known-blue = likely blue (strong protection signal)
        if (hard && blueDefendedIds.has(t.id)) {
          s -= 0.3;
        }

        // Hard+: grudge beast vote priority — vote-executing them is safe (no berserk)
        // and prevents survival override. Both blue and red benefit.
        if (hard && hasGrudgeInTheme && aliveGrudgeEstimate > 0) {
          const grudgeProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.GRUDGE_BEAST?.id] ?? 0;
          // Strong boost for confirmed/high-prob grudge targets
          if (grudgeProb > 0.4) s += 0.35;
          else if (grudgeProb > 0.2) s += 0.15;
        }

        // Hard+: survival suspicion — scale by night deaths and survival length
        if (hard && chatBehaviorVote && (state.dayNumber || 1) >= 3 && blueNightDeathsVote >= 2) {
          const speakRatio = (chatBehaviorVote.speakCount[t.id] || 0) / maxSpokenVote;
          // Stronger signal when more blues have died at night
          const deathMultiplier = Math.min(blueNightDeathsVote * 0.04, 0.16);
          if (speakRatio > 0.4) {
            s += deathMultiplier;
          }
        }

        // Hard+: red count awareness — conservative when few reds remain
        if (hard && remainingRedEstimate <= 2 && remainingRedEstimate > 0) {
          // Pull scores toward 0.5 to avoid friendly fire when few reds left
          s = 0.5 + (s - 0.5) * 0.85;
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

        // Bandwagon: AI allies follow human teammate vote momentum
        if (hard) {
          const humanVotes = humanVoteDist[t.id] || 0;
          if (humanVotes > 0) s += 0.12 * humanVotes;
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
    const consensusIsSafe = voteSavedIds.has(consensusTarget) || correctVoterIds.has(consensusTarget)
      || voteArsonMarkedIds.has(consensusTarget) || accusedByRedIds.has(consensusTarget);

    // Trust check: is the consensus backed by trusted blue voters?
    let trustedVotersInConsensus = 0;
    for (const v of votes) {
      if (v.targetId !== consensusTarget) continue;
      if (voteSavedIds.has(v.actorId) || correctVoterIds.has(v.actorId)) trustedVotersInConsensus++;
    }
    const consensusTrusted = trustedVotersInConsensus > 0;

    for (let i = 0; i < votes.length; i++) {
      const v = votes[i];
      if (v.targetId === consensusTarget) continue; // already voting consensus
      const actor = getPlayer(state, v.actorId);
      if (!actor || actor.isHuman) continue;
      // Red AI joins consensus to blend in — but only if target isn't a fellow red
      if (actor.faction === Faction.RED) {
        const conTarget = getPlayer(state, consensusTarget);
        // Only bandwagon if target isn't a red teammate AND consensus is strong
        if (!conTarget || conTarget.faction === Faction.RED || consensusCount < 3) continue;
        // Lower rate than blue (25%) — blend occasionally, not always
        if (state.rng() >= 0.25) continue;
        const currentVotesR = tally[v.targetId] || 0;
        if (currentVotesR <= 1 && consensusCount >= 3) {
          tally[v.targetId] = (tally[v.targetId] || 0) - 1;
          v.targetId = consensusTarget;
          tally[consensusTarget] = (tally[consensusTarget] || 0) + 1;
        }
        continue;
      }
      if (consensusIsSafe) continue; // don't bandwagon onto known blues

      // Bandwagon rate: higher if consensus is backed by trusted voters
      const bandwagonRate = consensusTrusted ? 0.55 : 0.4;
      if (state.rng() >= bandwagonRate) continue;

      // Only switch if they have real suspicion on the consensus target
      ensureAdvancedMemory(actor);
      const consensusSusp = actor.aiMemory?.suspicion?.[consensusTarget] ?? 0.5;
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
      const raw = tmpl(actor.name, target.name);
      // Tag vote-phase lines so chat memory parser skips them (avoids artificial accusation signal)
      const line = "[VOTE] " + raw;
      state.dayChat.push(line);
      state.publicLog.push(line);
      explained++;
    }
  }

  // ── Vote correction: if AI publicly accused X but is voting Y, add a "changed my mind" line ──
  if (hard && votes.length > 0 && state.dayChat) {
    // Build map: speakerId -> set of accused targetIds from dayChat
    // Sort players by name length descending to avoid prefix collisions (Player 15 before Player 1)
    const playersByNameLen = [...state.players].filter(Boolean).sort((a, b) => b.name.length - a.name.length);
    const chatAccused = {};
    for (const line of state.dayChat) {
      // Find speaker
      let speakerId = null;
      for (const p of playersByNameLen) {
        if (line.startsWith(p.name + ":")) { speakerId = p.id; break; }
      }
      if (speakerId === null) continue;
      const en = (line.split("||")[0] || line).toLowerCase();
      const zh = line.includes("||") ? line.split("||")[1] : "";
      const isAccusation = en.includes("suspicious") || en.includes("vote") || en.includes("don't trust") ||
        en.includes("confirmed red") || en.includes("has to go") || en.includes("not who they seem") ||
        en.includes("acting weird") || en.includes("doesn't add up") || en.includes("watching them") ||
        zh.includes("可疑") || zh.includes("投") || zh.includes("不信任") || zh.includes("有問題");
      if (!isAccusation) continue;
      // Find accused target (longest name match first to avoid prefix collision)
      for (const other of playersByNameLen) {
        if (other.id === speakerId) continue;
        if (line.includes(other.name)) {
          if (!chatAccused[speakerId]) chatAccused[speakerId] = new Set();
          chatAccused[speakerId].add(other.id);
          break; // one accused per line
        }
      }
    }

    let corrections = 0;
    for (const v of votes) {
      if (corrections >= 2) break;
      const actor = getPlayer(state, v.actorId);
      if (!actor || actor.isHuman) continue;
      const accused = chatAccused[v.actorId];
      if (!accused || accused.size === 0) continue;
      // If the AI accused someone but is voting a different person, and never accused their vote target
      if (!accused.has(v.targetId) && state.rng() < 0.35) {
        const target = getPlayer(state, v.targetId);
        if (!target) continue;
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.voteCorrection);
        const raw = tmpl(actor.name, target.name);
        const line = "[VOTE] " + raw;
        state.dayChat.push(line);
        state.publicLog.push(line);
        corrections++;
      }
    }
  }

  return votes;
}
