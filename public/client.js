// Client: rendering, animation, WebSocket plumbing.
import {
  MODULE_LEN,
  TRACK_LEN,
  PLAYER_COLORS,
  PLAYER_STROKES,
  modeLabel,
} from "./shared/rules.js";

import {
  renderBoardLayers,
  buildMovePath as renderBuildMovePath,
  animateAlongPath as renderAnimateAlongPath,
  tokenLabelColor,
} from "./shared/board-render.js?v=2";

// DOM refs
const homeView = document.querySelector("#homeView");
const lobbyView = document.querySelector("#lobbyView");
const gameView = document.querySelector("#gameView");
const errorBanner = document.querySelector("#errorBanner");

const createBtn = document.querySelector("#createBtn");
const joinForm = document.querySelector("#joinForm");
const joinCodeInput = document.querySelector("#joinCodeInput");
const ROOM_CODE_LENGTH = 4;

const nameForm = document.querySelector("#nameForm");
const nameInput = document.querySelector("#nameInput");

const lobbyCodeLabel = document.querySelector("#lobbyCodeLabel");
const copyLinkBtn = document.querySelector("#copyLinkBtn");
const playerListEl = document.querySelector("#playerList");
const modePicker = document.querySelector("#modePicker");
const startBtn = document.querySelector("#startBtn");
const leaveBtn = document.querySelector("#leaveBtn");

const board = document.querySelector("#board");
const boardShape = document.querySelector("#boardShape");
const boardClipShape = document.querySelector("#boardClipShape");
const woodLayer = document.querySelector("#woodLayer");
const trackLayer = document.querySelector("#trackLayer");
const finishLayer = document.querySelector("#finishLayer");
const homeLayer = document.querySelector("#homeLayer");
const tokenLayer = document.querySelector("#tokenLayer");
const turnLabel = document.querySelector("#turnLabel");
const rollButton = document.querySelector("#rollButton");
const dieValueEl = document.querySelector("#dieValue");
const movesPanel = document.querySelector("#movesPanel");
const statusPanel = document.querySelector("#statusPanel");
const resetGameBtn = document.querySelector("#resetGameButton");
const endGameBtn = document.querySelector("#endGameButton");
const adminGameActions = document.querySelector("#adminGameActions");

// Client state
const ui = {
  view: "home", // 'home' | 'name' | 'lobby' | 'game'
  roomCode: null,
  myName: null,
  isAdmin: false,
  lobby: null, // {players, adminName, mode, validModes}
  game: null, // game state snapshot
  pendingMoves: null, // moves for current roll (current player only)
  socket: null,
  connected: false,
};

let diceSpinTimer = null;
let diceSpinValue = 1;

function $on(el, ev, fn) {
  if (el) el.addEventListener(ev, fn);
}

function showView(name) {
  ui.view = name;
  for (const v of [homeView, lobbyView, gameView]) v.hidden = true;
  if (name === "home" || name === "name") homeView.hidden = false;
  if (name === "lobby") lobbyView.hidden = false;
  if (name === "game") gameView.hidden = false;
  if (name === "name") {
    nameForm.hidden = false;
    document.querySelector("#homeChoices").hidden = true;
    nameInput.focus();
  } else if (name === "home") {
    nameForm.hidden = true;
    document.querySelector("#homeChoices").hidden = false;
  }
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
  setTimeout(() => { errorBanner.hidden = true; }, 4000);
}

// --- WebSocket ---
function connectSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;
  const sock = new WebSocket(url);
  ui.socket = sock;
  sock.addEventListener("open", () => { ui.connected = true; });
  sock.addEventListener("close", () => {
    ui.connected = false;
    showError("Disconnected. Reload to reconnect.");
  });
  sock.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  });
}

function send(payload) {
  if (!ui.connected || !ui.socket) return;
  ui.socket.send(JSON.stringify(payload));
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "roomCreated":
      ui.roomCode = msg.code;
      ui.isAdmin = true;
      // Persist admin token
      try { localStorage.setItem(`adminToken:${msg.code}`, msg.adminToken); } catch {}
      // Update URL
      history.replaceState(null, "", `${location.pathname}?room=${msg.code}`);
      showView("name");
      break;
    case "joinedRoom":
      ui.roomCode = msg.code;
      ui.myName = msg.name;
      ui.isAdmin = msg.isAdmin;
      break;
    case "lobbyState":
      ui.lobby = msg;
      if (ui.view !== "lobby") showView("lobby");
      renderLobby();
      break;
    case "gameState":
      ui.game = msg.state;
      ui.pendingMoves = msg.movesFor === ui.myName ? msg.moves || null : null;
      if (ui.view !== "game") showView("game");
      renderGame();
      break;
    case "error":
      showError(msg.message);
      break;
  }
}

// --- Home / Join flow ---
$on(createBtn, "click", () => send({ type: "createRoom" }));

function beginJoinWithCode(code) {
  if (code.length !== ROOM_CODE_LENGTH) return;
  if (ui.view === "name" && ui.roomCode === code) return;
  ui.roomCode = code;
  history.replaceState(null, "", `${location.pathname}?room=${code}`);
  showView("name");
}

