import { Roles, Theme } from "./roles.js";

const els = {
  wsUrl: document.getElementById("wsUrl"),
  playerName: document.getElementById("playerName"),
  spectatorToggle: document.getElementById("spectatorToggle"),
  spectatorWait: document.getElementById("spectatorWait"),
  connectBtn: document.getElementById("connectBtn"),
  themeSelect: document.getElementById("themeSelect"),
  startBtn: document.getElementById("startBtn"),
  seatInfo: document.getElementById("seatInfo"),
  hostBadge: document.getElementById("hostBadge"),
  localeSelect: document.getElementById("localeSelect"),
  seatsList: document.getElementById("seatsList"),
  phaseDisplay: document.getElementById("phaseDisplay"),
  dayDisplay: document.getElementById("dayDisplay"),
  youDisplay: document.getElementById("youDisplay"),
  alliesDisplay: document.getElementById("alliesDisplay"),
  timerDisplay: document.getElementById("timerDisplay"),
  victoryDisplay: document.getElementById("victoryDisplay"),
  nightActionType: document.getElementById("nightActionType"),
  nightTarget: document.getElementById("nightTarget"),
  exorcistTargets: document.getElementById("exorcistTargets"),
  sendNightAction: document.getElementById("sendNightAction"),
  voteTarget: document.getElementById("voteTarget"),
  lastWordsInput: document.getElementById("lastWordsInput"),
  sendVote: document.getElementById("sendVote"),
  chatInput: document.getElementById("chatInput"),
  sendChat: document.getElementById("sendChat"),
  killerChatBox: document.getElementById("killerChatBox"),
  killerChatLines: document.getElementById("killerChatLines"),
  killerChatInput: document.getElementById("killerChatInput"),
  sendKillerChat: document.getElementById("sendKillerChat"),
  grudgeChatBox: document.getElementById("grudgeChatBox"),
  grudgeChatLines: document.getElementById("grudgeChatLines"),
  grudgeChatInput: document.getElementById("grudgeChatInput"),
  sendGrudgeChat: document.getElementById("sendGrudgeChat"),
  policeChatBox: document.getElementById("policeChatBox"),
  policeChatLines: document.getElementById("policeChatLines"),
  policeChatInput: document.getElementById("policeChatInput"),
  sendPoliceChat: document.getElementById("sendPoliceChat"),
  spectatorChatBox: document.getElementById("spectatorChatBox"),
  spectatorChatLines: document.getElementById("spectatorChatLines"),
  spectatorChatInput: document.getElementById("spectatorChatInput"),
  sendSpectatorChat: document.getElementById("sendSpectatorChat"),
  deadLastWordsBox: document.getElementById("deadLastWordsBox"),
  deadLastWordsInput: document.getElementById("deadLastWordsInput"),
  sendDeadLastWords: document.getElementById("sendDeadLastWords"),
  resolveNight: document.getElementById("resolveNight"),
  resolveVote: document.getElementById("resolveVote"),
  playersList: document.getElementById("playersList"),
  logText: document.getElementById("logText"),
  endBanner: document.getElementById("endBanner"),
  lastWordsList: document.getElementById("lastWordsList"),
};

