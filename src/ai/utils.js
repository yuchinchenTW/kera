import { alivePlayers } from "../state.js";
import { roleListFromTheme } from "../roles.js";

export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function rolePriorCounts(themeId) {
  const list = roleListFromTheme(themeId);
  const counts = {};
  for (const r of list) counts[r] = (counts[r] || 0) + 1;
  return counts;
}

export function isHard(state) {
  return state.difficulty === "hard" || state.difficulty === "nightmare";
}

// ─── Behavioral Analysis ───────────────────────────────────────────────────

/**
 * Chat memory as visible to *other* players: entries parsed from a private faction
 * channel (source "faction") must never leak into someone else's reasoning.
 */
export function publicChatMemory(p) {
  return (p?.aiMemory?.chatMemory || []).filter((m) => m.source !== "faction");
}

/**
 * Ids of players mentioned in a line. Longer names are matched first and a shorter
 * name only counts when it is not part of an already matched longer one, so
 * "Player 10" never registers as a mention of "Player 1".
 */
export function mentionedPlayerIds(line, players) {
  const ids = new Set();
  if (typeof line !== "string" || !line) return ids;
  const claimed = [];
  const sorted = (players || []).filter((p) => p && p.name).sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    let from = 0;
    for (;;) {
      const idx = line.indexOf(p.name, from);
      if (idx < 0) break;
      const end = idx + p.name.length;
      if (!claimed.some(([s, e]) => idx < e && end > s)) {
        ids.add(p.id);
        claimed.push([idx, end]);
      }
      from = end;
    }
  }
  return ids;
}

export function ensureAdvancedMemory(p) {
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
export function roleNameZh(roleId) {
  const map = { POLICE: "警察", DOCTOR: "醫生", AGENT: "特務", CIVILIAN: "平民", KILLER: "殺手", SNIPER: "狙擊手", COWBOY: "牛仔", PURIFIER: "淨化者", RIOT_POLICE: "鎮暴警察", EXORCIST: "驅魔師" };
  return map[roleId] || roleId;
}

// ─── Advanced Helper: Game Phase Detection ────────────────────────────────
export function getGamePhase(state) {
  const day = state.dayNumber || 1;
  const alive = alivePlayers(state).length;
  const total = state.players.length;
  const ratio = alive / total;
  if (day <= 2 && ratio > 0.7) return "early";
  if (day <= 4 && ratio > 0.4) return "mid";
  return "late";
}

export function randomChoice(list, rng) {
  if (!list.length) return null;
  const idx = Math.floor(rng() * list.length);
  return list[idx];
}

export function shuffled(list, rng) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function pickTemplate(rng, templates) {
  return templates[Math.floor(rng() * templates.length)];
}
