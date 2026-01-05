export const Faction = {
  BLUE: "BLUE",
  RED: "RED",
  GREEN: "GREEN",
};

export const Roles = {
  POLICE: { id: "POLICE", name: "Police", faction: Faction.BLUE, hasNightAction: true },
  KILLER: { id: "KILLER", name: "Killer", faction: Faction.RED, hasNightAction: true },
  DOCTOR: {
    id: "DOCTOR",
    name: "Doctor",
    faction: Faction.BLUE,
    hasNightAction: true,
    maxInjections: 4,
    emptyKillsAt: 2,
    revivableCauses: ["KILLER_MURDER", "KIDNAP_EXECUTION", "EXORCIST_PETRIFY"],
    nonRevivableCauses: ["SNIPER_HEADSHOT", "TERROR_BOMB", "ARSON_BURN", "ZOMBIE_FATAL"],
  },
  SNIPER: { id: "SNIPER", name: "Sniper", faction: Faction.RED, hasNightAction: true, maxShots: 4 },
  AGENT: { id: "AGENT", name: "Agent", faction: Faction.BLUE, hasNightAction: true },
  TERRORIST: { id: "TERRORIST", name: "Terrorist", faction: Faction.RED, hasNightAction: true },
  COWBOY: { id: "COWBOY", name: "Cowboy", faction: Faction.BLUE, hasNightAction: true },
  KIDNAPPER: { id: "KIDNAPPER", name: "Kidnapper", faction: Faction.RED, hasNightAction: true },
  ZOMBIE: { id: "ZOMBIE", name: "Zombie", faction: Faction.GREEN, hasNightAction: true },
  RIOT_POLICE: {
    id: "RIOT_POLICE",
    name: "Riot Police",
    faction: Faction.BLUE,
    hasNightAction: true,
    maxGrenades: 4,
  },
  ARSONIST: { id: "ARSONIST", name: "Arsonist", faction: Faction.RED, hasNightAction: true },
  HEAVENLY_FIEND: { id: "HEAVENLY_FIEND", name: "Heavenly Fiend", faction: Faction.BLUE, hasNightAction: true },
  VINE_DEMON: { id: "VINE_DEMON", name: "Vine Demon", faction: Faction.RED, hasNightAction: true },
  BRAT: { id: "BRAT", name: "Brat", faction: Faction.BLUE, hasNightAction: false },
  NIGHTMARE_DEMON: { id: "NIGHTMARE_DEMON", name: "Nightmare Demon", faction: Faction.RED, hasNightAction: true },
  EXORCIST: { id: "EXORCIST", name: "Exorcist", faction: Faction.BLUE, hasNightAction: true, maxChain: 3 },
  NECROMANCER: { id: "NECROMANCER", name: "Necromancer", faction: Faction.RED, hasNightAction: true },
  PURIFIER: { id: "PURIFIER", name: "Purifier", faction: Faction.BLUE, hasNightAction: true },
  GRUDGE_BEAST: { id: "GRUDGE_BEAST", name: "Grudge Beast", faction: Faction.GREEN, hasNightAction: true },
  CIVILIAN: { id: "CIVILIAN", name: "Civilian", faction: Faction.BLUE, hasNightAction: false },
};

