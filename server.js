import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { GameEngine } from "./src/engine.js";
import { buildPlayerView, buildSpectatorView } from "./src/view.js";
import { Theme, Phase } from "./src/roles.js";
import { generateNightFactionChat } from "./src/ai.js";

const PORT = process.env.PORT || 3001;
const MAX_PLAYERS = 18;
const RESTART_DELAY_MS = 8000;

const room = {
  started: false,
  engine: null,
  host: null,
  theme: Theme.GOOD_VS_EVIL.id,
  seats: [], // { playerId, name }
  connections: new Map(), // ws -> { playerId, name }
  nightActions: new Map(), // actorId -> action
  voteActions: new Map(), // actorId -> targetId
  lastWords: new Map(), // actorId -> text
  timer: {
    handle: null,
    interval: null,
    endsAt: null,
    phase: null,
  },
  restartHandle: null,
  restartLogged: false,
  spectatorChat: [],
};

const DURATIONS = {
  night: 30000,
  day: 20000,
  vote: 20000,
};

function log(...args) {
  console.log("[server]", ...args);
}

function normalizeName(str) {
  return (str || "").trim().toLowerCase();
}

function makeUniqueName(rawName) {
  const baseRaw = (rawName || "Player").trim() || "Player";
  const allNames = [
    ...room.seats.map((s) => s.name),
    ...Array.from(room.connections.values())
      .map((m) => m?.name)
      .filter(Boolean),
  ];
  const targetBase = normalizeName(baseRaw.slice(0, 32));
  let maxIndex = 0;
  for (const existing of allNames) {
    const match = existing.match(/^(.*?)(?: \((\d+)\))?$/);
    const base = normalizeName(match ? match[1] : existing);
    const idx = match && match[2] ? Number(match[2]) : 0;
    if (base === targetBase) {
      maxIndex = Math.max(maxIndex, idx || 1);
    }
  }
  const nextIndex = maxIndex + 1;
  const suffix = ` (${nextIndex})`;
  const baseLimited = baseRaw.slice(0, Math.max(1, 32 - suffix.length));
  return `${baseLimited}${suffix}`;
}

function nextSeatId() {
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (!room.seats.find((s) => s.playerId === i)) return i;
  }
  return null;
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const ws of room.connections.keys()) {
    ws.send(message);
  }
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function resetRoomState(clearSeats = false) {
  clearTimer();
  room.started = false;
  room.engine = null;
  room.nightActions.clear();
  room.voteActions.clear();
  room.lastWords.clear();
  if (room.restartHandle) {
    clearTimeout(room.restartHandle);
    room.restartHandle = null;
  }
  room.restartLogged = false;
  room.spectatorChat = [];
  if (clearSeats) {
    room.seats = [];
  }
}

function broadcastViews() {
  if (!room.engine) return;
  for (const [ws, seat] of room.connections.entries()) {
    let view = null;
    if (seat && seat.playerId !== undefined && seat.playerId !== null) {
      view = buildPlayerView(room.engine.state, seat.playerId);
    } else {
      view = buildSpectatorView(room.engine.state);
    }
    send(ws, { type: "view", view });
  }
  scheduleRestartAfterVictory();
}

function startGame(theme = Theme.GOOD_VS_EVIL.id) {
  if (room.restartHandle) {
    clearTimeout(room.restartHandle);
    room.restartHandle = null;
  }
  room.restartLogged = false;
  room.spectatorChat = [];
  const humanIds = room.seats.map((s) => s.playerId);
  room.theme = theme;
  room.engine = new GameEngine(Date.now(), theme, "hard", { humanIds });
  room.engine.state.spectatorChat = room.spectatorChat;
  for (const seat of room.seats) {
    const p = room.engine.state.players[seat.playerId];
    if (p) {
      p.name = seat.name;
      p.isHuman = true;
    }
  }
  room.started = true;
  room.nightActions.clear();
  room.voteActions.clear();
  room.lastWords.clear();
  broadcast({ type: "started", theme, humans: humanIds.length });
  broadcastViews();
  scheduleNightTimer();
  log("Game started with", humanIds.length, "humans, theme", theme);
}

