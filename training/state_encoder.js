/**
 * State Encoder for RL Training (v2 — expanded observations)
 *
 * Converts the rich game state into a fixed-size feature vector per player,
 * respecting information boundaries (each player only sees what they legally know).
 *
 * Observation structure per player:
 *   Global features     (30):   day, phase, alive count, faction estimates, theme, game phase, usage
 *   Per-player feats    (18x35 = 630): role beliefs, suspicion, vote/chat/social features
 *   Vote graph          (18x18 = 324): who voted for whom (cumulative, normalized)
 *   Chat interaction    (18x4  = 72):  accuse/defend matrix
 *   Last words signals  (18x3  = 54):  accused/defended/claimed role from dead players
 *   Own role context    (25):   role one-hot, faction, resource counters
 *   Total: 1135
 */

import { alivePlayers, getPlayer, factionCounts } from "../src/state.js";
import { Roles, Faction, Theme, roleMeta } from "../src/roles.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_IDS = [
  "POLICE", "KILLER", "DOCTOR", "SNIPER", "AGENT", "TERRORIST", "COWBOY",
  "KIDNAPPER", "ZOMBIE", "RIOT_POLICE", "ARSONIST", "HEAVENLY_FIEND",
  "VINE_DEMON", "BRAT", "NIGHTMARE_DEMON", "EXORCIST", "NECROMANCER",
  "PURIFIER", "GRUDGE_BEAST", "CIVILIAN",
];
const ROLE_IDX = Object.fromEntries(ROLE_IDS.map((r, i) => [r, i]));
const NUM_ROLES = ROLE_IDS.length; // 20

const FACTION_IDS = ["BLUE", "RED", "GREEN"];
const FACTION_IDX = Object.fromEntries(FACTION_IDS.map((f, i) => [f, i]));

const THEME_IDS = [
  "GOOD_VS_EVIL", "COUNTER_TERROR", "WILD_WEST", "DOOMSDAY_HORROR",
  "STREET_FURY", "PSYCHIC_CENTURY", "OTHER_DIMENSION", "FINAL_JUDGEMENT",
];

const PHASE_IDS = ["NIGHT", "DAY", "VOTE"];

const NUM_PLAYERS = 18;
const GLOBAL_DIM = 30;
const PER_PLAYER_DIM = 35;  // was 27, added 8 social features
const VOTE_GRAPH_DIM = NUM_PLAYERS * NUM_PLAYERS; // 324
const CHAT_MATRIX_DIM = NUM_PLAYERS * 4;          // 72
const LAST_WORDS_DIM = NUM_PLAYERS * 3;           // 54
const OWN_ROLE_DIM = 25;
export const OBS_DIM = GLOBAL_DIM
  + NUM_PLAYERS * PER_PLAYER_DIM
  + VOTE_GRAPH_DIM
  + CHAT_MATRIX_DIM
  + LAST_WORDS_DIM
  + OWN_ROLE_DIM; // 30 + 630 + 324 + 72 + 54 + 25 = 1135

// ─── Chat/Vote Analysis Helpers ───────────────────────────────────────────────

function buildVoteGraph(state) {
  // voteGraph[actorId][targetId] = cumulative vote count across all rounds
  const graph = Array.from({ length: NUM_PLAYERS }, () => new Float32Array(NUM_PLAYERS));
  const voteHist = state.history?.votes || [];
  for (const round of voteHist) {
    for (const entry of round.order || []) {
      graph[entry.actorId][entry.targetId] += 1;
    }
  }
  // Normalize per-actor row
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const sum = graph[i].reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (let j = 0; j < NUM_PLAYERS; j++) graph[i][j] /= sum;
    }
  }
  return graph;
}

