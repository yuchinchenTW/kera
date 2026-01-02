import { GameEngine } from "./engine.js";
import { alivePlayers } from "./state.js";
import { Phase, Roles, roleMeta, Theme } from "./roles.js";

let engine = null;

const el = {
  restartBtn: document.getElementById("restartBtn"),
  seedDisplay: document.getElementById("seedDisplay"),
  phaseDisplay: document.getElementById("phaseDisplay"),
  dayDisplay: document.getElementById("dayDisplay"),
  roleDisplay: document.getElementById("roleDisplay"),
  doctorUsage: document.getElementById("doctorUsage"),
  sniperUsage: document.getElementById("sniperUsage"),
  victoryDisplay: document.getElementById("victoryDisplay"),
  winRateDisplay: document.getElementById("winRateDisplay"),
  playersList: document.getElementById("playersList"),
  nightControls: document.getElementById("nightControls"),
  nightActionType: document.getElementById("nightActionType"),
  nightTarget: document.getElementById("nightTarget"),
  runNightBtn: document.getElementById("runNightBtn"),
  nightNote: document.getElementById("nightNote"),
  actionHint: document.getElementById("actionHint"),
  dayView: document.getElementById("dayView"),
  chatLines: document.getElementById("chatLines"),
  toVoteBtn: document.getElementById("toVoteBtn"),
  voteControls: document.getElementById("voteControls"),
  voteTarget: document.getElementById("voteTarget"),
  lastWordsInput: document.getElementById("lastWordsInput"),
  runVoteBtn: document.getElementById("runVoteBtn"),
  playerChatInput: document.getElementById("playerChatInput"),
  sendChatBtn: document.getElementById("sendChatBtn"),
  logText: document.getElementById("logText"),
  lastNight: document.getElementById("lastNight"),
  endView: document.getElementById("endView"),
  endSummary: document.getElementById("endSummary"),
  intelBox: document.getElementById("intelBox"),
  themeSelect: document.getElementById("themeSelect"),
  localeSelect: document.getElementById("localeSelect"),
  difficultySelect: document.getElementById("difficultySelect"),
};

