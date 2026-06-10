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
  assignSeats,
  validModes,
  createInitialState,
} from "../public/shared/rules.js";

import { roomStore } from "./storage.js";
import {
  EMPTY_ROOM_TTL_MS,
  ROOM_GC_INTERVAL_MS,
  roomShouldExpire,
} from "./room-lifecycle.js";
import {
  DEFAULT_TURN_TIME_LIMIT_SECONDS,
  TURN_TIMEOUT_SWEEP_MS,
  continueDelayedNoMoveRoll,
  continueTimedOutAutoPlay,
  normalizeTurnTimeLimit,
  rollForCurrentPlayer,
  submitPendingMoveForRoom,
  turnTimeLimitForRoom,
} from "./turn-timeout.js";

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

const MAX_ENTRY_FEE = 10_000;
const HANDLE_RE = /^[a-zA-Z0-9._-]{2,30}$/;

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function normalizeEntryFee(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  // Snap to cents and clamp.
  const cents = Math.round(num * 100);
  if (cents <= 0 || cents > MAX_ENTRY_FEE * 100) return null;
  return cents / 100;
}

function normalizeHandle(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) return null;
  if (!HANDLE_RE.test(trimmed)) return null;
  return trimmed;
}

// ---------- In-Memory Connections ----------
// WebSocket handles are transient and cannot be serialized to Redis.
// We map roomCode -> { socketsByName: Map, preJoinSockets: Set }
const roomConnections = new Map();
const roomJoinQueues = new Map();