function buildChatInteractions(state) {
  // Per player pair: accuseCount[speaker][target], defendCount[speaker][target]
  const accuse = Array.from({ length: NUM_PLAYERS }, () => new Float32Array(NUM_PLAYERS));
  const defend = Array.from({ length: NUM_PLAYERS }, () => new Float32Array(NUM_PLAYERS));
  const chats = state.dayChat || [];

  // Also scan chat memory from AI if available
  const playersByNameLen = [...state.players].filter(Boolean).sort((a, b) => b.name.length - a.name.length);

  for (const line of chats) {
    if (line.startsWith("[VOTE] ")) continue;
    const isLastWords = line.startsWith("[LAST] ");

    // Find speaker
    let speakerId = null;
    for (const p of playersByNameLen) {
      if (line.startsWith(p.name + ":") || (isLastWords && line.slice(7).startsWith(p.name + ":"))) {
        speakerId = p.id;
        break;
      }
    }
    if (speakerId === null) continue;

    // Detect accuse/defend keywords
    const enPart = (line.split("||")[0] || line).toLowerCase();
    const zhPart = line.includes("||") ? line.split("||")[1] : "";

    const isAccusation = enPart.includes("suspicious") || enPart.includes("killer") ||
      enPart.includes("vote them") || enPart.includes("doesn't add up") ||
      enPart.includes("acting weird") || enPart.includes("don't trust") ||
      enPart.includes("confirmed red") || enPart.includes("has to go") ||
      zhPart.includes("可疑") || zhPart.includes("殺手") || zhPart.includes("不信任") ||
      zhPart.includes("有問題") || zhPart.includes("投");

    const isDefense = enPart.includes("on our side") || enPart.includes("seems fine") ||
      enPart.includes("clean") || enPart.includes("innocent") || enPart.includes("protect") ||
      enPart.includes("don't vote") || enPart.includes("confirmed blue") ||
      zhPart.includes("清白") || zhPart.includes("無辜") || zhPart.includes("好人") ||
      zhPart.includes("保護") || zhPart.includes("別投");

    // Find target (longest name match first)
    for (const p of playersByNameLen) {
      if (p.id === speakerId) continue;
      if (line.includes(p.name)) {
        if (isAccusation) accuse[speakerId][p.id] += 1;
        if (isDefense) defend[speakerId][p.id] += 1;
        break; // one target per line
      }
    }
  }

  // Normalize
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const accSum = accuse[i].reduce((a, b) => a + b, 0) || 1;
    const defSum = defend[i].reduce((a, b) => a + b, 0) || 1;
    for (let j = 0; j < NUM_PLAYERS; j++) {
      accuse[i][j] /= accSum;
      defend[i][j] /= defSum;
    }
  }

  return { accuse, defend };
}

function buildLastWordsSignals(state) {
  // For each dead player: who they accused, who they defended, claimed role
  const accused = new Float32Array(NUM_PLAYERS);   // target id one-hot (last accusation)
  const defended = new Float32Array(NUM_PLAYERS);   // target id one-hot (last defense)
  const claimedRole = new Float32Array(NUM_PLAYERS); // role index / NUM_ROLES (normalized)

  const playersByNameLen = [...state.players].filter(Boolean).sort((a, b) => b.name.length - a.name.length);

  for (const p of state.players) {
    if (!p || p.alive) continue;
    const lw = p.lastWords;
    if (!lw || typeof lw !== "string" || !lw.trim()) continue;

    const en = (lw.split("||")[0] || lw).toLowerCase();
    const zh = lw.includes("||") ? lw.split("||")[1] : "";

    const isAccuse = en.includes("killer") || en.includes("suspicious") || en.includes("watch out") ||
      en.includes("vote") || en.includes("red") ||
      zh.includes("殺手") || zh.includes("小心") || zh.includes("投") || zh.includes("紅方");

    const isDefend = en.includes("protect") || en.includes("innocent") || en.includes("clean") ||
      en.includes("trust") || en.includes("blue") ||
      zh.includes("保護") || zh.includes("無辜") || zh.includes("好人") || zh.includes("藍方");

    // Find mentioned target
    for (const other of playersByNameLen) {
      if (other.id === p.id) continue;
      if (lw.includes(other.name)) {
        if (isAccuse) accused[other.id] = Math.min(accused[other.id] + 1, 3) / 3;
        if (isDefend) defended[other.id] = Math.min(defended[other.id] + 1, 3) / 3;
        break;
      }
    }

    // Check for role claims in last words (police revealing info)
    for (const roleId of ROLE_IDS) {
      const rl = roleId.toLowerCase().replace("_", " ");
      if (en.includes(rl)) {
        claimedRole[p.id] = (ROLE_IDX[roleId] + 1) / NUM_ROLES; // normalized, 0 = no claim
        break;
      }
    }
  }

  return { accused, defended, claimedRole };
}

