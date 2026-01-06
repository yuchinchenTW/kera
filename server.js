import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { GameEngine } from "./src/engine.js";
import { buildPlayerView, buildSpectatorView } from "./src/view.js";
import { Theme, Phase } from "./src/roles.js";

const PORT = process.env.PORT || 3001;
const MAX_PLAYERS = 18;

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
  const humanIds = room.seats.map((s) => s.playerId);
  room.theme = theme;
  room.engine = new GameEngine(Date.now(), theme, "hard", { humanIds });
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
  log("Auto-restart scheduled in 3s");
  room.restartHandle = setTimeout(() => {
    room.restartHandle = null;
    if (!room.engine) return;
    log("Auto-restart firing");
    startGame(themeToUse);
  }, 3000);
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
  broadcast({ type: "lobby", seats: room.seats });
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
  broadcast({ type: "lobby", seats: room.seats });
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
    broadcast({ type: "lobby", seats: room.seats });
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
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
          send(ws, { type: "error", message: "Game already started." });
          return;
        }
        if (wantsSpectator) {
          const name = makeUniqueName((msg.name || `Spectator`).slice(0, 32));
          const waitForStart = !!msg.waitForStart;
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
        broadcast({ type: "lobby", seats: room.seats });
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
        if (!msg.action || !msg.action.type) {
          room.nightActions.delete(seat.playerId);
          return;
        }
        room.nightActions.set(seat.playerId, { ...msg.action, actorId: seat.playerId });
        send(ws, { type: "acked", action: "night_action" });
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
          room.voteActions.set(seat.playerId, msg.targetId);
        }
        if (typeof msg.lastWords === "string") {
          room.lastWords.set(seat.playerId, msg.lastWords);
        }
        send(ws, { type: "acked", action: "vote" });
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
      case "chat": {
        if (!room.started || !room.engine || (room.engine.state.phase !== "DAY" && room.engine.state.phase !== "NIGHT")) {
          send(ws, { type: "error", message: "Chat only allowed in day or night discussion." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat || seat.spectator) return;
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
      case "restart": {
        if (!ensureHost(ws)) {
          send(ws, { type: "error", message: "Only host can restart." });
          return;
        }
        room.started = false;
        room.engine = null;
        room.nightActions.clear();
        room.voteActions.clear();
        room.lastWords.clear();
        broadcast({ type: "lobby", seats: room.seats });
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
        broadcast({ type: "lobby", seats: room.seats });
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
