import { Roles, Theme } from "./roles.js";

const els = {
  wsUrl: document.getElementById("wsUrl"),
  playerName: document.getElementById("playerName"),
  connectBtn: document.getElementById("connectBtn"),
  themeSelect: document.getElementById("themeSelect"),
  startBtn: document.getElementById("startBtn"),
  seatInfo: document.getElementById("seatInfo"),
  hostBadge: document.getElementById("hostBadge"),
  seatsList: document.getElementById("seatsList"),
  phaseDisplay: document.getElementById("phaseDisplay"),
  dayDisplay: document.getElementById("dayDisplay"),
  youDisplay: document.getElementById("youDisplay"),
  timerDisplay: document.getElementById("timerDisplay"),
  nightActionType: document.getElementById("nightActionType"),
  nightTarget: document.getElementById("nightTarget"),
  sendNightAction: document.getElementById("sendNightAction"),
  voteTarget: document.getElementById("voteTarget"),
  lastWordsInput: document.getElementById("lastWordsInput"),
  sendVote: document.getElementById("sendVote"),
  chatInput: document.getElementById("chatInput"),
  sendChat: document.getElementById("sendChat"),
  resolveNight: document.getElementById("resolveNight"),
  resolveVote: document.getElementById("resolveVote"),
  restartBtn: document.getElementById("restartBtn"),
  playersList: document.getElementById("playersList"),
  logText: document.getElementById("logText"),
};

let ws = null;
let isHost = false;
let seatId = null;
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
  ws = new WebSocket(els.wsUrl.value || "ws://localhost:3001");
  ws.onopen = () => {
    const name = (els.playerName.value || "Player").slice(0, 32);
    ws.send(JSON.stringify({ type: "join", name }));
    log(">> join as " + name);
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
  switch (msg.type) {
    case "joined":
      seatId = msg.playerId;
      isHost = !!msg.host;
      els.seatInfo.textContent = `Seat ${seatId + 1}`;
      els.hostBadge.textContent = isHost ? "Host" : "";
      log("Joined seat " + (seatId + 1) + (isHost ? " (host)" : ""));
      break;
    case "host":
      isHost = !!msg.value;
      els.hostBadge.textContent = isHost ? "Host" : "";
      break;
    case "lobby":
      lobbySeats = msg.seats || [];
      renderLobby();
      latestView = null;
      els.phaseDisplay.textContent = "Lobby";
      els.dayDisplay.textContent = "-";
      els.youDisplay.textContent = "-";
      log("Lobby reset (waiting to start)");
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
    name.textContent = `Seat ${s.playerId + 1}: ${s.name}`;
    li.appendChild(name);
    els.seatsList.appendChild(li);
  });
}

function roleActionChoices(roleId) {
  switch (roleId) {
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
        { value: "FIEND_PROTECT", label: "Absorb protect", needsTarget: true },
        { value: "FIEND_SHOOT", label: "Charge shot", needsTarget: true },
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
      return [
        { value: "GRUDGE_JUDGE", label: "Judge", needsTarget: true },
        { value: "GRUDGE_KILL_VOTE", label: "Berserk kill vote", needsTarget: true },
      ];
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
  els.phaseDisplay.textContent = v.phase || "-";
  els.dayDisplay.textContent = v.dayNumber || "-";
  els.youDisplay.textContent = v.you ? `${v.you.name} (${v.you.role})` : "-";
  // Players list
  els.playersList.innerHTML = "";
  (v.players || []).forEach((p) => {
    const li = document.createElement("div");
    li.className = "player-card" + (p.alive ? "" : " dead");
    li.textContent = `${p.name} | ${p.alive ? "Alive" : "Dead"} | Role: ${p.role} | Faction: ${p.faction}`;
    els.playersList.appendChild(li);
  });
  // Logs
  const mergedLogs = [...(v.publicLog || [])];
  els.logText.value = mergedLogs.join("\n");
  // Action controls
  const you = v.you;
  const choices = you ? roleActionChoices(you.role) : [];
  buildOptions(els.nightActionType, choices, choices.length ? "Pick action" : "No night action");
  const targetOptions = (v.players || [])
    .filter((p) => p.id !== you?.id && p.alive)
    .map((p) => ({ value: String(p.id), label: p.name }));
  buildOptions(els.nightTarget, targetOptions, "Choose target");
  const voteOptions = (v.players || [])
    .filter((p) => p.alive)
    .map((p) => ({ value: String(p.id), label: p.name }));
  buildOptions(els.voteTarget, voteOptions, "Abstain");
  // Host controls visibility
  document.getElementById("hostControls").style.display = isHost ? "block" : "none";
  renderTimer();
}

function renderTimer() {
  if (!els.timerDisplay) return;
  if (!timerState || !timerState.phase) {
    els.timerDisplay.textContent = "-";
    return;
  }
  const secs = Math.max(0, Math.round((timerState.msLeft || 0) / 1000));
  els.timerDisplay.textContent = `${timerState.phase} ${secs}s`;
}

// Event handlers
els.connectBtn.addEventListener("click", connect);
els.startBtn.addEventListener("click", () => {
  send({ type: "start", theme: els.themeSelect.value || Theme.GOOD_VS_EVIL.id });
});
els.sendNightAction.addEventListener("click", () => {
  const type = els.nightActionType.value;
  if (!type) return;
  const selected = latestView?.you ? roleActionChoices(latestView.you.role).find((c) => c.value === type) : null;
  const needsTarget = selected ? selected.needsTarget !== false : true;
  const targetId = needsTarget ? Number(els.nightTarget.value) : undefined;
  const action = { type };
  if (targetId !== undefined && !Number.isNaN(targetId)) action.targetId = targetId;
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
els.resolveNight.addEventListener("click", () => send({ type: "resolve_night" }));
els.resolveVote.addEventListener("click", () => send({ type: "resolve_vote" }));
els.restartBtn.addEventListener("click", () => send({ type: "restart" }));

setupThemeOptions();