const translations = {
  en: {
    eyebrow: "Multiplayer Lobby",
    subtitle: "WebSocket client for host/players",
    language: "Language",
    localeEn: "English",
    localeZh: "中文",
    spectator: "Spectator",
    spectatorWait: "Wait for start",
    join: "Join",
    startHost: "Start (host)",
    yourName: "Your name",
    lobby: "Lobby",
    seatLabel: "Seat",
    host: "Host",
    log: "Log",
    status: "Status",
    phase: "Phase",
    day: "Day",
    you: "You",
    timer: "Timer",
    allies: "Allies",
    victory: "Victory",
    actions: "Actions",
    phaseNight: "Night",
    phaseDay: "Day",
    phaseVote: "Vote",
    phaseEnd: "End",
    phaseRestart: "Restarting",
    nightAction: "Night action",
    vote: "Vote",
    dayChat: "Chat",
    killerChat: "Killer chat (private)",
    grudgeChat: "Grudge chat (private)",
    sendKillerChat: "Send (killers)",
    sendGrudgeChat: "Send (grudge)",
    grudgeChatPlaceholder: "Grudge chat...",
    killerChatPlaceholder: "Private killer chat...",
    policeChat: "Police chat (private)",
    sendPoliceChat: "Send (police)",
    policeChatPlaceholder: "Private police chat...",
    spectatorChat: "Spectator chat",
    sendSpectatorChat: "Send (spectators/dead)",
    spectatorChatPlaceholder: "Spectator chat...",
    noChat: "No chat yet",
    hostOnly: "Host only",
    gameView: "Game View",
    sendNightAction: "Send",
    sendVote: "Send vote",
    sendChat: "Send",
    resolveNight: "Resolve Night",
    resolveVote: "Resolve Vote",
    votePlaceholder: "Last words (optional)",
    chatPlaceholder: "Message",
    lastWordsTitle: "Last Words",
    noLastWords: "No last words yet.",
    pickAction: "Pick action",
    noNightAction: "No night action",
    chooseTarget: "Choose target",
    abstain: "Abstain",
    actionsMap: {
      POLICE_INVESTIGATE: "Investigate",
      KILLER_VOTE: "Murder vote",
      DOCTOR_INJECT: "Inject",
      SNIPER_SHOT: "Sniper shot",
      AGENT_PROTECT: "Protect",
      FIEND_PROTECT: "Absorb protect",
      FIEND_SHOOT: "Charge shot",
      TERROR_BOMB: "Bomb",
      COWBOY_GAMBLE: "Gamble shot",
      KIDNAP: "Kidnap",
      ZOMBIE_BITE: "Bite",
      RIOT_SMOKE: "Smoke grenade",
      ARSON_MARK: "Mark with fuel",
      ARSON_IGNITE: "Ignite all marks",
      VINE_SEED: "Plant seed",
      NIGHTMARE_ATTACK: "Nightmare strike",
      EXORCIST_STRIKE: "Exorcist strike",
      NECROMANCER_CURSE: "Curse",
      PURIFY: "Cleanse",
      GRUDGE_JUDGE: "Judge",
      GRUDGE_KILL_VOTE: "Berserk kill vote",
    },
  },
  zh: {
    eyebrow: "多人連線大廳",
    subtitle: "主機/玩家 WebSocket 用戶端",
    language: "語言",
    localeEn: "英文",
    localeZh: "中文",
    spectator: "觀戰",
    spectatorWait: "等待下一局",
    join: "加入",
    startHost: "開始 (房主)",
    yourName: "你的名字",
    lobby: "大廳",
    seatLabel: "座位",
    host: "房主",
    log: "紀錄",
    status: "狀態",
    phase: "階段",
    day: "天數",
    you: "你",
    timer: "計時",
    allies: "\u968a\u53cb",
    victory: "勝利",
    actions: "行動",
    alive: "存活",
    dead: "死亡",
    role: "角色",
    faction: "陣營",
    phaseNight: "夜",
    phaseDay: "白天",
    phaseVote: "投票",
    phaseEnd: "結束",
    phaseRestart: "重開倒數",
    roleMap: {
      POLICE: "警察",
      KILLER: "殺手",
      DOCTOR: "醫生",
      SNIPER: "狙擊手",
      AGENT: "特務",
      TERRORIST: "恐怖分子",
      COWBOY: "牛仔",
      KIDNAPPER: "綁匪",
      ZOMBIE: "死靈",
      RIOT_POLICE: "防暴警",
      ARSONIST: "縱火犯",
      HEAVENLY_FIEND: "天罰使",
      VINE_DEMON: "藤妖",
      BRAT: "熊孩子",
      NIGHTMARE_DEMON: "夢魃",
      EXORCIST: "驅魔人",
      NECROMANCER: "死靈師",
      PURIFIER: "淨化者",
      GRUDGE_BEAST: "怨鬥獸",
      CIVILIAN: "平民",
      HIDDEN: "隱藏",
    },
    factionMap: {
      BLUE: "藍",
      RED: "紅",
      GREEN: "綠",
      UNKNOWN: "未知",
    },
    nightAction: "夜行動",
    vote: "投票",
    dayChat: "聊天",
    killerChat: "殺手私聊",
    sendKillerChat: "發送（殺手）",
    killerChatPlaceholder: "殺手私聊訊息...",
    policeChat: "警察私聊",
    sendPoliceChat: "發送（警察）",
    policeChatPlaceholder: "警察私聊訊息...",
    hostOnly: "僅房主",
    spectatorChat: "觀戰者聊天窗（觀戰者）",
    sendSpectatorChat: "送出（觀戰者／死亡）",
    spectatorChatPlaceholder: "觀戰者聊天訊息...",
    noChat: "No chat yet",
    gameView: "遊戲畫面",
    sendNightAction: "送出",
    sendVote: "送出投票",
    sendChat: "送出",
    resolveNight: "結算夜晚",
    resolveVote: "結算投票",
    votePlaceholder: "遺言 (可選)",
    chatPlaceholder: "訊息",
    lastWordsTitle: "遺言",
    noLastWords: "暫無遺言",
    pickAction: "選擇行動",
    noNightAction: "沒有夜行動",
    chooseTarget: "選擇目標",
    abstain: "棄權",
    actionsMap: {
      POLICE_INVESTIGATE: "調查",
      KILLER_VOTE: "殺人投票",
      DOCTOR_INJECT: "注射",
      SNIPER_SHOT: "狙擊",
      AGENT_PROTECT: "守護",
      FIEND_PROTECT: "吸收守護",
      FIEND_SHOOT: "充能射擊",
      TERROR_BOMB: "炸彈",
      COWBOY_GAMBLE: "賭命開槍",
      KIDNAP: "綁架",
      ZOMBIE_BITE: "咬擊",
      RIOT_SMOKE: "煙霧",
      ARSON_MARK: "潑油標記",
      ARSON_IGNITE: "點燃標記",
      VINE_SEED: "種子交換",
      NIGHTMARE_ATTACK: "惡夢斬擊",
      EXORCIST_STRIKE: "驅魔鎖鏈",
      NECROMANCER_CURSE: "詛咒",
      PURIFY: "淨化",
      GRUDGE_JUDGE: "審判",
      GRUDGE_KILL_VOTE: "狂暴斬殺票",
    },
  },
};

let locale = "en";

function t(key) {
  return translations[locale]?.[key] ?? key;
}

function actionLabel(actionType) {
  const map = translations[locale]?.actionsMap || {};
  return map[actionType] || actionType;
}

function roleLabel(roleId) {
  const map = translations[locale]?.roleMap || {};
  return map[roleId] || roleId;
}

function factionLabel(faction) {
  const map = translations[locale]?.factionMap || {};
  return map[faction] || faction;
}

