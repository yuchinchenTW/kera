/**
 * Game Server for RL Training (v2 — batched multi-game)
 *
 * Single Node.js process runs N games simultaneously.
 * Supports batched commands to minimize IPC overhead.
 *
 * Protocol:
 *   {cmd: "init", numGames: N, theme?, difficulty?}
 *     -> {ok, numGames}
 *
 *   {cmd: "reset_all", seeds: [seed0, seed1, ...]}
 *     -> {ok, games: [{obs, masks, roles, factions}, ...]}
 *
 *   {cmd: "step_round", games: [{nightActions, voteActions}, ...]}
 *     -> {ok, games: [{obs, masks, rewards, done, phase, day, victory, usage, counts}, ...]}
 *     Night + chat + vote in ONE IPC call.
 *
 *   {cmd: "step_night", games: [{actions}, ...]}
 *   {cmd: "step_vote", games: [{actions}, ...]}
 *     -> Single-phase step (backward compat)
 *
 *   {cmd: "quit"} -> exit
 */

import { createInterface } from "node:readline";
import { GameEngine } from "../src/engine.js";
import { buildAiNightActions, buildAiVoteActions, generateChatLines, generateFactionChat, generateNightFactionChat } from "../src/ai/index.js";
import { alivePlayers, getPlayer, factionCounts } from "../src/state.js";
import { Phase, Roles, Faction, roleMeta } from "../src/roles.js";
import {
  encodeAllObservations,
  buildAllActionMasks,
  encodeGroundTruth,
  computeRewards,
  OBS_DIM,
} from "./state_encoder.js";

