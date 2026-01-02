import { DeathCause, Faction, Phase, roleListFromTheme, roleMeta, Theme, Roles } from "./roles.js";
import { createRng, shuffle } from "./rng.js";

function defaultStatus(roleId) {
  return {
    smoked: 0,
    kidnapped: false,
    purified: false,
    protectedByAgent: false,
    protectedByFiend: false,
    protectionSource: null,
    arsonMarked: false,
    vineSeededBy: null,
    vineActive: roleId === Roles.VINE_DEMON.id,
    fiendMode: roleId === Roles.HEAVENLY_FIEND.id ? "ABSORB" : null,
    bratRevealed: false,
    bratRevived: false,
    zombieBites: 0,
    pendingZombieConversion: false,
    grudgeKnownRole: null,
    cannotAct: false,
  };
}

function makePlayer(id, name, roleId, isHuman = false) {
  const meta = roleMeta(roleId);
  return {
    id,
    name,
    role: roleId,
    faction: meta.faction,
    alive: true,
    isHuman,
    status: defaultStatus(roleId),
    lastWords: "",
    emptyInjections: 0,
    souls: 0,
    lastKidnapTarget: null,
    chainsLeft: roleId === Roles.EXORCIST.id ? Roles.EXORCIST.maxChain : 0,
    aiMemory: {
      suspicion: {},
      persona: {},
    },
  };
}

export function createInitialState(seed = Date.now(), themeId = Theme.GOOD_VS_EVIL.id, difficulty = "normal") {
  const rng = createRng(seed);
  const rolePool = roleListFromTheme(themeId);
  shuffle(rng, rolePool);

  const humanIndex = Math.floor(rng() * rolePool.length);
  const players = [];
  for (let i = 0; i < rolePool.length; i++) {
    const name = `Player ${i + 1}`;
    players.push(makePlayer(i, name, rolePool[i], i === humanIndex));
  }

  const aliveIds = players.filter((p) => p.alive).map((p) => p.id);

  return {
    seed,
    rng,
    phase: Phase.NIGHT,
    dayNumber: 1,
    players,
    aliveIds,
    deadIds: [],
    theme: themeId,
    publicLog: [],
    privateLogs: {
      police: [],
      killer: [],
      grudge: [],
    },
    pendingActions: {
      night: [],
      vote: [],
    },
    history: {
      votes: [],
    },
    lastVoteTargetByActor: {},
    usage: {
      doctorInjections: 0,
      sniperShots: 0,
      riotGrenades: 0,
    },
    difficulty,
    grudgeState: {
      berserk: false,
      triggerFaction: null,
    },
    policeRevealedRed: null,
    chatLoggedForDay: null,
    victory: null,
    lastNightSummary: [],
    winrateHint: null,
  };
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function alivePlayers(state) {
  return state.players.filter((p) => p.alive);
}

export function getPlayer(state, id) {
  return state.players.find((p) => p.id === id);
}

export function addPublicLog(state, entry) {
  state.publicLog.push(entry);
  state.lastNightSummary.push(entry);
}

export function addPrivateLog(state, channel, entry) {
  if (!state.privateLogs[channel]) state.privateLogs[channel] = [];
  state.privateLogs[channel].push(entry);
}

export function markDeath(state, playerId, cause) {
  const player = getPlayer(state, playerId);
  if (!player || !player.alive) return;
  player.alive = false;
  player.deathCause = cause;
  state.aliveIds = state.players.filter((p) => p.alive).map((p) => p.id);
  if (!state.deadIds.includes(playerId)) state.deadIds.push(playerId);
  if (state.policeRevealedRed === playerId) state.policeRevealedRed = null;
  addPublicLog(state, `${player.name} died (${formatDeathCause(cause)}).`);
}

export function formatDeathCause(cause) {
  switch (cause) {
    case DeathCause.KILLER_MURDER:
      return "murdered during the night";
    case DeathCause.SNIPER_HEADSHOT:
      return "sniper headshot";
    case DeathCause.EMPTY_INJECTION:
      return "fatal overdose";
    case DeathCause.VOTE_EXECUTION:
      return "executed by vote";
    case DeathCause.TERROR_BOMB:
      return "died in a bomb blast";
    case DeathCause.ARSON_BURN:
      return "burned by arson";
    case DeathCause.KIDNAP_EXECUTION:
      return "executed by ransom";
    case DeathCause.ZOMBIE_BITE:
    case DeathCause.ZOMBIE_FATAL:
      return "killed by infection";
    case DeathCause.SMOKE_OVERDOSE:
      return "choked in smoke";
    case DeathCause.AGENT_LINK:
      return "died with their agent";
    case DeathCause.COWBOY_SHOT:
      return "shot by a cowboy";
    case DeathCause.COWBOY_BACKFIRE:
      return "cowboy backfire";
    case DeathCause.EXORCIST_PETRIFY:
      return "petrified by an exorcist";
    case DeathCause.NECROMANCER_CURSE:
      return "cursed by a necromancer";
    case DeathCause.FIEND_SHOT:
      return "smited by a heavenly fiend";
    case DeathCause.NIGHTMARE_STRIKE:
      return "slain by nightmare demon";
    case DeathCause.GRUDGE_PUNISH:
      return "cut down by grudge beasts";
    case DeathCause.VINE_SWAP:
      return "sacrificed by vine seed";
    default:
      return "unknown";
  }
}

function isCivilianForWinCheck(player) {
  return player.alive && player.role !== Roles.POLICE.id && player.role !== Roles.KILLER.id;
}

export function factionCounts(state) {
  let blue = 0;
  let red = 0;
  let green = 0;
  let killers = 0;
  let police = 0;
  let civilians = 0;
  let zombies = 0;
  let grudge = 0;

  for (const p of state.players) {
    if (!p.alive) continue;
    if (p.faction === Faction.BLUE) blue++;
    if (p.faction === Faction.RED) red++;
    if (p.faction === Faction.GREEN) green++;
    if (p.role === Roles.KILLER.id) killers++;
    if (p.role === Roles.POLICE.id) police++;
    if (p.role === Roles.ZOMBIE.id) zombies++;
    if (p.role === Roles.GRUDGE_BEAST.id) grudge++;
    if (isCivilianForWinCheck(p)) civilians++;
  }

  return { blue, red, green, killers, police, civilians, zombies, grudge };
}