function translateLine(line) {
  if (locale !== "zh" || typeof line !== "string") return line;
  const factionMap = {
    BLUE: "藍方",
    RED: "紅方",
    GREEN: "綠方",
  };
  const roleMap = {
    POLICE: "警察",
    KILLER: "殺手",
    DOCTOR: "醫生",
    SNIPER: "狙擊手",
    AGENT: "特工",
    TERRORIST: "恐怖份子",
    COWBOY: "牛仔",
    KIDNAPPER: "綁匪",
    ZOMBIE: "殘屍",
    RIOT_POLICE: "防暴警",
    ARSONIST: "縱火犯",
    HEAVENLY_FIEND: "天罰者",
    VINE_DEMON: "藤蔓魔",
    BRAT: "熊孩子",
    NIGHTMARE_DEMON: "夢魘魔",
    EXORCIST: "驅魔人",
    NECROMANCER: "死靈法師",
    PURIFIER: "淨化者",
    GRUDGE_BEAST: "怨獸",
    CIVILIAN: "平民",
  };
  const deathMap = {
    "murdered during the night": "晚上被謀殺",
    "sniper headshot": "遭到狙擊爆頭",
    "fatal overdose": "醫療過量致死",
    "executed by vote": "被公投處決",
    "died in a bomb blast": "死於炸彈爆炸",
    "burned by arson": "被縱火燒死",
    "executed by ransom": "被綁匪處決",
    "killed by infection": "死於感染",
    "choked in smoke": "窒息於濃煙",
    "died with their agent": "與特工連命而死",
    "shot by a cowboy": "被牛仔射殺",
    "cowboy backfire": "牛仔反噬身亡",
    "petrified by an exorcist": "被驅魔鎖魂",
    "cursed by a necromancer": "遭死靈詛咒",
    "smited by a heavenly fiend": "被天罰擊殺",
    "slain by nightmare demon": "被夢魘擊殺",
    "cut down by grudge beasts": "被怨獸撕裂",
    "sacrificed by vine seed": "為藤種換命",
    "unknown": "未知原因",
  };
  const intelMatch = line.match(/(\[INTEL\]\s*)?Investigation result: (.+) is (RED|GREEN|BLUE) \((.+)\)/);
  if (intelMatch) {
    const [, prefix = "", name, faction, role] = intelMatch;
    const factionText = factionMap[faction] || faction;
    const roleText = roleMap[role] || role;
    return `${prefix}調查結果：${name} 是 ${factionText} (${roleText})`;
  }
  const deathMatch = line.match(/^(.+) died \((.+)\)\.$/);
  if (deathMatch) {
    const [, name, causeEn] = deathMatch;
    const causeZh = deathMap[causeEn] || causeEn;
    return `${name} 死亡 (${causeZh})`;
  }
  const rules = [
[/Someone deployed smoke on (.+)\./, "有人對 $1 投擲了煙霧彈。"],
    [/Someone cleansed (.+)\./, "有人淨化了 $1。"],
    [/Someone kidnapped (.+)\./, "有人綁架了 $1。"],
    [/Someone fired a sniper shot\./, "有人開了一槍狙擊。"],
    [/A bomb went off but failed on an ally; the bomber died\./, "炸彈引爆但擊中同陣營，炸彈客身亡。"],
    [/A bomb detonated on (.+)\./, "炸彈在 $1 身上爆炸。"],
    [/Someone fired a risky shot at (.+)\./, "有人冒險射擊了 $1。"],
    [/A cowboy\'s chamber clicked on (.+)\./, "牛仔對 $1 空包彈。"],
    [/A cowboy drew a wild bullet\. Chaos ensued\./, "牛仔抽到瘋狂子彈，場面大亂。"],
    [/Someone splashed fuel on (.+)\./, "有人對 $1 潑上汽油。"],
    [/Someone prepared to ignite marked targets\./, "有人準備點燃已標記的目標。"],
    [/Someone saved (.+) from death\./, "有人救回了 $1。"],
    [/Someone injected (.+) \(dose (\d+)\/(\d+)\)\./, "有人注射 $1（第 $2/$3 劑）。"],
    [/Killers failed to agree on a target\./, "殺手未能達成共識。"],
    [/Police could not agree on a target\./, "警察未能達成共識。"],
    [/Votes:/, "投票結果："],
    [/(.+) was executed by vote.*$/, "$1 被多數票處決。"],
    [/(.+) was executed by highest votes.*$/, "$1 因最高票被處決。"],
    [/No majority reached\. Nobody was executed\./, "無人過半，暫不處決。"],
    [/Grudge Beasts entered berserk rage\./, "怨獸進入狂暴狀態。"],
    [/(.+) turned into a zombie overnight\./, "$1 在夜裡變成了殘屍。"],
    [/(.+) was overwhelmed and turned into a zombie immediately\./, "$1 被壓制後立刻變成殘屍。"],
    [/feels off\./, "覺得不對勁。"],
    [/seems fine to me\./, "在我看來沒問題。"],
    [/What's everyone thinking about (.+)\?/, "大家覺得 $1 怎麼樣？"],
  ];
  let out = line;
  for (const [pat, rep] of rules) {
    if (pat.test(out)) {
      out = out.replace(pat, rep);
      break;
    }
  }
  return out;
}


function translateLines(list) {
  return list.map((l) => translateLine(l));
}

function applyLocaleText() {
  document.documentElement.lang = locale;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    const val = translations[locale]?.[key];
    if (typeof val === "string") node.textContent = val;
  });
  if (els.playerName) els.playerName.placeholder = t("yourName");
  if (els.chatInput) els.chatInput.placeholder = t("chatPlaceholder");
  if (els.lastWordsInput) els.lastWordsInput.placeholder = t("votePlaceholder");
  if (els.spectatorChatInput) els.spectatorChatInput.placeholder = t("spectatorChatPlaceholder");
  if (els.deadLastWordsInput) els.deadLastWordsInput.placeholder = t("votePlaceholder");
  if (els.localeSelect) els.localeSelect.value = locale;
  if (els.seatInfo && seatId !== null) els.seatInfo.textContent = `${t("seatLabel")} ${seatId + 1}`;
  if (els.hostBadge) els.hostBadge.textContent = isHost ? t("host") : "";
  if (els.lastWordsList && els.lastWordsList.dataset.titleApplied !== "1") {
    // Title is handled by data-i18n on the header; just mark once to avoid duplicate work.
    els.lastWordsList.dataset.titleApplied = "1";
  }
}

