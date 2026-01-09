import { getPlayer, alivePlayers } from "./state.js";
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

function ensureBeliefs(state) {
  const living = alivePlayers(state).map((p) => p.id);
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;
  const human = state.players.find((p) => p.isHuman);
  const humanFaction = human?.faction || null;
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

  for (const p of alivePlayers(state)) {
    if (p.isHuman) continue;
    if (!p.aiMemory) p.aiMemory = { suspicion: {}, roleProbs: {} };
    if (!p.aiMemory.roleProbs) p.aiMemory.roleProbs = {};
    if (!p.aiMemory.suspicion) p.aiMemory.suspicion = {};
    for (const targetId of living) {
      if (targetId === p.id) continue;
      const target = getPlayer(state, targetId);
      // 初始化或衰減到先驗
      if (!p.aiMemory.roleProbs[targetId]) p.aiMemory.roleProbs[targetId] = {};
      const decay = 0.9;
      let mass = 0;
      for (const role of allRoles) {
        const prior = (rolePriors[role] || 0) / totalPrior;
        const prev = p.aiMemory.roleProbs[targetId][role] ?? prior;
        const blended = prior * (1 - decay) + prev * decay;
        p.aiMemory.roleProbs[targetId][role] = blended;
        mass += blended;
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
      // 不使用真實陣營偏置，避免作弊。
      // 應用到角色分布
      for (const role of allRoles) {
        const meta = roleMeta(role);
        let mult = 1;
        if (meta.faction === Faction.RED) mult += redBoost;
        if (meta.faction === Faction.BLUE) mult += blueBoost;
        p.aiMemory.roleProbs[targetId][role] = clamp(p.aiMemory.roleProbs[targetId][role] * Math.max(0.01, mult), 0.0001, 1);
        mass += 0; // no-op
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
  }
}

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
  const diffScaleMap = { easy: 0.6, normal: 1, hard: 1.3, nightmare: 1.6 };
  const diffScale = diffScaleMap[state.difficulty || "normal"] ?? 1;
  for (const t of alivePlayers(state)) {
    if (t.id === actor.id || t.role === Roles.POLICE.id) continue;
    const killerProb = actor.aiMemory?.roleProbs?.[t.id]?.[Roles.KILLER.id] ?? 0;
    const redProb = factionProb(actor, t.id, Faction.RED) ?? 0;
    const likelyBluePower =
      (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0) > 0.6 ||
      (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0) > 0.6;
    if (likelyBluePower && state.rng() < 0.8) continue;
    let score = killerProb * 2 + redProb;
    score = clamp(score + (state.rng() - 0.5) * 0.1 * diffScale, 0, 3);
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

export function buildAiNightActions(state, opts = {}) {
  const includeHuman = opts.includeHuman === true;
  const humanChoice = opts.humanChoice || null;
  const humanActionsRaw = opts.humanActions || null;
  const human = state.players.find((p) => p.isHuman);
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
    sharedKillerTarget =
      state.rng() < 0.6
        ? pickGroupTarget(state, killerActors, (t) => t.role !== Roles.KILLER.id)
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
          pickPoliceSmartTarget(state, actor) ||
          pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.POLICE.id);
        if (target) actions.push({ actorId: actor.id, type: "POLICE_INVESTIGATE", targetId: target.id });
        break;
      }
      case Roles.KILLER.id: {
        let target = sharedKillerTarget;
        if (!target) {
          let best = null;
          let bestScore = -Infinity;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.role === Roles.KILLER.id) continue;
            const redProb = factionProb(actor, t.id, Faction.BLUE) ?? 0;
            const priority = redProb + (actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
            if (priority > bestScore || (priority === bestScore && state.rng() < 0.5)) {
              bestScore = priority;
              best = t;
            }
          }
          target = best;
        }
        if (target) actions.push({ actorId: actor.id, type: "KILLER_VOTE", targetId: target.id });
        break;
      }
      case Roles.DOCTOR.id: {
        if (state.usage.doctorInjections < (Roles.DOCTOR.maxInjections || 0)) {
          let target = actor;
          if (state.rng() <= 0.7) {
            let best = null;
            let bestScore = -Infinity;
            for (const t of shuffled(alivePlayers(state), state.rng)) {
              const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
              const specialProb =
                (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.POLICE.id] ?? 0) +
                (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.DOCTOR.id] ?? 0) +
                (actor.aiMemory?.roleProbs?.[t.id]?.[Roles.AGENT?.id] ?? 0);
              const score = blueProb + specialProb;
              if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
                bestScore = score;
                best = t;
              }
            }
            target = best || actor;
          }
          if (target) actions.push({ actorId: actor.id, type: "DOCTOR_INJECT", targetId: target.id });
        }
        break;
      }
      case Roles.SNIPER.id: {
        if (state.usage.sniperShots < (Roles.SNIPER.maxShots || 0) && state.rng() > 0.4) {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "SNIPER_SHOT", targetId: target.id });
        }
        break;
      }
      case Roles.AGENT.id: {
        let best = null;
        let bestScore = -Infinity;
        for (const t of alivePlayers(state)) {
          if (t.id === actor.id) continue;
          const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
          const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
          const score = blueProb - redProb;
          if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
            bestScore = score;
            best = t;
          }
        }
        const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "AGENT_PROTECT", targetId: target.id });
        break;
      }
      case Roles.HEAVENLY_FIEND.id: {
        if (actor.status.fiendMode === "ABSORB") {
          let best = null;
          let bestScore = -Infinity;
          for (const t of shuffled(alivePlayers(state), state.rng)) {
            if (t.id === actor.id) continue;
            const blueProb = factionProb(actor, t.id, Faction.BLUE) ?? 0.5;
            const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
            const score = blueProb - redProb;
            if (score > bestScore || (score === bestScore && state.rng() < 0.5)) {
              bestScore = score;
              best = t;
            }
          }
          const target = best || pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "FIEND_PROTECT", targetId: target.id });
        } else {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
          if (target) actions.push({ actorId: actor.id, type: "FIEND_SHOOT", targetId: target.id });
        }
        break;
      }
      case Roles.TERRORIST.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target && state.rng() > 0.35) actions.push({ actorId: actor.id, type: "TERROR_BOMB", targetId: target.id });
        break;
      }
      case Roles.COWBOY.id: {
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
        if (target) actions.push({ actorId: actor.id, type: "COWBOY_GAMBLE", targetId: target.id });
        break;
      }
      case Roles.KIDNAPPER.id: {
        let best = null;
        let bestScore = -Infinity;
        for (const t of shuffled(alivePlayers(state), state.rng)) {
          if (t.id === actor.id) continue;
          if (actor.lastKidnapTarget !== null && t.id === actor.lastKidnapTarget) continue;
          const redProb = factionProb(actor, t.id, Faction.RED) ?? 0.5;
          const score = redProb + (actor.aiMemory?.suspicion?.[t.id] ?? 0.5);
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
        const target = pickTargetBySuspicion(state, actor, (t) => t.role !== Roles.ZOMBIE.id);
        if (target) actions.push({ actorId: actor.id, type: "ZOMBIE_BITE", targetId: target.id });
        break;
      }
      case Roles.RIOT_POLICE.id: {
        if (state.usage.riotGrenades < (Roles.RIOT_POLICE.maxGrenades || 0)) {
          const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
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
        const target = pickTargetBySuspicion(state, actor, (t) => t.id !== actor.id);
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

  const votes = [];
  const aiVoters = alivePlayers(state).filter(
    (p) => (includeHuman || !p.isHuman) && !(p.role === Roles.BRAT.id && p.status.bratRevived)
  );
  const randomVoteChance = { easy: 0.8, normal: 0.6, hard: 0.2, nightmare: 0.05 };
  const chaosVoteChance = randomVoteChance[state.difficulty || "normal"] ?? 0.6;
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

    // Hard+ 紅方：若有暴露隊友，偶爾賣隊友以博信任。
    if ((state.difficulty === "hard" || state.difficulty === "nightmare") && actor.faction === Faction.RED) {
      const redTargetId = state.policeRevealedRed;
      const exposedRed =
        redTargetId !== null ? getPlayer(state, redTargetId) : candidates.find((t) => t.role === Roles.KILLER.id && t.id !== actor.id);
      if (exposedRed?.alive && state.rng() < 0.5) {
        votes.push({ actorId: actor.id, type: "VOTE_EXECUTE", targetId: exposedRed.id });
        return;
      }
    }

    let target = null;
    if (roll < chaosVoteChance) {
      target = randomChoice(candidates, state.rng);
    } else {
      let best = null;
      let bestScore = -Infinity;
      for (const t of candidates) {
        const redProb = actor.aiMemory?.suspicion?.[t.id] ?? 0.5;
        const base = jitter(redProb);
        const chatBonus = actor.role !== Roles.POLICE.id ? chatWeight(t.id) * 0.05 : 0;
        let s = clamp(base + chatBonus, 0, 1);
        s = clamp(s, 0, 1);
        if (s > bestScore || (s === bestScore && state.rng() < 0.5)) {
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
    const accusePool = allCandidates;
    const defendPool = allCandidates;

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
    // Hard+紅方偶爾賊喊捉賊，提高迷惑性。仍然不使用真實陣營，只隨機指向任何人。
    const deceptive = (state.difficulty === "hard" || state.difficulty === "nightmare") && speaker.faction === Faction.RED;
    if (deceptive && state.rng() < 0.25) {
      const anyone = allCandidates;
      const bluff = randomChoice(anyone, state.rng);
      if (bluff) useTarget = bluff;
    }
    const suspicion = speaker.aiMemory?.suspicion?.[useTarget?.id] ?? 0.5;
    const tone = suspicion > 0.7 ? "accuses" : suspicion < 0.3 && defendPool.length ? "defends" : "wonders";
    const defendTarget =
      useTarget ||
      (defendPool.length ? randomChoice(defendPool, state.rng) : null);
    const line =
      tone === "accuses"
        ? `${speaker.name}: ${useTarget?.name ?? "someone"} feels off.`
        : tone === "defends"
        ? `${speaker.name}: ${defendTarget?.name ?? "someone"} seems fine to me.`
        : `${speaker.name}: What's everyone thinking about ${useTarget?.name ?? "this"}?`;
    lines.push(line);
  }
  return lines;
}
