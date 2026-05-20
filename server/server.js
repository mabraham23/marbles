// Marbles multiplayer server: static files + WebSocket lobby + game.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize as pathNormalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

import {
  MODES,
  validModes,
  createInitialState,
  legalMoves,
  applyMove,
  rollAndCompute,
} from "../public/shared/rules.js";

import { roomStore } from "./storage.js";
import {
  EMPTY_ROOM_TTL_MS,
  ROOM_GC_INTERVAL_MS,
  roomShouldExpire,
} from "./room-lifecycle.js";

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

// ---------- In-Memory Connections ----------
// WebSocket handles are transient and cannot be serialized to Redis.
// We map roomCode -> { socketsByName: Map, preJoinSockets: Set }
const roomConnections = new Map();
const roomJoinQueues = new Map();

function getConnections(code) {
  let conn = roomConnections.get(code);
  if (!conn) {
    conn = { socketsByName: new Map(), preJoinSockets: new Set() };
    roomConnections.set(code, conn);
  }
  return conn;
}

function deleteConnections(code) {
  roomConnections.delete(code);
}

async function deleteRoomEverywhere(code) {
  const conn = getConnections(code);
  for (const socket of [...conn.socketsByName.values(), ...conn.preJoinSockets]) {
    try { socket.close(); } catch { /* ignore */ }
  }
  await roomStore.delete(code);
  deleteConnections(code);
  roomJoinQueues.delete(code);
}

async function withRoomJoinQueue(code, task) {
  const previous = roomJoinQueues.get(code) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  roomJoinQueues.set(code, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (roomJoinQueues.get(code) === tail) roomJoinQueues.delete(code);
  }
}

// ---------- Rooms ----------

function makeCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

async function createRoom() {
  let code = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const testCode = makeCode();
    const existing = await roomStore.get(testCode);
    if (!existing) {
      code = testCode;
      break;
    }
  }
  if (!code) throw new Error("Could not allocate room code");

  const room = {
    code,
    adminToken: randomUUID(),
    adminName: null,
    phase: "lobby",
    players: [], // [{ name }]
    mode: null,
    gameState: null,
    pendingMoves: null,
    pendingMovesFor: null,
    createdAt: Date.now(),
    lastMoveAt: null,
    completedAt: null,
  };

  await roomStore.set(code, room);
  getConnections(code); // Pre-warm connection pool
  return room;
}

async function deleteRoomIfEmpty(room) {
  const conn = getConnections(room.code);
  if (conn.socketsByName.size === 0 && conn.preJoinSockets.size === 0 && room.players.length === 0) {
    await deleteRoomEverywhere(room.code);
  }
}