let ws = null;
let isHost = false;
let seatId = null;
let isSpectator = false;
let latestView = null;
let lobbySeats = [];
let timerState = null;

function log(message) {
  const prev = els.logText.value ? els.logText.value + "\n" : "";
  els.logText.value = prev + message;
  els.logText.scrollTop = els.logText.scrollHeight;
}

function setupThemeOptions() {
  els.themeSelect.innerHTML = "";
  Object.values(Theme).forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    els.themeSelect.appendChild(opt);
  });
  els.themeSelect.value = Theme.GOOD_VS_EVIL.id;
}

function connect() {
  if (ws) ws.close();
  ws = new WebSocket(els.wsUrl.value || "wss://kera.onrender.com");
  ws.onopen = () => {
    const name = (els.playerName.value || "Player").slice(0, 32);
    const spectator = !!els.spectatorToggle?.checked;
    const waitForStart = !!els.spectatorWait?.checked;
    ws.send(JSON.stringify({ type: "join", name, spectator, waitForStart }));
    log(">> join as " + name + (spectator ? " (spectator)" : ""));
    if (spectator && waitForStart) {
      log("Waiting for next start as spectator.");
    }
    if (!spectator && waitForStart) {
      log("Current game in progress: you will spectate and auto-join next start.");
    }
    if (spectator) {
      seatId = null;
      isSpectator = true;
    }
  };
  ws.onclose = () => {
    log("Connection closed.");
    isHost = false;
    seatId = null;
    latestView = null;
    render();
  };
  ws.onmessage = (evt) => {
    let msg = null;
    try {
      msg = JSON.parse(evt.data);
    } catch (err) {
      log("<< invalid JSON");
      return;
    }
    handleMessage(msg);
  };
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function handleMessage(msg) {
  if ((msg?.type === "action_log_killer" || msg?.type === "action_log_police") && msg.text) {
    log(msg.text);
    return;
  }
  switch (msg.type) {
    case "joined":
      seatId = msg.playerId;
      isSpectator = !!msg.spectator;
      isHost = !!msg.host;
      if (!isSpectator) {
        els.seatInfo.textContent = `${t("seatLabel")} ${seatId + 1}`;
        els.hostBadge.textContent = isHost ? t("host") : "";
        log("Joined seat " + (seatId + 1) + (isHost ? " (host)" : ""));
      } else {
        seatId = null;
        els.seatInfo.textContent = t("spectator");
        els.hostBadge.textContent = "";
      log("Joined as spectator");
    }
      break;
    case "host":
      isHost = !!msg.value;
      els.hostBadge.textContent = isHost ? t("host") : "";
      break;
    case "acked": {
      if (msg.action === "night_action") {
        const roleText = msg.role ? roleLabel(msg.role) : t("you");
        const actorText = msg.actorName ? `${msg.actorName}` : "";
        const targetText = msg.targetName || t("abstain");
        log(`Ack: ${roleText}${actorText ? ` (${actorText})` : ""} -> ${targetText}`);
      } else if (msg.action === "vote") {
        const actorText = msg.actorName || t("you");
        const targetText = msg.targetName || t("abstain");
        log(`Ack: ${actorText} vote -> ${targetText}`);
      } else {
        log("Ack: " + JSON.stringify(msg));
      }
      break;
    }
    case "action_log":
      if (msg.text) log(msg.text);
      break;
    case "action_log_killer":
      if (msg.text) log(msg.text);
      break;
    case "lobby":
      lobbySeats = msg.seats || [];
      renderLobby();
      latestView = null;
      els.phaseDisplay.textContent = t("lobby");
      els.dayDisplay.textContent = "-";
      els.youDisplay.textContent = "-";
      log("Lobby reset (waiting to start)");
      if (isSpectator && seatId === null && els.spectatorWait?.checked) {
        const name = (els.playerName.value || "Player").slice(0, 32);
        log("Auto-joining lobby as player from spectator wait.");
        send({ type: "join", name, spectator: false, waitForStart: false });
      }
      break;
    case "started":
      log("Game started. Humans: " + msg.humans);
      break;
    case "view":
      latestView = msg.view;
      renderView();
      break;
    case "phase":
      if (latestView) latestView.phase = msg.phase;
      renderView();
      break;
    case "timer":
      timerState = { phase: msg.phase, msLeft: msg.msLeft };
      renderTimer();
      break;
    case "chat":
      log("Chat: " + msg.line);
      break;
    case "error":
      log("Error: " + msg.message);
      break;
    default:
      log("<< " + JSON.stringify(msg));
  }
}

function renderLobby() {
  els.seatsList.innerHTML = "";
  lobbySeats.forEach((s) => {
    const li = document.createElement("li");
    li.className = "player-card";
    const name = document.createElement("div");
    name.textContent = `${t("seatLabel")} ${s.playerId + 1}: ${s.name}`;
    li.appendChild(name);
    els.seatsList.appendChild(li);
  });
  applyLocaleText();
}

function roleActionChoices(roleId, grudgeBerserk = false) {
  switch (roleId) {
    case Roles.POLICE.id:
      return [{ value: "POLICE_INVESTIGATE", label: actionLabel("POLICE_INVESTIGATE"), needsTarget: true }];
    case Roles.KILLER.id:
      return [{ value: "KILLER_VOTE", label: actionLabel("KILLER_VOTE"), needsTarget: true }];
    case Roles.DOCTOR.id:
      return [{ value: "DOCTOR_INJECT", label: actionLabel("DOCTOR_INJECT"), needsTarget: true }];
    case Roles.SNIPER.id:
      return [{ value: "SNIPER_SHOT", label: actionLabel("SNIPER_SHOT"), needsTarget: true }];
    case Roles.AGENT.id:
      return [{ value: "AGENT_PROTECT", label: actionLabel("AGENT_PROTECT"), needsTarget: true }];
    case Roles.HEAVENLY_FIEND.id:
      return [
        { value: "FIEND_PROTECT", label: actionLabel("FIEND_PROTECT"), needsTarget: true },
        { value: "FIEND_SHOOT", label: actionLabel("FIEND_SHOOT"), needsTarget: true },
      ];
    case Roles.TERRORIST.id:
      return [{ value: "TERROR_BOMB", label: actionLabel("TERROR_BOMB"), needsTarget: true }];
    case Roles.COWBOY.id:
      return [{ value: "COWBOY_GAMBLE", label: actionLabel("COWBOY_GAMBLE"), needsTarget: true }];
    case Roles.KIDNAPPER.id:
      return [{ value: "KIDNAP", label: actionLabel("KIDNAP"), needsTarget: true }];
    case Roles.ZOMBIE.id:
      return [{ value: "ZOMBIE_BITE", label: actionLabel("ZOMBIE_BITE"), needsTarget: true }];
    case Roles.RIOT_POLICE.id:
      return [{ value: "RIOT_SMOKE", label: actionLabel("RIOT_SMOKE"), needsTarget: true }];
    case Roles.ARSONIST.id:
      return [
        { value: "ARSON_MARK", label: actionLabel("ARSON_MARK"), needsTarget: true },
        { value: "ARSON_IGNITE", label: actionLabel("ARSON_IGNITE"), needsTarget: false },
      ];
    case Roles.VINE_DEMON.id:
      return [{ value: "VINE_SEED", label: actionLabel("VINE_SEED"), needsTarget: true }];
    case Roles.NIGHTMARE_DEMON.id:
      return [{ value: "NIGHTMARE_ATTACK", label: actionLabel("NIGHTMARE_ATTACK"), needsTarget: true }];
    case Roles.EXORCIST.id:
      return [{ value: "EXORCIST_STRIKE", label: actionLabel("EXORCIST_STRIKE"), needsTarget: true }];
    case Roles.NECROMANCER.id:
      return [{ value: "NECROMANCER_CURSE", label: actionLabel("NECROMANCER_CURSE"), needsTarget: true }];
    case Roles.PURIFIER.id:
      return [{ value: "PURIFY", label: actionLabel("PURIFY"), needsTarget: true }];
    case Roles.GRUDGE_BEAST.id:
      return grudgeBerserk
        ? [{ value: "GRUDGE_KILL_VOTE", label: actionLabel("GRUDGE_KILL_VOTE"), needsTarget: true }]
        : [{ value: "GRUDGE_JUDGE", label: actionLabel("GRUDGE_JUDGE"), needsTarget: true }];
    default:
      return [];
  }
}

function buildOptions(selectEl, options, placeholder = "Select") {
  selectEl.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = placeholder;
  selectEl.appendChild(ph);
  options.forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    selectEl.appendChild(o);
  });
}