$on(joinCodeInput, "input", () => {
  const normalized = joinCodeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LENGTH);
  joinCodeInput.value = normalized;
  beginJoinWithCode(normalized);
});

$on(joinForm, "submit", (e) => {
  e.preventDefault();
  beginJoinWithCode(joinCodeInput.value.trim().toUpperCase());
});

$on(nameForm, "submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  if (!ui.roomCode) { showError("No room code"); return; }
  let adminToken = null;
  try { adminToken = localStorage.getItem(`adminToken:${ui.roomCode}`) || undefined; } catch {}
  send({ type: "joinRoom", code: ui.roomCode, name, adminToken });
});

// --- Lobby ---
$on(copyLinkBtn, "click", async () => {
  const url = `${location.origin}${location.pathname}?room=${ui.roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    copyLinkBtn.textContent = "Copied!";
    setTimeout(() => { copyLinkBtn.textContent = "Copy invite link"; }, 1500);
  } catch {
    showError("Copy failed; link: " + url);
  }
});

$on(startBtn, "click", () => send({ type: "startGame" }));
$on(leaveBtn, "click", () => {
  send({ type: "leaveRoom" });
  try { localStorage.removeItem(`adminToken:${ui.roomCode}`); } catch {}
  location.href = location.pathname;
});

function renderLobby() {
  const { code, players, adminName, mode, validModes: vm } = ui.lobby;
  lobbyCodeLabel.textContent = code;
  // Player list
  playerListEl.replaceChildren();
  for (let i = 0; i < 6; i += 1) {
    const li = document.createElement("li");
    li.className = "lobby-slot";
    const p = players[i];
    if (p) {
      li.classList.add("filled");
      const adminTag = p.name === adminName ? '<span class="tag">admin</span>' : "";
      const youTag = p.name === ui.myName ? '<span class="tag tag-self">you</span>' : "";
      li.innerHTML = `<span class="slot-num">${i + 1}</span><span class="slot-name">${escapeHTML(p.name)}</span>${adminTag}${youTag}`;
    } else {
      li.innerHTML = `<span class="slot-num">${i + 1}</span><span class="slot-empty">waiting…</span>`;
    }
    playerListEl.append(li);
  }
  // Mode picker — admin only
  modePicker.replaceChildren();
  if (ui.isAdmin && players.length >= 2) {
    const label = document.createElement("div");
    label.className = "mode-label";
    label.textContent = "Game mode:";
    modePicker.append(label);
    vm.forEach((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mode-button${mode === m ? " selected" : ""}`;
      btn.textContent = modeLabel(m, players.length);
      btn.addEventListener("click", () => send({ type: "setMode", mode: m }));
      modePicker.append(btn);
    });
  } else if (!ui.isAdmin) {
    modePicker.textContent = `Waiting for ${adminName} to start…`;
  } else {
    modePicker.textContent = "Need at least 2 players to start.";
  }
  startBtn.hidden = !ui.isAdmin;
  startBtn.disabled = players.length < 2 || !mode;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// --- Rotation helpers (local player at bottom) ---
function localPlayerIdx() {
  if (!ui.game || !ui.myName) return null;
  return ui.game.playerNames.indexOf(ui.myName);
}

function localSeat() {
  const lp = localPlayerIdx();
  if (lp === null || lp < 0) return 0;
  return ui.game.seatColors[lp];
}

function renderGame() {
  const state = ui.game;
  if (!state) return;
  const cp = state.currentPlayer;
  const seat = state.seatColors[cp];
  const isMyTurn = state.currentPlayer === localPlayerIdx();
  resetGameBtn.hidden = !ui.isAdmin;
  adminGameActions.hidden = !ui.isAdmin;

  rollButton.style.setProperty("--dice-color", PLAYER_COLORS[seat]);
  rollButton.style.setProperty("--dice-stroke", PLAYER_STROKES[seat]);
  rollButton.style.setProperty("--dice-ink", tokenLabelColor(seat));
  movesPanel.style.setProperty("--current-player-color", PLAYER_COLORS[seat]);
  movesPanel.style.setProperty("--current-player-stroke", PLAYER_STROKES[seat]);
  movesPanel.style.setProperty("--current-player-ink", tokenLabelColor(seat));

  // Turn panel
  if (state.gameOver) {
    turnLabel.innerHTML = `<span class="winner">${state.winner} wins</span>`;
  } else {
    turnLabel.innerHTML = `<span class="current-player" style="--player-color:${PLAYER_COLORS[seat]};--player-stroke:${PLAYER_STROKES[seat]};--player-ink:${tokenLabelColor(seat)}">${escapeHTML(
      state.playerNames[cp],
    )}</span>`;
  }

  // Dice
  const canRoll = !state.gameOver && isMyTurn && state.pendingRoll == null;
  rollButton.disabled = !canRoll || Boolean(diceSpinTimer);
  if (state.pendingDieValue != null) {
    stopDiceRollAnimation(state.pendingDieValue);
    if (isMyTurn && ui.pendingMoves?.length) {
      dieValueEl.textContent = `Rolled ${state.pendingDieValue} · choose a move`;
    } else if (canRoll) {
      dieValueEl.textContent = `Rolled ${state.pendingDieValue} · tap again`;
    } else {
      dieValueEl.textContent = `Rolled ${state.pendingDieValue}`;
    }
  } else if (!diceSpinTimer) {
    setDiceFace(null);
    dieValueEl.textContent = canRoll ? "Tap the dice to roll" : "Waiting for roll";
  }

  // Moves panel
  movesPanel.replaceChildren();
  if (isMyTurn && ui.pendingMoves && ui.pendingMoves.length > 0) {
    ui.pendingMoves.forEach((m, idx) => {
      const b = document.createElement("button");
      b.className = "move-button";
      b.type = "button";
      b.textContent = m.label;
      b.addEventListener("click", () => {
        // Disable while waiting for server confirmation
        Array.from(movesPanel.querySelectorAll("button")).forEach((x) => (x.disabled = true));
        send({ type: "submitMove", moveIdx: idx });
      });
      movesPanel.append(b);
    });
  } else if (isMyTurn && state.pendingDieValue != null && !canRoll) {
    const empty = document.createElement("p");
    empty.className = "moves-note";
    empty.textContent = "No move available.";
    movesPanel.append(empty);
  }
  // Status
  renderStatus();
  // Board + animation
  renderBoard();
  if (state.lastMove) {
    animateLastMove(state.lastMove);
  }
}

