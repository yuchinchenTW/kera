/**
 * Game Server for RL Training
 *
 * Headless game server that exposes step-by-step control via JSON over stdin/stdout.
 * Each line of stdin is a JSON command; each response is a JSON line on stdout.
 *
 * Protocol:
 *   {cmd: "reset", theme?, seed?, difficulty?}
 *     -> {ok: true, obs: [...18x505...], masks: [...18x19...], roles: [...], alive: [...], phase: "NIGHT"}
 *
 *   {cmd: "step_night", actions: [{actorId, targetId}, ...]}
 *     -> {ok: true, obs, masks, rewards, done, phase, day, victory?, alive}
 *
 *   {cmd: "step_vote", actions: [{actorId, targetId}, ...]}
 *     -> {ok: true, obs, masks, rewards, done, phase, day, victory?, alive}
 *
 *   {cmd: "get_info"}
 *     -> {ok: true, roles, factions, alive, phase, day, victory}
 *
 * Notes:
 *   - All 18 players are AI-controlled (allAi: true).
 *   - For step_night, omitted players get heuristic AI actions.
 *   - For step_vote, omitted players get heuristic AI votes.
 *   - The RL agent can control any subset of players per step.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert Float32Array to regular array for JSON serialization */
function f32ToArray(f32) {
  return Array.from(f32);
}

/** Map RL action (target index 0-17, or 18=no_action) to engine action format */
function rlActionToNightAction(state, actorId, targetIdx) {
  if (targetIdx === 18 || targetIdx === null || targetIdx === undefined) return null;
  const actor = getPlayer(state, actorId);
  if (!actor?.alive) return null;

  const role = actor.role;
  const target = getPlayer(state, targetIdx);
  if (!target?.alive) return null;

  // Map role to action type
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
    ARSONIST: "ARSON_MARK", // simplified: always mark (ignite is targetIdx=18)
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

function rlActionToVote(actorId, targetIdx) {
  if (targetIdx === 18 || targetIdx === null || targetIdx === undefined) return null;
  return { actorId, targetId: targetIdx };
}

// ─── Game State ───────────────────────────────────────────────────────────────

let engine = null;

function buildResponse(extra = {}) {
  const state = engine.state;
  const obs = encodeAllObservations(state);
  const phase = state.victory ? "END" : state.phase;
  const masks = buildAllActionMasks(state, phase);
  const rewards = computeRewards(state);
  const done = !!state.victory;

  return {
    ok: true,
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
      // Derived stats not tracked in engine.usage
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
    ...extra,
  };
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

function handleReset(msg) {
  const theme = msg.theme || "GOOD_VS_EVIL";
  const seed = msg.seed ?? Date.now();
  const difficulty = msg.difficulty || "hard";

  engine = new GameEngine(seed, theme, difficulty, { allAi: true });

  // Run belief initialization so observations have meaningful values
  // (ensureBeliefs is called inside buildAiNightActions, but we want obs before actions)

  const roles = engine.state.players.map(p => p.role);
  const factions = engine.state.players.map(p => p.faction);

  return {
    ...buildResponse(),
    roles,
    factions,
    seed,
  };
}

function handleStepNight(msg) {
  if (!engine) return { ok: false, error: "No game. Call reset first." };
  if (engine.state.victory) return { ok: false, error: "Game already ended." };

  const rlActions = msg.actions || [];

  // Convert RL actions to engine format
  const externalActions = [];
  const controlledIds = new Set();

  for (const a of rlActions) {
    if (typeof a.actorId !== "number") continue;
    controlledIds.add(a.actorId);
    const action = rlActionToNightAction(engine.state, a.actorId, a.targetId);
    if (action) externalActions.push(action);
  }

  // For players NOT controlled by RL, let heuristic AI decide
  // We pass external actions via humanActions and set includeHuman
  // so buildAiNightActions generates for all players, then engine merges
  engine.resolveNight(null, {
    includeHuman: true,
    humanActions: externalActions,
  });

  // If game didn't end after night, run day phase (chat generation)
  if (!engine.state.victory && engine.state.phase === Phase.DAY) {
    // Generate AI chat for the day
    const chatLines = generateChatLines(engine.state);
    if (chatLines) {
      engine.state.dayChat = engine.state.dayChat || [];
      for (const line of chatLines) {
        engine.state.dayChat.push(line);
        engine.state.publicLog.push(line);
      }
    }
    generateFactionChat(engine.state);
  }

  return buildResponse();
}

function handleStepVote(msg) {
  if (!engine) return { ok: false, error: "No game. Call reset first." };
  if (engine.state.victory) return { ok: false, error: "Game already ended." };

  const rlActions = msg.actions || [];

  // Convert RL actions to vote format
  const externalVotes = [];
  for (const a of rlActions) {
    if (typeof a.actorId !== "number") continue;
    const vote = rlActionToVote(a.actorId, a.targetId);
    if (vote) externalVotes.push(vote);
  }

  // resolveVote with external votes + AI fills the rest
  engine.resolveVote(null, "", {
    includeHuman: true,
    humanVotes: externalVotes,
  });

  return buildResponse();
}

function handleGetInfo() {
  if (!engine) return { ok: false, error: "No game. Call reset first." };

  const state = engine.state;
  return {
    ok: true,
    roles: state.players.map(p => p.role),
    factions: state.players.map(p => p.faction),
    alive: state.aliveIds,
    phase: state.phase,
    day: state.dayNumber,
    victory: state.victory || null,
    counts: factionCounts(state),
  };
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: "Invalid JSON" }) + "\n");
    return;
  }

  let response;
  try {
    switch (msg.cmd) {
      case "reset":
        response = handleReset(msg);
        break;
      case "step_night":
        response = handleStepNight(msg);
        break;
      case "step_vote":
        response = handleStepVote(msg);
        break;
      case "get_info":
        response = handleGetInfo();
        break;
      case "quit":
        process.exit(0);
        break;
      default:
        response = { ok: false, error: `Unknown command: ${msg.cmd}` };
    }
  } catch (e) {
    response = { ok: false, error: e.message };
  }

  process.stdout.write(JSON.stringify(response) + "\n");
});

rl.on("close", () => process.exit(0));