async function findRoomBySocket(socket) {
  if (!socket.roomCode) return null;
  const room = await roomStore.get(socket.roomCode);
  if (!room) return null;
  return { room, name: socket.playerName || null };
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

async function broadcastLobby(room) {
  const payload = lobbyStatePayload(room);
  const conn = getConnections(room.code);
  for (const socket of conn.socketsByName.values()) safeSend(socket, payload);
  for (const socket of conn.preJoinSockets) safeSend(socket, payload);
}

async function broadcastGame(room) {
  const conn = getConnections(room.code);
  for (const [name, socket] of conn.socketsByName) {
    safeSend(socket, gameStatePayloadFor(room, name));
  }
}

// ---------- Handlers ----------

async function handleCreateRoom(socket) {
  try {
    const room = await createRoom();
    const conn = getConnections(room.code);
    conn.preJoinSockets.add(socket);
    socket.roomCode = room.code;
    socket.playerName = null;
    safeSend(socket, { type: "roomCreated", code: room.code, adminToken: room.adminToken });
  } catch (err) {
    console.error("Error creating room:", err);
    sendError(socket, "Could not create room");
  }
}

async function handleJoinRoom(socket, msg) {
  const code = typeof msg.code === "string" ? msg.code.toUpperCase().trim() : "";
  const rawName = typeof msg.name === "string" ? msg.name.trim() : "";
  const adminToken = typeof msg.adminToken === "string" ? msg.adminToken : null;

  if (!code) return sendError(socket, "Missing room code");
  if (!rawName) return sendError(socket, "Name required");
  if (rawName.length > 20) return sendError(socket, "Name too long");

  const name = rawName;

  return withRoomJoinQueue(code, async () => {
    const room = await roomStore.get(code);
    if (!room) return sendError(socket, "Game not found");

    const conn = getConnections(code);

    // Detach the joining socket from any prior room slot to avoid duplicates.
    const previous = await findRoomBySocket(socket);
    if (previous) {
      if (previous.room.code !== code) {
        const prevConn = getConnections(previous.room.code);
        prevConn.preJoinSockets.delete(socket);
        if (previous.name) prevConn.socketsByName.delete(previous.name);
        await deleteRoomIfEmpty(previous.room);
      }
    }

    if (room.phase === "lobby") {
      const existing = room.players.find((p) => p.name === name);
      if (existing) {
        const liveSocket = conn.socketsByName.get(name);
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

    // Attach socket properties
    socket.roomCode = code;
    socket.playerName = name;

    conn.preJoinSockets.delete(socket);
    // If they had a stale socket, replace it.
    const oldSocket = conn.socketsByName.get(name);
    if (oldSocket && oldSocket !== socket) {
      try { oldSocket.close(); } catch { /* ignore */ }
    }
    conn.socketsByName.set(name, socket);

    await roomStore.set(code, room);

    safeSend(socket, { type: "joinedRoom", code: room.code, name, isAdmin });
    safeSend(socket, { type: "chatHistory", chat: room.chat || [] });

    if (room.phase === "lobby") {
      await broadcastLobby(room);
    } else {
      await broadcastGame(room);
    }
  });
}

async function handleLeaveRoom(socket) {
  const found = await findRoomBySocket(socket);
  if (!found) return;
  const { room, name } = found;
  const conn = getConnections(room.code);

  conn.preJoinSockets.delete(socket);
  if (name) {
    if (room.phase === "lobby") {
      room.players = room.players.filter((p) => p.name !== name);
      if (room.adminName === name) room.adminName = null;
    }
    conn.socketsByName.delete(name);
  }

  socket.roomCode = null;
  socket.playerName = null;

  await roomStore.set(room.code, room);

  if (room.phase === "lobby") await broadcastLobby(room);
  else await broadcastGame(room);
  await deleteRoomIfEmpty(room);
}

async function handleSetMode(socket, msg) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "lobby") return sendError(socket, "Game already started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can change mode");
  const allowed = validModes(Math.max(2, room.players.length || 2));
  if (!allowed.includes(msg.mode)) return sendError(socket, "Mode not valid for player count");
  room.mode = msg.mode;

  await roomStore.set(room.code, room);
  await broadcastLobby(room);
}

async function handleStartGame(socket) {
  const found = await findRoomBySocket(socket);
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
  room.lastMoveAt = Date.now();
  room.completedAt = null;

  await roomStore.set(room.code, room);
  await broadcastGame(room);
}

function makeFreshGameState(room) {
  const sourceNames = room.gameState?.playerNames?.length
    ? room.gameState.playerNames
    : room.players.map((p) => p.name);
  const playerNames = sourceNames.slice();
  const playerCount = playerNames.length;
  const allowed = validModes(playerCount);
  let mode = room.gameState?.mode || room.mode;
  if (!mode || !allowed.includes(mode)) mode = MODES.SINGLE;
  room.mode = mode;
  return createInitialState({ playerCount, mode, playerNames });
}

async function handleResetGame(socket) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "playing" || !room.gameState) return sendError(socket, "Game not started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can reset");

  room.gameState = makeFreshGameState(room);
  room.phase = "playing";
  room.pendingMoves = null;
  room.pendingMovesFor = null;
  room.lastMoveAt = Date.now();
  room.completedAt = null;

  await roomStore.set(room.code, room);
  await broadcastGame(room);
}

async function handleEndGame(socket) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "playing") return sendError(socket, "Game not started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can end the game");

  const names = room.gameState?.playerNames || room.players.map((p) => p.name);
  room.players = names.map((playerName) => ({ name: playerName }));
  room.phase = "lobby";
  room.gameState = null;
  room.pendingMoves = null;
  room.pendingMovesFor = null;
  room.lastMoveAt = null;
  room.completedAt = null;

  await roomStore.set(room.code, room);
  await broadcastLobby(room);
}

