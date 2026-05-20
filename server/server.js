// Marbles multiplayer server: static files + WebSocket lobby + game.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize as pathNormalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

import {
  MODES,
  validModes,
  createInitialState,
  legalMoves,
  applyMove,
  rollAndCompute,
} from "../public/shared/rules.js";

const __filename = fileURLToPath(import.meta.url);
const PUBLIC_DIR = resolve(__filename, "..", "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
};

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

// ---------- Rooms ----------

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not allocate room code");
}

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    adminToken: randomUUID(),
    adminName: null,
    phase: "lobby",
    players: [], // [{ name }]
    socketsByName: new Map(),
    preJoinSockets: new Set(),
    mode: null,
    gameState: null,
    pendingMoves: null,
    pendingMovesFor: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function deleteRoomIfEmpty(room) {
  if (room.socketsByName.size === 0 && room.preJoinSockets.size === 0 && room.players.length === 0) {
    rooms.delete(room.code);
  }
}

function findRoomBySocket(socket) {
  for (const room of rooms.values()) {
    if (room.preJoinSockets.has(socket)) return { room, name: null };
    for (const [name, s] of room.socketsByName) {
      if (s === socket) return { room, name };
    }
  }
  return null;
}

// ---------- Messaging ----------

function safeSend(socket, payload) {
  if (!socket || socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function sendError(socket, message) {
  safeSend(socket, { type: "error", message });
}

function lobbyStatePayload(room) {
  return {
    type: "lobbyState",
    code: room.code,
    players: room.players.map((p) => ({ name: p.name })),
    adminName: room.adminName,
    mode: room.mode,
    validModes: validModes(Math.max(2, room.players.length || 2)),
  };
}

function gameStatePayloadFor(room, recipientName) {
  const payload = { type: "gameState", state: room.gameState };
  if (
    room.pendingMoves &&
    room.pendingMovesFor &&
    room.pendingMovesFor === recipientName
  ) {
    payload.moves = room.pendingMoves;
    payload.movesFor = recipientName;
  }
  return payload;
}

function broadcastLobby(room) {
  const payload = lobbyStatePayload(room);
  for (const socket of room.socketsByName.values()) safeSend(socket, payload);
  for (const socket of room.preJoinSockets) safeSend(socket, payload);
}

function broadcastGame(room) {
  for (const [name, socket] of room.socketsByName) {
    safeSend(socket, gameStatePayloadFor(room, name));
  }
}

function broadcastRoomState(room) {
  if (room.phase === "lobby") broadcastLobby(room);
  else broadcastGame(room);
}

// ---------- Handlers ----------

function handleCreateRoom(socket) {
  const room = createRoom();
  room.preJoinSockets.add(socket);
  safeSend(socket, { type: "roomCreated", code: room.code, adminToken: room.adminToken });
}

function handleJoinRoom(socket, msg) {
  const code = typeof msg.code === "string" ? msg.code.toUpperCase().trim() : "";
  const rawName = typeof msg.name === "string" ? msg.name.trim() : "";
  const adminToken = typeof msg.adminToken === "string" ? msg.adminToken : null;

  if (!code) return sendError(socket, "Missing room code");
  if (!rawName) return sendError(socket, "Name required");
  if (rawName.length > 20) return sendError(socket, "Name too long");

  const room = rooms.get(code);
  if (!room) return sendError(socket, "Game not found");

  const name = rawName;
  // Detach the joining socket from any prior room slot to avoid duplicates.
  const previous = findRoomBySocket(socket);
  if (previous) {
    if (previous.room !== room) {
      previous.room.preJoinSockets.delete(socket);
      if (previous.name) previous.room.socketsByName.delete(previous.name);
      deleteRoomIfEmpty(previous.room);
    }
  }

  if (room.phase === "lobby") {
    const existing = room.players.find((p) => p.name === name);
    if (existing) {
      const liveSocket = room.socketsByName.get(name);
      if (liveSocket && liveSocket !== socket && liveSocket.readyState === liveSocket.OPEN) {
        return sendError(socket, "Name taken");
      }
      // Reclaim
    } else {
      if (room.players.length >= 6) return sendError(socket, "Lobby full");
      room.players.push({ name });
    }
  } else {
    // Playing phase: only existing players may rejoin.
    if (!room.gameState.playerNames.includes(name)) {
      return sendError(socket, "Game already started");
    }
  }

  // Admin claim
  let isAdmin = false;
  if (adminToken && adminToken === room.adminToken) {
    if (room.adminName === null || room.adminName === name) {
      room.adminName = name;
      isAdmin = true;
    } else if (room.adminName === name) {
      isAdmin = true;
    }
  } else if (room.adminName === name) {
    isAdmin = true;
  }

  // Attach socket
  room.preJoinSockets.delete(socket);
  // If they had a stale socket, replace it.
  const oldSocket = room.socketsByName.get(name);
  if (oldSocket && oldSocket !== socket) {
    try { oldSocket.close(); } catch { /* ignore */ }
  }
  room.socketsByName.set(name, socket);

  safeSend(socket, { type: "joinedRoom", code: room.code, name, isAdmin });

  if (room.phase === "lobby") {
    broadcastLobby(room);
  } else {
    broadcastGame(room);
  }
}

function handleLeaveRoom(socket) {
  const found = findRoomBySocket(socket);
  if (!found) return;
  const { room } = found;
  room.preJoinSockets.delete(socket);
  if (found.name) {
    if (room.phase === "lobby") {
      room.players = room.players.filter((p) => p.name !== found.name);
      if (room.adminName === found.name) room.adminName = null;
    }
    room.socketsByName.delete(found.name);
  }
  if (room.phase === "lobby") broadcastLobby(room);
  else broadcastGame(room);
  deleteRoomIfEmpty(room);
}

function handleSetMode(socket, msg) {
  const found = findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "lobby") return sendError(socket, "Game already started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can change mode");
  const allowed = validModes(Math.max(2, room.players.length || 2));
  if (!allowed.includes(msg.mode)) return sendError(socket, "Mode not valid for player count");
  room.mode = msg.mode;
  broadcastLobby(room);
}

function handleStartGame(socket) {
  const found = findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "lobby") return sendError(socket, "Game already started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can start");
  if (room.players.length < 2) return sendError(socket, "Need at least 2 players");

  const allowed = validModes(room.players.length);
  let mode = room.mode;
  if (!mode || !allowed.includes(mode)) mode = MODES.SINGLE;
  room.mode = mode;

  const playerNames = room.players.map((p) => p.name);
  room.gameState = createInitialState({
    playerCount: room.players.length,
    mode,
    playerNames,
  });
  room.phase = "playing";
  room.pendingMoves = null;
  room.pendingMovesFor = null;

  broadcastGame(room);
}

