import { getPlayer, alivePlayers } from "./state.js";
import { Roles, Faction } from "./roles.js";

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function ensureSuspicion(state) {
  const living = alivePlayers(state).map((p) => p.id);
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;
  const human = state.players.find((p) => p.isHuman);
  const humanFaction = human?.faction || null;
  const opposingFaction =
    humanFaction === Faction.RED ? Faction.BLUE : humanFaction === Faction.BLUE ? Faction.RED : null;
  const revealedRed = state.policeRevealedRed;
  const lastVoteHist = state.history?.votes?.[state.history.votes.length - 1] || null;
  const mentionMax = lastVoteHist?.mentions ? Math.max(1, ...Object.values(lastVoteHist.mentions)) : 1;
  const flipSet = new Set(lastVoteHist?.flips || []);
  const firstVoterId = lastVoteHist?.order?.[0]?.actorId ?? null;
  const lastVoterId = lastVoteHist?.order?.[lastVoteHist.order.length - 1]?.actorId ?? null;
  const lastTally = lastVoteHist?.tally || {};

  for (const p of alivePlayers(state)) {
    if (p.isHuman) continue;
    if (!p.aiMemory) p.aiMemory = { suspicion: {} };
    for (const targetId of living) {
      if (targetId === p.id) continue;
      const target = getPlayer(state, targetId);
      const sameFaction = target?.faction === p.faction;
      const baseStart = p.faction === Faction.BLUE ? 0.32 : 0.35;
      const base = baseStart + state.rng() * 0.35 - (sameFaction ? 0.15 : 0);
      if (p.aiMemory.suspicion[targetId] === undefined) {
        p.aiMemory.suspicion[targetId] = clamp(base, 0.05, 0.95);
      } else {
        const drift = (state.rng() - 0.5) * 0.08;
        p.aiMemory.suspicion[targetId] = clamp(p.aiMemory.suspicion[targetId] + drift, 0.05, 0.95);
      }

      // Heuristic bumps (weak strength)
      let delta = 0;
      // Mentions in discussion
      if (lastVoteHist?.mentions && lastVoteHist.mentions[targetId]) {
        const weight = (lastVoteHist.mentions[targetId] || 0) / mentionMax;
        delta += 0.05 * weight * diffScale;
      }
      // Flip voters (medium)
      if (flipSet.has(targetId)) {
        delta += 0.15 * diffScale;
      }
      // Last voter (opportunistic, medium)
      if (targetId === lastVoterId) {
        delta += 0.15 * diffScale;
      }
      // First voter (info holder) slight reduction
      if (targetId === firstVoterId) {
        delta -= 0.05 * diffScale;
      }
      // Voted into majority (if tally shows high votes)
      const tallyScore = lastTally[targetId] || 0;
      const maxTally = Math.max(1, ...Object.values(lastTally || {}));
      if (tallyScore && maxTally > 0) {
        const bandwagon = tallyScore / maxTally;
        delta += 0.08 * bandwagon * diffScale;
      }
      // Police investigation: if a red is revealed, boost suspicion for blue-side actors
      if (revealedRed && targetId === revealedRed && p.faction === Faction.BLUE) {
        delta += 0.25 * diffScale;
      }
      // Difficulty-based bias toward opposing the human (only on nightmare)
      if (humanFaction && target?.faction && state.difficulty === "nightmare") {
        if (target.faction === humanFaction) delta += 0.12 * diffScale;
        else if (opposingFaction && target.faction === opposingFaction) delta -= 0.05 * diffScale;
      }
      p.aiMemory.suspicion[targetId] = clamp(p.aiMemory.suspicion[targetId] + delta, 0.01, 0.99);
    }

    // Normalize suspicions per actor
    const vals = Object.values(p.aiMemory.suspicion).filter((v) => typeof v === "number");
    const minVal = Math.min(...vals, 1);
    const maxVal = Math.max(...vals, 0);
    const range = maxVal - minVal;
    if (range > 0) {
      for (const tId of Object.keys(p.aiMemory.suspicion)) {
        const v = p.aiMemory.suspicion[tId];
        const norm = 0.05 + ((v - minVal) / range) * 0.9;
        p.aiMemory.suspicion[tId] = clamp(norm, 0.01, 0.99);
      }
    }
  }
}

function pickTargetBySuspicion(state, actor, filterFn = () => true) {
  let best = null;
  let bestScore = -1;
  for (const target of alivePlayers(state)) {
    if (target.id === actor.id) continue;
    if (!filterFn(target)) continue;
    const score = actor.aiMemory?.suspicion?.[target.id] ?? 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  }
  return best;
}

function randomChoice(list, rng) {
  if (!list.length) return null;
  const idx = Math.floor(rng() * list.length);
  return list[idx];
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
    if (avg > bestScore) {
      bestScore = avg;
      best = target;
    }
  }
  return best;
}

