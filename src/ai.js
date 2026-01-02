import { getPlayer, alivePlayers } from "./state.js";
import { Roles, Faction } from "./roles.js";

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function ensureSuspicion(state) {
  const living = alivePlayers(state).map((p) => p.id);
  for (const p of alivePlayers(state)) {
    if (p.isHuman) continue;
    if (!p.aiMemory) p.aiMemory = { suspicion: {} };
    for (const targetId of living) {
      if (targetId === p.id) continue;
      const target = getPlayer(state, targetId);
      const sameFaction = target?.faction === p.faction;
      const base = 0.35 + state.rng() * 0.4 - (sameFaction ? 0.2 : 0);
      if (p.aiMemory.suspicion[targetId] === undefined) {
        p.aiMemory.suspicion[targetId] = clamp(base, 0.05, 0.95);
      } else {
        const drift = (state.rng() - 0.5) * 0.08;
        p.aiMemory.suspicion[targetId] = clamp(p.aiMemory.suspicion[targetId] + drift, 0.05, 0.95);
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
  const human = state.players.find((p) => p.isHuman);
  ensureSuspicion(state);
  const actions = [];

  // Pre-pick a shared killer target to avoid split votes.
  const killerActors = alivePlayers(state).filter((p) => p.role === Roles.KILLER.id && (!p.isHuman || includeHuman));
  let sharedKillerTarget = pickGroupTarget(
    state,
    killerActors,
    (t) => t.faction !== Faction.RED && t.role !== Roles.KILLER.id
  );
  if (
    humanChoice &&
    human?.role === Roles.KILLER.id &&
    typeof humanChoice.targetId === "number" &&
    state.rng() < 0.75
  ) {
    sharedKillerTarget = getPlayer(state, humanChoice.targetId) || sharedKillerTarget;
  }
  // Pre-pick a shared police target to avoid split votes.
  const policeActors = alivePlayers(state).filter((p) => p.role === Roles.POLICE.id && (!p.isHuman || includeHuman));
  let sharedPoliceTarget =
    Math.random() < 0.45
      ? null
      : pickGroupTarget(
          state,
          policeActors,
          (t) => t.role !== Roles.POLICE.id
        );
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
          (Math.random() < 0.5
            ? randomChoice(alivePlayers(state).filter((t) => t.role !== Roles.POLICE.id), state.rng)
            : pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.POLICE.id));
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
      if (redTarget?.alive && state.rng() < 0.99) {
        votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: redTarget.id });
        return;
      }
    }
    const pruned =
      actor.faction === Faction.RED && state.rng() >= 0.15
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
        const s = jitter(actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
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
      Math.random() < 0.5
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
