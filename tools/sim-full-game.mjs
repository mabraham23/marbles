// Full-game autoplay simulation for Marbles.
//
// Creates a room, joins N players over WebSocket, starts the requested mode,
// and plays with natural server dice until someone wins — checking state
// invariants on every broadcast. Exits non-zero on any violation or stall.
//
// Usage:
//   node sim-full-game.mjs --players 4 --mode pairs [--bots 2] [--afk 1] \
//        [--turnLimit 15] [--moveChoice random|best] [--label mylabel]
//
// Server must run with: ROOM_STORE=memory DEBUG_HOOKS=1 and (for speed)
//   NO_MOVE_DIE_DISPLAY_MS=40 NO_MOVE_NOTICE_MS=40 TURN_TIMEOUT_SWEEP_MS=50 BOT_STEP_DELAY_MS=50

import WebSocket from "ws";
import {
  TRACK_LEN,
  MARBLES_PER_PLAYER,
  PLACE,
  getWinningPlayers,
} from "../public/shared/rules.js";

const PORT = process.env.PORT || 3000;
const WS_URL = `ws://localhost:${PORT}/ws`;

function arg(name, dflt) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return dflt;
  const val = process.argv[idx + 1];
  return val === undefined || val.startsWith("--") ? true : val;
}

const PLAYERS = Number(arg("players", 4));
const MODE = String(arg("mode", "single"));
const BOTS = Number(arg("bots", 0));
const AFK = Number(arg("afk", 0)); // this many humans never act (exercise auto-play); needs turnLimit > 0
const TURN_LIMIT = Number(arg("turnLimit", 0));
const MOVE_CHOICE = String(arg("moveChoice", "random"));
const LABEL = String(arg("label", `${PLAYERS}p-${MODE}${BOTS ? `-bots${BOTS}` : ""}${AFK ? `-afk${AFK}` : ""}`));
const FEE = Number(arg("fee", 0));
const GAME_TIMEOUT_MS = Number(arg("timeout", 480_000));
const STALL_MS = TURN_LIMIT > 0 ? (TURN_LIMIT + 25) * 1000 : 25_000;

const HUMANS = PLAYERS - BOTS;
if (HUMANS < 1) throw new Error("need at least 1 human (the admin)");
const NAMES = ["Admin", "Bea", "Cal", "Dot", "Eli", "Fay"].slice(0, HUMANS);
const AFK_NAMES = new Set(NAMES.slice(1, 1 + AFK)); // never the admin (must start game)

const problems = [];
const stats = { broadcasts: 0, rolls: 0, moves: 0, captures: 0, noMoves: 0 };
let lastStateAt = Date.now();
let finalState = null;
let sawWinner = null;

function fail(reason, state) {
  problems.push(reason);
  console.error(`INVARIANT VIOLATION [${LABEL}]: ${reason}`);
  if (state) {
    console.error(JSON.stringify({
      turnNumber: state.turnNumber, currentPlayer: state.currentPlayer,
      pendingRoll: state.pendingRoll, marbles: state.marbles,
    }));
  }
}

function checkInvariants(state) {
  const n = state.playerCount;
  if (state.marbles.length !== n * MARBLES_PER_PLAYER) {
    return fail(`marble count ${state.marbles.length} != ${n * MARBLES_PER_PLAYER}`, state);
  }
  const trackAbs = new Map();
  let centerCount = 0;
  const finishSlots = new Map();
  const perPlayer = new Array(n).fill(0);
  for (const m of state.marbles) {
    perPlayer[m.player] += 1;
    if (m.place === PLACE.TRACK) {
      if (!Number.isInteger(m.progress) || m.progress < 0 || m.progress > TRACK_LEN - 2) {
        return fail(`track progress out of range: ${JSON.stringify(m)}`, state);
      }
      const abs = (state.starts[m.player] + m.progress) % TRACK_LEN;
      if (trackAbs.has(abs)) {
        return fail(`two marbles on abs track hole ${abs}: ${JSON.stringify([trackAbs.get(abs), m])}`, state);
      }
      trackAbs.set(abs, m);
    } else if (m.place === PLACE.CENTER) {
      centerCount += 1;
      if (centerCount > 1) return fail("two marbles in center", state);
    } else if (m.place === PLACE.FINISH) {
      if (!Number.isInteger(m.finish) || m.finish < 0 || m.finish > 3) {
        return fail(`finish slot out of range: ${JSON.stringify(m)}`, state);
      }
      const key = `${m.player}:${m.finish}`;
      if (finishSlots.has(key)) return fail(`duplicate finish slot ${key}`, state);
      finishSlots.set(key, m);
    } else if (m.place !== PLACE.HOME) {
      return fail(`bad place ${m.place}`, state);
    }
  }
  perPlayer.forEach((count, player) => {
    if (count !== MARBLES_PER_PLAYER) fail(`player ${player} has ${count} marbles`, state);
  });
  if (state.currentPlayer < 0 || state.currentPlayer >= n) fail(`bad currentPlayer ${state.currentPlayer}`, state);
  if (state.gameOver) {
    const winners = getWinningPlayers(state);
    if (!winners || winners.length === 0) {
      fail("gameOver with no winning players", state);
    } else {
      for (const player of winners) {
        const done = state.marbles.filter((m) => m.player === player && m.place === PLACE.FINISH).length;
        if (done !== MARBLES_PER_PLAYER) fail(`winner ${player} has only ${done} finished marbles`, state);
      }
    }
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const sendMsg = (ws, m) => ws.send(JSON.stringify(m));

function waitFor(ws, predicate, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    const onMessage = (data) => {
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (predicate(m)) { clearTimeout(timer); ws.off("message", onMessage); resolve(m); }
    };
    ws.on("message", onMessage);
  });
}