export function buildAiNightActions(state, opts = {}) {
  const includeHuman = opts.includeHuman === true;
  const humanChoice = opts.humanChoice || null;
  const humanActionsRaw = opts.humanActions || null;
  const human = state.players.find((p) => p.isHuman);
  ensureSuspicion(state);
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
    sharedKillerTarget =
      state.rng() < 0.6
        ? pickGroupTarget(state, killerActors, (t) => t.faction !== Faction.RED && t.role !== Roles.KILLER.id)
        : null;
  }
  // Pre-pick a shared police target to avoid split votes.
  const policeActors = alivePlayers(state).filter((p) => p.role === Roles.POLICE.id && (!p.isHuman || includeHuman));
  const humanPoliceTarget = pickHumanTarget("POLICE_INVESTIGATE");
  let sharedPoliceTarget =
    humanPoliceTarget ||
    pickGroupTarget(
      state,
      policeActors,
      (t) => t.role !== Roles.POLICE.id
    );
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

  for (const actor of alivePlayers(state)) {
    if (actor.isHuman && !includeHuman) continue;
    switch (actor.role) {
      case Roles.POLICE.id: {
        const target =
          sharedPoliceTarget ||
          pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.POLICE.id);
        if (target) actions.push({ actorId: actor.id, type: "POLICE_INVESTIGATE", targetId: target.id });
        break;
      }
      case Roles.KILLER.id: {
        const target =
          sharedKillerTarget ||
          pickTargetBySuspicion(state, actor, (t) => t.faction !== Faction.RED && t.role !== Roles.KILLER.id);
        if (target) actions.push({ actorId: actor.id, type: "KILLER_VOTE", targetId: target.id });
        break;
      }
      case Roles.DOCTOR.id: {
        if (state.usage.doctorInjections < (Roles.DOCTOR.maxInjections || 0)) {
          const target =
            state.rng() > 0.7
              ? actor
              : pickTargetBySuspicion(state, actor, (t) => t.faction === Faction.BLUE);
          if (target) actions.push({ actorId: actor.id, type: "DOCTOR_INJECT", targetId: target.id });
        }
        break;
      }
      case Roles.SNIPER.id: {
        if (state.usage.sniperShots < (Roles.SNIPER.maxShots || 0) && state.rng() > 0.4) {
          const target = pickTargetBySuspicion(state, actor, (t) => t.faction !== actor.faction);
          if (target) actions.push({ actorId: actor.id, type: "SNIPER_SHOT", targetId: target.id });
        }
        break;
      }
      case Roles.AGENT.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.faction === Faction.BLUE);
        if (target) actions.push({ actorId: actor.id, type: "AGENT_PROTECT", targetId: target.id });
        break;
      }
      case Roles.HEAVENLY_FIEND.id: {
        if (actor.status.fiendMode === "ABSORB") {
          const target = pickTargetBySuspicion(state, actor, (t) => t.faction === Faction.BLUE);
          if (target) actions.push({ actorId: actor.id, type: "FIEND_PROTECT", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.faction !== Faction.BLUE);
          if (target) actions.push({ actorId: actor.id, type: "FIEND_SHOOT", targetId: target.id });
        }
        break;
      }
      case Roles.TERRORIST.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.faction !== Faction.RED);
        if (target && state.rng() > 0.35) actions.push({ actorId: actor.id, type: "TERROR_BOMB", targetId: target.id });
        break;
      }
      case Roles.COWBOY.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "COWBOY_GAMBLE", targetId: target.id });
        break;
      }
      case Roles.KIDNAPPER.id: {
        const target = pickTargetBySuspicion(
          state,
          actor,
          (t) => t.faction !== Faction.RED && t.id !== actor.lastKidnapTarget
        );
        if (target) actions.push({ actorId: actor.id, type: "KIDNAP", targetId: target.id });
        break;
      }
      case Roles.ZOMBIE.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.ZOMBIE.id);
        if (target) actions.push({ actorId: actor.id, type: "ZOMBIE_BITE", targetId: target.id });
        break;
      }
      case Roles.RIOT_POLICE.id: {
        if (state.usage.riotGrenades < (Roles.RIOT_POLICE.maxGrenades || 0)) {
          const target = pickTargetBySuspicion(state, actor, (t) => t.faction !== Faction.BLUE);
          if (target) actions.push({ actorId: actor.id, type: "RIOT_SMOKE", targetId: target.id });
        }
        break;
      }
      case Roles.ARSONIST.id: {
        const marked = state.players.filter((p) => p.status.arsonMarked && p.alive).length;
        if (marked >= 2 || state.rng() > 0.65) {
          actions.push({ actorId: actor.id, type: "ARSON_IGNITE" });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "ARSON_MARK", targetId: target.id });
        }
        break;
      }
      case Roles.VINE_DEMON.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.faction === Faction.BLUE);
        if (target) actions.push({ actorId: actor.id, type: "VINE_SEED", targetId: target.id });
        break;
      }
      case Roles.NIGHTMARE_DEMON.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "NIGHTMARE_ATTACK", targetId: target.id });
        break;
      }
      case Roles.EXORCIST.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "EXORCIST_STRIKE", targetId: target.id });
        break;
      }
      case Roles.NECROMANCER.id: {
        if (actor.souls >= 2) {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "NECROMANCER_CURSE", targetId: target.id });
        }
        break;
      }
      case Roles.PURIFIER.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "PURIFY", targetId: target.id });
        break;
      }
      case Roles.GRUDGE_BEAST.id: {
        if (state.grudgeState.berserk) {
          const target = pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.GRUDGE_BEAST.id);
          if (target) actions.push({ actorId: actor.id, type: "GRUDGE_KILL_VOTE", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "GRUDGE_JUDGE", targetId: target.id });
        }
        break;
      }
      default:
        break;
    }
  }
  return actions;
}

