// Repeatable teammate-bump styling scenario for Marbles.
//
// Usage:
//   node sim-teammate-bump.mjs            -> create fresh room, set scenario, print URL
//   node sim-teammate-bump.mjs CODE       -> re-apply the scenario to an existing room
//
// Requires the server running locally with: ROOM_STORE=memory DEBUG_HOOKS=1 npm start
//
// Scenario (4 players, 2 teams of 2 — teams are Admin+Jess vs Mark+Sam):
//   It is Mark's (Red, player 1) turn with a forced die of 3. Red has three moves:
//     marble 1: lands on teammate Sam's Blue marble  -> teammate-bump warning style
//     marble 2: lands on opponent Jess's Yellow marble -> capture style
//     marble 3: lands on an empty hole                -> plain style
// Join the printed URL as "Mark" to see the move hints from the Red seat.

import WebSocket from "ws";

const PORT = process.env.PORT || 3000;
const WS_URL = `ws://localhost:${PORT}/ws`;
const HTTP_URL = `http://localhost:${PORT}`;
// Usage: node sim-teammate-bump.mjs [CODE] [variant]
const args = process.argv.slice(2);
const existingCode = args[0] && !/^\d$/.test(args[0]) ? args[0].toUpperCase() : null;
const variant = Number(args.find((a) => /^\d$/.test(a))) || 1;

// Marble indices: player*4 + index. Red = player 1 (idx 4..7),
// Yellow = player 2 (idx 8..11), Blue = player 3 (idx 12..15).
// progress is relative to the owner's start hole; abs = (start + progress) % 84
// (MODULE_LEN 14 * 6). Starts: Black 8, Red 22, Yellow 36, Blue 50.
// All variants: Red (player 1) to act with a forced die of 3.
const VARIANTS = {
  1: {
    note: "mid-board: teammate bump left edge, capture upper-middle, plain move",
    marbles: [
      { marbleIdx: 4, place: "track", progress: 10 }, // Red 1 @abs 32 -> 35 = Blue teammate
      { marbleIdx: 5, place: "track", progress: 29 }, // Red 2 @abs 51 -> 54 = Yellow opponent
      { marbleIdx: 6, place: "track", progress: 45 }, // Red 3 @abs 67 -> 70 = empty
      { marbleIdx: 12, place: "track", progress: 69 }, // Sam/Blue 1 @abs 35 (teammate victim)
      { marbleIdx: 8, place: "track", progress: 18 }, // Jess/Yellow 1 @abs 54 (capture victim)
    ],
  },
  2: {
    note: "teammate bump bottom row, capture near yellow start, plain move right side",
    marbles: [
      { marbleIdx: 4, place: "track", progress: 60 }, // Red 1 @abs 82 -> 1 = Blue teammate
      { marbleIdx: 5, place: "track", progress: 12 }, // Red 2 @abs 34 -> 37 = Yellow opponent
      { marbleIdx: 6, place: "track", progress: 40 }, // Red 3 @abs 62 -> 65 = empty
      { marbleIdx: 12, place: "track", progress: 35 }, // Sam/Blue 1 @abs 1 (teammate victim)
      { marbleIdx: 8, place: "track", progress: 1 }, // Jess/Yellow 1 @abs 37 (capture victim)
    ],
  },
  3: {
    note: "capture right before red's finish entry (crowded corner), teammate bump in the CENTER hole",
    marbles: [
      { marbleIdx: 4, place: "track", progress: 79 }, // Red 1 @abs 17 -> 82/abs 20 = Yellow opponent
      { marbleIdx: 5, place: "track", progress: 3 }, // Red 2 @abs 25 -> exact center entry
      { marbleIdx: 8, place: "track", progress: 68 }, // Jess/Yellow 1 @abs 20 (capture victim)
      { marbleIdx: 13, place: "center" }, // Sam/Blue 2 in the center hole (teammate victim)
    ],
  },
  4: {
    note: "two red marbles reach the SAME occupied hole (corner jump + normal) = multi-chip stack",
    marbles: [
      { marbleIdx: 4, place: "track", progress: 5 }, // Red 1 on corner apex -> corner-jumps to 47
      { marbleIdx: 5, place: "track", progress: 44 }, // Red 2 -> 47 as a normal move
      { marbleIdx: 12, place: "track", progress: 19 }, // Sam/Blue 1 @abs 69 (= red progress 47)
    ],
  },
};