function clearTimer() {
  if (room.timer.handle) clearTimeout(room.timer.handle);
  if (room.timer.interval) clearInterval(room.timer.interval);
  room.timer = { handle: null, interval: null, endsAt: null, phase: null };
}

function broadcastTimer() {
  if (!room.timer.phase || !room.timer.endsAt) return;
  const msLeft = Math.max(0, room.timer.endsAt - Date.now());
  broadcast({ type: "timer", phase: room.timer.phase, msLeft });
}

function startTimer(phase, durationMs, onFire) {
  clearTimer();
  room.timer.phase = phase;
  room.timer.endsAt = Date.now() + durationMs;
  room.timer.handle = setTimeout(() => {
    onFire();
  }, durationMs);
  room.timer.interval = setInterval(() => broadcastTimer(), 1000);
  broadcastTimer();
}

function scheduleNightTimer() {
  // Generate AI night faction chat so players see it during the night phase
  if (room.engine) {
    room.engine.state.nightFactionChatDay = room.engine.state.dayNumber;
    generateNightFactionChat(room.engine.state);
    broadcastViews();
  }
  startTimer("NIGHT", DURATIONS.night, () => {
    const humanActions = Object.fromEntries(room.nightActions.entries());
    room.engine.resolveNight(null, { humanActions, includeHuman: false });
    room.nightActions.clear();
    broadcast({ type: "phase", phase: room.engine.state.phase, day: room.engine.state.dayNumber });
    broadcastViews();
    if (room.engine.state.phase !== Phase.END) scheduleDayToVote();
    scheduleRestartAfterVictory();
  });
}

function advanceToVotePhase() {
  if (!room.engine || room.engine.state.phase === Phase.END) return;
  room.engine.state.phase = Phase.VOTE;
  broadcast({ type: "phase", phase: Phase.VOTE, day: room.engine.state.dayNumber });
  broadcastViews();
  scheduleVoteTimer();
}

function scheduleDayToVote() {
  startTimer("DAY", DURATIONS.day, () => {
    advanceToVotePhase();
  });
}

function scheduleVoteTimer() {
  startTimer("VOTE", DURATIONS.vote, () => {
    const humanVotes = Object.fromEntries(room.voteActions.entries());
    const lastWordsByPlayer = Object.fromEntries(room.lastWords.entries());
    room.engine.resolveVote(null, "", { humanVotes, lastWordsByPlayer, includeHuman: false });
    room.voteActions.clear();
    room.lastWords.clear();
    broadcast({ type: "phase", phase: room.engine.state.phase, day: room.engine.state.dayNumber });
    broadcastViews();
    if (room.engine.state.phase !== Phase.END) scheduleNightTimer();
    scheduleRestartAfterVictory();
  });
}

function ensureHost(ws) {
  return ws === room.host;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(__dirname);

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }
  const urlPath = new URL(req.url, "http://localhost").pathname;
  const normalized = path.normalize(urlPath);
  const filePath = path.resolve(baseDir, normalized === "/" ? "index.html" : "." + normalized);
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    if (req.method === "GET") res.end(data);
    else res.end();
  } catch (err) {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  serveStatic(req, res);
});
const wss = new WebSocketServer({ server });

let lobbyBroadcastHandle = null;
function scheduleLobbyBroadcast() {
  if (lobbyBroadcastHandle) return;
  lobbyBroadcastHandle = setTimeout(() => {
    lobbyBroadcastHandle = null;
    broadcast({ type: "lobby", seats: room.seats });
  }, 150);
}