export function buildAiVoteActions(state, humanVoteTargetId = null, opts = {}) {
  const includeHuman = opts.includeHuman === true;
  ensureSuspicion(state);
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

  const votes = [];
  const aiVoters = alivePlayers(state).filter(
    (p) => (includeHuman || !p.isHuman) && !(p.role === Roles.BRAT.id && p.status.bratRevived)
  );
  aiVoters.forEach((actor, idx) => {
    // force at least one vote by making the last AI always vote
    const abstainChance = idx === aiVoters.length - 1 ? 0 : 0.05;
    if (state.rng() < abstainChance) return;
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
      if (redTarget?.alive && state.rng() < 0.7) {
        votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redTarget.id });
        return;
      }
    }
    const pruned =
      actor.faction === Faction.RED
        ? everyone.filter((t) => t.faction !== Faction.RED)
        : everyone;
    const candidates = pruned.length ? pruned : everyone;
    let target = null;
    if (roll < 0.6) {
      target = randomChoice(candidates, state.rng);
    } else {
      let best = null;
      let bestScore = -Infinity;
      for (const t of candidates) {
        const base = jitter(actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
        const chatBonus = actor.role !== Roles.POLICE.id ? chatWeight(t.id) * 0.05 : 0;
        let s = clamp(base + chatBonus, 0, 1);
        // Difficulty bias: opposing the human only on nightmare
        const human = state.players.find((p) => p.isHuman);
        if (human) {
          if (state.difficulty === "nightmare") {
            if (actor.faction !== human.faction && t.faction === human.faction) {
              s += 0.1;
            }
            if (actor.faction === human.faction && t.faction === actor.faction) {
              s -= 0.05;
            }
          }
          s = clamp(s, 0, 1);
        }
        if (s > bestScore) {
          bestScore = s;
          best = t;
        }
      }
      target = best || randomChoice(candidates, state.rng);
    }
    if (target) votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: target.id });
  });

  if (votes.length === 0 && aiVoters.length > 0) {
    const actor = aiVoters[0];
    const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id && t.alive);
    if (target) votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: target.id });
  }
  return votes;
}

export function generateChatLines(state, maxLines = 6) {
  const lines = [];
  const living = alivePlayers(state).filter((p) => !p.isHuman);
    const redFound = state.policeRevealedRed !== null ? getPlayer(state, state.policeRevealedRed) : null;
  for (const speaker of living) {
    if (lines.length >= maxLines) break;
    const allCandidates = alivePlayers(state).filter((t) => t.id !== speaker.id);
    const accusePool =
      speaker.faction === Faction.RED
        ? allCandidates.filter((t) => t.faction !== Faction.RED)
        : allCandidates;
    const defendPool =
      speaker.faction === Faction.RED
        ? allCandidates.filter((t) => t.faction === Faction.RED)
        : allCandidates.filter((t) => t.faction === speaker.faction);

    const target =
      state.rng() < 0.5
        ? randomChoice(accusePool.length ? accusePool : allCandidates, state.rng)
        : pickTargetBySuspicion(
            state,
            speaker,
            (t) => t.alive && t.id !== speaker.id && (accusePool.includes(t) || accusePool.length === 0)
          );
    let useTarget = target;
    if (redFound?.alive && speaker.role === Roles.POLICE.id && state.rng() < 0.8) {
      useTarget = redFound;
    }
    if (speaker.faction === Faction.RED && state.rng() < 0.75) {
      const nonRed = allCandidates.filter((t) => t.faction !== Faction.RED);
      if (nonRed.length) useTarget = randomChoice(nonRed, state.rng);
    }
    const suspicion = speaker.aiMemory?.suspicion?.[useTarget?.id] ?? 0.5;
    const tone = suspicion > 0.7 ? "accuses" : suspicion < 0.3 && defendPool.length ? "defends" : "wonders";
    const line =
      tone === "accuses"
        ? `${speaker.name}: ${useTarget?.name ?? "someone"} feels off.`
        : tone === "defends"
        ? `${speaker.name}: ${(defendPool[0]?.name ?? useTarget?.name) || "someone"} seems fine to me.`
        : `${speaker.name}: What's everyone thinking about ${useTarget?.name ?? "this"}?`;
    lines.push(line);
  }
  return lines;
}