const translations = {
  en: {
    eyebrow: "Single-Player Social Deduction",
    title: "Night / Day 18",
    subtitle: "1 human vs 17 AI, deterministic runs",
    newGame: "New Game",
    phase: "Phase",
    day: "Day",
    youAre: "You are",
    doctorUsage: "Doctor injections",
    sniperUsage: "Sniper shots",
    victory: "Victory",
    winRate: "Win rate",
    players: "Players",
    actions: "Actions",
    nightMove: "Night move",
    resolveNight: "Resolve Night",
    discussion: "Discussion",
    sendChat: "Send",
    chatPlaceholder: "Say something...",
    diffEasy: "Easy",
    diffNormal: "Normal",
    diffHard: "Hard",
    diffNightmare: "Nightmare",
    toVote: "Go to Vote",
    publicVote: "Public vote",
    resolveVote: "Resolve Vote",
    voteNote: "Majority (>50%) executes; otherwise highest votes execute.",
    gameOver: "Game finished",
    events: "Events",
    chooseTarget: "Choose target",
    skipNight: "Skip night action",
    noNight: "No night action",
    abstain: "Abstain",
    phaseNight: "Night",
    phaseDay: "Day discussion",
    phaseVote: "Vote",
    phaseEnd: "End",
    hintNight: "Night: pick an action, then resolve.",
    hintDay: "Day: read the chat, then move to vote.",
    hintVote: "Vote: pick a target for execution.",
    hintEnd: "Game over - start a new seed any time.",
    endSummary: (w, r) => `${w} wins - ${r}`,
    winRateValue: (r, b) => `Red ~${r}% / Blue ~${b}%`,
    winRateNone: "n/a",
    noPrivateIntel: "No private intel yet.",
    noEventsYet: "No major events yet.",
    noChat: "No one spoke up.",
    deadNote: "You are dead; AI will resolve the night.",
    noNightAction: "No night action for this role.",
    doctorNote: (used, max) => `Doctor injections: ${used}/${max}. Overdose at 2/2 empties.`,
    sniperNote: (left) => `Sniper shots left: ${left}.`,
    riotNote: (left) => `Grenades left: ${left}.`,
    pickAction: "Pick an action and target.",
    lastWordsPlaceholder: "Last words (32 English or 16 Chinese chars)",
  },
  zh: {
    eyebrow: "單人社會推理",
    title: "夜 / 晝 18",
    subtitle: "1 名玩家對 17 個 AI，決定論迴合",
    newGame: "新遊戲",
    phase: "階段",
    day: "天數",
    youAre: "你的身份",
    doctorUsage: "醫生注射",
    sniperUsage: "狙擊子彈",
    victory: "勝利",
    winRate: "紅藍勝率預估",
    players: "玩家",
    actions: "行動",
    nightMove: "夜間行動",
    resolveNight: "結算夜晚",
    discussion: "白天討論",
    sendChat: "發言",
    chatPlaceholder: "輸入你的發言…",
    diffEasy: "簡單",
    diffNormal: "一般",
    diffHard: "困難",
    diffNightmare: "夢魘",
    toVote: "進入投票",
    publicVote: "公開投票",
    resolveVote: "結算投票",
    voteNote: "超過 50% 票數直接處決，否則採最高票。",
    gameOver: "遊戲結束",
    events: "事件紀錄",
    chooseTarget: "選擇目標",
    skipNight: "跳過行動",
    noNight: "無夜間行動",
    abstain: "棄權",
    phaseNight: "夜晚",
    phaseDay: "白天討論",
    phaseVote: "投票",
    phaseEnd: "結束",
    hintNight: "夜晚：選擇行動後結算。",
    hintDay: "白天：看完對話再去投票。",
    hintVote: "投票：挑一個要處決的目標。",
    hintEnd: "遊戲結束 - 隨時可以開新局。",
    endSummary: (w, r) => `${w} 勝利 - ${r}`,
    winRateValue: (r, b) => `紅方 ~${r}% / 藍方 ~${b}%`,
    winRateNone: "暫無數據",
    noPrivateIntel: "目前沒有私人情報。",
    noEventsYet: "尚無重大事件。",
    noChat: "暫時沒有人發言。",
    deadNote: "你已死亡，AI 會自動結算夜晚。",
    noNightAction: "此身分沒有夜間行動。",
    doctorNote: (used, max) => `醫生針數：${used}/${max}。累積 2/2 空針會致死。`,
    sniperNote: (left) => `狙擊子彈剩餘：${left}。`,
    riotNote: (left) => `煙霧彈剩餘：${left}。`,
    pickAction: "選擇行動與目標。",
    lastWordsPlaceholder: "遺言（英文 32 字 / 中文 16 字內）",
  },
};

let locale = "zh";
let defaultDifficulty = "hard";

function applyLocaleText() {
  document.documentElement.lang = locale;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    const val = translations[locale][key];
    if (typeof val === "string") node.textContent = val;
  });
  if (el.lastWordsInput) el.lastWordsInput.placeholder = translations[locale].lastWordsPlaceholder;
  if (el.playerChatInput) el.playerChatInput.placeholder = translations[locale].chatPlaceholder;
}

function resetGame() {
  const themeId = el.themeSelect?.value || Theme.GOOD_VS_EVIL.id;
  const difficulty = el.difficultySelect?.value || defaultDifficulty || "normal";
  engine = new GameEngine(Date.now(), themeId, difficulty);
  render();
}

function formatPhase(phase) {
  switch (phase) {
    case Phase.NIGHT:
      return translations[locale].phaseNight;
    case Phase.DAY:
      return translations[locale].phaseDay;
    case Phase.VOTE:
      return translations[locale].phaseVote;
    case Phase.END:
      return translations[locale].phaseEnd;
    default:
      return phase;
  }
}

function buildOptions(selectEl, options, placeholder = "Choose") {
  selectEl.innerHTML = "";
  const placeholderOpt = document.createElement("option");
  placeholderOpt.value = "";
  placeholderOpt.textContent = placeholder;
  selectEl.appendChild(placeholderOpt);
  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    selectEl.appendChild(option);
  }
}

function buildPlayerOptions(filterFn = () => true) {
  const options = [];
  for (const p of alivePlayers(engine.state)) {
    if (!filterFn(p)) continue;
    options.push({ value: String(p.id), label: p.name });
  }
  return options;
}