// ─── Encoder ──────────────────────────────────────────────────────────────────

/**
 * Encode the full game state from the perspective of a single player.
 * Returns a flat Float32 array of length OBS_DIM.
 */
export function encodeObservation(state, playerId) {
  const obs = new Float32Array(OBS_DIM);
  let offset = 0;

  const actor = getPlayer(state, playerId);
  const alive = alivePlayers(state);
  const aliveCount = alive.length;

  // ── Global features (30) ─────────────────────────────────────────────────

  obs[offset++] = Math.min((state.dayNumber || 1) / 15, 1);

  for (const pid of PHASE_IDS) {
    obs[offset++] = state.phase === pid ? 1 : 0;
  }

  obs[offset++] = aliveCount / NUM_PLAYERS;

  const deadBlue = state.players.filter(p => !p.alive && p.faction === Faction.BLUE).length;
  const deadRed = state.players.filter(p => !p.alive && p.faction === Faction.RED).length;
  const deadGreen = state.players.filter(p => !p.alive && p.faction === Faction.GREEN).length;
  obs[offset++] = deadBlue / NUM_PLAYERS;
  obs[offset++] = deadRed / NUM_PLAYERS;
  obs[offset++] = deadGreen / NUM_PLAYERS;

  for (const tid of THEME_IDS) {
    obs[offset++] = state.theme === tid ? 1 : 0;
  }

  const day = state.dayNumber || 1;
  const ratio = aliveCount / NUM_PLAYERS;
  const isEarly = day <= 2 && ratio > 0.7 ? 1 : 0;
  const isLate = !(day <= 4 && ratio > 0.4) ? 1 : 0;
  const isMid = (!isEarly && !isLate) ? 1 : 0;
  obs[offset++] = isEarly;
  obs[offset++] = isMid;
  obs[offset++] = isLate;

  const u = state.usage || {};
  obs[offset++] = (u.doctorInjections || 0) / 6;
  obs[offset++] = (u.doctorSaves || 0) / 6;
  obs[offset++] = (u.sniperShots || 0) / 4;
  obs[offset++] = (u.riotGrenades || 0) / 4;
  obs[offset++] = (u.arsonMarks || 0) / 4;
  obs[offset++] = (u.cowboyShots || 0) / 3;

  offset = GLOBAL_DIM; // pad to 30

  // ── Pre-compute social features ──────────────────────────────────────────

  const actorRole = actor?.role;
  const actorFaction = actor?.faction;
  const isKiller = actorRole === Roles.KILLER.id;
  const isPolice = actorRole === Roles.POLICE.id;
  const isGrudge = actorRole === Roles.GRUDGE_BEAST.id;

  const voteHist = state.history?.votes || [];
  const lastRound = voteHist[voteHist.length - 1];
  const lastTally = lastRound?.tally || {};
  const maxTally = Math.max(1, ...Object.values(lastTally).map(Number));

  // Chat activity
  const chats = state.dayChat || [];
  const speakCount = {};
  const mentionCount = {};
  for (const line of chats) {
    if (line.startsWith("[VOTE] ") || line.startsWith("[LAST] ")) continue;
    for (const p of state.players) {
      if (!p) continue;
      if (line.startsWith(p.name + ":")) speakCount[p.id] = (speakCount[p.id] || 0) + 1;
      if (line.includes(p.name) && !line.startsWith(p.name + ":")) {
        mentionCount[p.id] = (mentionCount[p.id] || 0) + 1;
      }
    }
  }
  const maxSpeak = Math.max(1, ...Object.values(speakCount));
  const maxMention = Math.max(1, ...Object.values(mentionCount));

  // Vote graph, chat interactions, last words
  const voteGraph = buildVoteGraph(state);
  const chatInteract = buildChatInteractions(state);
  const lwSignals = buildLastWordsSignals(state);

  // Vote-together: how often each pair voted for the same target
  const votedTogether = Array.from({ length: NUM_PLAYERS }, () => new Float32Array(NUM_PLAYERS));
  for (const round of voteHist) {
    const targetByActor = {};
    for (const entry of round.order || []) targetByActor[entry.actorId] = entry.targetId;
    const actors = Object.keys(targetByActor);
    for (let i = 0; i < actors.length; i++) {
      for (let j = i + 1; j < actors.length; j++) {
        if (targetByActor[actors[i]] === targetByActor[actors[j]]) {
          votedTogether[actors[i]][actors[j]] += 1;
          votedTogether[actors[j]][actors[i]] += 1;
        }
      }
    }
  }
  let maxTogether = 1;
  for (let i = 0; i < NUM_PLAYERS; i++) {
    for (let j = 0; j < NUM_PLAYERS; j++) {
      if (votedTogether[i][j] > maxTogether) maxTogether = votedTogether[i][j];
    }
  }

  // ── Per-player features (18 x 35 = 630) ─────────────────────────────────

  for (let pid = 0; pid < NUM_PLAYERS; pid++) {
    const p = state.players[pid];
    if (!p) { offset += PER_PLAYER_DIM; continue; }

    const baseOffset = offset;

    // [1] is_self
    obs[offset++] = p.id === playerId ? 1 : 0;

    // [2] is_alive
    obs[offset++] = p.alive ? 1 : 0;

    // [3] is_known_ally
    let knownAlly = 0;
    if (p.id === playerId) knownAlly = 1;
    else if (!p.alive) knownAlly = 0;
    else if (isKiller && p.role === Roles.KILLER.id) knownAlly = 1;
    else if (isPolice && p.role === Roles.POLICE.id) knownAlly = 1;
    else if (isGrudge && p.role === Roles.GRUDGE_BEAST.id) knownAlly = 1;
    obs[offset++] = knownAlly;

    // [4-23] role_probs (20)
    const beliefProbs = actor?.aiMemory?.roleProbs?.[p.id];
    if (!p.alive || p.id === playerId || knownAlly) {
      for (let r = 0; r < NUM_ROLES; r++) {
        obs[offset + r] = ROLE_IDS[r] === p.role ? 1 : 0;
      }
    } else if (beliefProbs) {
      for (let r = 0; r < NUM_ROLES; r++) {
        obs[offset + r] = beliefProbs[ROLE_IDS[r]] || 0;
      }
    } else {
      for (let r = 0; r < NUM_ROLES; r++) {
        obs[offset + r] = 1 / NUM_ROLES;
      }
    }
    offset += NUM_ROLES;

    // [24] suspicion
    obs[offset++] = actor?.aiMemory?.suspicion?.[p.id] ?? 0.5;

    // [25] vote pressure (last round)
    obs[offset++] = (lastTally[p.id] || 0) / maxTally;

    // [26] speak ratio
    obs[offset++] = (speakCount[p.id] || 0) / maxSpeak;

    // [27] mention ratio
    obs[offset++] = (mentionCount[p.id] || 0) / maxMention;

    // ── NEW: social features (8) ────────────────────────────────────────

    // [28] times I accused this player (normalized)
    obs[offset++] = chatInteract.accuse[playerId]?.[pid] ?? 0;

    // [29] times I defended this player (normalized)
    obs[offset++] = chatInteract.defend[playerId]?.[pid] ?? 0;

    // [30] times this player accused me (normalized)
    obs[offset++] = chatInteract.accuse[pid]?.[playerId] ?? 0;

    // [31] times this player defended me (normalized)
    obs[offset++] = chatInteract.defend[pid]?.[playerId] ?? 0;

    // [32] vote-together score (how often we voted the same target)
    obs[offset++] = (votedTogether[playerId]?.[pid] ?? 0) / maxTogether;

    // [33] last words accused this player?
    obs[offset++] = lwSignals.accused[pid] ?? 0;

    // [34] last words defended this player?
    obs[offset++] = lwSignals.defended[pid] ?? 0;

    // [35] dead player claimed role (normalized index, 0=no claim)
    obs[offset++] = lwSignals.claimedRole[pid] ?? 0;

    if (offset - baseOffset !== PER_PLAYER_DIM) {
      throw new Error(`Per-player dim mismatch: expected ${PER_PLAYER_DIM}, got ${offset - baseOffset}`);
    }
  }

  // ── Vote graph (18x18 = 324) ─────────────────────────────────────────────
  // Full vote history: who voted for whom (row = voter, col = target)
  for (let i = 0; i < NUM_PLAYERS; i++) {
    for (let j = 0; j < NUM_PLAYERS; j++) {
      obs[offset++] = voteGraph[i][j];
    }
  }

  // ── Chat interaction matrix (18x4 = 72) ──────────────────────────────────
  // For each player: total accusations made, total defenses made,
  //                  total accusations received, total defenses received
  for (let pid = 0; pid < NUM_PLAYERS; pid++) {
    let accMade = 0, defMade = 0, accRecv = 0, defRecv = 0;
    for (let j = 0; j < NUM_PLAYERS; j++) {
      accMade += chatInteract.accuse[pid]?.[j] ?? 0;
      defMade += chatInteract.defend[pid]?.[j] ?? 0;
      accRecv += chatInteract.accuse[j]?.[pid] ?? 0;
      defRecv += chatInteract.defend[j]?.[pid] ?? 0;
    }
    obs[offset++] = accMade;
    obs[offset++] = defMade;
    obs[offset++] = accRecv;
    obs[offset++] = defRecv;
  }

  // ── Last words signals (18x3 = 54) ───────────────────────────────────────
  // Per dead player: accused target score, defended target score, claimed role
  for (let pid = 0; pid < NUM_PLAYERS; pid++) {
    obs[offset++] = lwSignals.accused[pid];
    obs[offset++] = lwSignals.defended[pid];
    obs[offset++] = lwSignals.claimedRole[pid];
  }

  // ── Own role context (25) ────────────────────────────────────────────────

  for (let r = 0; r < NUM_ROLES; r++) {
    obs[offset++] = ROLE_IDS[r] === actorRole ? 1 : 0;
  }

  for (let f = 0; f < FACTION_IDS.length; f++) {
    obs[offset++] = FACTION_IDS[f] === actorFaction ? 1 : 0;
  }

  if (actorRole === Roles.DOCTOR.id) {
    obs[offset++] = (6 - (u.doctorInjections || 0)) / 6;
    obs[offset++] = (actor?.emptyInjections || 0) / 2;
  } else if (actorRole === Roles.SNIPER?.id) {
    obs[offset++] = (4 - (u.sniperShots || 0)) / 4;
    obs[offset++] = 0;
  } else if (actorRole === Roles.EXORCIST?.id) {
    obs[offset++] = (actor?.maxChains || 0) / 3;
    obs[offset++] = (actor?.exorcistMistakes || 0) / 3;
  } else if (actorRole === Roles.NECROMANCER?.id) {
    obs[offset++] = (actor?.souls || 0) / 4;
    obs[offset++] = 0;
  } else {
    obs[offset++] = 0;
    obs[offset++] = 0;
  }

  return obs;
}