function handleRoll(socket) {
  const found = findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "playing" || !room.gameState) return sendError(socket, "Game not started");
  const state = room.gameState;
  if (state.gameOver) return sendError(socket, "Game over");
  const currentName = state.playerNames[state.currentPlayer];
  if (currentName !== name) return sendError(socket, "Not your turn");
  if (state.pendingRoll != null) return sendError(socket, "Already rolled");

  const dieValue = Math.floor(Math.random() * 6) + 1;
  const moves = rollAndCompute(state, dieValue);
  if (moves.length > 0) {
    room.pendingMoves = moves;
    room.pendingMovesFor = currentName;
  } else {
    room.pendingMoves = null;
    room.pendingMovesFor = null;
  }
  broadcastGame(room);
}

function handleSubmitMove(socket, msg) {
  const found = findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "playing" || !room.gameState) return sendError(socket, "Game not started");
  if (!room.pendingMoves || room.pendingMovesFor !== name) {
    return sendError(socket, "No pending move for you");
  }
  const moveIdx = Number(msg.moveIdx);
  if (!Number.isInteger(moveIdx) || moveIdx < 0 || moveIdx >= room.pendingMoves.length) {
    return sendError(socket, "Invalid move index");
  }
  const move = room.pendingMoves[moveIdx];
  // Re-validate against current state to be safe.
  const fresh = legalMoves(room.gameState, room.gameState.currentPlayer, room.gameState.pendingDieValue);
  const stillLegal = fresh.some(
    (m) =>
      m.marbleIdx === move.marbleIdx &&
      m.targetPlace === move.targetPlace &&
      (m.targetProgress ?? null) === (move.targetProgress ?? null) &&
      (m.targetFinish ?? null) === (move.targetFinish ?? null),
  );
  if (!stillLegal) return sendError(socket, "Move no longer legal");

  applyMove(room.gameState, move, room.gameState.pendingDieValue);
  room.pendingMoves = null;
  room.pendingMovesFor = null;
  broadcastGame(room);
}

// ---------- Message router ----------

function handleMessage(socket, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendError(socket, "Bad JSON");
  }
  if (!msg || typeof msg.type !== "string") return sendError(socket, "Bad message");

  switch (msg.type) {
    case "createRoom":  return handleCreateRoom(socket);
    case "joinRoom":    return handleJoinRoom(socket, msg);
    case "leaveRoom":   return handleLeaveRoom(socket);
    case "setMode":     return handleSetMode(socket, msg);
    case "startGame":   return handleStartGame(socket);
    case "roll":        return handleRoll(socket);
    case "submitMove":  return handleSubmitMove(socket, msg);
    default:
      return sendError(socket, `Unknown message type: ${msg.type}`);
  }
}

// ---------- Static file server ----------

async function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end("Bad URL");
    return;
  }
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

  // Resolve and prevent traversal.
  const requested = pathNormalize(join(PUBLIC_DIR, urlPath));
  if (!requested.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const data = await readFile(requested);
    const type = MIME[extname(requested)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404).end("Not found");
    } else {
      console.error("Static serve error", err);
      res.writeHead(500).end("Server error");
    }
  }
}

// ---------- Boot ----------

const PORT = Number(process.env.PORT) || 3000;
const httpServer = http.createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (socket) => {
  socket.on("message", (data) => handleMessage(socket, data.toString()));
  socket.on("close", () => {
    const found = findRoomBySocket(socket);
    if (!found) return;
    const { room } = found;
    room.preJoinSockets.delete(socket);
    if (found.name) {
      // Only drop the socket reference if it matches; don't kick the player.
      const current = room.socketsByName.get(found.name);
      if (current === socket) room.socketsByName.delete(found.name);
    }
    deleteRoomIfEmpty(room);
  });
  socket.on("error", (err) => {
    console.warn("socket error", err.message);
  });
});

// Periodic GC: drop empty rooms older than 1h.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const live = room.socketsByName.size + room.preJoinSockets.size;
    if (live === 0 && now - room.createdAt > 60 * 60 * 1000) {
      rooms.delete(room.code);
    }
  }
}, 5 * 60 * 1000).unref();

httpServer.listen(PORT, () => {
  console.log(`Marbles server listening on http://localhost:${PORT}`);
});