function translateLine(line) {
  if (locale !== "zh" || typeof line !== "string") return line;
  const rules = [
    [/Someone deployed smoke on (.+)\./, `有人對 $1 投擲煙霧彈。`],
    [/Someone cleansed (.+)\./, `有人淨化了 $1。`],
    [/Someone kidnapped (.+)\./, `有人綁架了 $1。`],
    [/Someone fired a sniper shot\./, "有人開了狙擊槍。"],
    [/A bomb went off but failed on an ally; the bomber died\./, "炸彈在友方身上失效，炸彈客自爆身亡。"],
    [/A bomb detonated on (.+)\./, "炸彈在 $1 身上爆炸。"],
    [/Someone fired a risky shot at (.+)\./, "有人冒險朝 $1 開槍。"],
    [/A cowboy's chamber clicked on (.+)\./, "牛仔對 $1 開槍空響。"],
    [/A cowboy drew a wild bullet\. Chaos ensued\./, "牛仔抽到瘋狂子彈，場面大亂。"],
    [/Someone splashed fuel on (.+)\./, "有人往 $1 潑了汽油。"],
    [/Someone prepared to ignite marked targets\./, "有人準備點燃所有被標記的目標。"],
    [/Someone saved (.+) from death\./, "有人救下了 $1。"],
    [/Someone injected (.+) \(dose (\d+)\/(\d+)\)\./, `有人注射 $1（第 $2/$3 針）。`],
    [/Killers failed to agree on a target\./, "殺手未達成共識。"],
    [/Police could not agree on a target\./, "警察未達成共識。"],
    [/Votes:/, "投票："],
    [/(.+) was executed by vote.*$/, "$1 被處決（過半數）。"],
    [/(.+) was executed by highest votes.*$/, "$1 被最高票處決。"],
    [/No majority reached\. Nobody was executed\./, "沒有過半數，無人被處決。"],
    [/Grudge Beasts entered berserk rage\./, "冤魂獸進入暴走狀態。"],
    [/(.+) turned into a zombie overnight\./, "$1 在夜裡變成了殭屍。"],
    [/(.+) was overwhelmed and turned into a zombie immediately\./, "$1 被圍毆立刻變成殭屍。"],
    [/feels off\./, "不太對勁。"],
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

function setupThemeSelect() {
  if (!el.themeSelect) return;
  el.themeSelect.innerHTML = "";
  Object.values(Theme).forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    el.themeSelect.appendChild(opt);
  });
  el.themeSelect.value = Theme.GOOD_VS_EVIL.id;
}

function actionChoicesForHuman(human) {
  if (!human || !human.alive) return [];
  const state = engine.state;
  switch (human.role) {
    case Roles.POLICE.id:
      return [{ value: "POLICE_INVESTIGATE", label: "Investigate", needsTarget: true }];
    case Roles.KILLER.id:
      return [{ value: "KILLER_VOTE", label: "Murder vote", needsTarget: true }];
    case Roles.DOCTOR.id:
      return [{ value: "DOCTOR_INJECT", label: "Inject", needsTarget: true }];
    case Roles.SNIPER.id:
      return [{ value: "SNIPER_SHOT", label: "Sniper shot", needsTarget: true }];
    case Roles.AGENT.id:
      return [{ value: "AGENT_PROTECT", label: "Protect", needsTarget: true }];
    case Roles.HEAVENLY_FIEND.id:
      return [
        human.status.fiendMode === "ABSORB"
          ? { value: "FIEND_PROTECT", label: "Absorb protect", needsTarget: true }
          : { value: "FIEND_SHOOT", label: "Charge shot", needsTarget: true },
      ];
    case Roles.TERRORIST.id:
      return [{ value: "TERROR_BOMB", label: "Bomb", needsTarget: true }];
    case Roles.COWBOY.id:
      return [{ value: "COWBOY_GAMBLE", label: "Gamble shot", needsTarget: true }];
    case Roles.KIDNAPPER.id:
      return [{ value: "KIDNAP", label: "Kidnap", needsTarget: true }];
    case Roles.ZOMBIE.id:
      return [{ value: "ZOMBIE_BITE", label: "Bite", needsTarget: true }];
    case Roles.RIOT_POLICE.id:
      return [{ value: "RIOT_SMOKE", label: "Smoke grenade", needsTarget: true }];
    case Roles.ARSONIST.id:
      return [
        { value: "ARSON_MARK", label: "Mark with fuel", needsTarget: true },
        { value: "ARSON_IGNITE", label: "Ignite all marks", needsTarget: false },
      ];
    case Roles.VINE_DEMON.id:
      return [{ value: "VINE_SEED", label: "Plant seed", needsTarget: true }];
    case Roles.NIGHTMARE_DEMON.id:
      return [{ value: "NIGHTMARE_ATTACK", label: "Nightmare strike", needsTarget: true }];
    case Roles.EXORCIST.id:
      return [{ value: "EXORCIST_STRIKE", label: "Exorcist strike", needsTarget: true }];
    case Roles.NECROMANCER.id:
      return [{ value: "NECROMANCER_CURSE", label: "Curse", needsTarget: true }];
    case Roles.PURIFIER.id:
      return [{ value: "PURIFY", label: "Cleanse", needsTarget: true }];
    case Roles.GRUDGE_BEAST.id:
      return state.grudgeState.berserk
        ? [{ value: "GRUDGE_KILL_VOTE", label: "Berserk kill vote", needsTarget: true }]
        : [{ value: "GRUDGE_JUDGE", label: "Judge", needsTarget: true }];
    default:
      return [];
  }
}

function resolveNightAction() {
  const human = engine.human();
  if (!human?.alive) {
    engine.resolveNight(null);
    render();
    return;
  }
  const actionType = el.nightActionType.value;
  if (!actionType) {
    engine.resolveNight(null);
    render();
    return;
  }
  const choices = actionChoicesForHuman(human);
  const selected = choices.find((c) => c.value === actionType);
  const needsTarget = selected?.needsTarget !== false;
  const targetVal = el.nightTarget.value;
  const targetId = needsTarget && targetVal ? Number(targetVal) : null;
  const action = { type: actionType };
  if (targetId !== null) action.targetId = targetId;
  engine.resolveNight(action);
  render();
}

function resolveVoteAction() {
  const val = el.voteTarget.value;
  const human = engine.human();
  let targetId = val ? Number(val) : null;
  if (human.role === Roles.BRAT.id && human.status.bratRevived) {
    targetId = null;
  }
  engine.resolveVote(targetId, el.lastWordsInput.value);
  el.lastWordsInput.value = "";
  render();
}

function setPhaseDayToVote() {
  if (engine.state.victory) return;
  engine.state.phase = Phase.VOTE;
  render();
}

function renderPlayers() {
  el.playersList.innerHTML = "";
  for (const p of engine.state.players) {
    const li = document.createElement("li");
    li.className = "player-card" + (p.alive ? "" : " dead");
    const name = document.createElement("div");
    const youTag = p.isHuman ? (locale === "zh" ? "（你）" : " (You)") : "";
    name.textContent = p.name + youTag;
    const badges = document.createElement("div");
    const roleBadge = document.createElement("span");
    roleBadge.className = "badge role";
    let roleText = "Hidden";
    if (!p.alive || p.isHuman) {
      roleText = roleMeta(p.role).name;
    } else {
      const humanRole = engine.human().role;
      if (humanRole === Roles.POLICE.id && p.role === Roles.POLICE.id) roleText = roleMeta(p.role).name;
      if (humanRole === Roles.KILLER.id && p.role === Roles.KILLER.id) roleText = roleMeta(p.role).name;
    }
    roleBadge.textContent = roleText;
    badges.appendChild(roleBadge);
    const factionBadge = document.createElement("span");
    const humanRole = engine.human().role;
    const revealFaction =
      !p.alive ||
      p.isHuman ||
      (humanRole === Roles.POLICE.id && p.role === Roles.POLICE.id) ||
      (humanRole === Roles.KILLER.id && p.role === Roles.KILLER.id);
    const factionClass = p.faction === "RED" ? "red" : p.faction === "GREEN" ? "green" : "blue";
    factionBadge.className = "badge " + (revealFaction ? factionClass : "role");
    factionBadge.textContent = revealFaction ? p.faction : "Unknown";
    badges.appendChild(factionBadge);
    li.appendChild(name);
    li.appendChild(badges);
    el.playersList.appendChild(li);
  }
}

function renderLog() {
  const human = engine.human();
  el.intelBox.innerHTML = "";
  const intelLines = [];
  if (human.role === Roles.POLICE.id) {
    intelLines.push(...(engine.state.privateLogs.police || []));
  }
  if (human.role === Roles.KILLER.id) {
    intelLines.push(...(engine.state.privateLogs.killer || []));
  }
  if (human.role === Roles.GRUDGE_BEAST.id) {
    intelLines.push(...(engine.state.privateLogs.grudge || []));
  }
  if (intelLines.length) {
    const list = document.createElement("ul");
    translateLines(intelLines.slice(-5)).forEach((entry) => {
      const item = document.createElement("li");
      item.textContent = entry;
      list.appendChild(item);
    });
    el.intelBox.appendChild(list);
  } else {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = translations[locale].noPrivateIntel;
    el.intelBox.appendChild(p);
  }

  const translated = translateLines(engine.state.publicLog);
  if (el.logText) {
    el.logText.value = translated.join("\n");
  }
  el.lastNight.innerHTML = "";
  if (engine.state.lastNightSummary.length === 0) {
    el.lastNight.textContent = translations[locale].noEventsYet;
  } else {
    const list = document.createElement("ul");
    for (const entry of translateLines(engine.state.lastNightSummary)) {
      const item = document.createElement("li");
      item.textContent = entry;
      list.appendChild(item);
    }
    el.lastNight.appendChild(list);
  }
}

function renderChat() {
  el.chatLines.innerHTML = "";
  if (!engine.state.dayChat || !engine.state.dayChat.length) {
    const p = document.createElement("p");
    p.textContent = translations[locale].noChat;
    el.chatLines.appendChild(p);
    return;
  }
  const translated = translateLines(engine.state.dayChat);
  for (const line of translated) {
    const p = document.createElement("p");
    p.textContent = line;
    el.chatLines.appendChild(p);
  }
}

function sendPlayerChat() {
  const input = el.playerChatInput;
  if (!input || engine.state.phase !== Phase.DAY) return;
  const text = (input.value || "").trim();
  if (!text) return;
  const human = engine.human();
  const line = `${human.name}: ${text}`;
  engine.state.dayChat.push(line);
  engine.state.publicLog.push(line);
  input.value = "";
  render();
}

function renderControls() {
  const phase = engine.state.phase;
  const human = engine.human();
  const alive = human?.alive;
  el.nightControls.classList.toggle("hidden", phase !== Phase.NIGHT);
  el.dayView.classList.toggle("hidden", phase !== Phase.DAY);
  el.voteControls.classList.toggle("hidden", phase !== Phase.VOTE);
  el.endView.classList.toggle("hidden", phase !== Phase.END);
  if (el.playerChatInput) {
    el.playerChatInput.disabled = phase !== Phase.DAY || !alive;
  }
  if (el.sendChatBtn) {
    el.sendChatBtn.disabled = phase !== Phase.DAY || !alive;
  }

  if (phase === Phase.NIGHT) {
    const roleId = human?.role;
    let note = "";
    const choices = actionChoicesForHuman(human);
    const prevAction = el.nightActionType.value;
    const prevTarget = el.nightTarget.value;
    if (!alive) {
      note = translations[locale].deadNote;
    } else if (!choices.length) {
      note = translations[locale].noNightAction;
    } else if (roleId === Roles.DOCTOR.id) {
      note = translations[locale].doctorNote(engine.state.usage.doctorInjections, Roles.DOCTOR.maxInjections);
    } else if (roleId === Roles.SNIPER.id) {
      const left = Math.max(0, (Roles.SNIPER.maxShots || 0) - engine.state.usage.sniperShots);
      note = translations[locale].sniperNote(left);
    } else if (roleId === Roles.RIOT_POLICE.id) {
      const left = Math.max(0, (Roles.RIOT_POLICE.maxGrenades || 0) - engine.state.usage.riotGrenades);
      note = translations[locale].riotNote(left);
    } else {
      note = translations[locale].pickAction;
    }
    el.nightNote.textContent = note;

    buildOptions(
      el.nightActionType,
      choices,
      choices.length ? translations[locale].skipNight : translations[locale].noNight
    );
    el.nightActionType.disabled = !choices.length;

    const selected = choices.find((c) => c.value === prevAction);
    if (selected) {
      el.nightActionType.value = prevAction;
    } else if (choices.length) {
      el.nightActionType.value = choices[0].value;
    }

    const chosen = choices.find((c) => c.value === el.nightActionType.value);
    const needsTarget = !!chosen && chosen.needsTarget !== false;
    if (needsTarget) {
      let options = [];
      if (alive) {
        switch (roleId) {
          case Roles.POLICE.id:
            options = buildPlayerOptions((p) => p.role !== Roles.POLICE.id);
            break;
          case Roles.KILLER.id:
            options = buildPlayerOptions((p) => p.faction !== "RED");
            break;
          case Roles.DOCTOR.id:
            options = buildPlayerOptions(() => true);
            break;
          case Roles.SNIPER.id:
            options = buildPlayerOptions((p) => p.id !== human.id);
            break;
          default:
            options = buildPlayerOptions(() => true);
        }
      }
      buildOptions(el.nightTarget, options, translations[locale].chooseTarget);
      el.nightTarget.disabled = false;
      if (prevTarget && options.some((o) => o.value === prevTarget)) {
        el.nightTarget.value = prevTarget;
      }
    } else {
      buildOptions(el.nightTarget, [], translations[locale].noNight);
      el.nightTarget.disabled = true;
    }
  }

  if (phase === Phase.DAY) {
    renderChat();
  }

  if (phase === Phase.VOTE) {
    const options = buildPlayerOptions((p) => p.alive);
    buildOptions(el.voteTarget, options, translations[locale].abstain);
  }

  if (phase === Phase.END) {
    const winner = engine.state.victory?.winner;
    const reason = engine.state.victory?.reason;
    el.endSummary.textContent = translations[locale].endSummary(winner, reason);
  }
}

function render() {
  const state = engine.state;
  const human = engine.human();
  if (!human) return;
  el.seedDisplay.textContent = `Seed ${state.seed}`;
  el.phaseDisplay.textContent = formatPhase(state.phase);
  el.dayDisplay.textContent = `${state.dayNumber}`;
  el.roleDisplay.textContent = `${roleMeta(human.role).name} (${human.faction})`;
  el.doctorUsage.textContent = `${state.usage.doctorInjections}/${Roles.DOCTOR.maxInjections || 0}`;
  el.sniperUsage.textContent = `${state.usage.sniperShots}/${Roles.SNIPER.maxShots || 0}`;
  el.victoryDisplay.textContent = state.victory ? `${state.victory.winner}` : "-";
  if (el.winRateDisplay) {
    if (state.winrateHint) {
      const redPct = Math.round(state.winrateHint.red * 100);
      const bluePct = Math.round(state.winrateHint.blue * 100);
      el.winRateDisplay.textContent = translations[locale].winRateValue(redPct, bluePct);
    } else {
      el.winRateDisplay.textContent = translations[locale].winRateNone;
    }
  }
  el.actionHint.textContent =
    state.phase === Phase.NIGHT
      ? translations[locale].hintNight
      : state.phase === Phase.DAY
      ? translations[locale].hintDay
      : state.phase === Phase.VOTE
      ? translations[locale].hintVote
      : translations[locale].hintEnd;

  renderPlayers();
  renderLog();
  renderControls();
}

function init() {
  setupThemeSelect();
  if (el.difficultySelect && defaultDifficulty) {
    el.difficultySelect.value = defaultDifficulty;
  }
  if (el.restartBtn) el.restartBtn.addEventListener("click", resetGame);
  if (el.runNightBtn) el.runNightBtn.addEventListener("click", resolveNightAction);
  if (el.runVoteBtn) el.runVoteBtn.addEventListener("click", resolveVoteAction);
  if (el.toVoteBtn) el.toVoteBtn.addEventListener("click", setPhaseDayToVote);
  if (el.themeSelect) el.themeSelect.addEventListener("change", resetGame);
  if (el.difficultySelect) el.difficultySelect.addEventListener("change", resetGame);
  if (el.sendChatBtn) el.sendChatBtn.addEventListener("click", sendPlayerChat);
  if (el.playerChatInput) {
    el.playerChatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendPlayerChat();
      }
    });
  }
  if (el.localeSelect) {
    el.localeSelect.value = locale;
    el.localeSelect.addEventListener("change", () => {
      locale = el.localeSelect.value === "en" ? "en" : "zh";
      applyLocaleText();
      resetGame();
    });
  }
  applyLocaleText();
  resetGame();
}

init();
