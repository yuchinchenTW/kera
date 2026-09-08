/**
 * Neural Network AI — runs the trained ONNX policy for hard AI decisions.
 *
 * Loads the ONNX model once, then provides inference for night/vote phases.
 * Falls back to heuristic AI if model is not loaded.
 */

import { alivePlayers, getPlayer } from "../state.js";
import { encodeObservation, buildActionMask, ROLE_IDS } from "../../training/state_encoder.js";

// ─── Singleton session ──────────────────────────────────────────────────────

let ort = null;
let session = null;

export async function loadNeuralModel(path) {
  // Dynamic import: onnxruntime-node is Node.js-only, unavailable in browser
  try {
    ort = await import("onnxruntime-node");
  } catch {
    console.warn("[Neural AI] Optional onnxruntime-node is unavailable; legacy neural simulations require a separate runtime install and local model.");
    return false;
  }

  if (!path) {
    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    path = join(__dirname, "../../training/mafia_policy.onnx");
  }

  try {
    session = await ort.InferenceSession.create(path, {
      executionProviders: ["cpu"],
    });
    console.log(`[Neural AI] Model loaded: ${path}`);
    return true;
  } catch (err) {
    console.warn(`[Neural AI] Failed to load model: ${err.message}`);
    session = null;
    return false;
  }
}

export function isNeuralModelLoaded() {
  return session !== null;
}

// ─── Inference ──────────────────────────────────────────────────────────────

/**
 * Run neural inference for a batch of AI players.
 * @param {object} state - game state
 * @param {number[]} playerIds - AI player IDs to run inference for
 * @param {string} phase - "NIGHT" or "VOTE"
 * @returns {Array<{actorId, targetId, chatType, chatTargetId, claimRoleId}>}
 */
export async function neuralInfer(state, playerIds, phase) {
  if (!session || playerIds.length === 0) return [];
  console.log(`[Neural AI] Inference: ${phase}, ${playerIds.length} players, day ${state.dayNumber || 1}`);

  const N = playerIds.length;
  const OBS_DIM = 1135;
  const MASK_DIM = 63;

  // Encode observations and masks
  const obsData = new Float32Array(N * OBS_DIM);
  const maskData = new Float32Array(N * MASK_DIM);

  for (let i = 0; i < N; i++) {
    const obs = encodeObservation(state, playerIds[i]);
    const mask = buildActionMask(state, playerIds[i], phase);
    obsData.set(obs, i * OBS_DIM);
    maskData.set(mask, i * MASK_DIM);
  }

  const obsTensor = new ort.Tensor("float32", obsData, [N, OBS_DIM]);
  const maskTensor = new ort.Tensor("float32", maskData, [N, MASK_DIM]);

  const results = await session.run({ obs: obsTensor, action_mask: maskTensor });

  const targetProbs = results.target_probs.data;
  const chatTypeProbs = results.chat_type_probs.data;
  const chatTargetProbs = results.chat_target_probs.data;
  const claimRoleProbs = results.claim_role_probs.data;

  const actions = [];
  for (let i = 0; i < N; i++) {
    const targetId = argmax(targetProbs, i * 19, 19);
    const chatType = argmax(chatTypeProbs, i * 5, 5);
    const chatTargetId = argmax(chatTargetProbs, i * 19, 19);
    const claimRoleId = argmax(claimRoleProbs, i * 20, 20);

    actions.push({
      actorId: playerIds[i],
      targetId: targetId >= 18 ? null : targetId,
      chatType,
      chatTargetId: chatTargetId >= 18 ? null : chatTargetId,
      claimRoleId,
    });
  }

  return actions;
}

function argmax(data, offset, size) {
  let best = 0;
  let bestVal = data[offset];
  for (let i = 1; i < size; i++) {
    if (data[offset + i] > bestVal) {
      bestVal = data[offset + i];
      best = i;
    }
  }
  return best;
}

// ─── Action translation: Night ──────────────────────────────────────────────

/**
 * Convert neural outputs to night action format.
 * @returns {Array<{actorId, type, targetId}>}
 */
export function neuralToNightActions(state, neuralActions) {
  const actions = [];
  for (const a of neuralActions) {
    const actor = getPlayer(state, a.actorId);
    if (!actor?.alive) continue;

    // Arsonist: targetId === null means ignite (no target needed)
    if (actor.role === "ARSONIST" && a.targetId === null) {
      actions.push({ actorId: a.actorId, type: "ARSON_IGNITE" });
      continue;
    }

    if (a.targetId === null) continue;
    const target = getPlayer(state, a.targetId);
    if (!target?.alive) continue;

    const roleActionMap = {
      POLICE: "POLICE_INVESTIGATE",
      KILLER: "KILLER_VOTE",
      DOCTOR: "DOCTOR_INJECT",
      SNIPER: "SNIPER_SHOT",
      AGENT: "AGENT_PROTECT",
      HEAVENLY_FIEND: actor.status?.fiendMode === "CHARGE" ? "FIEND_SHOOT" : "FIEND_PROTECT",
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

    const type = roleActionMap[actor.role];
    if (!type) continue;
    actions.push({ actorId: a.actorId, type, targetId: a.targetId });
  }
  return actions;
}

// ─── Action translation: Vote ───────────────────────────────────────────────

/**
 * Convert neural outputs to vote action format.
 * @returns {Array<{actorId, targetId}>}
 */
export function neuralToVoteActions(state, neuralActions) {
  const votes = [];
  for (const a of neuralActions) {
    if (a.targetId === null) continue;
    const actor = getPlayer(state, a.actorId);
    if (!actor?.alive) continue;
    const target = getPlayer(state, a.targetId);
    if (!target?.alive) continue;
    votes.push({ actorId: a.actorId, targetId: a.targetId });
  }
  return votes;
}

// ─── Chat injection ─────────────────────────────────────────────────────────

const CHAT_TYPES = ["silence", "accuse", "defend", "claim_role", "deflect"];
const roleZh = {
  POLICE: "警察", DOCTOR: "醫生", CIVILIAN: "平民", KILLER: "殺手",
  SNIPER: "狙擊手", AGENT: "特務", TERRORIST: "恐怖分子", COWBOY: "牛仔",
};

/**
 * Inject neural chat actions into state.dayChat.
 */
export function neuralInjectChat(state, neuralActions) {
  state.dayChat = state.dayChat || [];
  state.roleClaims = state.roleClaims || {};

  for (const a of neuralActions) {
    const actor = getPlayer(state, a.actorId);
    if (!actor?.alive) continue;
    const chatType = CHAT_TYPES[a.chatType] || "silence";
    if (chatType === "silence") continue;

    const chatTarget = a.chatTargetId !== null ? getPlayer(state, a.chatTargetId) : null;
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
      if (state.publicLog) state.publicLog.push(line);
    }
  }
}
