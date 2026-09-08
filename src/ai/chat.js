import { alivePlayers, getPlayer } from "../state.js";
import { Roles, Faction } from "../roles.js";
import { isHard, randomChoice, shuffled, getGamePhase, ensureAdvancedMemory, pickTemplate, roleNameZh, mentionedPlayerIds } from "./utils.js";
import { analyzeChatBehavior, analyzeVotingPatterns, factionProb, publicPoliceConfirmed, recordPublicRedClaim } from "./analysis.js";
import { ensureBeliefs } from "./memory.js";
import { pickKillerSmartTarget, pickPoliceSmartTarget } from "./targeting.js";
import { CHAT_TEMPLATES, FACTION_CHAT, NIGHT_FACTION_CHAT, LAST_WORDS_TEMPLATES } from "./templates.js";

export function generateChatLines(state, maxLines = 6) {
  const lines = [];
  const living = alivePlayers(state).filter((p) => !p.isHuman);
  const hard = isHard(state);
  const redFound = state.policeRevealedRed !== null ? getPlayer(state, state.policeRevealedRed) : null;
  const voteHist = state.history?.votes || [];
  const lastRound = voteHist[voteHist.length - 1];
  const recentDeaths = state.players.filter((p) => !p.alive && p.deathCause);
  const publicClearedBlueIds = new Set(hard ? (state.policePublicClearedBlueIds || []) : []);
  const recentlySavedIds = new Set(hard ? (state.lastNightSavedIds || []) : []);

  // Shuffle speakers for natural order variety
  const speakers = shuffled(living, state.rng);

  // Track who accused whom in this round for bandwagon detection (improvement 6)
  const accuseCounts = {}; // accuseCounts[targetId] = count of accuse lines
  // Track whether police has publicly revealed a red in this round's chat
  let policeRevealedInChat = false;
  // Track speakers who already have a line (prevent contradictory replies)
  const spokenSpeakers = new Set();

  // Advanced: Game phase for chat tone adjustment
  const gamePhase = hard ? getGamePhase(state) : "mid";

  const markPoliceClaim = (policeId) => {
    state.roleClaims = state.roleClaims || {};
    state.roleClaims[policeId] = Roles.POLICE.id;
  };

  const markPublicInvestigationResult = (policeId, result) => {
    markPoliceClaim(policeId);
    if (!result) return;
    if (result.result === "red") {
      recordPublicRedClaim(state, result.targetId);
      state.policeConfirmed = state.policeConfirmed || {};
      state.policeConfirmed[result.targetId] = true;
    } else if (result.result === "blue") {
      state.policePublicClearedBlueIds = state.policePublicClearedBlueIds || [];
      if (!state.policePublicClearedBlueIds.includes(result.targetId)) {
        state.policePublicClearedBlueIds.push(result.targetId);
      }
    }
  };

  if (hard && redFound?.alive && (state.policePublicRevealedRed ?? null) === null && (state.dayNumber || 1) >= 2) {
    const policeAlive = living.filter((p) => p.role === Roles.POLICE.id);
    const revealingPolice = policeAlive
      .filter((p) => !p.isHuman)
      .sort((a, b) => (b.aiMemory?.selfThreat || 0) - (a.aiMemory?.selfThreat || 0))[0];
    if (revealingPolice) {
      const dayNum = state.dayNumber || 1;
      const lastRound = state.history?.votes?.[state.history.votes.length - 1] || null;
      const priorVotesOnRed = lastRound?.tally?.[redFound.id] || 0;
      const selfThreat = revealingPolice.aiMemory?.selfThreat || 0;
      const forcedReveal =
        policeAlive.length <= 2 ||
        selfThreat >= 0.5 ||
        priorVotesOnRed >= 2 ||
        dayNum >= 4;
      const revealChance = dayNum === 2 ? 0.75 : 0.9;

      if (forcedReveal || state.rng() < revealChance) {
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeRevealRed);
        lines.push(tmpl(revealingPolice.name, redFound.name));
        markPublicInvestigationResult(revealingPolice.id, { targetId: redFound.id, result: "red" });
        policeRevealedInChat = true;
        spokenSpeakers.add(revealingPolice.id);
      }
    }
  }

  for (const speaker of speakers) {
    if (lines.length >= maxLines) break;
    if (spokenSpeakers.has(speaker.id)) continue;
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

    if (hard && speaker.faction === Faction.BLUE && speaker.role === Roles.CIVILIAN.id && state.rng() < 0.45) {
      const publicSafeTargets = allCandidates.filter((t) =>
        publicClearedBlueIds.has(t.id) ||
        recentlySavedIds.has(t.id)
      );
      let safeTarget = null;
      let safePressure = -Infinity;
      for (const t of publicSafeTargets) {
        const priorVotes = lastRound?.tally?.[t.id] || 0;
        const priorMentions = lastRound?.mentions?.[t.id] || 0;
        const suspicion = speaker.aiMemory?.suspicion?.[t.id] ?? 0.5;
        const pressure = suspicion + priorVotes * 0.35 + priorMentions * 0.12;
        if (pressure > safePressure) {
          safePressure = pressure;
          safeTarget = t;
        }
      }
      if (safeTarget && (safePressure >= 0.65 || state.rng() < 0.2)) {
        if (publicClearedBlueIds.has(safeTarget.id)) {
          lines.push(`${speaker.name}: ${safeTarget.name} was publicly cleared blue, don't waste votes there.||${speaker.name}：${safeTarget.name} 已公開查藍，別浪費票在他身上。`);
        } else if (recentlySavedIds.has(safeTarget.id)) {
          lines.push(`${speaker.name}: ${safeTarget.name} was protected last night, don't rush that vote.||${speaker.name}：${safeTarget.name} 昨晚被救過，先別急著投他。`);
        }
        spokenSpeakers.add(speaker.id);
        continue;
      }
    }

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

    // ── Fake police claim (40% chance, once per game, killer only) ──
    // Killer pretends to be police and frames a blue player as "confirmed red".
    // Writes to roleClaims so the belief system treats it as a real police reveal,
    // misleading blue AI into voting out their own teammate.
    if (hard && isRedSpeaker && speaker.role === Roles.KILLER.id &&
        !speaker.aiMemory.fakePoliceClaimUsed &&
        (state.policePublicRevealedRed ?? null) === null &&
        (state.dayNumber || 1) >= 2 &&
        state.rng() < 0.40) {
      // Strategic target selection: pick the most dangerous blue player to frame
      // Killers can see other killers, so frame non-killers only
      const framePool = allCandidates.filter((t) => t.role !== Roles.KILLER.id);
      let frameTarget = null;
      let bestFrameScore = -Infinity;

      for (const t of framePool) {
        let fs = 0;
        // Prefer framing active speakers (they're influential — removing them hurts blue)
        const speakRatio = (state.dayChat || []).filter(l => l.startsWith(t.name + ":")).length;
        fs += speakRatio * 0.3;
        // Prefer framing players who accused killers (they're onto us)
        const accusedKiller = (speaker.aiMemory?.chatMemory || []).some(
          m => m.speakerId === t.id && m.accusedId !== null &&
               state.players[m.accusedId]?.role === Roles.KILLER.id
        );
        if (accusedKiller) fs += 0.5;
        // Prefer framing players with high blue probability (more believable as "found red")
        const blueProb = factionProb(speaker, t.id, Faction.BLUE) ?? 0.5;
        if (blueProb > 0.6) fs += 0.3;
        // Avoid framing players already under heavy suspicion (less impactful)
        const susp = speaker.aiMemory?.suspicion?.[t.id] ?? 0.5;
        if (susp > 0.6) fs -= 0.3;
        // Jitter
        fs += state.rng() * 0.15;

        if (fs > bestFrameScore) {
          bestFrameScore = fs;
          frameTarget = t;
        }
      }

      if (frameTarget) {
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.fakePoliceClaim);
        lines.push(tmpl(speaker.name, frameTarget.name));
        speaker.aiMemory.fakePoliceClaimUsed = true;

        // Write to roleClaims — killer is now "publicly claiming police"
        state.roleClaims = state.roleClaims || {};
        state.roleClaims[speaker.id] = Roles.POLICE.id;

        // Write fake "public reveal" so blue AI's vote logic picks it up
        // Only if no real police has revealed yet (otherwise it conflicts)
        if ((state.policePublicRevealedRed ?? null) === null) {
          recordPublicRedClaim(state, frameTarget.id);
        }

        continue;
      }
    }

    // ── Improvement 14: Trust building chat (15% chance for hard RED AI) ──
    if (hard && isRedSpeaker && state.rng() < 0.15) {
      // Defend low-suspicion players to seem credible (no true faction access)
      const lowSusp = allCandidates.filter((t) => (speaker.aiMemory?.suspicion?.[t.id] ?? 0.5) < 0.35);
      const trustTarget = randomChoice(lowSusp.length ? lowSusp : allCandidates, state.rng);
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
          if (claimedRole === speaker.role && speaker.faction === Faction.BLUE && claimedRole !== Roles.POLICE.id) {
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
          if (speaker.role === Roles.POLICE.id && claimedRole === Roles.POLICE.id) {
            if (claimer.role !== Roles.POLICE.id && state.rng() < 0.75) {
              const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.roleClaim.challenge);
              lines.push(tmpl(speaker.name, claimer.name, claimedRole, roleNameZh(claimedRole)));
              break;
            }
            continue;
          }
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
        const greenMatch = log.match(/Investigation result: (.+) is GREEN/);
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
        if (greenMatch) {
          const targetName = greenMatch[1];
          const targetPlayer = state.players.find((pl) => pl && pl.name === targetName);
          if (targetPlayer && !speaker.aiMemory.investigationResults.some((r) => r.targetId === targetPlayer.id)) {
            speaker.aiMemory.investigationResults.push({ targetId: targetPlayer.id, result: "green", day: dayNum });
          }
        }
      }

      const results = speaker.aiMemory.investigationResults;
      const redResults = results.filter((r) => r.result === "red");
      const blueResults = results.filter((r) => r.result === "blue");

      // Day 1: NEVER reveal
      if (dayNum >= 2) {
        // Find best alive red to reveal (not just first found — prioritize alive targets)
        const aliveRedResult = redResults.find((r) => {
          const tp = getPlayer(state, r.targetId);
          return tp?.alive;
        });
        // Find best alive blue to share
        const aliveBlueResult = blueResults.find((r) => {
          const tp = getPlayer(state, r.targetId);
          return tp?.alive;
        });

        // About to die: dump all info (prioritize this over normal reveals)
        if (selfThreat > 0.6 && results.length > 0 && !speaker.aiMemory.policeDeathDumped) {
          const infoParts = results.map((r) => {
            const tp = getPlayer(state, r.targetId);
            return tp ? `${tp.name}=${r.result.toUpperCase()}` : "";
          }).filter(Boolean);
          if (infoParts.length > 0) {
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeDeathDump);
            lines.push(tmpl(speaker.name, infoParts.join(", ")));
            for (const r of results) {
              markPublicInvestigationResult(speaker.id, r);
            }
            if (results.some((r) => r.result === "red")) {
              policeRevealedInChat = true;
            }
            speaker.aiMemory.policeDeathDumped = true;
            continue;
          }
        }
        // Day 2+: reveal red — early reveal is critical for vote accuracy
        // Day 2: 90% reveal (was selfThreat>0.3 gated — too conservative)
        // Day 3+: 85% reveal
        if (aliveRedResult && (state.policePublicRevealedRed ?? null) === null) {
          const revealChance = dayNum === 2 ? 0.9 : 0.85;
          if (state.rng() < revealChance) {
            const redTarget = getPlayer(state, aliveRedResult.targetId);
            if (redTarget) {
              const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeRevealRed);
              lines.push(tmpl(speaker.name, redTarget.name));
              policeRevealedInChat = true;
              markPublicInvestigationResult(speaker.id, { targetId: redTarget.id, result: "red" });
              continue;
            }
          }
        }
        // Share blue confirmations — help prevent friendly fire
        // Higher rate: 50% mid/late game, 30% early game
        if (aliveBlueResult) {
          const blueShareChance = gamePhase === "early" ? 0.3 : 0.5;
          // Boost further if the blue player is under vote pressure
          const blueTarget = getPlayer(state, aliveBlueResult.targetId);
          const lastVoteHistChat = (state.history?.votes || []).length > 0
            ? state.history.votes[state.history.votes.length - 1] : null;
          const blueVotes = lastVoteHistChat?.tally?.[aliveBlueResult.targetId] || 0;
          const underPressure = blueVotes >= 2;
          const finalChance = underPressure ? Math.min(blueShareChance + 0.3, 0.9) : blueShareChance;
          if (blueTarget && state.rng() < finalChance) {
            const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeRevealBlue);
            lines.push(tmpl(speaker.name, blueTarget.name));
            markPublicInvestigationResult(speaker.id, { targetId: blueTarget.id, result: "blue" });
            continue;
          }
        }
      }
    }

    // ── Police strategic reveal (legacy, kept for non-timed reveals) ──
    if (speaker.role === Roles.POLICE.id && redFound?.alive && (state.policePublicRevealedRed ?? null) === null && state.rng() < 0.8) {
      const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.policeReveal);
      lines.push(tmpl(speaker.name, redFound.name));
      policeRevealedInChat = true;
      markPublicInvestigationResult(speaker.id, { targetId: redFound.id, result: "red" });
      continue;
    }

    // ── Blue non-police follow police reveal — ONLY after police has publicly announced ──
    if (hard && policeRevealedInChat && (state.policePublicRevealedRed ?? null) !== null && speaker.faction === Faction.BLUE && speaker.role !== Roles.POLICE.id) {
      const revealedTarget = getPlayer(state, state.policePublicRevealedRed);
      if (revealedTarget?.alive && state.rng() < 0.85) {
        const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.followReveal);
        lines.push(tmpl(speaker.name, revealedTarget.name));
        continue;
      }
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

      // Bluff — aggressively accuse someone believed to be non-red
      if (deceptionRoll < bluffThreshold) {
        // Killers know other killers; non-Killer reds use suspicion
        const innocents = speaker.role === Roles.KILLER.id
          ? allCandidates.filter((t) => t.role !== Roles.KILLER.id)
          : allCandidates.filter((t) => (speaker.aiMemory?.suspicion?.[t.id] ?? 0.5) < 0.4);
        const bluffTarget = randomChoice(innocents.length ? innocents : allCandidates, state.rng);
        if (bluffTarget) {
          const tmpl = pickTemplate(state.rng, CHAT_TEMPLATES.bluff);
          lines.push(tmpl(speaker.name, bluffTarget.name));
          accuseCounts[bluffTarget.id] = (accuseCounts[bluffTarget.id] || 0) + 1;
          continue;
        }
      }

      // Defend a red ally subtly — only Killers can see other Killers
      if (deceptionRoll < bluffThreshold + 0.15) {
        let defendAlly = null;
        if (speaker.role === Roles.KILLER.id) {
          // Killers can see each other
          const allies = allCandidates.filter((t) => t.role === Roles.KILLER.id);
          defendAlly = randomChoice(allies, state.rng);
        } else {
          // Non-Killer reds (Sniper, Terrorist, etc.) can't see allies —
          // defend someone with low suspicion as a generic deflection
          const lowSusp = allCandidates.filter((t) => (speaker.aiMemory?.suspicion?.[t.id] ?? 0.5) < 0.35);
          defendAlly = randomChoice(lowSusp.length ? lowSusp : allCandidates, state.rng);
        }
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

    // ── Standard chat (uses vote-like scoring for target selection) ──
    let target = null;
    if (hard && state.rng() >= 0.2) {
      // 80%: pick target using vote-relevant signals (mirrors buildAiVoteActions scoring)
      let bestTarget = null;
      let bestScore = -Infinity;
      for (const t of allCandidates) {
        let s = speaker.aiMemory?.suspicion?.[t.id] ?? 0.5;
        // Bonus: voted together with known-dead reds
        for (const dead of state.players.filter((dp) => !dp.alive && dp.faction === Faction.RED)) {
          const voteHistory = speaker.aiMemory?.voteHistory || {};
          if (voteHistory[t.id]?.[dead.id]) s += 0.06;
        }
        // Penalty: saved players are confirmed blue
        const wasSaved = (state.lastNightSavedIds || []).includes(t.id);
        if (wasSaved) s -= 0.2;
        // Jitter for variety
        s += (state.rng() - 0.5) * 0.2;
        if (s > bestScore) { bestScore = s; bestTarget = t; }
      }
      target = bestTarget;
    }
    if (!target) {
      // 20%: random for natural variety
      target = randomChoice(allCandidates, state.rng);
    }
    const useTarget = target;
    const suspicion = speaker.aiMemory?.suspicion?.[useTarget?.id] ?? 0.5;
    let tone = suspicion > 0.6 ? "accuse" : suspicion < 0.3 ? "defend" : "wonder";
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
  // Build set of speakers who already have a line to prevent contradictions
  for (const line of lines) {
    for (const p of state.players) {
      if (p && line.startsWith(p.name + ":")) { spokenSpeakers.add(p.name); break; }
    }
  }
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
      const mentionedIds = mentionedPlayerIds(enPart, state.players);
      for (const p of state.players) {
        if (!p) continue;
        if (enPart.startsWith(p.name + ":")) speakerName = p.name;
        else if (mentionedIds.has(p.id)) accusedName = p.name;
      }
      if (!speakerName || !accusedName) continue;

      // Pick a responder (different from speaker, accused, and anyone who already spoke)
      const responders = living.filter(
        (p) => p.name !== speakerName && p.name !== accusedName && !spokenSpeakers.has(p.name)
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
      const accusedIds = mentionedPlayerIds(enPart, state.players);
      for (const p of state.players) {
        if (!p) continue;
        if (p.name === accuserName) continue;
        if (accusedIds.has(p.id) && p.alive && !p.isHuman) {
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

export function generateNightFactionChat(state) {
  if (!isHard(state)) return;

  const alive = alivePlayers(state);

  // ── Killer Night Chat (tactical briefing) ──
  const killers = alive.filter((p) => p.role === Roles.KILLER.id && !p.isHuman);
  if (killers.length > 0) {
    state.killerChat = state.killerChat || [];
    state.privateLogs.killer = state.privateLogs.killer || [];
    const speaker = randomChoice(killers, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonKillers = alive.filter((t) => t.role !== Roles.KILLER.id);
      const dayNum = state.dayNumber || 1;
      const isFirstNight = dayNum === 1;
      const s = speaker.name;
      const lines = [];

      // ─ Group consensus: each killer picks, majority wins ─
      const killerPicks = {};
      for (const k of killers) {
        const pick = pickKillerSmartTarget(state, k);
        if (pick) killerPicks[pick.id] = (killerPicks[pick.id] || 0) + 1;
      }
      let actualTarget = null;
      let bestCount = 0;
      for (const [tid, cnt] of Object.entries(killerPicks)) {
        if (cnt > bestCount || (cnt === bestCount && state.rng() < 0.5)) {
          bestCount = cnt;
          actualTarget = alivePlayers(state).find(p => p.id === Number(tid)) || null;
        }
      }
      // Store the coordinated target so buildAiNightActions uses the same one
      if (actualTarget) state._killerChatTarget = actualTarget.id;

      // Check if someone was saved last night
      const savedRecently = (state.lastNightSavedIds || []).length > 0;
      const savedName = savedRecently ? nonKillers.find((t) =>
        (state.lastNightSavedIds || []).includes(t.id)
      ) : null;

      // ─ Check for publicly-claimed police (highest priority kill) ─
      // Decided first so every line below describes the target we will actually attack.
      const claimedPoliceTarget = nonKillers.find((t) =>
        t.alive && state.roleClaims?.[t.id] === Roles.POLICE.id
      );
      if (claimedPoliceTarget && actualTarget?.id !== claimedPoliceTarget.id) {
        // Override target to the claimed police
        actualTarget = claimedPoliceTarget;
        state._killerChatTarget = actualTarget.id;
      }

      // Build role probability info for the chosen target
      const topProbs = actualTarget ? {
        policeProb: speaker.aiMemory?.roleProbs?.[actualTarget.id]?.[Roles.POLICE.id] ?? 0,
        doctorProb: speaker.aiMemory?.roleProbs?.[actualTarget.id]?.[Roles.DOCTOR.id] ?? 0,
        agentProb: speaker.aiMemory?.roleProbs?.[actualTarget.id]?.[Roles.AGENT.id] ?? 0,
        blueProb: factionProb(speaker, actualTarget.id, Faction.BLUE) ?? 0.5,
        wasSaved: savedName && savedName.id === actualTarget.id,
      } : null;
      const top = actualTarget ? { p: actualTarget, ...topProbs } : null;
      // Fallback alt target
      const altTarget = nonKillers.find((t) => t.id !== actualTarget?.id && t.alive);
      const alt = altTarget ? { p: altTarget } : null;

      // Find most suspected killer among our team (selfThreat)
      const allKillersAlive = alive.filter((p) => p.role === Roles.KILLER.id);
      const mostExposed = allKillersAlive.reduce((a, b) =>
        (a.aiMemory?.selfThreat ?? 0) > (b.aiMemory?.selfThreat ?? 0) ? a : b, allKillersAlive[0]);
      const exposedThreat = mostExposed?.aiMemory?.selfThreat ?? 0;

      // Police reveal danger — only if publicly announced
      const policeRevealed = (state.policePublicRevealedRed ?? null) !== null;
      const revealedIsUs = policeRevealed && allKillersAlive.some((k) => k.id === state.policePublicRevealedRed);

      // ─ Build tactical lines ─
      if (isFirstNight) {
        // First night: target recommendation + reasoning
        if (top) {
          const reason = top.policeProb > 0.15
            ? `police prob ${Math.round(top.policeProb * 100)}%||警察機率 ${Math.round(top.policeProb * 100)}%`
            : `high blue prob ${Math.round(top.blueProb * 100)}%||藍方機率高 ${Math.round(top.blueProb * 100)}%`;
          lines.push(`${s}: Target ${top.p.name} tonight (${reason.split("||")[0]}).||${s}：今晚目標 ${top.p.name}（${reason.split("||")[1]}）。`);
        }
      } else {
        // Subsequent nights: richer briefing

        // 0. PRIORITY: publicly-claimed police must die
        if (claimedPoliceTarget && claimedPoliceTarget.alive) {
          lines.push(`${s}: ${claimedPoliceTarget.name} claimed police and revealed our teammate — they MUST die tonight. Ignore protection.||${s}：${claimedPoliceTarget.name} 跳警揭露了我們的人，今晚必須殺掉。不管有沒有保護。`);
        }

        // 1. Save intel — exploit doctor's overdose dilemma
        if (top && top.wasSaved && !claimedPoliceTarget) {
          lines.push(`${s}: ${top.p.name} was saved last night — hit them again. Doctor can't protect twice without overdose risk.||${s}：${top.p.name} 昨晚被救了，再殺一次。醫生不敢連續保，會有過量風險。`);
        } else if (savedRecently && savedName) {
          lines.push(`${s}: ${savedName.name} got saved — attack again, the doctor has to switch or risk overdose.||${s}：${savedName.name} 被救了，再打一次，醫生必須換人保否則會過量。`);
        }

        // 2. Kill target + reasoning
        if (top && !top.wasSaved) {
          if (top.policeProb > 0.2) {
            lines.push(`${s}: Kill ${top.p.name} — ${Math.round(top.policeProb * 100)}% chance they're police.||${s}：殺 ${top.p.name}——${Math.round(top.policeProb * 100)}% 機率是警察。`);
          } else if (top.doctorProb > 0.15) {
            lines.push(`${s}: Go for ${top.p.name}, I think they're the doctor (${Math.round(top.doctorProb * 100)}%).||${s}：殺 ${top.p.name}，我認為他是醫生（${Math.round(top.doctorProb * 100)}%）。`);
          } else {
            lines.push(`${s}: ${top.p.name} is our best target — threat score highest.||${s}：${top.p.name} 是最佳目標，威脅最高。`);
          }
        } else if (alt) {
          lines.push(`${s}: Fallback to ${alt.p.name} (threat rank #2).||${s}：改殺 ${alt.p.name}（威脅排名第二）。`);
        }

        // 3. Team exposure warning
        if (exposedThreat > 0.5) {
          lines.push(`${s}: Warning — ${mostExposed.name} is getting suspected (${Math.round(exposedThreat * 100)}% threat). ${revealedIsUs ? "We're exposed, act fast." : "Lay low in chat."}||${s}：警告——${mostExposed.name} 被懷疑了（威脅度 ${Math.round(exposedThreat * 100)}%）。${revealedIsUs ? "已經暴露，加速行動。" : "聊天低調點。"}`);
        }

        // 4. Vote coordination for tomorrow
        if (state.rng() < 0.6) {
          // Find a blue who's already suspicious to frame
          const frameable = nonKillers.filter((t) => {
            const susp = speaker.aiMemory?.suspicion?.[t.id] ?? 0;
            return susp > 0.4;
          });
          if (frameable.length > 0) {
            const frame = randomChoice(frameable, state.rng);
            lines.push(`${s}: Tomorrow push ${frame.name} in chat — they're already at ${Math.round((speaker.aiMemory?.suspicion?.[frame.id] ?? 0) * 100)}% suspicion.||${s}：明天帶風向指控 ${frame.name}——他已經有 ${Math.round((speaker.aiMemory?.suspicion?.[frame.id] ?? 0) * 100)}% 嫌疑了。`);
          } else {
            lines.push(`${s}: Tomorrow scatter votes, don't cluster.||${s}：明天分散投票，別聚在一起。`);
          }
        }
      }

      // 5. Urgency if few killers remain
      if (allKillersAlive.length <= 2 && dayNum >= 3) {
        lines.push(`${s}: ${allKillersAlive.length} of us left — every kill counts now.||${s}：我們只剩 ${allKillersAlive.length} 人了，每一刀都關鍵。`);
      }

      // Push lines (cap at 3 to avoid flooding)
      const output = lines.slice(0, 3);
      for (const line of output) {
        state.killerChat.push(line);
        state.privateLogs.killer.push(line);
      }

      // ─ Responder reacts to speaker's briefing ─
      const otherKillers = killers.filter((k) => k.id !== speaker.id);
      if (otherKillers.length > 0 && output.length > 0 && state.rng() < 0.65) {
        const responder = randomChoice(otherKillers, state.rng);
        const r = responder.name;
        ensureAdvancedMemory(responder);
        let reply = null;

        // React contextually to the briefing
        if (top && top.wasSaved && alt) {
          reply = `${r}: Agreed, switch to ${alt.p.name}. The protection is too strong on ${top.p.name}.||${r}：同意，改殺 ${alt.p.name}。${top.p.name} 的保護太強了。`;
        } else if (top && top.policeProb > 0.2) {
          reply = `${r}: If ${top.p.name} really is police, we need them gone ASAP.||${r}：如果 ${top.p.name} 真的是警察，必須馬上解決。`;
        } else if (exposedThreat > 0.5) {
          reply = `${r}: I'll cover for ${mostExposed.name} in chat tomorrow.||${r}：明天我在聊天幫 ${mostExposed.name} 打掩護。`;
        } else if (top) {
          const agree = state.rng() < 0.7;
          if (agree) {
            reply = `${r}: Copy, ${top.p.name} it is.||${r}：收到，就 ${top.p.name}。`;
          } else if (alt) {
            reply = `${r}: I'd rather hit ${alt.p.name} — ${top.p.name} might be bait.||${r}：我比較想殺 ${alt.p.name}——${top.p.name} 可能是陷阱。`;
          }
        }

        if (reply) {
          state.killerChat.push(reply);
          state.privateLogs.killer.push(reply);
        }
      }
    }
  }

  // ── Police Night Chat (tactical briefing — uses real targeting logic) ──
  const police = alive.filter((p) => p.role === Roles.POLICE.id && !p.isHuman);
  if (police.length > 0) {
    state.policeChat = state.policeChat || [];
    state.privateLogs.police = state.privateLogs.police || [];
    const speaker = randomChoice(police, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonPolice = alive.filter((t) => t.role !== Roles.POLICE.id);
      const s = speaker.name;
      const dayNum = state.dayNumber || 1;
      const isFirstNight = dayNum === 1;
      const lines = [];

      // Use the real targeting logic to get tonight's actual investigation target
      const smartTarget = pickPoliceSmartTarget(state, speaker);
      const actualTarget = smartTarget || randomChoice(nonPolice, state.rng);
      // Store so buildAiNightActions uses the same target
      if (actualTarget) state._policeChatTarget = actualTarget.id;

      // Share last investigation results
      const results = speaker.aiMemory?.investigationResults || [];
      const lastResult = results.length > 0 ? results[results.length - 1] : null;
      if (lastResult && !isFirstNight) {
        const targetP = getPlayer(state, lastResult.targetId);
        if (targetP) {
          if (lastResult.result === "red") {
            lines.push(`${s}: Last check: ${targetP.name} is RED — confirmed.||${s}：上次查驗：${targetP.name} 是紅方，確認了。`);
          } else {
            lines.push(`${s}: Last check: ${targetP.name} is ${lastResult.result.toUpperCase()} — cleared.||${s}：上次查驗：${targetP.name} 是${lastResult.result === "blue" ? "藍方" : "綠方"}，排除了。`);
          }
        }
      }

      // Tonight's investigation plan — references the real target
      if (actualTarget) {
        const susp = speaker.aiMemory?.suspicion?.[actualTarget.id] ?? 0;
        const redProb = speaker.aiMemory?.roleProbs?.[actualTarget.id] || {};
        const killerProb = redProb[Roles.KILLER.id] ?? 0;
        if (isFirstNight) {
          lines.push(`${s}: Investigating ${actualTarget.name} tonight — starting with them.||${s}：今晚查 ${actualTarget.name}，從他開始。`);
        } else if (killerProb > 0.15) {
          lines.push(`${s}: Investigating ${actualTarget.name} tonight — ${Math.round(killerProb * 100)}% killer probability.||${s}：今晚查 ${actualTarget.name}——殺手機率 ${Math.round(killerProb * 100)}%。`);
        } else if (susp > 0.4) {
          lines.push(`${s}: Checking ${actualTarget.name} tonight — suspicion at ${Math.round(susp * 100)}%.||${s}：今晚查 ${actualTarget.name}——嫌疑度 ${Math.round(susp * 100)}%。`);
        } else {
          lines.push(`${s}: Investigating ${actualTarget.name} tonight — haven't verified them yet.||${s}：今晚查 ${actualTarget.name}——還沒查驗過。`);
        }
      }

      // Revealed red reminder
      const revealedRed = state.policeRevealedRed !== null ? getPlayer(state, state.policeRevealedRed) : null;
      if (revealedRed?.alive) {
        lines.push(`${s}: Reminder: ${revealedRed.name} is confirmed red. We vote them out tomorrow.||${s}：提醒：${revealedRed.name} 確認紅方。明天投他出局。`);
      }

      // Push lines (cap at 3)
      const output = lines.slice(0, 3);
      for (const line of output) {
        state.policeChat.push(line);
        state.privateLogs.police.push(line);
      }

      // Responder reacts to the actual briefing
      const otherPolice = police.filter((p) => p.id !== speaker.id);
      if (otherPolice.length > 0 && output.length > 0 && state.rng() < 0.6) {
        const responder = randomChoice(otherPolice, state.rng);
        const r = responder.name;
        let reply = null;

        if (revealedRed?.alive) {
          reply = `${r}: Agreed, ${revealedRed.name} is priority vote. Focus investigation elsewhere.||${r}：同意，${revealedRed.name} 是優先投票目標。查驗集中在其他人。`;
        } else if (actualTarget) {
          const susp = responder.aiMemory?.suspicion?.[actualTarget.id] ?? 0;
          if (susp > 0.4) {
            reply = `${r}: ${actualTarget.name} is on my radar too — ${Math.round(susp * 100)}% suspicion. Good pick.||${r}：${actualTarget.name} 我也有注意到——嫌疑 ${Math.round(susp * 100)}%。好選擇。`;
          } else {
            reply = `${r}: Copy, checking ${actualTarget.name}. Let's see what turns up.||${r}：收到，查 ${actualTarget.name}。看看結果如何。`;
          }
        } else {
          reply = `${r}: Stay sharp tonight.||${r}：今晚保持警覺。`;
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
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.grudge.berserkHuntGeneral);
          line = tmpl(speaker.name);
        }
      } else {
        if (target && roll < 0.4) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.grudge.planJudge);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.7 && target) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.grudge.caution);
          line = tmpl(speaker.name, target.name);
        } else if (roll < 0.7) {
          const tmpl = pickTemplate(state.rng, NIGHT_FACTION_CHAT.grudge.cautionGeneral);
          line = tmpl(speaker.name);
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

export function generateFactionChat(state) {
  if (!isHard(state)) return;

  const alive = alivePlayers(state);

  // ── Killer Day Chat (strategy description — mirrors actual vote logic) ──
  const killers = alive.filter((p) => p.role === Roles.KILLER.id && !p.isHuman);
  if (killers.length > 0) {
    state.killerChat = state.killerChat || [];
    state.privateLogs.killer = state.privateLogs.killer || [];
    const speaker = randomChoice(killers, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonKillers = alive.filter((t) => t.role !== Roles.KILLER.id);
      const allKillersAlive = alive.filter((p) => p.role === Roles.KILLER.id);
      const s = speaker.name;
      const lines = [];
      // Track which strategy branch the chat describes for responder context
      let chatStrategy = "generic";

      // ─ Last night debrief ─
      const savedP = (state.lastNightSavedIds || []).length > 0
        ? nonKillers.find((t) => (state.lastNightSavedIds || []).includes(t.id))
        : null;

      if (savedP) {
        const doctorProb = speaker.aiMemory?.roleProbs?.[savedP.id]?.[Roles.DOCTOR.id] ?? 0;
        if (doctorProb > 0.15) {
          lines.push(`${s}: ${savedP.name} got saved — and they might BE the doctor (${Math.round(doctorProb * 100)}%). Watch who protects whom.||${s}：${savedP.name} 被救了，而且他可能就是醫生（${Math.round(doctorProb * 100)}%）。注意誰在保誰。`);
        } else {
          lines.push(`${s}: Kill failed on ${savedP.name} — someone's protecting them. Note that for tonight.||${s}：${savedP.name} 殺失敗了，有人在保他。今晚要記住這點。`);
        }
      }

      // ─ Vote strategy: describe what AI will actually do (only react to public reveals) ─
      const policeRevealed = (state.policePublicRevealedRed ?? null) !== null;
      const revealedIsUs = policeRevealed && allKillersAlive.some((k) => k.id === state.policePublicRevealedRed);
      const exposed = revealedIsUs ? allKillersAlive.find((k) => k.id === state.policePublicRevealedRed) : null;
      const dayNum = state.dayNumber || 1;

      if (revealedIsUs && exposed) {
        // Mirrors sell-out logic: 60% early, 85% late — per-killer independent roll
        const sellOutRate = dayNum >= 4 ? 85 : 60;
        chatStrategy = "sellout";
        if (allKillersAlive.length > 1) {
          lines.push(`${s}: ${exposed.name} is confirmed red. Consider voting them to blend in (~${sellOutRate}% safe). Don't defend too hard — but if you see a grudge or better play, take it.||${s}：${exposed.name} 確認紅方了。考慮跟投來偽裝（約 ${sellOutRate}% 安全）。別太用力辯護，但如果有怨獸或更好的機會，自行判斷。`);
        } else {
          lines.push(`${s}: I'm exposed. Everyone's voting me — just vote whoever looks most suspicious to blend in.||${s}：我暴露了，大家都會投我。你們投最可疑的人來偽裝就好。`);
        }
      } else if (policeRevealed) {
        // Mirrors: blue follows police reveal, red blends in
        chatStrategy = "blend";
        lines.push(`${s}: Police revealed a red (not us). Vote with the crowd to stay hidden.||${s}：警察揭露了紅方（不是我們）。跟著大家投，保持隱藏。`);
      } else if (allKillersAlive.length >= 3) {
        // Mirrors scatter logic: killerVoteTargets avoids clustering (60% per killer)
        chatStrategy = "scatter";
        lines.push(`${s}: 3+ of us alive — try to scatter votes if possible. Some of us might end up on the same target depending on the situation, but avoid obvious clustering.||${s}：我們還有 3 人以上，盡量分散投票。根據情況有些人可能投同一個，但避免明顯聚集。`);
      } else if (allKillersAlive.length === 2) {
        // 2 killers: one can push a target, other votes elsewhere
        const suspScores = nonKillers.map((t) => {
          let totalSusp = 0;
          for (const k of allKillersAlive) {
            ensureAdvancedMemory(k);
            totalSusp += k.aiMemory?.suspicion?.[t.id] ?? 0;
          }
          return { p: t, avgSusp: totalSusp / allKillersAlive.length };
        }).sort((a, b) => b.avgSusp - a.avgSusp);
        const voteTarget = suspScores[0];
        if (voteTarget && voteTarget.avgSusp > 0.35) {
          chatStrategy = "split";
          lines.push(`${s}: ${voteTarget.p.name} has high suspicion (${Math.round(voteTarget.avgSusp * 100)}%). Ideally we split — one pushes them, other goes elsewhere. But adapt to the vote flow.||${s}：${voteTarget.p.name} 嫌疑高（${Math.round(voteTarget.avgSusp * 100)}%）。理想上分工，一人帶他一人投別處。但看實際投票風向調整。`);
        } else {
          chatStrategy = "scatter";
          lines.push(`${s}: No obvious target yet. Vote separately, follow the crowd.||${s}：還沒明確目標。各自投票，跟著風向走。`);
        }
      } else {
        // Solo killer: mimic blue behavior
        chatStrategy = "mimic";
        lines.push(`${s}: I'm the last one — voting whoever looks most suspicious to blend in.||${s}：只剩我一個了，投最可疑的人來偽裝。`);
      }

      // ─ Self-threat check ─
      const mostExposed = allKillersAlive.reduce((a, b) =>
        (a.aiMemory?.selfThreat ?? 0) > (b.aiMemory?.selfThreat ?? 0) ? a : b, allKillersAlive[0]);
      const exposedThreat = mostExposed?.aiMemory?.selfThreat ?? 0;
      if (exposedThreat > 0.4 && !revealedIsUs) {
        lines.push(`${s}: Heads up — ${mostExposed.name} is drawing attention (${Math.round(exposedThreat * 100)}% threat). Talk less in public.||${s}：注意——${mostExposed.name} 引起注意了（威脅度 ${Math.round(exposedThreat * 100)}%）。公開場合少說話。`);
      }

      // Push lines (cap at 3)
      const output = lines.slice(0, 3);
      for (const line of output) {
        state.killerChat.push(line);
        state.privateLogs.killer.push(line);
      }

      // ─ Responder (contextual to described strategy) ─
      const otherKillers = killers.filter((k) => k.id !== speaker.id);
      if (otherKillers.length > 0 && output.length > 0 && state.rng() < 0.65) {
        const responder = randomChoice(otherKillers, state.rng);
        const r = responder.name;
        let reply = null;

        switch (chatStrategy) {
          case "sellout":
            reply = exposed && responder.id !== exposed.id
              ? `${r}: Leaning toward voting ${exposed.name} to blend in, but I'll read the room first.||${r}：傾向投 ${exposed.name} 來偽裝，但會先看情況再決定。`
              : `${r}: I know I'm the target. You all play it safe — don't stick your neck out for me.||${r}：我知道我是目標。你們安全行事，別為我出頭。`;
            break;
          case "blend":
            reply = `${r}: Got it, following the crowd vote.||${r}：收到，跟著大家投。`;
            break;
          case "scatter":
            reply = `${r}: I'll try to pick a different target. Let's see how the vote shapes up.||${r}：我盡量選不同的人。看投票怎麼走。`;
            break;
          case "split":
            reply = `${r}: I'll aim for a different target if I can. Depends on what others do.||${r}：我盡量投別人。看其他人怎麼投再說。`;
            break;
          case "mimic":
            reply = `${r}: Stay safe. Vote smart.||${r}：小心。聰明投票。`;
            break;
          default:
            reply = `${r}: Understood.||${r}：了解。`;
        }

        if (reply) {
          state.killerChat.push(reply);
          state.privateLogs.killer.push(reply);
        }
      }
    }
  }

  // ── Police Day Chat (debrief + vote coordination — mirrors actual vote logic) ──
  const police = alive.filter((p) => p.role === Roles.POLICE.id && !p.isHuman);
  if (police.length > 0) {
    state.policeChat = state.policeChat || [];
    state.privateLogs.police = state.privateLogs.police || [];
    const speaker = randomChoice(police, state.rng);
    if (speaker) {
      ensureAdvancedMemory(speaker);
      const nonPolice = alive.filter((t) => t.role !== Roles.POLICE.id);
      const s = speaker.name;
      const lines = [];
      let chatContext = "generic"; // for responder

      // ─ Vote strategy: mirrors actual vote logic ─
      // Police with policeRevealedRed alive → 100% vote them (ai.js:3021-3026)
      const revealedRed = state.policeRevealedRed !== null ? getPlayer(state, state.policeRevealedRed) : null;
      if (revealedRed?.alive) {
        chatContext = "voteRed";
        lines.push(`${s}: ${revealedRed.name} is confirmed red — all police vote them, no exceptions. Push the village to follow.||${s}：${revealedRed.name} 確認紅方——所有警察都投他，沒有例外。帶動村民跟投。`);
      }

      // ─ Share investigation intel ─
      const results = speaker.aiMemory?.investigationResults || [];
      if (results.length > 0 && state.rng() < 0.7) {
        // Share most recent unshared or notable result
        const lastResult = results[results.length - 1];
        const targetP = getPlayer(state, lastResult.targetId);
        if (targetP && targetP.alive) {
          if (lastResult.result === "red") {
            lines.push(`${s}: Intel: ${targetP.name} checked RED. High priority target.||${s}：情報：${targetP.name} 查出紅方。高優先目標。`);
            chatContext = "intelRed";
          } else {
            lines.push(`${s}: Intel: ${targetP.name} checked ${lastResult.result.toUpperCase()} — cleared, skip them.||${s}：情報：${targetP.name} 查出${lastResult.result === "blue" ? "藍方" : "綠方"}——排除，跳過他。`);
            if (chatContext === "generic") chatContext = "intelClear";
          }
        }
      }

      // ─ Threat analysis ─
      if (!revealedRed?.alive && state.rng() < 0.5) {
        // Find highest suspicion non-police target
        let suspect = null;
        let highSusp = -1;
        for (const t of nonPolice) {
          const susp = speaker.aiMemory?.suspicion?.[t.id] ?? 0;
          if (susp > highSusp) { highSusp = susp; suspect = t; }
        }
        if (suspect && highSusp > 0.35) {
          lines.push(`${s}: ${suspect.name} has ${Math.round(highSusp * 100)}% suspicion — worth pushing in the vote if no better lead.||${s}：${suspect.name} 嫌疑度 ${Math.round(highSusp * 100)}%——如果沒更好的線索，值得投票時推一下。`);
          if (chatContext === "generic") chatContext = "suspect";
        }
      }

      // Push lines (cap at 3)
      const output = lines.slice(0, 3);
      for (const line of output) {
        state.policeChat.push(line);
        state.privateLogs.police.push(line);
      }

      // ─ Responder reacts to the actual briefing ─
      const otherPolice = police.filter((p) => p.id !== speaker.id);
      if (otherPolice.length > 0 && output.length > 0 && state.rng() < 0.6) {
        const responder = randomChoice(otherPolice, state.rng);
        const r = responder.name;
        let reply = null;

        switch (chatContext) {
          case "voteRed":
            reply = `${r}: Voting ${revealedRed.name}, no question. I'll back it up in public chat.||${r}：投 ${revealedRed.name}，沒問題。我會在公開聊天支持。`;
            break;
          case "intelRed": {
            const redP = results.length > 0 ? getPlayer(state, results[results.length - 1].targetId) : null;
            reply = redP
              ? `${r}: ${redP.name} is red — should we reveal publicly or save for next round?||${r}：${redP.name} 是紅方——要公開揭露還是留到下回合？`
              : `${r}: Good intel. Let's use it wisely.||${r}：好情報。謹慎使用。`;
            break;
          }
          case "intelClear":
            reply = `${r}: One less suspect. Focus investigation on the remaining unknowns.||${r}：少一個嫌疑人。查驗集中在剩下的未知者。`;
            break;
          case "suspect":
            reply = `${r}: Agreed, they've been acting suspicious. Let's coordinate the vote.||${r}：同意，他一直很可疑。我們協調投票。`;
            break;
          default:
            reply = `${r}: Stay vigilant. We'll figure this out.||${r}：保持警覺。我們會找出來的。`;
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
          const tmpl = pickTemplate(state.rng, FACTION_CHAT.grudge.berserkPlanGeneral);
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
    // Police: dump all investigation results (most valuable intel on death)
    if (player.role === Roles.POLICE.id) {
      const results = player.aiMemory?.investigationResults || [];
      const redParts = []; // highest priority
      const otherParts = [];

      // If there's a revealed red not in results, add it first
      if (state.policeRevealedRed !== null) {
        const redTarget = getPlayer(state, state.policeRevealedRed);
        if (redTarget?.alive && !results.some((r) => r.targetId === redTarget.id)) {
          const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.policeRevealRed);
          redParts.push(tmpl(player.name, redTarget.name));
        }
      }

      // Dump each investigation result with correct template
      for (const r of results) {
        const tp = getPlayer(state, r.targetId);
        if (!tp?.alive) continue; // skip dead players (already public info)
        if (r.result === "red") {
          const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.policeRevealRed);
          redParts.push(tmpl(player.name, tp.name));
        } else if (r.result === "green") {
          // GREEN results get their own accurate phrasing
          otherParts.push(`${player.name}: ${tp.name} is GREEN (third party).||${player.name}：${tp.name} 是綠方（第三方）。`);
        } else {
          const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.policeRevealBlue);
          otherParts.push(tmpl(player.name, tp.name));
        }
      }

      // Red intel first, then blue/green — prioritize actionable info
      const parts = [...redParts, ...otherParts];

      // If no results yet, accuse most suspicious
      if (parts.length === 0 && mostSuspicious && highestSusp > 0.5) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.policeAccuse);
        parts.push(tmpl(player.name, mostSuspicious.name));
      }

      if (parts.length > 0) {
        // Combine up to 2 results, red always first
        // Each part is "EN||ZH" — split correctly and rejoin
        const selected = parts.slice(0, 2);
        const enParts = selected.map((p) => {
          const idx = p.indexOf("||");
          return idx >= 0 ? p.slice(0, idx) : p;
        });
        const zhParts = selected.map((p) => {
          const idx = p.indexOf("||");
          return idx >= 0 ? p.slice(idx + 2) : "";
        });
        return enParts.join(" ") + "||" + zhParts.join(" ");
      }
    }

    // Doctor: defend who they were actually protecting
    if (player.role === Roles.DOCTOR.id) {
      const lastProt = player.aiMemory?.lastProtected;
      const protTarget = lastProt !== null && lastProt !== undefined ? getPlayer(state, lastProt) : null;
      if (protTarget?.alive && state.rng() < 0.5) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.doctorDefend);
        return tmpl(player.name, protTarget.name);
      }
    }

    // Agent: defend who they were actually protecting
    if (player.role === Roles.AGENT?.id) {
      const lastProt = player.aiMemory?.lastProtected;
      const protTarget = lastProt !== null && lastProt !== undefined ? getPlayer(state, lastProt) : null;
      if (protTarget?.alive && state.rng() < 0.5) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.blueDefend);
        return tmpl(player.name, protTarget.name);
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
    // 35%: frame someone the dying red believes is blue (no true faction access)
    if (roll < 0.35) {
      // Killers know other killers; non-Killer reds know nothing — use suspicion
      const innocents = player.role === Roles.KILLER.id
        ? alive.filter((t) => t.role !== Roles.KILLER.id)
        : alive.filter((t) => (player.aiMemory?.suspicion?.[t.id] ?? 0.5) < 0.4);
      const frameTarget = innocents.length > 0
        ? randomChoice(innocents, state.rng)
        : mostSuspicious;
      if (frameTarget) {
        const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.redBluff);
        return tmpl(player.name, frameTarget.name);
      }
    }
    // 20%: subtly defend an ally — only Killers see other Killers
    if (roll < 0.55) {
      let ally = null;
      if (player.role === Roles.KILLER.id) {
        const allies = alive.filter((t) => t.role === Roles.KILLER.id);
        ally = allies.length > 0 ? randomChoice(allies, state.rng) : null;
      } else {
        // Non-Killer reds: defend a low-suspicion player as generic misdirection
        const lowSusp = alive.filter((t) => t.id !== player.id && (player.aiMemory?.suspicion?.[t.id] ?? 0.5) < 0.35);
        ally = lowSusp.length > 0 ? randomChoice(lowSusp, state.rng) : null;
      }
      if (ally) {
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
      // Templates that name a target are only eligible when we actually have one.
      const nameTarget = !!mostSuspicious && state.rng() < 0.5;
      const pool = nameTarget
        ? LAST_WORDS_TEMPLATES.greenGrudge
        : LAST_WORDS_TEMPLATES.greenGrudge.filter((t) => t.length < 2);
      const tmpl = pickTemplate(state.rng, pool);
      return tmpl(player.name, mostSuspicious?.name);
    }
    if (player.role === Roles.ZOMBIE.id) {
      // Reveal bite targets to help allied zombies avoid re-biting (reduce FATAL)
      const biteTargets = player.aiMemory?.biteTargets || {};
      const bittenNames = Object.keys(biteTargets)
        .filter((id) => biteTargets[id] > 0)
        .map((id) => getPlayer(state, Number(id)))
        .filter((p) => p?.alive)
        .map((p) => p.name);
      if (bittenNames.length > 0) {
        const names = bittenNames.slice(0, 3).join(", ");
        return `${player.name}: I bit ${names}... the infection spreads.||${player.name}：我咬了 ${names}⋯感染在蔓延。`;
      }
      const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.greenZombie);
      return tmpl(player.name);
    }
  }

  // Fallback
  const tmpl = pickTemplate(state.rng, LAST_WORDS_TEMPLATES.generic);
  return tmpl(player.name);
}