function renderView() {
  const v = latestView;
  if (!v) return;
  const phaseLabel =
    v.phase === "NIGHT"
      ? t("phaseNight")
      : v.phase === "DAY"
      ? t("phaseDay")
      : v.phase === "VOTE"
      ? t("phaseVote")
      : v.phase === "END"
      ? t("phaseEnd")
      : v.phase === "Lobby"
      ? t("lobby")
      : v.phase || "-";
  els.phaseDisplay.textContent = phaseLabel;
  els.dayDisplay.textContent = v.dayNumber || "-";
  if (v.you) {
    const youRole = roleLabel(v.you.role);
    const youFaction = factionLabel(v.you.faction || v.you.role);
    els.youDisplay.textContent = `${v.you.name} (${youRole}${youFaction ? ` / ${youFaction}` : ""})`;
    if (v.you.aiTakenOver) {
      log("AI has taken over your seat (disconnected).");
    }
  } else {
    els.youDisplay.textContent = "-";
  }
  if (els.alliesDisplay) {
    const you = v.you;
    const players = v.players || [];
    let allies = [];
    if (you?.role === Roles.POLICE.id) {
      allies = players.filter((p) => p.role === Roles.POLICE.id && p.id !== you.id);
    } else if (you?.role === Roles.KILLER.id) {
      allies = players.filter((p) => p.role === Roles.KILLER.id && p.id !== you.id);
    } else if (you?.role === Roles.GRUDGE_BEAST.id) {
      allies = players.filter((p) => p.role === Roles.GRUDGE_BEAST.id && p.id !== you.id);
    }
    els.alliesDisplay.textContent = allies.length
      ? allies.map((p) => (p.alive ? p.name : `${p.name} (dead)`)).join(", ")
      : "-";
  }
  if (v.victory) {
    const winner = v.victory.winner || "";
    const reason = v.victory.reason || "";
    const winnerZhMap = { RED: "紅方", BLUE: "藍方", ZOMBIE: "殭屍", GRUDGE: "怨獸" };
    const reasonZhMap = {
      "Grudge Beasts finished their rage condition.": "怨獸完成狂暴條件。",
      "Grudge Beasts survive without berserk.": "怨獸存活即獲勝。",
      "Zombies outnumber the living.": "殭屍數量過半，感染全場。",
      "Red faction satisfied elimination condition.": "紅方達成淘汰條件。",
      "All killers eliminated.": "所有殺手被清除。",
    };
    const colorMap = { RED: "#e74c3c", BLUE: "#1e90ff", ZOMBIE: "#27ae60", GRUDGE: "#9b59b6" };
    const winnerText = locale === "zh" ? winnerZhMap[winner] || winner : winner;
    const reasonText = locale === "zh" ? reasonZhMap[reason] || reason : reason;
    els.victoryDisplay.style.color = colorMap[winner] || "#333";
    els.victoryDisplay.textContent = `${winnerText} (${reasonText})`;
  } else {
    els.victoryDisplay.style.color = "#333";
    els.victoryDisplay.textContent = "-";
  }
  // Players list
  els.playersList.innerHTML = "";
  const ended = !!v.victory;
  (v.players || []).forEach((p) => {
    const li = document.createElement("div");
    li.className = "player-card" + (p.alive ? "" : " dead");
    const factionColor =
      p.faction === "BLUE" ? "#1e90ff" : p.faction === "RED" ? "#e74c3c" : p.faction === "GREEN" ? "#27ae60" : null;
    if (!p.alive || ended) {
      if (factionColor) li.style.color = factionColor;
    }
    const aliveText = p.alive ? t("alive") : t("dead");
    const roleText = roleLabel(p.role);
    const factionText = factionLabel(p.faction);
    li.textContent = `${p.name} | ${aliveText} | ${t("role")}: ${roleText} | ${t("faction")}: ${factionText}`;
    els.playersList.appendChild(li);
  });
  // Logs
  const intelLines = (v.privateIntel || []).map((l) => `[INTEL] ${l}`);
  const mergedLogs = [...intelLines, ...(v.publicLog || [])];
  const displayLogs = locale === "zh" ? translateLines(mergedLogs) : mergedLogs;
  els.logText.value = displayLogs.join("\n");

  // Last words panel
  if (els.lastWordsList) {
    els.lastWordsList.innerHTML = "";
    const entries = (v.players || [])
      .filter((p) => typeof p.lastWords === "string" && p.lastWords.trim())
      .map((p) => ({ name: p.name, text: p.lastWords.trim() }));
    if (!entries.length) {
      const li = document.createElement("li");
      li.className = "note";
      li.textContent = t("noLastWords");
      els.lastWordsList.appendChild(li);
    } else {
      entries.forEach((e) => {
        const li = document.createElement("li");
        li.textContent = `${e.name}: ${e.text}`;
        els.lastWordsList.appendChild(li);
      });
    }
  }
  // Action controls
  const you = v.you;
  const isGrudgeBerserk = !!v.grudgeState?.berserk;
  const isGrudge = you && you.role === Roles.GRUDGE_BEAST.id && you.alive;
  let choices = you ? roleActionChoices(you.role, isGrudgeBerserk) : [];
  buildOptions(els.nightActionType, choices, choices.length ? t("pickAction") : t("noNightAction"));
  const targetOptions = (v.players || [])
    .filter((p) => p.id !== you?.id && p.alive)
    .map((p) => ({ value: String(p.id), label: p.name }));
  buildOptions(els.nightTarget, targetOptions, t("chooseTarget"));
  // Exorcist: show N target dropdowns (maxChains); others: single target
  if (els.exorcistTargets) {
    els.exorcistTargets.innerHTML = "";
  }
  if (you?.role === Roles.EXORCIST.id) {
    const maxChains = Math.max(1, you.maxChains || 1);
    if (els.nightTarget) els.nightTarget.multiple = false;
    if (els.exorcistTargets) {
      const extraCount = Math.max(0, maxChains - 1);
      for (let i = 0; i < extraCount; i++) {
        const sel = document.createElement("select");
        buildOptions(sel, targetOptions, t("chooseTarget"));
        els.exorcistTargets.appendChild(sel);
      }
    }
  } else {
    if (els.nightTarget) els.nightTarget.multiple = false;
  }
  const voteOptions = (v.players || [])
    .filter((p) => p.alive)
    .map((p) => ({ value: String(p.id), label: p.name }));
  buildOptions(els.voteTarget, voteOptions, t("abstain"));
  const alive = v.you?.alive;
  const phase = v.phase;
  const canSpectatorChat = !you || !you.alive;
  // Killer chat
  if (els.killerChatBox) {
    const isKiller = you && you.role === Roles.KILLER.id && you.alive;
    els.killerChatBox.classList.toggle("hidden", !(isKiller && !ended));
    const lines = (v.killerChat || []).slice(-10);
    els.killerChatLines.innerHTML = "";
    if (!lines.length) {
      const p = document.createElement("p");
      p.textContent = t("noChat");
      els.killerChatLines.appendChild(p);
    } else {
      lines.forEach((line) => {
        const p = document.createElement("p");
        p.textContent = line;
        els.killerChatLines.appendChild(p);
      });
    }
    if (els.killerChatInput) els.killerChatInput.placeholder = t("killerChatPlaceholder");
    if (els.sendKillerChat) els.sendKillerChat.disabled = !(isKiller && !ended);
  }
  // Grudge chat (read-only)
  if (els.grudgeChatBox) {
    const isGrudge = you && you.role === Roles.GRUDGE_BEAST.id && you.alive;
    els.grudgeChatBox.classList.toggle("hidden", !(isGrudge && !ended));
    const glines = (v.grudgeChat || []).slice(-10);
    els.grudgeChatLines.innerHTML = "";
    if (!glines.length) {
      const p = document.createElement("p");
      p.textContent = t("noChat");
      els.grudgeChatLines.appendChild(p);
    } else {
      glines.forEach((line) => {
        const p = document.createElement("p");
        p.textContent = line;
        els.grudgeChatLines.appendChild(p);
      });
    }
    if (els.grudgeChatInput) els.grudgeChatInput.placeholder = t("grudgeChatPlaceholder") || t("chatPlaceholder");
    if (els.sendGrudgeChat) els.sendGrudgeChat.disabled = !(isGrudge && !ended);
  }
  // Police chat
  if (els.policeChatBox) {
    const isPolice = you && you.role === Roles.POLICE.id && you.alive;
    els.policeChatBox.classList.toggle("hidden", !(isPolice && !ended));
    const plines = (v.policeChat || []).slice(-10);
    els.policeChatLines.innerHTML = "";
    if (!plines.length) {
      const p = document.createElement("p");
      p.textContent = t("noChat");
      els.policeChatLines.appendChild(p);
    } else {
      plines.forEach((line) => {
        const p = document.createElement("p");
        p.textContent = line;
        els.policeChatLines.appendChild(p);
      });
    }
    if (els.policeChatInput) els.policeChatInput.placeholder = t("policeChatPlaceholder");
  }
  // Spectator chat (spectators or dead players)
  if (els.spectatorChatBox) {
    const showSpectator = canSpectatorChat;
    els.spectatorChatBox.classList.toggle("hidden", !showSpectator);
    const slines = (v.spectatorChat || []).slice(-20);
    els.spectatorChatLines.innerHTML = "";
    if (!slines.length) {
      const p = document.createElement("p");
      p.textContent = t("noChat");
      els.spectatorChatLines.appendChild(p);
    } else {
      slines.forEach((line) => {
        const p = document.createElement("p");
        p.textContent = line;
        els.spectatorChatLines.appendChild(p);
      });
    }
    if (els.spectatorChatInput) els.spectatorChatInput.placeholder = t("spectatorChatPlaceholder");
    if (els.sendSpectatorChat) els.sendSpectatorChat.disabled = !showSpectator;
  }
  // Night-death last words for dead players
  if (els.deadLastWordsBox) {
    const selfPlayer = (v.players || []).find((p) => p.id === v.you?.id);
    const canLastWords =
      selfPlayer &&
      !selfPlayer.alive &&
      !selfPlayer.lastWords &&
      !selfPlayer.noLastWords &&
      !ended &&
      v.phase === "DAY";
    els.deadLastWordsBox.classList.toggle("hidden", !canLastWords);
    if (els.sendDeadLastWords) els.sendDeadLastWords.disabled = !canLastWords;
  }
  // Host controls visibility
  document.getElementById("hostControls").style.display = isHost ? "block" : "none";
  // Enable/disable controls based on phase/alive
  document.getElementById("nightControls").style.display = phase === "NIGHT" && alive && !ended ? "block" : "none";
  document.getElementById("voteControls").style.display = phase === "VOTE" && alive && !ended ? "block" : "none";
  const showChatControls = ((phase === "DAY" || phase === "NIGHT") && alive && !ended) || canSpectatorChat;
  document.getElementById("chatControls").style.display = showChatControls ? "block" : "none";
  els.sendNightAction.disabled = !(phase === "NIGHT" && alive && !ended);
  els.sendVote.disabled = !(phase === "VOTE" && alive && !ended);
  els.sendChat.disabled = !((phase === "DAY" || phase === "NIGHT") && alive && !ended);
  const canKillerChat = (phase === "DAY" || phase === "NIGHT") && alive && you?.role === Roles.KILLER.id && !ended;
  const canPoliceChat = (phase === "DAY" || phase === "NIGHT") && alive && you?.role === Roles.POLICE.id && !ended;
  if (els.sendKillerChat) els.sendKillerChat.disabled = !canKillerChat;
  if (els.sendPoliceChat) els.sendPoliceChat.disabled = !canPoliceChat;
  els.resolveNight.disabled = !(isHost && phase === "NIGHT" && !ended);
  els.resolveVote.disabled = !(isHost && phase === "VOTE" && !ended);
  renderTimer();
  renderEndBanner();
  applyLocaleText();
}