/**
 * Encode observations for ALL players in a single call.
 */
export function encodeAllObservations(state) {
  const observations = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    observations.push(encodeObservation(state, i));
  }
  return observations;
}

/**
 * Build multi-head action mask for a player.
 * Returns Float32Array of length 63:
 *   [0:19]  target mask (night action / vote target)
 *   [19:24] chat_type mask (0=silence 1=accuse 2=defend 3=claim 4=deflect)
 *   [24:43] chat_target mask (who to accuse/defend)
 *   [43:63] claim_role mask (which role to claim)
 */
export function buildActionMask(state, playerId, phase) {
  const TOTAL_MASK = 63;
  const mask = new Float32Array(TOTAL_MASK);
  const actor = getPlayer(state, playerId);

  if (!actor?.alive) {
    mask[18] = 1;    // target: no_action
    mask[19] = 1;    // chat: silence only
    mask[42] = 1;    // chat_target: nobody
    // claim: all zero (can't claim)
    return mask;
  }

  const meta = roleMeta(actor.role);
  const aliveOthers = alivePlayers(state).filter(p => p.id !== actor.id);

  // ── Target mask [0:19] ──
  if (phase === "NIGHT") {
    if (!meta.hasNightAction || actor.status.cannotAct || actor.status.smoked > 0 ||
        actor.status.kidnapped || actor.status.purified ||
        actor.role === Roles.CIVILIAN.id || actor.role === Roles.BRAT.id) {
      mask[18] = 1; // no_action only
    } else {
      if (actor.role === Roles.ARSONIST.id) mask[18] = 1; // can ignite (no target)
      for (const p of aliveOthers) {
        if (actor.role === Roles.KILLER.id && p.role === Roles.KILLER.id) continue;
        mask[p.id] = 1;
      }
      mask[18] = 1; // can skip
    }
  } else {
    // VOTE / DAY
    if ((actor.role === Roles.BRAT.id && actor.status.bratRevived) || actor.status.purified) {
      mask[18] = 1; // abstain only
    } else {
      for (const p of aliveOthers) {
        if (p.status.purified) continue;
        mask[p.id] = 1;
      }
      mask[18] = 1; // abstain
    }
  }

  // ── Chat type mask [19:24] ──
  // Chat is processed during NIGHT step only. VOTE step ignores chat.
  if (phase === "NIGHT") {
    mask[19 + 0] = 1; // silence
    if (aliveOthers.length > 0) {
      mask[19 + 1] = 1; // accuse
      mask[19 + 2] = 1; // defend
    }
    mask[19 + 3] = 1; // claim_role
    mask[19 + 4] = 1; // deflect

    // ── Chat target mask [24:43] ──
    for (const p of aliveOthers) {
      mask[24 + p.id] = 1;
    }
    mask[24 + 18] = 1; // nobody

    // ── Claim role mask [43:63] ──
    for (let r = 0; r < ROLE_IDS.length; r++) {
      mask[43 + r] = 1;
    }
  } else {
    // VOTE/DAY: silence only, no chat targets, no claims
    mask[19 + 0] = 1; // silence
    mask[24 + 18] = 1; // nobody
  }

  return mask;
}