// Per-client autoplayer: rolls when it's my turn, submits a move when offered.
function attachAutoplayer(ws, myName) {
  let lastActionKey = null;
  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type === "error") {
      // "Already rolled"/"Not your turn" can happen benignly on races; anything
      // else is suspicious.
      if (!/Already rolled|Not your turn|No pending move/.test(msg.message)) {
        console.error(`server error to ${myName}: ${msg.message}`);
        problems.push(`server error to ${myName}: ${msg.message}`);
      }
      return;
    }
    if (msg.type !== "gameState") return;
    const state = msg.state;
    lastStateAt = Date.now();
    if (myName === "Admin") {
      stats.broadcasts += 1;
      checkInvariants(state);
      if (state.noMoveRoll) stats.noMoves += 1;
      if (state.gameOver && !sawWinner) {
        sawWinner = state.winner ?? "(unnamed)";
        finalState = state;
      }
      if (msg.settlement) stats.settlement = msg.settlement;
    }
    if (state.gameOver) return;
    if (AFK_NAMES.has(myName)) return; // this player is "asleep"; server auto-plays
    const current = state.playerNames[state.currentPlayer];
    if (current !== myName) return;
    if (state.noMoveRoll?.shouldAdvance) return; // server advances on its own

    if (msg.movesFor === myName && Array.isArray(msg.moves) && msg.moves.length > 0) {
      const key = `move:${state.turnNumber}:${state.turnRollCount}:${state.pendingRoll}`;
      if (key === lastActionKey) return;
      lastActionKey = key;
      const idx = MOVE_CHOICE === "best" ? 0 : Math.floor(Math.random() * msg.moves.length);
      const move = msg.moves[idx];
      if (move.bump) stats.captures += 1;
      stats.moves += 1;
      setTimeout(() => sendMsg(ws, { type: "submitMove", moveIdx: idx }), 5);
      return;
    }
    if (state.pendingRoll == null) {
      const key = `roll:${state.turnNumber}:${state.turnRollCount}:${state.turnSegment}:${state.currentPlayer}`;
      if (key === lastActionKey) return;
      lastActionKey = key;
      stats.rolls += 1;
      setTimeout(() => sendMsg(ws, { type: "roll" }), 5);
    }
  });
}

async function main() {
  const started = Date.now();
  const admin = await connect();
  sendMsg(admin, { type: "createRoom", entryFee: FEE || undefined });
  const created = await waitFor(admin, (m) => m.type === "roomCreated", "roomCreated");
  const code = created.code;
  const handle = FEE ? { venmoHandle: "test-handle" } : {};
  sendMsg(admin, { type: "joinRoom", code, name: "Admin", adminToken: created.adminToken, ...handle });
  await waitFor(admin, (m) => m.type === "joinedRoom", "admin join");

  const sockets = [{ name: "Admin", ws: admin }];
  for (const name of NAMES.slice(1)) {
    const ws = await connect();
    sendMsg(ws, { type: "joinRoom", code, name, ...handle });
    await waitFor(ws, (m) => m.type === "joinedRoom", `${name} join`);
    sockets.push({ name, ws });
  }
  for (let b = 0; b < BOTS; b += 1) {
    sendMsg(admin, { type: "addBot" });
    await waitFor(admin, (m) => m.type === "lobbyState" && m.players.filter((p) => p.isBot).length === b + 1, `bot ${b + 1}`);
  }

  if (MODE !== "single") {
    sendMsg(admin, { type: "setMode", mode: MODE });
    await waitFor(admin, (m) => m.type === "lobbyState" && m.mode === MODE, `mode=${MODE}`);
  }
  sendMsg(admin, { type: "setTurnTimeLimit", seconds: TURN_LIMIT });
  await waitFor(admin, (m) => m.type === "lobbyState" && m.turnTimeLimitSeconds === TURN_LIMIT, "turn limit");

  for (const { name, ws } of sockets) attachAutoplayer(ws, name);

  sendMsg(admin, { type: "startGame" });
  const first = await waitFor(admin, (m) => m.type === "gameState" || m.type === "teamStagingState", "start");
  if (first.type === "teamStagingState") {
    sendMsg(admin, { type: "startGame" });
    await waitFor(admin, (m) => m.type === "gameState", "start after staging");
  }

  // Wait for the game to finish, with stall detection.
  while (!sawWinner) {
    await new Promise((r) => setTimeout(r, 250));
    if (Date.now() - lastStateAt > STALL_MS) {
      problems.push(`STALL: no state broadcast for ${Math.round((Date.now() - lastStateAt) / 1000)}s`);
      sendMsg(admin, { type: "syncRoom" });
      break;
    }
    if (Date.now() - started > GAME_TIMEOUT_MS) {
      problems.push("TIMEOUT: game did not finish in time");
      break;
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const summary = {
    label: LABEL, code, winner: sawWinner,
    turns: finalState?.turnNumber ?? null, seconds: Number(secs),
    rolls: stats.rolls, moves: stats.moves, captures: stats.captures,
    broadcasts: stats.broadcasts, problems,
  };
  if (stats.settlement) summary.settlement = stats.settlement;
  console.log(`RESULT ${JSON.stringify(summary)}`);
  for (const { ws } of sockets) { try { ws.close(); } catch {} }
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => { console.error(`FATAL [${LABEL}]:`, err.message || err); process.exit(2); });