function renderTimer() {
  if (!els.timerDisplay) return;
  if (!timerState || !timerState.phase) {
    els.timerDisplay.textContent = "-";
    return;
  }
  const secs = Math.max(0, Math.round((timerState.msLeft || 0) / 1000));
  const phaseLabel =
    timerState.phase === "NIGHT"
      ? t("phaseNight")
      : timerState.phase === "DAY"
      ? t("phaseDay")
      : timerState.phase === "VOTE"
      ? t("phaseVote")
      : timerState.phase === "END"
      ? t("phaseEnd")
      : timerState.phase === "RESTART"
      ? t("phaseRestart")
      : timerState.phase;
  els.timerDisplay.textContent = `${phaseLabel} ${secs}s`;
}

function renderEndBanner() {
  if (!els.endBanner) return;
  if (latestView && latestView.victory) {
    els.endBanner.classList.remove("hidden");
    els.endBanner.style.fontSize = "32px";
    els.endBanner.style.fontWeight = "800";
    const winner = latestView.victory.winner || "";
    const reason = latestView.victory.reason || "";
    const colorMap = { RED: "#e74c3c", BLUE: "#1e90ff", ZOMBIE: "#27ae60", GRUDGE: "#9b59b6" };
    const winnerColor = colorMap[winner] || "#f1c40f";
    els.endBanner.style.color = winnerColor;
    if (locale === "zh") {
      const winnerZhMap = { RED: "紅方", BLUE: "藍方", ZOMBIE: "殭屍", GRUDGE: "怨獸" };
      const reasonZhMap = {
        "Grudge Beasts finished their rage condition.": "怨獸完成狂暴條件。",
        "Grudge Beasts survive without berserk.": "怨獸存活即獲勝。",
        "Zombies outnumber the living.": "殭屍數量過半，感染全場。",
        "Red faction satisfied elimination condition.": "紅方達成淘汰條件。",
        "All killers eliminated.": "所有殺手被清除。",
      };
      const winnerText = winnerZhMap[winner] || winner;
      const reasonText = reasonZhMap[reason] || reason;
      els.endBanner.textContent = `遊戲結束：${winnerText} - ${reasonText}`;
    } else {
      els.endBanner.textContent = `Game Over: ${winner} - ${reason}`;
    }
  } else {
    els.endBanner.classList.add("hidden");
    els.endBanner.textContent = "";
  }
}