export const Theme = {
  GOOD_VS_EVIL: {
    id: "GOOD_VS_EVIL",
    name: "Good vs Evil (Standard 18)",
    counts: {
      POLICE: 4,
      KILLER: 4,
      DOCTOR: 1,
      SNIPER: 1,
      CIVILIAN: 8,
    },
  },
  COUNTER_TERROR: {
    id: "COUNTER_TERROR",
    name: "Counter-Terror Crisis (18)",
    counts: {
      POLICE: 4,
      KILLER: 4,
      DOCTOR: 1,
      SNIPER: 1,
      AGENT: 1,
      TERRORIST: 1,
      CIVILIAN: 6,
    },
  },
  WILD_WEST: {
    id: "WILD_WEST",
    name: "Wild West (18)",
    counts: {
      POLICE: 4,
      KILLER: 4,
      DOCTOR: 1,
      SNIPER: 1,
      COWBOY: 1,
      KIDNAPPER: 1,
      CIVILIAN: 6,
    },
  },
  DOOMSDAY_HORROR: {
    id: "DOOMSDAY_HORROR",
    name: "Doomsday Horror (18)",
    counts: {
      POLICE: 4,
      KILLER: 4,
      DOCTOR: 1,
      SNIPER: 1,
      COWBOY: 1,
      KIDNAPPER: 1,
      ZOMBIE: 1,
      CIVILIAN: 5,
    },
  },
  STREET_FURY: {
    id: "STREET_FURY",
    name: "Street Fury (18)",
    counts: {
      POLICE: 4,
      KILLER: 4,
      RIOT_POLICE: 1,
      ARSONIST: 1,
      AGENT: 1,
      TERRORIST: 1,
      CIVILIAN: 6,
    },
  },
  PSYCHIC_CENTURY: {
    id: "PSYCHIC_CENTURY",
    name: "Psychic Century (18)",
    counts: {
      POLICE: 4,
      KILLER: 4,
      DOCTOR: 1,
      SNIPER: 1,
      HEAVENLY_FIEND: 1,
      VINE_DEMON: 1,
      BRAT: 1,
      CIVILIAN: 5,
    },
  },
  OTHER_DIMENSION: {
    id: "OTHER_DIMENSION",
    name: "Other Dimension (18)",
    counts: {
      POLICE: 4,
      KILLER: 4,
      EXORCIST: 1,
      NIGHTMARE_DEMON: 1,
      PURIFIER: 1,
      NECROMANCER: 1,
      CIVILIAN: 6,
    },
  },
  FINAL_JUDGEMENT: {
    id: "FINAL_JUDGEMENT",
    name: "Final Judgement (18)",
    counts: {
      POLICE: 4,
      KILLER: 4,
      GRUDGE_BEAST: 3,
      COWBOY: 1,
      SNIPER: 1,
      CIVILIAN: 5,
    },
  },
};

export const Phase = {
  NIGHT: "NIGHT",
  DAY: "DAY",
  VOTE: "VOTE",
  END: "END",
};

export const DeathCause = {
  KILLER_MURDER: "KILLER_MURDER",
  SNIPER_HEADSHOT: "SNIPER_HEADSHOT",
  EMPTY_INJECTION: "EMPTY_INJECTION",
  VOTE_EXECUTION: "VOTE_EXECUTION",
  AGENT_LINK: "AGENT_LINK",
  TERROR_BOMB: "TERROR_BOMB",
  COWBOY_SHOT: "COWBOY_SHOT",
  COWBOY_BACKFIRE: "COWBOY_BACKFIRE",
  KIDNAP_EXECUTION: "KIDNAP_EXECUTION",
  ZOMBIE_BITE: "ZOMBIE_BITE",
  ZOMBIE_FATAL: "ZOMBIE_FATAL",
  SMOKE_OVERDOSE: "SMOKE_OVERDOSE",
  ARSON_BURN: "ARSON_BURN",
  FIEND_SHOT: "FIEND_SHOT",
  EXORCIST_PETRIFY: "EXORCIST_PETRIFY",
  NECROMANCER_CURSE: "NECROMANCER_CURSE",
  VINE_SWAP: "VINE_SWAP",
  NIGHTMARE_STRIKE: "NIGHTMARE_STRIKE",
  GRUDGE_PUNISH: "GRUDGE_PUNISH",
};

export function roleListFromTheme(themeId) {
  const theme = Object.values(Theme).find((t) => t.id === themeId) || Theme.GOOD_VS_EVIL;
  const list = [];
  Object.entries(theme.counts).forEach(([roleId, count]) => {
    for (let i = 0; i < count; i++) list.push(roleId);
  });
  return list;
}

export function roleMeta(roleId) {
  return Roles[roleId] || Roles.CIVILIAN;
}