function getConnections(code) {
  let conn = roomConnections.get(code);
  if (!conn) {
    conn = { socketsByName: new Map(), preJoinSockets: new Set(), voiceParticipants: new Set() };
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

async function createRoom(opts = {}) {
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
    pendingMoveDeadlineAt: null,
    noMoveAdvanceAt: null,
    timedOutAutoPlayer: null,
    turnTimeLimitSeconds: DEFAULT_TURN_TIME_LIMIT_SECONDS,
    entryFee: opts.entryFee ?? null,
    playerHandles: {}, // { [playerName]: { venmo } }
    settlement: null,
    createdAt: Date.now(),
    lastMoveAt: null,
    completedAt: null,
  };

  await roomStore.set(code, room);
  getConnections(code); // Pre-warm connection pool
  return room;
}

async function deleteRoomIfEmpty(room) {
  const conn = pruneRoomConnections(room.code);
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

function pruneRoomConnections(code) {
  const conn = getConnections(code);
  for (const socket of [...conn.preJoinSockets]) {
    if (!socket || socket.readyState === socket.CLOSED || socket.readyState === socket.CLOSING) {
      conn.preJoinSockets.delete(socket);
    }
  }
  for (const [name, socket] of [...conn.socketsByName]) {
    if (!socket || socket.readyState === socket.CLOSED || socket.readyState === socket.CLOSING) {
      conn.socketsByName.delete(name);
    }
  }
  return conn;
}

function sendError(socket, message) {
  safeSend(socket, { type: "error", message });
}

function lobbyStatePayload(room) {
  return {
    type: "lobbyState",
    code: room.code,
    players: room.players.map((p) => ({ name: p.name, isBot: !!p.isBot })),
    adminName: room.adminName,
    mode: room.mode,
    validModes: validModes(Math.max(2, room.players.length || 2)),
    entryFee: room.entryFee ?? null,
    turnTimeLimitSeconds: turnTimeLimitForRoom(room),
    playerHandles: room.playerHandles || {},
    settlement: room.settlement || null,
  };
}

function teamStagingStatePayload(room) {
  return {
    type: "teamStagingState",
    code: room.code,
    players: room.players.map((p) => ({ name: p.name, isBot: !!p.isBot })),
    adminName: room.adminName,
    mode: room.mode,
    entryFee: room.entryFee ?? null,
    turnTimeLimitSeconds: turnTimeLimitForRoom(room),
    playerHandles: room.playerHandles || {},
  };
}

function gameStatePayloadFor(room, recipientName) {
  const payload = {
    type: "gameState",
    state: room.gameState,
    turnTimeLimitSeconds: turnTimeLimitForRoom(room),
    pendingMoveDeadlineAt: room.pendingMoveDeadlineAt ?? null,
  };
  if (
    room.pendingMoves &&
    room.pendingMovesFor &&
    room.pendingMovesFor === recipientName
  ) {
    payload.moves = room.pendingMoves;
    payload.movesFor = recipientName;
  }
  if (room.entryFee) payload.entryFee = room.entryFee;
  if (room.playerHandles) payload.playerHandles = room.playerHandles;
  if (room.settlement) payload.settlement = room.settlement;
  const botNames = room.players.filter((p) => p.isBot).map((p) => p.name);
  if (botNames.length) payload.botNames = botNames;
  return payload;
}

async function broadcastLobby(room) {
  const payload = lobbyStatePayload(room);
  const conn = pruneRoomConnections(room.code);
  for (const socket of conn.socketsByName.values()) safeSend(socket, payload);
  for (const socket of conn.preJoinSockets) safeSend(socket, payload);
}

async function broadcastTeamStaging(room) {
  const payload = teamStagingStatePayload(room);
  const conn = pruneRoomConnections(room.code);
  for (const socket of conn.socketsByName.values()) safeSend(socket, payload);
}

async function broadcastGame(room) {
  const conn = pruneRoomConnections(room.code);
  for (const [name, socket] of conn.socketsByName) {
    safeSend(socket, gameStatePayloadFor(room, name));
  }
}

// ---------- Handlers ----------

async function handleCreateRoom(socket, msg) {
  try {
    const entryFee = msg ? normalizeEntryFee(msg.entryFee) : null;
    const room = await createRoom({ entryFee });
    const conn = getConnections(room.code);
    conn.preJoinSockets.add(socket);
    socket.roomCode = room.code;
    socket.playerName = null;
    safeSend(socket, {
      type: "roomCreated",
      code: room.code,
      adminToken: room.adminToken,
      entryFee: room.entryFee,
    });
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

    // If room has an entry fee, accept handle on join. We only require it
    // when the player is newly joining a paid room and doesn't already have
    // one on file from a prior join.
    const incomingHandle = normalizeHandle(msg.venmoHandle);
    if (room.entryFee) {
      const alreadyHasHandle = Boolean(room.playerHandles?.[name]?.venmo);
      if (!incomingHandle && !alreadyHasHandle) {
        return sendError(socket, "needHandle:Venmo handle required for this room");
      }
    }

    const existing = room.players.find((p) => p.name === name);
    if (room.phase === "lobby") {
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
    } else if (room.phase === "staging") {
      if (!existing) return sendError(socket, "Team review already started");
      const liveSocket = conn.socketsByName.get(name);
      if (liveSocket && liveSocket !== socket && liveSocket.readyState === liveSocket.OPEN) {
        return sendError(socket, "Name taken");
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

    // Stash/refresh the player's payment handle if they supplied one.
    if (incomingHandle) {
      room.playerHandles = room.playerHandles || {};
      room.playerHandles[name] = { ...(room.playerHandles[name] || {}), venmo: incomingHandle };
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
    } else if (room.phase === "staging") {
      await broadcastTeamStaging(room);
    } else {
      await broadcastGame(room);
    }
  });
}

async function handleSyncRoom(socket) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase === "lobby") {
    safeSend(socket, lobbyStatePayload(room));
    return;
  }
  if (room.phase === "staging") {
    safeSend(socket, teamStagingStatePayload(room));
    return;
  }
  if (room.phase === "playing" && room.gameState) {
    safeSend(socket, gameStatePayloadFor(room, name));
  }
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
  else if (room.phase === "staging") await broadcastTeamStaging(room);
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

async function handleSetTurnTimeLimit(socket, msg) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "lobby") return sendError(socket, "Game already started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can change time limit");
  const seconds = normalizeTurnTimeLimit(msg.seconds);
  if (seconds === null) return sendError(socket, "Invalid time limit");
  room.turnTimeLimitSeconds = seconds;

  await roomStore.set(room.code, room);
  await broadcastLobby(room);
}

async function handleSetEntryFee(socket, msg) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "lobby") return sendError(socket, "Game already started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can change the entry fee");
  const fee = normalizeEntryFee(msg.entryFee);
  if (fee && room.players.some((p) => p.isBot)) {
    return sendError(socket, "Remove computer players to set an entry fee");
  }
  // null clears the fee (free game); a positive number sets the buy-in.
  room.entryFee = fee;

  await roomStore.set(room.code, room);
  await broadcastLobby(room);
}

