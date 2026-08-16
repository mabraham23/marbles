// Lifecycle test: game -> game over -> chat -> resetGame (rematch) -> second
// game completes -> endGame -> back to lobby. Exercises the admin flows a
// family actually uses between games.
import WebSocket from "ws";

const PORT = process.env.PORT || 3000;
const WS_URL = `ws://localhost:${PORT}/ws`;
const problems = [];

const connect = () => new Promise((res, rej) => {
  const ws = new WebSocket(WS_URL);
  ws.on("open", () => res(ws));
  ws.on("error", rej);
});
const sendMsg = (ws, m) => ws.send(JSON.stringify(m));
const waitFor = (ws, pred, label, ms = 60000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
  const on = (d) => {
    let m; try { m = JSON.parse(String(d)); } catch { return; }
    if (pred(m)) { clearTimeout(t); ws.off("message", on); res(m); }
  };
  ws.on("message", on);
});

// Simple autoplayer for both sockets (best move).
function autoplay(ws, myName) {
  let last = null;
  ws.on("message", (d) => {
    let msg; try { msg = JSON.parse(String(d)); } catch { return; }
    if (msg.type !== "gameState" || msg.state.gameOver) return;
    const state = msg.state;
    if (state.playerNames[state.currentPlayer] !== myName) return;
    if (state.noMoveRoll?.shouldAdvance) return;
    if (msg.movesFor === myName && msg.moves?.length) {
      const key = `m${state.turnNumber}:${state.turnRollCount}`;
      if (key === last) return; last = key;
      setTimeout(() => sendMsg(ws, { type: "submitMove", moveIdx: 0 }), 5);
    } else if (state.pendingRoll == null) {
      const key = `r${state.turnNumber}:${state.turnRollCount}:${state.turnSegment}`;
      if (key === last) return; last = key;
      setTimeout(() => sendMsg(ws, { type: "roll" }), 5);
    }
  });
}

async function main() {
  const admin = await connect();
  sendMsg(admin, { type: "createRoom" });
  const created = await waitFor(admin, (m) => m.type === "roomCreated", "created");
  const code = created.code;
  sendMsg(admin, { type: "joinRoom", code, name: "Admin", adminToken: created.adminToken });
  await waitFor(admin, (m) => m.type === "joinedRoom", "admin join");
  const p2 = await connect();
  sendMsg(p2, { type: "joinRoom", code, name: "Bea" });
  await waitFor(p2, (m) => m.type === "joinedRoom", "bea join");
  sendMsg(admin, { type: "setTurnTimeLimit", seconds: 0 });
  await waitFor(admin, (m) => m.type === "lobbyState" && m.turnTimeLimitSeconds === 0, "limit");

  autoplay(admin, "Admin");
  autoplay(p2, "Bea");

  // Game 1 to completion.
  sendMsg(admin, { type: "startGame" });
  const over1 = await waitFor(admin, (m) => m.type === "gameState" && m.state.gameOver, "game 1 over", 180000);
  console.log("game 1 winner:", over1.state.winner, "turns:", over1.state.turnNumber);
  if (!over1.state.stats) problems.push("no stats on finished game");

  // Chat after game over.
  sendMsg(p2, { type: "chat", text: "gg!" });
  const chat = await waitFor(
    admin,
    (m) => m.type === "chatHistory" && m.chat?.length && m.chat[m.chat.length - 1].text === "gg!",
    "chat relay",
    5000,
  );
  const lastEntry = chat.chat[chat.chat.length - 1];
  if (lastEntry.sender !== "Bea") problems.push(`chat attributed to ${lastEntry.sender}`);

  // Rematch.
  sendMsg(admin, { type: "resetGame" });
  const fresh = await waitFor(admin, (m) => m.type === "gameState" && !m.state.gameOver && m.state.turnNumber === 1, "rematch state", 10000);
  const onTrack = fresh.state.marbles.filter((m) => m.place !== "home").length;
  if (onTrack !== 0) problems.push(`rematch started with ${onTrack} marbles not at home`);

  // Game 2 to completion.
  const over2 = await waitFor(admin, (m) => m.type === "gameState" && m.state.gameOver, "game 2 over", 180000);
  console.log("game 2 winner:", over2.state.winner, "turns:", over2.state.turnNumber);

  // End game -> lobby.
  sendMsg(admin, { type: "endGame" });
  await waitFor(admin, (m) => m.type === "lobbyState", "back to lobby", 10000);
  await waitFor(p2, (m) => m.type === "lobbyState", "bea back to lobby", 10000).catch(() => {
    problems.push("Bea did not get lobbyState after endGame");
  });

  console.log(problems.length ? `PROBLEMS: ${JSON.stringify(problems)}` : "LIFECYCLE OK");
  admin.close(); p2.close();
  process.exit(problems.length ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(2); });