// Per-connection rate limiting (simple token bucket).
const RATE_LIMIT = {
  intervalMs: 2000,
  maxTokens: 8,
  refill: 8,
};
const MAX_MESSAGE_BYTES = 16 * 1024; // hard cap per incoming WS message
const VIOLATION_LIMIT = 5; // disconnect after too many violations
function makeRateLimiter() {
  return { tokens: RATE_LIMIT.maxTokens, last: Date.now(), violations: 0 };
}
function consumeToken(limiter) {
  const now = Date.now();
  const elapsed = now - limiter.last;
  if (elapsed > RATE_LIMIT.intervalMs) {
    limiter.tokens = Math.min(RATE_LIMIT.maxTokens, limiter.tokens + RATE_LIMIT.refill);
    limiter.last = now;
  }
  if (limiter.tokens <= 0) return false;
  limiter.tokens -= 1;
  return true;
}

// IP-level penalties to block reconnect spam.
const ipPenalties = new Map();
const MAX_VIOLATIONS_PER_IP = 10;
const BAN_DURATION_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipPenalties.entries()) {
    if (now - record.lastViolationTime > BAN_DURATION_MS) {
      ipPenalties.delete(ip);
    }
  }
}, BAN_DURATION_MS);

function scheduleRestartAfterVictory() {
  if (!room.engine) return;
  const victory = !!room.engine.state?.victory;
  const isEndPhase = room.engine.state.phase === Phase.END;
  if (!victory && !isEndPhase) return;
  if (room.restartHandle) return;
  if (!room.restartLogged) {
    log(
      victory
        ? "Victory detected, preparing auto-restart."
        : "END phase detected without victory payload; preparing auto-restart."
    );
    room.restartLogged = true;
  }
  if (!isEndPhase) {
    log("Phase not END; forcing END for restart.");
    room.engine.state.phase = Phase.END;
  }
  promoteWaitingSpectatorsToSeats();
  const themeToUse = room.theme;
  clearTimer();
  log(`Auto-restart scheduled in ${RESTART_DELAY_MS / 1000}s`);
  room.restartHandle = true;
  startTimer("RESTART", RESTART_DELAY_MS, () => {
    room.restartHandle = null;
    if (!room.engine) return;
    log("Auto-restart firing");
    startGame(themeToUse);
  });
}

// Fallback guard: poll for victory and ensure restart is scheduled.
setInterval(() => {
  try {
    scheduleRestartAfterVictory();
  } catch (err) {
    log("Auto-restart poll error:", err);
  }
}, 1000);

function promoteWaitingSpectator() {
  const waiterEntry = Array.from(room.connections.entries()).find(
    ([, meta]) => meta?.spectator && meta.waitForStart
  );
  if (!waiterEntry) return false;
  const [waiterWs, meta] = waiterEntry;
  resetRoomState(true);
  const seatId = nextSeatId();
  const seat = { playerId: seatId, name: meta.name };
  room.seats.push(seat);
  room.connections.set(waiterWs, { playerId: seatId, name: meta.name, waitForStart: false });
  room.host = waiterWs;
  send(waiterWs, { type: "joined", playerId: seatId, host: true });
  send(waiterWs, { type: "host", value: true });
  scheduleLobbyBroadcast();
  log("Promoted waiting spectator to host", seatId, seat.name);
  return true;
}

function handleHostVacancy() {
  const nextPlayer = Array.from(room.connections.entries()).find(
    ([, meta]) => meta && meta.playerId !== undefined
  );
  if (nextPlayer) {
    room.host = nextPlayer[0];
    send(room.host, { type: "host", value: true });
    return;
  }
  if (promoteWaitingSpectator()) return;
  resetRoomState(true);
  room.host = null;
  scheduleLobbyBroadcast();
}

function promoteWaitingSpectatorsToSeats() {
  let changed = false;
  for (const [ws, meta] of Array.from(room.connections.entries())) {
    if (!meta?.spectator || !meta.waitForStart) continue;
    const seatId = nextSeatId();
    if (seatId === null) break;
    const seat = { playerId: seatId, name: meta.name };
    room.seats.push(seat);
    room.connections.set(ws, { playerId: seatId, name: meta.name, waitForStart: false });
    send(ws, { type: "joined", playerId: seatId, host: ensureHost(ws) });
    changed = true;
  }
  if (changed) {
    scheduleLobbyBroadcast();
  }
}