async function handleRoll(socket) {
  const found = await findRoomBySocket(socket);
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
  room.lastMoveAt = Date.now();
  if (state.gameOver && !room.completedAt) room.completedAt = room.lastMoveAt;

  await roomStore.set(room.code, room);
  await broadcastGame(room);
}

async function handleSubmitMove(socket, msg) {
  const found = await findRoomBySocket(socket);
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
  room.lastMoveAt = Date.now();
  if (room.gameState.gameOver) room.completedAt = room.lastMoveAt;
  room.pendingMoves = null;
  room.pendingMovesFor = null;

  await roomStore.set(room.code, room);
  await broadcastGame(room);
}

async function handleChat(socket, msg) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const room = found.room;
  const name = found.name;

  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!text) return sendError(socket, "Message is empty");
  if (text.length > 150) return sendError(socket, "Message too long");

  room.chat = room.chat || [];
  room.chat.push({
    sender: name,
    text,
    timestamp: Date.now(),
  });

  if (room.chat.length > 50) {
    room.chat.shift();
  }

  await roomStore.set(room.code, room);

  // Broadcast to all sockets in this room
  const conn = getConnections(room.code);
  const payload = {
    type: "chatHistory",
    chat: room.chat,
  };
  for (const s of conn.socketsByName.values()) safeSend(s, payload);
  for (const s of conn.preJoinSockets) safeSend(s, payload);
}

// ---------- Message router ----------

async function handleMessage(socket, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendError(socket, "Bad JSON");
  }
  if (!msg || typeof msg.type !== "string") return sendError(socket, "Bad message");

  try {
    switch (msg.type) {
      case "createRoom":  return await handleCreateRoom(socket);
      case "joinRoom":    return await handleJoinRoom(socket, msg);
      case "leaveRoom":   return await handleLeaveRoom(socket);
      case "setMode":     return await handleSetMode(socket, msg);
      case "startGame":   return await handleStartGame(socket);
      case "resetGame":   return await handleResetGame(socket);
      case "endGame":     return await handleEndGame(socket);
      case "roll":        return await handleRoll(socket);
      case "submitMove":  return await handleSubmitMove(socket, msg);
      case "chat":        return await handleChat(socket, msg);
      default:
        return sendError(socket, `Unknown message type: ${msg.type}`);
    }
  } catch (err) {
    console.error(`Error processing action ${msg.type}:`, err);
    sendError(socket, "Internal server error");
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

// WebSocket-level heartbeat. Pinging every 25s keeps the connection warm.
const HEARTBEAT_INTERVAL_MS = 25_000;

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("message", (data) => handleMessage(socket, data.toString()));
  socket.on("close", async () => {
    const found = await findRoomBySocket(socket);
    if (!found) return;
    const { room } = found;
    const conn = getConnections(room.code);
    conn.preJoinSockets.delete(socket);
    if (found.name) {
      // Only drop the socket reference if it matches; don't kick the player.
      const current = conn.socketsByName.get(found.name);
      if (current === socket) conn.socketsByName.delete(found.name);
    }
    await deleteRoomIfEmpty(room);
  });
  socket.on("error", (err) => {
    console.warn("socket error", err.message);
  });
});

// Sweep dead sockets.
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      try { socket.terminate(); } catch { /* ignore */ }
      return;
    }
    socket.isAlive = false;
    try { socket.ping(); } catch { /* ignore */ }
  });
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref();
wss.on("close", () => clearInterval(heartbeatTimer));

// Periodic GC: delete completed games, inactive games, and abandoned empty rooms.
setInterval(async () => {
  try {
    const now = Date.now();
    const rooms = await roomStore.list();
    for (const room of rooms) {
      const conn = getConnections(room.code);
      const live = conn.socketsByName.size + conn.preJoinSockets.size;
      if (
        roomShouldExpire(room, now) ||
        (live === 0 && now - room.createdAt > EMPTY_ROOM_TTL_MS)
      ) {
        await deleteRoomEverywhere(room.code);
      }
    }
  } catch (err) {
    console.error("Error in GC interval:", err);
  }
}, ROOM_GC_INTERVAL_MS).unref();

httpServer.listen(PORT, () => {
  console.log(`Marbles server listening on http://localhost:${PORT}`);
});