function renderStatus() {
  const state = ui.game;
  const rows = [];
  for (let player = 0; player < state.playerCount; player += 1) {
    const seat = state.seatColors[player];
    const teamSuffix = state.teams ? `Team ${String.fromCharCode(65 + state.teams.findIndex((t) => t.includes(player)))}` : `Player ${player + 1}`;
    rows.push(
      `<div class="player-row"><span><span class="swatch" style="background:${PLAYER_COLORS[seat]};border:1px solid ${PLAYER_STROKES[seat]}"></span>${escapeHTML(state.playerNames[player])}</span><span>${teamSuffix}</span></div>`,
    );
  }
  const recent = state.log.slice(0, 6).map((e) => `<div class="log-row">${escapeHTML(e)}</div>`).join("");
  statusPanel.innerHTML = `<div class="info-group"><h2>Players</h2>${rows.join("")}</div><div class="info-group"><h2>History</h2>${recent}</div>`;
}

function renderBoard() {
  renderBoardLayers(
    { boardShape, boardClipShape, woodLayer, trackLayer, finishLayer, homeLayer, tokenLayer },
    ui.game,
    localSeat(),
  );
}

let lastAnimatedMoveSig = null;

function animateLastMove(lastMove) {
  const sig = JSON.stringify(lastMove);
  if (sig === lastAnimatedMoveSig) return;
  lastAnimatedMoveSig = sig;
  const path = renderBuildMovePath(ui.game, lastMove, localSeat());
  const marble = ui.game.marbles[lastMove.marbleIdx];
  renderAnimateAlongPath(tokenLayer, marble, path, () => {});
}

function setDiceFace(value) {
  rollButton.replaceChildren();
  const face = document.createElement("span");
  face.className = "dice-face";
  face.dataset.value = value == null ? "ready" : String(value);
  for (let i = 0; i < 9; i += 1) {
    const pip = document.createElement("span");
    pip.className = "pip";
    face.append(pip);
  }
  rollButton.append(face);
  rollButton.setAttribute("aria-label", value == null ? "Roll dice" : `Rolled ${value}`);
}

function startDiceRollAnimation() {
  clearInterval(diceSpinTimer);
  rollButton.disabled = true;
  rollButton.classList.add("rolling");
  dieValueEl.textContent = "Rolling...";
  diceSpinTimer = setInterval(() => {
    diceSpinValue = (diceSpinValue % 6) + 1;
    setDiceFace(diceSpinValue);
  }, 72);
}

function stopDiceRollAnimation(finalValue) {
  if (diceSpinTimer) clearInterval(diceSpinTimer);
  diceSpinTimer = null;
  rollButton.classList.remove("rolling");
  setDiceFace(finalValue);
}

// --- Roll button ---
$on(rollButton, "click", () => {
  if (!ui.game || ui.game.gameOver) return;
  if (ui.game.currentPlayer !== localPlayerIdx()) return;
  if (ui.game.pendingRoll != null || diceSpinTimer) return;
  startDiceRollAnimation();
  send({ type: "roll" });
});

$on(resetGameBtn, "click", () => {
  if (!ui.isAdmin) return;
  send({ type: "resetGame" });
});

$on(endGameBtn, "click", () => {
  if (!ui.isAdmin) return;
  send({ type: "endGame" });
});

// --- Init ---
function init() {
  const params = new URLSearchParams(location.search);
  const room = params.get("room");
  if (room) {
    ui.roomCode = room.toUpperCase();
    showView("name");
  } else {
    showView("home");
  }
  connectSocket();
}

init();