wss.on("connection", (ws, req) => {
  const ip = req?.socket?.remoteAddress || "unknown";
  ws.ip = ip;
  const penalty = ipPenalties.get(ip);
  if (penalty && penalty.violations >= MAX_VIOLATIONS_PER_IP) {
    const since = Date.now() - penalty.lastViolationTime;
    if (since < BAN_DURATION_MS) {
      ws.terminate();
      return;
    } else {
      ipPenalties.delete(ip);
    }
  }
  ws.rateLimiter = makeRateLimiter();
  ws.on("message", (data) => {
    if (!consumeToken(ws.rateLimiter)) {
      const record = ipPenalties.get(ws.ip) || { violations: 0, lastViolationTime: 0 };
      record.violations += 1;
      record.lastViolationTime = Date.now();
      ipPenalties.set(ws.ip, record);
      send(ws, { type: "error", message: "Too many requests; slow down." });
      if (record.violations >= MAX_VIOLATIONS_PER_IP) {
        log(`[server] Banning IP ${ws.ip} for ${BAN_DURATION_MS / 1000}s`);
        ws.terminate();
      }
      return;
    }
    if (typeof data?.length === "number" && data.length > MAX_MESSAGE_BYTES) {
      const record = ipPenalties.get(ws.ip) || { violations: 0, lastViolationTime: 0 };
      record.violations += 1;
      record.lastViolationTime = Date.now();
      ipPenalties.set(ws.ip, record);
      send(ws, { type: "error", message: "Payload too large." });
      if (record.violations >= MAX_VIOLATIONS_PER_IP) {
        log(`[server] Banning IP ${ws.ip} for ${BAN_DURATION_MS / 1000}s`);
        ws.terminate();
      }
      return;
    }
    let msg = null;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "join": {
        const wantsSpectator = !!msg.spectator;
        if (room.started && !wantsSpectator) {
          // Auto-convert to spectator waiting for next game.
          msg.spectator = true;
          msg.waitForStart = true;
        }
        if (wantsSpectator || msg.spectator) {
          const name = makeUniqueName((msg.name || `Spectator`).slice(0, 32));
          const waitForStart = room.started ? true : !!msg.waitForStart;
          room.connections.set(ws, { spectator: true, name, waitForStart });
          if (!room.host && room.seats.length > 0) {
            const hostSeat = room.connections.keys().next().value;
            room.host = hostSeat || ws;
          }
          send(ws, { type: "joined", spectator: true, host: ensureHost(ws) });
          broadcastViews();
          log("Spectator joined", name);
          break;
        }
        if (room.started) {
          send(ws, { type: "error", message: "Game already started." });
          return;
        }
        const seatId = nextSeatId();
        if (seatId === null) {
          send(ws, { type: "error", message: "Room is full." });
          return;
        }
        const name = makeUniqueName((msg.name || `Player ${seatId + 1}`).slice(0, 32));
        const seat = { playerId: seatId, name };
        room.seats.push(seat);
        room.connections.set(ws, seat);
        if (!room.host) room.host = ws;
        send(ws, { type: "joined", playerId: seatId, host: ensureHost(ws) });
        scheduleLobbyBroadcast();
        log("Player joined", seatId, name);
        break;
      }
      case "start": {
        if (!ensureHost(ws)) {
          send(ws, { type: "error", message: "Only host can start." });
          return;
        }
        if (room.started) {
          send(ws, { type: "error", message: "Game already started." });
          return;
        }
        const theme = msg.theme || room.theme;
        startGame(theme);
        break;
      }
      case "night_action": {
        if (!room.started || !room.engine || room.engine.state.phase !== "NIGHT") {
          send(ws, { type: "error", message: "Not in night phase." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat || seat.spectator) return;
        const actor = room.engine.state.players[seat.playerId];
        if (!actor?.alive) {
          send(ws, { type: "error", message: "You are dead and cannot act." });
          return;
        }
        // Role-based allowlist to prevent tampering.
        const roleActions = {
          POLICE: ["POLICE_INVESTIGATE"],
          KILLER: ["KILLER_VOTE"],
          DOCTOR: ["DOCTOR_INJECT"],
          SNIPER: ["SNIPER_SHOT"],
          AGENT: ["AGENT_PROTECT"],
          HEAVENLY_FIEND: ["FIEND_PROTECT", "FIEND_SHOOT"],
          TERRORIST: ["TERROR_BOMB"],
          COWBOY: ["COWBOY_GAMBLE"],
          KIDNAPPER: ["KIDNAP"],
          ZOMBIE: ["ZOMBIE_BITE"],
          RIOT_POLICE: ["RIOT_SMOKE"],
          ARSONIST: ["ARSON_MARK", "ARSON_IGNITE"],
          VINE_DEMON: ["VINE_SEED"],
          NIGHTMARE_DEMON: ["NIGHTMARE_ATTACK"],
          EXORCIST: ["EXORCIST_STRIKE"],
          NECROMANCER: ["NECROMANCER_CURSE"],
          PURIFIER: ["PURIFY"],
          GRUDGE_BEAST: ["GRUDGE_JUDGE", "GRUDGE_KILL_VOTE"],
        };
        if (!msg.action || !msg.action.type) {
          room.nightActions.delete(seat.playerId);
          return;
        }
        const allowed = roleActions[actor.role] || [];
        if (!allowed.includes(msg.action.type)) {
          send(ws, { type: "error", message: "Action not allowed for your role." });
          return;
        }
        // Target sanity: only allow numeric targetId that exists when required.
        if (msg.action.targetId !== undefined && msg.action.targetId !== null) {
          const t = room.engine.state.players?.[msg.action.targetId];
          if (!t || !t.alive) {
            send(ws, { type: "error", message: "Invalid target." });
            return;
          }
          // Role-specific targeting rules (mirror single-player restrictions).
          const tid = msg.action.targetId;
          if (actor.role === "KILLER" && t.faction === "RED") {
            send(ws, { type: "error", message: "Cannot target your own faction." });
            return;
          }
          if (actor.role === "POLICE" && t.role === "POLICE") {
            send(ws, { type: "error", message: "Cannot investigate fellow police." });
            return;
          }
        }
        if (Array.isArray(msg.action.extraTargets)) {
          for (const tid of msg.action.extraTargets) {
            const t = room.engine.state.players?.[tid];
            if (!t || !t.alive) {
              send(ws, { type: "error", message: "Invalid extra target." });
              return;
            }
          }
        }
        room.nightActions.set(seat.playerId, { ...msg.action, actorId: seat.playerId });
        const targetName =
          typeof msg.action.targetId === "number"
            ? room.engine.state.players?.[msg.action.targetId]?.name || null
            : null;
        const actorName = room.engine.state.players?.[seat.playerId]?.name || seat.name || `Player ${seat.playerId + 1}`;
        send(ws, {
          type: "acked",
          action: "night_action",
          actorName,
          role: room.engine.state.players?.[seat.playerId]?.role || null,
          targetId: msg.action.targetId,
          targetName,
        });
        // Notify alive allies with the same role about this action.
        {
          const actorPlayer = room.engine.state.players?.[seat.playerId];
          const actorRole = actorPlayer?.role;
          const actionLabelEn = msg.action.type.replace(/_/g, " ").toLowerCase();
          const actionZhMap = {
            "killer vote": "殺手投票", "police investigate": "警察調查",
            "doctor inject": "醫生注射", "sniper shot": "狙擊手射擊",
            "agent protect": "特務保護", "fiend protect": "天邪鬼吸收",
            "fiend shoot": "天邪鬼射擊", "terror bomb": "恐怖份子炸彈",
            "cowboy gamble": "牛仔賭命", "kidnap": "綁架",
            "zombie bite": "殭屍咬", "riot smoke": "鎮暴警察煙霧",
            "arson mark": "縱火犯標記", "arson ignite": "縱火犯點燃",
            "vine seed": "藤蔓惡魔播種", "nightmare attack": "夢魘惡魔攻擊",
            "exorcist strike": "驅魔師打擊", "necromancer curse": "死靈法師詛咒",
            "purify": "淨化", "grudge judge": "怨獸審判", "grudge kill vote": "怨獸殺戮投票",
          };
          const actionZh = actionZhMap[actionLabelEn] || actionLabelEn;
          const targetEn = targetName || "abstain";
          const targetZh = targetName || "棄權";
          const line = `[${actorName}] ${actionLabelEn} → ${targetEn}||[${actorName}] ${actionZh} → ${targetZh}`;

          // Only KILLER, POLICE, GRUDGE_BEAST share action logs with same-role allies.
          let chatArray = null;
          let privateLogChannel = null;
          let wsType = null;
          if (actorRole === "KILLER") {
            room.engine.state.killerChat = room.engine.state.killerChat || [];
            chatArray = room.engine.state.killerChat;
            privateLogChannel = "killer";
            wsType = "action_log_killer";
          } else if (actorRole === "POLICE") {
            room.engine.state.policeChat = room.engine.state.policeChat || [];
            chatArray = room.engine.state.policeChat;
            privateLogChannel = "police";
            wsType = "action_log_police";
          } else if (actorRole === "GRUDGE_BEAST") {
            room.engine.state.grudgeChat = room.engine.state.grudgeChat || [];
            chatArray = room.engine.state.grudgeChat;
            privateLogChannel = "grudge";
            wsType = "action_log_grudge";
          }

          if (chatArray) {
            chatArray.push(line);
            if (privateLogChannel) {
              room.engine.state.privateLogs[privateLogChannel] = room.engine.state.privateLogs[privateLogChannel] || [];
              room.engine.state.privateLogs[privateLogChannel].push(line);
            }
          }

          // Real-time push to all alive allies with the same role.
          if (wsType && actorRole) {
            for (const [otherWs, meta] of room.connections.entries()) {
              const pid = meta?.playerId;
              if (pid === undefined || pid === null) continue;
              const p = room.engine?.state?.players?.[pid];
              if (!p?.alive) continue;
              const shouldNotify = p.role === actorRole;
              if (shouldNotify) {
                send(otherWs, { type: wsType, text: line });
              }
            }
          }
        }
        break;
      }
      case "resolve_night": {
        if (!ensureHost(ws)) {
          send(ws, { type: "error", message: "Only host can resolve night." });
          return;
        }
        if (!room.engine || room.engine.state.phase !== "NIGHT") {
          send(ws, { type: "error", message: "Can only resolve during NIGHT." });
          return;
        }
        if (!room.started || !room.engine) return;
        const humanActions = Object.fromEntries(room.nightActions.entries());
        room.engine.resolveNight(null, { humanActions, includeHuman: false });
        room.nightActions.clear();
        clearTimer();
        broadcast({ type: "phase", phase: room.engine.state.phase, day: room.engine.state.dayNumber });
        broadcastViews();
        if (room.engine.state.phase !== Phase.END) scheduleDayToVote();
        scheduleRestartAfterVictory();
        break;
      }
      case "vote": {
        if (!room.started || !room.engine || room.engine.state.phase !== "VOTE") {
          send(ws, { type: "error", message: "Not in vote phase." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat || seat.spectator) return;
        const actor = room.engine.state.players[seat.playerId];
        if (!actor?.alive || (actor.role === "BRAT" && actor.status?.bratRevived)) {
          send(ws, { type: "error", message: "You cannot vote." });
          return;
        }
        if (msg.targetId === undefined || msg.targetId === null) {
          room.voteActions.delete(seat.playerId);
        } else {
          const target = room.engine.state.players?.[msg.targetId];
          if (!target || !target.alive) {
            send(ws, { type: "error", message: "Invalid vote target." });
            return;
          }
          room.voteActions.set(seat.playerId, msg.targetId);
        }
        if (typeof msg.lastWords === "string") {
          room.lastWords.set(seat.playerId, msg.lastWords);
        }
        const actorName = room.engine.state.players?.[seat.playerId]?.name || seat.name || `Player ${seat.playerId + 1}`;
        const targetName =
          msg.targetId !== undefined && msg.targetId !== null
            ? room.engine.state.players?.[msg.targetId]?.name || null
            : null;
        send(ws, {
          type: "acked",
          action: "vote",
          actorName,
          role: room.engine.state.players?.[seat.playerId]?.role || null,
          targetId: msg.targetId,
          targetName,
        });
        const logLine = `${actorName} vote -> ${targetName || "abstain"}`;
        broadcast({ type: "action_log", text: logLine });
        break;
      }
      case "resolve_vote": {
        if (!ensureHost(ws)) {
          send(ws, { type: "error", message: "Only host can resolve vote." });
          return;
        }
        if (!room.engine || room.engine.state.phase !== "VOTE") {
          send(ws, { type: "error", message: "Can only resolve during VOTE." });
          return;
        }
        if (!room.started || !room.engine) return;
        const humanVotes = Object.fromEntries(room.voteActions.entries());
        const lastWordsByPlayer = Object.fromEntries(room.lastWords.entries());
        room.engine.resolveVote(null, "", { humanVotes, lastWordsByPlayer, includeHuman: false });
        room.voteActions.clear();
        room.lastWords.clear();
        clearTimer();
        broadcast({ type: "phase", phase: room.engine.state.phase, day: room.engine.state.dayNumber });
        broadcastViews();
        if (room.engine.state.phase !== Phase.END) scheduleNightTimer();
        scheduleRestartAfterVictory();
        break;
      }
      case "last_words": {
        if (!room.started || !room.engine) {
          send(ws, { type: "error", message: "Game not started." });
          return;
        }
        if (room.engine.state.phase !== Phase.DAY && room.engine.state.phase !== Phase.VOTE) {
          send(ws, { type: "error", message: "Last words only during day." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat || seat.spectator) return;
        const player = room.engine.state.players[seat.playerId];
        if (!player || player.alive) {
          send(ws, { type: "error", message: "Only dead players can send last words." });
          return;
        }
        const text = (msg.text || "").trim();
        if (!text) {
          send(ws, { type: "error", message: "Empty last words." });
          return;
        }
        const ok = room.engine.submitLastWords(player.id, text);
        if (!ok) {
          send(ws, { type: "error", message: "Cannot accept last words (maybe already set or blocked)." });
          return;
        }
        send(ws, { type: "acked", action: "last_words" });
        broadcastViews();
        break;
      }
      case "chat": {
        if (!room.started || !room.engine || (room.engine.state.phase !== "DAY" && room.engine.state.phase !== "NIGHT")) {
          send(ws, { type: "error", message: "Chat only allowed in day or night discussion." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat || seat.spectator) return;
        const chatActor = room.engine.state.players?.[seat.playerId];
        if (!chatActor?.alive) {
          send(ws, { type: "error", message: "Dead players cannot use public chat." });
          return;
        }
        const text = (msg.text || "").trim();
        if (!text) return;
        const line = `${room.engine.state.players[seat.playerId]?.name || "Player"}: ${text.slice(0, 120)}`;
        room.engine.state.dayChat = room.engine.state.dayChat || [];
        room.engine.state.dayChat.push(line);
        room.engine.state.publicLog.push(line);
        broadcast({ type: "chat", line });
        break;
      }
      case "killer_chat": {
        if (!room.started || !room.engine || (room.engine.state.phase !== "DAY" && room.engine.state.phase !== "NIGHT")) {
          send(ws, { type: "error", message: "Killer chat only allowed in day or night." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat || seat.spectator) return;
        const actor = room.engine.state.players[seat.playerId];
        if (!actor?.alive || actor.role !== "KILLER") {
          send(ws, { type: "error", message: "Only alive killers can use killer chat." });
          return;
        }
        const text = (msg.text || "").trim();
        if (!text) return;
        const line = `${actor.name}: ${text.slice(0, 120)}`;
        room.engine.state.killerChat = room.engine.state.killerChat || [];
        room.engine.state.killerChat.push(line);
        room.engine.state.privateLogs.killer = room.engine.state.privateLogs.killer || [];
        room.engine.state.privateLogs.killer.push(line);
        broadcastViews();
        break;
      }
      case "spectator_chat": {
        const text = (msg.text || "").trim();
        if (!text) return;
        const meta = room.connections.get(ws) || {};
        const seat = room.connections.get(ws);
        const player =
          seat && seat.playerId !== undefined && seat.playerId !== null
            ? room.engine?.state?.players?.[seat.playerId]
            : null;
        const canChat = meta.spectator === true || (player && !player.alive);
        if (!canChat) {
          send(ws, { type: "error", message: "Only spectators or dead players can use spectator chat." });
          return;
        }
        const name = player?.name || meta.name || "Spectator";
        const line = `${name}: ${text.slice(0, 120)}`;
        room.spectatorChat.push(line);
        if (room.engine?.state) {
          room.engine.state.spectatorChat = room.spectatorChat;
        }
        broadcastViews();
        break;
      }
      case "police_chat": {
        if (!room.started || !room.engine || (room.engine.state.phase !== "DAY" && room.engine.state.phase !== "NIGHT")) {
          send(ws, { type: "error", message: "Police chat only allowed in day or night." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat || seat.spectator) return;
        const actor = room.engine.state.players[seat.playerId];
        if (!actor?.alive || actor.role !== "POLICE") {
          send(ws, { type: "error", message: "Only alive police can use police chat." });
          return;
        }
        const text = (msg.text || "").trim();
        if (!text) return;
        const line = `${actor.name}: ${text.slice(0, 120)}`;
        room.engine.state.policeChat = room.engine.state.policeChat || [];
        room.engine.state.policeChat.push(line);
        room.engine.state.privateLogs.police = room.engine.state.privateLogs.police || [];
        room.engine.state.privateLogs.police.push(line);
        broadcastViews();
        break;
      }
      case "grudge_chat": {
        if (!room.started || !room.engine || (room.engine.state.phase !== "DAY" && room.engine.state.phase !== "NIGHT")) {
          send(ws, { type: "error", message: "Grudge chat only allowed in day or night." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat || seat.spectator) return;
        const actor = room.engine.state.players[seat.playerId];
        if (!actor?.alive || actor.role !== "GRUDGE_BEAST") {
          send(ws, { type: "error", message: "Only alive grudge beasts can use grudge chat." });
          return;
        }
        const text = (msg.text || "").trim();
        if (!text) return;
        const line = `${actor.name}: ${text.slice(0, 120)}`;
        room.engine.state.grudgeChat = room.engine.state.grudgeChat || [];
        room.engine.state.grudgeChat.push(line);
        room.engine.state.privateLogs.grudge = room.engine.state.privateLogs.grudge || [];
        room.engine.state.privateLogs.grudge.push(line);
        broadcastViews();
        break;
      }
      case "restart": {
        if (!ensureHost(ws)) {
          send(ws, { type: "error", message: "Only host can restart." });
          return;
        }
        resetRoomState(false);
        scheduleLobbyBroadcast();
        break;
      }
      default:
        send(ws, { type: "error", message: "Unknown message type." });
    }
  });

  ws.on("close", () => {
    const seat = room.connections.get(ws);
    room.connections.delete(ws);
    if (seat && seat.playerId !== undefined) {
      const player = room.engine?.state?.players?.[seat.playerId];
      if (room.started && player) {
        player.isHuman = false; // AI takes over on disconnect
        if (!player.name.endsWith(" (AI)")) {
          player.name = `${player.name} (AI)`;
        }
        log("Player disconnected, AI taking over seat", seat.playerId, player.name);
      } else if (!room.started) {
        room.seats = room.seats.filter((s) => s.playerId !== seat.playerId);
        scheduleLobbyBroadcast();
      }
    }
    if (room.host === ws) {
      room.host = null;
      handleHostVacancy();
    }
    log("Connection closed", seat?.playerId ?? (seat?.spectator ? "spectator" : "?"));
  });
});

server.listen(PORT, () => {
  log(`Server listening on ${PORT}`);
});