function buildScenario(variant) {
  const spec = VARIANTS[variant];
  if (!spec) throw new Error(`Unknown variant ${variant}`);
  const byIdx = new Map(spec.marbles.map((m) => [m.marbleIdx, m]));
  const marbles = [];
  for (let idx = 0; idx < 16; idx += 1) {
    marbles.push(byIdx.get(idx) || { marbleIdx: idx, place: "home" });
  }
  return { type: "debugPlaceMarbles", currentPlayer: 1, marbles };
}
const DIE = { type: "debugRoll", dieValue: 3 };

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function sendMsg(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function waitFor(ws, predicate, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}`)),
      timeoutMs,
    );
    const onMessage = (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === "error") console.error(`  server error while waiting for ${label}:`, msg.message);
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg);
      }
    };
    ws.on("message", onMessage);
  });
}

// sendWs issues the debug messages; watchWs is the socket whose gameState we
// return (moves are only included for the current player's own socket).
async function applyScenario(sendWs, watchWs = sendWs) {
  sendMsg(sendWs, buildScenario(variant));
  await waitFor(watchWs, (m) => m.type === "gameState" && m.state?.pendingRoll == null, "placed marbles");
  sendMsg(sendWs, DIE);
  const msg = await waitFor(watchWs, (m) => m.type === "gameState" && m.state?.pendingRoll === 3, "forced roll");
  console.log(`Variant ${variant}: ${VARIANTS[variant].note}`);
  return msg;
}

async function main() {
  if (existingCode) {
    // Re-apply: join as Jess (a seat the browser isn't using) and inject.
    const ws = await connect();
    sendMsg(ws, { type: "joinRoom", code: existingCode, name: "Jess" });
    await waitFor(ws, (m) => m.type === "joinedRoom", "join as Jess");
    const msg = await applyScenario(ws);
    ws.close();
    console.log(`Scenario re-applied to room ${existingCode}.`);
    console.log(`Current player: ${msg.state.playerNames[msg.state.currentPlayer]} (Red), die = 3.`);
    return;
  }

  // Fresh room: Admin creates, three more join, teams mode, start (lobby->staging->playing).
  const admin = await connect();
  sendMsg(admin, { type: "createRoom" });
  const created = await waitFor(admin, (m) => m.type === "roomCreated", "roomCreated");
  const code = created.code;
  sendMsg(admin, { type: "joinRoom", code, name: "Admin", adminToken: created.adminToken });
  await waitFor(admin, (m) => m.type === "joinedRoom", "admin join");

  const others = [];
  for (const name of ["Mark", "Jess", "Sam"]) {
    const ws = await connect();
    sendMsg(ws, { type: "joinRoom", code, name });
    await waitFor(ws, (m) => m.type === "joinedRoom", `${name} join`);
    others.push({ name, ws });
  }

  sendMsg(admin, { type: "setMode", mode: "pairs" });
  await waitFor(admin, (m) => m.type === "lobbyState" && m.mode === "pairs", "mode=pairs");
  sendMsg(admin, { type: "setTurnTimeLimit", seconds: 0 });
  await waitFor(admin, (m) => m.type === "lobbyState" && m.turnTimeLimitSeconds === 0, "turn timer off");

  sendMsg(admin, { type: "startGame" });
  await waitFor(admin, (m) => m.type === "teamStagingState", "team staging");
  sendMsg(admin, { type: "startGame" });
  await waitFor(admin, (m) => m.type === "gameState", "game started");

  const markWs = others.find((o) => o.name === "Mark").ws;
  const msg = await applyScenario(admin, markWs);
  const moves = msg.moves || [];

  // Free the Mark seat so the visible browser can claim it.
  for (const { ws } of others) ws.close();
  admin.close();

  console.log(`Room ready: ${code}`);
  console.log(`Current player: ${msg.state.playerNames[msg.state.currentPlayer]} (Red), die = 3.`);
  console.log(`Moves offered to Mark: ${moves.length}`);
  for (const move of moves) {
    const bump = move.bump ? (move.bump.isTeammate ? `TEAMMATE BUMP ${move.bump.token}` : `capture ${move.bump.token}`) : "plain";
    console.log(`  - ${move.label} [${bump}]`);
  }
  console.log("");
  console.log(`Open:  ${HTTP_URL}/?room=${code}   and join as "Mark"`);
  console.log(`Rerun: node sim-teammate-bump.mjs ${code}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