// Event handlers
locale = "zh";
applyLocaleText();
if (els.localeSelect) {
  els.localeSelect.addEventListener("change", () => {
    locale = els.localeSelect.value === "zh" ? "zh" : "en";
    applyLocaleText();
    renderLobby();
    renderView();
    if (!latestView) els.phaseDisplay.textContent = t("lobby");
  });
}
els.connectBtn.addEventListener("click", connect);
els.startBtn.addEventListener("click", () => {
  send({ type: "start", theme: els.themeSelect.value || Theme.GOOD_VS_EVIL.id });
});
els.sendNightAction.addEventListener("click", () => {
  const type = els.nightActionType.value;
  if (!type) return;
  const selected = latestView?.you
    ? roleActionChoices(latestView.you.role, !!latestView.grudgeState?.berserk).find((c) => c.value === type)
    : null;
  const needsTarget = selected ? selected.needsTarget !== false : true;
  let targetId = undefined;
  let extraTargets = [];
  if (needsTarget) {
    if (latestView?.you?.role === Roles.EXORCIST.id) {
      const selects = [els.nightTarget, ...(els.exorcistTargets ? Array.from(els.exorcistTargets.querySelectorAll("select")) : [])];
      const ids = selects
        .map((s) => Number(s?.value))
        .filter((n) => !Number.isNaN(n));
      if (ids.length) {
        targetId = ids[0];
        extraTargets = ids.slice(1);
      }
    } else {
      targetId = Number(els.nightTarget.value);
    }
  }
  const action = { type };
  if (targetId !== undefined && !Number.isNaN(targetId)) action.targetId = targetId;
  if (extraTargets.length) action.extraTargets = extraTargets;
  send({ type: "night_action", action });
});
els.sendVote.addEventListener("click", () => {
  const targetVal = els.voteTarget.value;
  const targetId = targetVal ? Number(targetVal) : null;
  const lastWords = els.lastWordsInput.value;
  send({ type: "vote", targetId, lastWords });
});
els.sendChat.addEventListener("click", () => {
  const text = els.chatInput.value;
  if (!text) return;
  send({ type: "chat", text });
  els.chatInput.value = "";
});
if (els.sendKillerChat) {
  els.sendKillerChat.addEventListener("click", () => {
    const text = els.killerChatInput.value;
    if (!text) return;
    send({ type: "killer_chat", text });
    els.killerChatInput.value = "";
  });
}
if (els.sendGrudgeChat) {
  els.sendGrudgeChat.addEventListener("click", () => {
    const text = els.grudgeChatInput.value;
    if (!text) return;
    send({ type: "grudge_chat", text });
    els.grudgeChatInput.value = "";
  });
}
if (els.sendPoliceChat) {
  els.sendPoliceChat.addEventListener("click", () => {
    const text = els.policeChatInput.value;
    if (!text) return;
    send({ type: "police_chat", text });
    els.policeChatInput.value = "";
  });
}
if (els.sendSpectatorChat) {
  els.sendSpectatorChat.addEventListener("click", () => {
    const text = els.spectatorChatInput.value;
    if (!text) return;
    send({ type: "spectator_chat", text });
    els.spectatorChatInput.value = "";
  });
}
if (els.sendDeadLastWords) {
  els.sendDeadLastWords.addEventListener("click", () => {
    const text = els.deadLastWordsInput.value;
    if (!text) return;
    send({ type: "last_words", text });
    els.deadLastWordsInput.value = "";
  });
}
const spectatorWaitLabel = document.getElementById("spectatorWaitLabel");
if (els.spectatorToggle && spectatorWaitLabel) {
  const updateWaitVisibility = () => {
    const show = !!els.spectatorToggle.checked;
    spectatorWaitLabel.classList.toggle("hidden", !show);
    spectatorWaitLabel.style.display = show ? "inline-flex" : "none";
  };
  els.spectatorToggle.addEventListener("change", updateWaitVisibility);
  updateWaitVisibility();
}
els.resolveNight.addEventListener("click", () => send({ type: "resolve_night" }));
els.resolveVote.addEventListener("click", () => send({ type: "resolve_vote" }));

setupThemeOptions();
