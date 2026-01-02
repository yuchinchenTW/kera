import http from "node:http";
import { WebSocketServer } from "ws";
import { GameEngine } from "./src/engine.js";
import { buildPlayerView } from "./src/view.js";
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
};

const DURATIONS = {
  night: 30000,
  day: 20000,
  vote: 20000,
};

function log(...args) {
  console.log("[server]", ...args);
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

function broadcastViews() {
  if (!room.engine) return;
  for (const [ws, seat] of room.connections.entries()) {
    const view = buildPlayerView(room.engine.state, seat.playerId);
    send(ws, { type: "view", view });
  }
}

function startGame(theme = Theme.GOOD_VS_EVIL.id) {
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
  });
}

function ensureHost(ws) {
  return ws === room.host;
}

const server = http.createServer();
const wss = new WebSocketServer({ server });

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
        if (room.started) {
          send(ws, { type: "error", message: "Game already started." });
          return;
        }
        const seatId = nextSeatId();
        if (seatId === null) {
          send(ws, { type: "error", message: "Room is full." });
          return;
        }
        const name = (msg.name || `Player ${seatId + 1}`).slice(0, 32);
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
        if (!seat) return;
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
        if (!room.started || !room.engine) return;
        const humanActions = Object.fromEntries(room.nightActions.entries());
        room.engine.resolveNight(null, { humanActions, includeHuman: false });
        room.nightActions.clear();
        clearTimer();
        broadcast({ type: "phase", phase: room.engine.state.phase, day: room.engine.state.dayNumber });
        broadcastViews();
        if (room.engine.state.phase !== Phase.END) scheduleDayToVote();
        break;
      }
      case "vote": {
        if (!room.started || !room.engine || room.engine.state.phase !== "VOTE") {
          send(ws, { type: "error", message: "Not in vote phase." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat) return;
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
        break;
      }
      case "chat": {
        if (!room.started || !room.engine || room.engine.state.phase !== "DAY") {
          send(ws, { type: "error", message: "Chat only allowed in day discussion." });
          return;
        }
        const seat = room.connections.get(ws);
        if (!seat) return;
        const text = (msg.text || "").trim();
        if (!text) return;
        const line = `${room.engine.state.players[seat.playerId]?.name || "Player"}: ${text.slice(0, 120)}`;
        room.engine.state.dayChat = room.engine.state.dayChat || [];
        room.engine.state.dayChat.push(line);
        room.engine.state.publicLog.push(line);
        broadcast({ type: "chat", line });
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
    if (seat && !room.started) {
      room.seats = room.seats.filter((s) => s.playerId !== seat.playerId);
      broadcast({ type: "lobby", seats: room.seats });
    }
        if (room.host === ws) {
          room.host = room.connections.keys().next().value || null;
          if (room.host) send(room.host, { type: "host", value: true });
        }
        log("Connection closed", seat?.playerId ?? "?");
      });
    });

server.listen(PORT, () => {
  log(`Server listening on ${PORT}`);
});