export function buildAllActionMasks(state, phase) {
  const masks = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    masks.push(buildActionMask(state, i, phase));
  }
  return masks;
}

export function encodeGroundTruth(state) {
  const truth = new Float32Array(NUM_PLAYERS * NUM_ROLES);
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const p = state.players[i];
    if (p) {
      const idx = ROLE_IDX[p.role] ?? ROLE_IDX.CIVILIAN;
      truth[i * NUM_ROLES + idx] = 1;
    }
  }
  return truth;
}

export function computeRewards(state) {
  const rewards = new Float32Array(NUM_PLAYERS);
  const victory = state.victory;
  if (!victory) return rewards;

  for (let i = 0; i < NUM_PLAYERS; i++) {
    const p = state.players[i];
    if (!p) continue;

    const startFaction = p.startFaction;
    const winner = victory.winner;
    let reward = 0;

    if (winner === "ZOMBIE") {
      reward = p.role === Roles.ZOMBIE.id ? 1.0 : -1.0;
    } else if (winner === "GRUDGE") {
      reward = p.role === Roles.GRUDGE_BEAST.id ? 1.0 : -1.0;
    } else if (winner === startFaction) {
      reward = 1.0;
    } else if (winner === "NONE") {
      reward = -0.5;
    } else {
      reward = -1.0;
    }

    if (p.alive) reward += 0.05;
    rewards[i] = reward;
  }

  return rewards;
}

export { ROLE_IDS, FACTION_IDS, THEME_IDS, NUM_PLAYERS, NUM_ROLES };