function nextBotName(room) {
  const taken = new Set(room.players.map((p) => p.name));
  for (let i = 1; i <= 12; i += 1) {
    const candidate = `Computer ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

async function handleAddBot(socket) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "lobby") return sendError(socket, "Game already started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can add a computer player");
  if (room.players.length >= 6) return sendError(socket, "Lobby full");
  if (room.entryFee) return sendError(socket, "Clear the entry fee to add computer players");
  const botName = nextBotName(room);
  if (!botName) return sendError(socket, "Could not add computer player");
  room.players.push({ name: botName, isBot: true });
  await roomStore.set(room.code, room);
  await broadcastLobby(room);
}

async function handleRemoveBot(socket, msg) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "lobby") return sendError(socket, "Game already started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can remove a computer player");
  const target = typeof msg.botName === "string" ? msg.botName : null;
  const idx = room.players.findIndex((p) => p.isBot && (target ? p.name === target : true));
  // With no name, remove the last bot added (most recent).
  const removeIdx = target ? idx : [...room.players].map((p, i) => (p.isBot ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  if (removeIdx < 0) return sendError(socket, "No computer player to remove");
  const [removed] = room.players.splice(removeIdx, 1);
  if (removed && room.playerHandles) delete room.playerHandles[removed.name];
  await roomStore.set(room.code, room);
  await broadcastLobby(room);
}

async function handleStartGame(socket) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "lobby" && room.phase !== "staging") return sendError(socket, "Game already started");
  if (room.adminName !== name) return sendError(socket, "Only the admin can start");
  if (room.players.length < 2) return sendError(socket, "Need at least 2 players");
  if (room.entryFee) {
    // Computer players don't pay in, so they don't need a Venmo handle.
    const missing = room.players.filter((p) => !p.isBot && !room.playerHandles?.[p.name]?.venmo);
    if (missing.length) {
      return sendError(socket, `Need Venmo handle for: ${missing.map((p) => p.name).join(", ")}`);
    }
  }

  const allowed = validModes(room.players.length);
  let mode = room.mode;
  if (!mode || !allowed.includes(mode)) mode = MODES.SINGLE;
  room.mode = mode;

  const teamMode = Boolean(assignSeats(room.players.length, mode).teams);
  if (room.phase === "lobby" && teamMode) {
    room.phase = "staging";
    room.gameState = null;
    room.pendingMoves = null;
    room.pendingMovesFor = null;
    room.pendingMoveDeadlineAt = null;
    room.noMoveAdvanceAt = null;
    room.timedOutAutoPlayer = null;
    room.lastMoveAt = null;
    room.completedAt = null;

    await roomStore.set(room.code, room);
    await broadcastTeamStaging(room);
    return;
  }

  const playerNames = room.players.map((p) => p.name);
  room.gameState = createInitialState({
    playerCount: room.players.length,
    mode,
    playerNames,
  });
  room.phase = "playing";
  room.pendingMoves = null;
  room.pendingMovesFor = null;
  room.pendingMoveDeadlineAt = null;
  room.noMoveAdvanceAt = null;
  room.timedOutAutoPlayer = null;
  room.settlement = null;
  room.lastMoveAt = Date.now();
  room.completedAt = null;

  await roomStore.set(room.code, room);
  await broadcastGame(room);
}

async function handleReturnToLobby(socket) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (room.phase !== "staging") return sendError(socket, "Team review is not active");
  if (room.adminName !== name) return sendError(socket, "Only the admin can return to lobby");

  room.phase = "lobby";
  room.gameState = null;
  room.pendingMoves = null;
  room.pendingMovesFor = null;
  room.pendingMoveDeadlineAt = null;
  room.noMoveAdvanceAt = null;
  room.timedOutAutoPlayer = null;
  room.lastMoveAt = null;
  room.completedAt = null;

  await roomStore.set(room.code, room);
  await broadcastLobby(room);
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
  room.pendingMoveDeadlineAt = null;
  room.noMoveAdvanceAt = null;
  room.timedOutAutoPlayer = null;
  room.settlement = null;
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
  room.pendingMoveDeadlineAt = null;
  room.noMoveAdvanceAt = null;
  room.timedOutAutoPlayer = null;
  // Keep room.settlement so an unsettled payout list survives back-to-lobby.
  // Cleared on the next startGame/resetGame.
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
  if (state.noMoveRoll?.shouldAdvance) return sendError(socket, "No-move roll is resolving");

  rollForCurrentPlayer(room, rollDie(), Date.now());

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
  const submitted = submitPendingMoveForRoom(room, moveIdx, Date.now());
  if (!submitted.ok) return sendError(socket, submitted.error);
  room.timedOutAutoPlayer = null;

  await roomStore.set(room.code, room);
  await broadcastGame(room);
}

async function handleUpdateHandle(socket, msg) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  const handle = normalizeHandle(msg.venmoHandle);
  if (!handle) return sendError(socket, "Invalid Venmo handle");
  room.playerHandles = room.playerHandles || {};
  room.playerHandles[name] = { ...(room.playerHandles[name] || {}), venmo: handle };
  await roomStore.set(room.code, room);
  if (room.phase === "lobby") await broadcastLobby(room);
  else if (room.phase === "staging") await broadcastTeamStaging(room);
  else await broadcastGame(room);
}

async function handleMarkSent(socket, msg) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (!room.settlement) return sendError(socket, "No settlement to update");
  const idx = Number(msg.transferIndex);
  const transfer = room.settlement.transfers[idx];
  if (!transfer) return sendError(socket, "Invalid transfer");
  if (transfer.from !== name) return sendError(socket, "Only the sender can mark sent");
  transfer.sentAt = msg.sent === false ? null : Date.now();
  await roomStore.set(room.code, room);
  await broadcastGame(room);
}

async function handleMarkReceived(socket, msg) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const { room, name } = found;
  if (!room.settlement) return sendError(socket, "No settlement to update");
  const idx = Number(msg.transferIndex);
  const transfer = room.settlement.transfers[idx];
  if (!transfer) return sendError(socket, "Invalid transfer");
  if (transfer.to !== name) return sendError(socket, "Only the recipient can mark received");
  transfer.receivedAt = msg.received === false ? null : Date.now();
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

// ---------- Voice chat (WebRTC mesh signaling) ----------
// Voice membership is ephemeral and lives only in the in-memory connection
// pool — never persisted to Redis. The server only relays signaling; audio
// flows peer-to-peer between browsers.

async function handleVoiceJoin(socket) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return sendError(socket, "Not in a room");
  const conn = getConnections(found.room.code);
  const name = found.name;

  // Tell the joiner who is already in voice so it can open connections to them.
  const peers = [...conn.voiceParticipants].filter((n) => n !== name);
  safeSend(socket, { type: "voicePeers", peers });

  conn.voiceParticipants.add(name);

  // Tell everyone else that this player joined voice.
  for (const [peerName, s] of conn.socketsByName) {
    if (peerName !== name) safeSend(s, { type: "voicePeerJoined", name });
  }
}

async function handleVoiceLeave(socket) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return;
  const conn = getConnections(found.room.code);
  const name = found.name;
  if (!conn.voiceParticipants.delete(name)) return;
  for (const [peerName, s] of conn.socketsByName) {
    if (peerName !== name) safeSend(s, { type: "voicePeerLeft", name });
  }
}

async function handleVoiceSignal(socket, msg) {
  const found = await findRoomBySocket(socket);
  if (!found || !found.name) return;
  if (typeof msg.to !== "string") return;
  const conn = getConnections(found.room.code);
  const target = conn.socketsByName.get(msg.to);
  if (!target) return;
  // Relay the opaque WebRTC payload to the single named peer.
  safeSend(target, { type: "voiceSignal", from: found.name, data: msg.data });
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
      case "createRoom":     return await handleCreateRoom(socket, msg);
      case "joinRoom":       return await handleJoinRoom(socket, msg);
      case "syncRoom":       return await handleSyncRoom(socket);
      case "leaveRoom":      return await handleLeaveRoom(socket);
      case "setMode":        return await handleSetMode(socket, msg);
      case "setTurnTimeLimit": return await handleSetTurnTimeLimit(socket, msg);
      case "setEntryFee":    return await handleSetEntryFee(socket, msg);
      case "addBot":         return await handleAddBot(socket);
      case "removeBot":      return await handleRemoveBot(socket, msg);
      case "startGame":      return await handleStartGame(socket);
      case "returnToLobby":   return await handleReturnToLobby(socket);
      case "resetGame":      return await handleResetGame(socket);
      case "endGame":        return await handleEndGame(socket);
      case "roll":           return await handleRoll(socket);
      case "submitMove":     return await handleSubmitMove(socket, msg);
      case "updateHandle":   return await handleUpdateHandle(socket, msg);
      case "markSent":       return await handleMarkSent(socket, msg);
      case "markReceived":   return await handleMarkReceived(socket, msg);
      case "chat":           return await handleChat(socket, msg);
      case "voiceJoin":      return await handleVoiceJoin(socket);
      case "voiceLeave":     return await handleVoiceLeave(socket);
      case "voiceSignal":    return await handleVoiceSignal(socket, msg);
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
      // (On reconnect the slot already points at the new socket — leave it.)
      const current = conn.socketsByName.get(found.name);
      if (current === socket) {
        conn.socketsByName.delete(found.name);
        // This was the live socket, so the player really left: drop them from
        // voice and notify peers so they tear down the connection.
        if (conn.voiceParticipants.delete(found.name)) {
          for (const [peerName, s] of conn.socketsByName) {
            if (peerName !== found.name) safeSend(s, { type: "voicePeerLeft", name: found.name });
          }
        }
      }
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

// Drive a computer player's turn by one action (roll, or play the best-ranked
// move). One action per sweep tick keeps bot play watchable. pendingMoves are
// already ranked best-first by the shared heuristic, so index 0 is the choice.
function isBotName(room, name) {
  return room.players.some((p) => p.isBot && p.name === name);
}

function driveBotTurn(room, now) {
  if (room.phase !== "playing" || !room.gameState) return { changed: false };
  const state = room.gameState;
  if (state.gameOver) return { changed: false };
  const currentName = state.playerNames[state.currentPlayer];
  if (!isBotName(room, currentName)) return { changed: false };
  // A no-move notice is resolving on its own timer — wait for it.
  if (state.noMoveRoll?.shouldAdvance) return { changed: false };

  if (room.pendingMoves && room.pendingMovesFor === currentName && room.pendingMoves.length > 0) {
    const submitted = submitPendingMoveForRoom(room, 0, now);
    return { changed: submitted.ok };
  }
  if (state.pendingRoll == null) {
    rollForCurrentPlayer(room, rollDie(), now, { startDeadline: false });
    return { changed: true };
  }
  return { changed: false };
}

// Server-authoritative move timer. Expired move choices are auto-played.
setInterval(async () => {
  try {
    const now = Date.now();
    const rooms = await roomStore.list();
    for (const room of rooms) {
      const noMoveAdvanceDue = room.noMoveAdvanceAt && room.noMoveAdvanceAt <= now;
      if (noMoveAdvanceDue) {
        const result = continueDelayedNoMoveRoll(room, now);
        if (result.changed) {
          await roomStore.set(room.code, room);
          await broadcastGame(room);
        }
        continue;
      }

      // Computer players take their turns automatically.
      const botResult = driveBotTurn(room, now);
      if (botResult.changed) {
        await roomStore.set(room.code, room);
        await broadcastGame(room);
        continue;
      }

      const shouldContinueAuto = Boolean(room.timedOutAutoPlayer);
      const deadlineExpired =
        room.pendingMoveDeadlineAt &&
        room.pendingMoveDeadlineAt <= now &&
        room.pendingMoves &&
        room.pendingMoves.length > 0;
      if (!shouldContinueAuto && !deadlineExpired) continue;

      const result = continueTimedOutAutoPlay(room, now, rollDie);
      if (!result.changed) continue;
      await roomStore.set(room.code, room);
      await broadcastGame(room);
    }
  } catch (err) {
    console.error("Error in turn-timeout interval:", err);
  }
}, TURN_TIMEOUT_SWEEP_MS).unref();

// Periodic GC: delete completed games, inactive games, and abandoned empty rooms.
setInterval(async () => {
  try {
    const now = Date.now();
    const rooms = await roomStore.list();
    for (const room of rooms) {
      const conn = pruneRoomConnections(room.code);
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