const ROLE_IDS = [
  "POLICE", "KILLER", "DOCTOR", "SNIPER", "AGENT", "TERRORIST", "COWBOY",
  "KIDNAPPER", "ZOMBIE", "RIOT_POLICE", "ARSONIST", "HEAVENLY_FIEND",
  "VINE_DEMON", "BRAT", "NIGHTMARE_DEMON", "EXORCIST", "NECROMANCER",
  "PURIFIER", "GRUDGE_BEAST", "CIVILIAN",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function f32ToArray(f32) {
  return Array.from(f32);
}

function rlActionToNightAction(state, actorId, targetIdx) {
  if (targetIdx === 18 || targetIdx === null || targetIdx === undefined) return null;
  const actor = getPlayer(state, actorId);
  if (!actor?.alive) return null;
  const target = getPlayer(state, targetIdx);
  if (!target?.alive) return null;

  const role = actor.role;
  const roleActionMap = {
    POLICE: "POLICE_INVESTIGATE",
    KILLER: "KILLER_VOTE",
    DOCTOR: "DOCTOR_INJECT",
    SNIPER: "SNIPER_SHOT",
    AGENT: "AGENT_PROTECT",
    HEAVENLY_FIEND: actor.status.fiendMode === "CHARGE" ? "FIEND_SHOOT" : "FIEND_PROTECT",
    TERRORIST: "TERROR_BOMB",
    COWBOY: "COWBOY_GAMBLE",
    KIDNAPPER: "KIDNAP",
    ZOMBIE: "ZOMBIE_BITE",
    RIOT_POLICE: "RIOT_SMOKE",
    ARSONIST: "ARSON_MARK",
    VINE_DEMON: "VINE_SEED",
    NIGHTMARE_DEMON: "NIGHTMARE_ATTACK",
    EXORCIST: "EXORCIST_STRIKE",
    NECROMANCER: "NECROMANCER_CURSE",
    PURIFIER: "PURIFY",
    GRUDGE_BEAST: state.grudgeState?.berserk ? "GRUDGE_KILL_VOTE" : "GRUDGE_JUDGE",
  };
  const type = roleActionMap[role];
  if (!type) return null;
  return { actorId, type, targetId: targetIdx };
}

function injectRlChat(state, actions) {
  state.dayChat = state.dayChat || [];
  state.roleClaims = state.roleClaims || {};
  const CHAT_TYPES = ["silence", "accuse", "defend", "claim_role", "deflect"];
  const roleZh = { POLICE: "警察", DOCTOR: "醫生", CIVILIAN: "平民", KILLER: "殺手", SNIPER: "狙擊手", AGENT: "特務" };

  for (const a of actions) {
    if (typeof a.actorId !== "number") continue;
    const actor = getPlayer(state, a.actorId);
    if (!actor?.alive) continue;
    const chatType = CHAT_TYPES[a.chatType] || "silence";
    if (chatType === "silence") continue;

    const chatTarget = typeof a.chatTargetId === "number" ? getPlayer(state, a.chatTargetId) : null;
    const targetName = chatTarget?.name || "someone";
    let line = null;

    if (chatType === "accuse" && chatTarget) {
      line = `${actor.name}: I think ${targetName} is suspicious.||${actor.name}：我覺得 ${targetName} 很可疑。`;
    } else if (chatType === "defend" && chatTarget) {
      line = `${actor.name}: ${targetName} seems fine to me.||${actor.name}：${targetName} 我覺得沒問題。`;
    } else if (chatType === "claim_role") {
      const claimedRole = ROLE_IDS[a.claimRoleId] || "CIVILIAN";
      const zhName = roleZh[claimedRole] || claimedRole;
      line = `${actor.name}: I am ${claimedRole}.||${actor.name}：我是${zhName}。`;
      state.roleClaims[actor.id] = claimedRole;
    } else if (chatType === "deflect") {
      line = `${actor.name}: Let's focus on the real threats.||${actor.name}：我們應該專注在真正的威脅上。`;
    }

    if (line) {
      state.dayChat.push(line);
      state.publicLog.push(line);
    }
  }
}

function buildGameResponse(engine) {
  const state = engine.state;
  const phase = state.victory ? "END" : state.phase;
  const obs = encodeAllObservations(state);
  const masks = buildAllActionMasks(state, phase);
  const rewards = computeRewards(state);
  const done = !!state.victory;

  return {
    obs: obs.map(f32ToArray),
    masks: masks.map(f32ToArray),
    ground_truth: f32ToArray(encodeGroundTruth(state)),
    rewards: f32ToArray(rewards),
    done,
    phase,
    day: state.dayNumber,
    alive: state.aliveIds,
    victory: state.victory || null,
    usage: {
      ...(state.usage || {}),
      doctorOverdoses: state.players.filter(p => !p.alive && p.deathCause === "EMPTY_INJECTION").length,
      zombieConversions: state.players.filter(p => p.alive && p.role === Roles.ZOMBIE.id && p.startRole !== Roles.ZOMBIE.id).length,
      zombieKills: state.players.filter(p => !p.alive && (p.deathCause === "ZOMBIE_BITE" || p.deathCause === "ZOMBIE_FATAL")).length,
      policeFoundRed: Object.keys(state.policeConfirmed || {}).length,
      terrorBombs: state.players.filter(p => !p.alive && p.deathCause === "TERROR_BOMB").length,
      exorcistPetrifies: state.players.filter(p => !p.alive && p.deathCause === "EXORCIST_PETRIFY").length,
      nightKills: state.players.filter(p => !p.alive && p.deathCause && p.deathCause !== "VOTE_EXECUTION").length,
      voteKills: state.players.filter(p => !p.alive && p.deathCause === "VOTE_EXECUTION").length,
    },
    counts: done ? factionCounts(state) : null,
  };
}

// ─── Multi-Game State ─────────────────────────────────────────────────────────

let engines = [];
let config = { theme: "GOOD_VS_EVIL", difficulty: "hard" };

// ─── Command Handlers ─────────────────────────────────────────────────────────

function handleInit(msg) {
  const n = msg.numGames || 1;
  config.theme = msg.theme || "GOOD_VS_EVIL";
  config.difficulty = msg.difficulty || "hard";
  engines = new Array(n).fill(null);
  return { ok: true, numGames: n };
}

function handleResetAll(msg) {
  const seeds = msg.seeds || [];
  const games = [];
  for (let g = 0; g < engines.length; g++) {
    const seed = seeds[g];
    if (seed === -1 || seed === undefined || seed === null) {
      // Skip — keep existing game, return current state
      if (engines[g]) {
        games.push(buildGameResponse(engines[g]));
      } else {
        games.push({ done: true, phase: "END" });
      }
      continue;
    }
    engines[g] = new GameEngine(seed, config.theme, config.difficulty, { allAi: true });
    const state = engines[g].state;
    const resp = buildGameResponse(engines[g]);
    resp.roles = state.players.map(p => p.role);
    resp.factions = state.players.map(p => p.faction);
    resp.seed = seed;
    games.push(resp);
  }
  return { ok: true, games };
}

async function stepNightOne(engine, actions) {
  const state = engine.state;
  const externalActions = [];
  for (const a of actions) {
    if (typeof a.actorId !== "number") continue;
    const action = rlActionToNightAction(state, a.actorId, a.targetId);
    if (action) externalActions.push(action);
  }
  await engine.resolveNight(null, { includeHuman: true, humanActions: externalActions });

  if (!state.victory && state.phase === Phase.DAY) {
    injectRlChat(state, actions);
    const chatLines = generateChatLines(state);
    if (chatLines) {
      state.dayChat = state.dayChat || [];
      for (const line of chatLines) { state.dayChat.push(line); state.publicLog.push(line); }
    }
    generateFactionChat(state);
  }
}

async function stepVoteOne(engine, actions) {
  const state = engine.state;
  // Don't inject chat during vote — chat only happens once per day (in stepNightOne)
  const externalVotes = [];
  for (const a of actions) {
    if (typeof a.actorId !== "number") continue;
    if (a.targetId !== null && a.targetId !== undefined && a.targetId < 18) {
      externalVotes.push({ actorId: a.actorId, targetId: a.targetId });
    }
  }
  await engine.resolveVote(null, "", { includeHuman: true, humanVotes: externalVotes });
}

async function handleStepRound(msg) {
  // Night + Vote in one IPC call
  const gameInputs = msg.games || [];
  const results = [];
  for (let g = 0; g < engines.length; g++) {
    const engine = engines[g];
    if (!engine || engine.state.victory) {
      results.push(engine ? buildGameResponse(engine) : { done: true, error: "no engine" });
      continue;
    }
    const input = gameInputs[g] || {};

    // Night
    await stepNightOne(engine, input.nightActions || []);
    if (engine.state.victory) {
      results.push(buildGameResponse(engine));
      continue;
    }

    // Vote
    await stepVoteOne(engine, input.voteActions || []);
    results.push(buildGameResponse(engine));
  }
  return { ok: true, games: results };
}

async function handleStepNight(msg) {
  const gameInputs = msg.games || [];
  const results = [];
  for (let g = 0; g < engines.length; g++) {
    const engine = engines[g];
    if (!engine || engine.state.victory) {
      results.push(engine ? buildGameResponse(engine) : { done: true });
      continue;
    }
    await stepNightOne(engine, (gameInputs[g] || {}).actions || []);
    results.push(buildGameResponse(engine));
  }
  return { ok: true, games: results };
}

async function handleStepVote(msg) {
  const gameInputs = msg.games || [];
  const results = [];
  for (let g = 0; g < engines.length; g++) {
    const engine = engines[g];
    if (!engine || engine.state.victory) {
      results.push(engine ? buildGameResponse(engine) : { done: true });
      continue;
    }
    await stepVoteOne(engine, (gameInputs[g] || {}).actions || []);
    results.push(buildGameResponse(engine));
  }
  return { ok: true, games: results };
}

// Legacy single-game commands (backward compat)
function handleLegacyReset(msg) {
  engines = [new GameEngine(msg.seed ?? Date.now(), msg.theme || config.theme, msg.difficulty || config.difficulty, { allAi: true })];
  const state = engines[0].state;
  const resp = buildGameResponse(engines[0]);
  return { ok: true, ...resp, roles: state.players.map(p => p.role), factions: state.players.map(p => p.faction), seed: msg.seed };
}

async function handleLegacyStepNight(msg) {
  if (!engines[0]) return { ok: false, error: "No game" };
  await stepNightOne(engines[0], msg.actions || []);
  return { ok: true, ...buildGameResponse(engines[0]) };
}

async function handleLegacyStepVote(msg) {
  if (!engines[0]) return { ok: false, error: "No game" };
  await stepVoteOne(engines[0], msg.actions || []);
  return { ok: true, ...buildGameResponse(engines[0]) };
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line.trim()); } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: "Invalid JSON" }) + "\n");
    return;
  }

  let response;
  try {
    switch (msg.cmd) {
      case "init":       response = handleInit(msg); break;
      case "reset_all":  response = handleResetAll(msg); break;
      case "step_round": response = await handleStepRound(msg); break;
      case "step_night_batch": response = await handleStepNight(msg); break;
      case "step_vote_batch":  response = await handleStepVote(msg); break;
      // Legacy single-game commands
      case "reset":      response = handleLegacyReset(msg); break;
      case "step_night": response = await handleLegacyStepNight(msg); break;
      case "step_vote":  response = await handleLegacyStepVote(msg); break;
      case "get_info":   response = { ok: true, numGames: engines.length }; break;
      case "quit":       process.exit(0); break;
      default:           response = { ok: false, error: `Unknown: ${msg.cmd}` };
    }
  } catch (e) {
    response = { ok: false, error: e.message };
  }

  process.stdout.write(JSON.stringify(response) + "\n");
});

rl.on("close", () => process.exit(0));
