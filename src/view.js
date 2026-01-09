import { alivePlayers, getPlayer } from "./state.js";
import { Roles, Phase } from "./roles.js";

function canSeeRole(viewer, target) {
  if (!viewer || !target) return false;
  if (viewer.id === target.id) return true;
  if (viewer.role === Roles.POLICE.id && target.role === Roles.POLICE.id) return true;
  if (viewer.role === Roles.KILLER.id && target.role === Roles.KILLER.id) return true;
  return false;
}

function visibleRole(viewer, target) {
  return canSeeRole(viewer, target) ? target.role : "HIDDEN";
}

function visibleFaction(viewer, target) {
  if (!viewer || !target) return "UNKNOWN";
  if (viewer.id === target.id) return target.faction;
  if (viewer.role === Roles.POLICE.id && target.role === Roles.POLICE.id) return target.faction;
  if (viewer.role === Roles.KILLER.id && target.role === Roles.KILLER.id) return target.faction;
  return "UNKNOWN";
}

export function buildPlayerView(state, playerId) {
  const viewer = getPlayer(state, playerId);
  if (!viewer) return null;
  const revealAll = state.phase === Phase.END || !!state.victory;
  const players = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    role: revealAll ? p.role : visibleRole(viewer, p),
    faction: revealAll ? p.faction : visibleFaction(viewer, p),
    isYou: p.id === playerId,
    bratRevealed: p.status?.bratRevealed || false,
    lastWords: p.lastWords || "",
    noLastWords: !!p.noLastWords,
  }));

  let privateIntel = [];
  if (viewer.role === Roles.POLICE.id) privateIntel = privateIntel.concat(state.privateLogs.police || []);
  if (viewer.role === Roles.KILLER.id) privateIntel = privateIntel.concat(state.privateLogs.killer || []);
  if (viewer.role === Roles.GRUDGE_BEAST.id) privateIntel = privateIntel.concat(state.privateLogs.grudge || []);

  const aiTakenOver = !viewer.isHuman && state.started;

  return {
    phase: state.phase,
    dayNumber: state.dayNumber,
    theme: state.theme,
    victory: state.victory,
    you: {
      id: viewer.id,
      name: viewer.name,
      role: viewer.role,
      faction: viewer.faction,
      alive: viewer.alive,
      isHuman: viewer.isHuman,
      aiTakenOver,
      noLastWords: !!viewer.noLastWords,
    },
    players,
    publicLog: [...state.publicLog],
    lastNightSummary: [...state.lastNightSummary],
    killerChat: viewer.role === Roles.KILLER.id ? [...(state.killerChat || [])] : [],
    policeChat: viewer.role === Roles.POLICE.id ? [...(state.policeChat || [])] : [],
    spectatorChat: !viewer.alive ? [...(state.spectatorChat || [])] : [],
    privateIntel,
    winrateHint: state.winrateHint,
    usage: { ...state.usage },
  };
}

export function buildSpectatorView(state) {
  const revealAll = state.phase === Phase.END || !!state.victory;
  const players = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    role: revealAll ? p.role : "HIDDEN",
    faction: revealAll ? p.faction : "UNKNOWN",
    isYou: false,
    bratRevealed: p.status?.bratRevealed || false,
    lastWords: p.lastWords || "",
    noLastWords: !!p.noLastWords,
  }));
  return {
    phase: state.phase,
    dayNumber: state.dayNumber,
    theme: state.theme,
    victory: state.victory,
    you: null,
    players,
    publicLog: [...state.publicLog],
    lastNightSummary: [...state.lastNightSummary],
    privateIntel: [],
    winrateHint: state.winrateHint,
    usage: { ...state.usage },
    // Do not expose private channels to spectators to prevent leakage.
    killerChat: [],
    policeChat: [],
    spectatorChat: [...(state.spectatorChat || [])],
  };
}

export function availableActionTargets(state, actorId) {
  const actor = getPlayer(state, actorId);
  if (!actor || !actor.alive) return [];
  return alivePlayers(state)
    .filter((p) => p.id !== actor.id)
    .map((p) => ({ id: p.id, name: p.name }));
}
