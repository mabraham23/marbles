// Client: rendering, animation, WebSocket plumbing.
import {
  TRACK_LEN,
  PLAYER_COLORS,
  PLAYER_STROKES,
  modeLabel,
  PLACE,
  centerOccupant,
  marbleAtTrack,
  marbleToken,
} from "./shared/rules.js";

import {
  renderBoardLayers,
  buildMovePath as renderBuildMovePath,
  animateAlongPath as renderAnimateAlongPath,
  pointForMarble,
  pointForMarbleState,
  svgEl,
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
const ERROR_BANNER_MS = 2500;
const CONNECTED_PILL_MS = 900;
const OFFLINE_PILL_MS = 1200;
const COPY_CONFIRM_MS = 1000;
const NO_MOVE_NOTICE_MS = 1000;

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
const moveHintLayer = document.querySelector("#moveHintLayer");
const turnPanel = document.querySelector(".turn-panel");
const turnLabel = document.querySelector("#turnLabel");
const rollButton = document.querySelector("#rollButton");
const dieValueEl = document.querySelector("#dieValue");
const movesPanel = document.querySelector("#movesPanel");
const statusPanel = document.querySelector("#statusPanel");
const resetGameBtn = document.querySelector("#resetGameButton");
const endGameBtn = document.querySelector("#endGameButton");
const adminGameActions = document.querySelector("#adminGameActions");

const connPill = document.querySelector("#connPill");
const endedModal = document.querySelector("#endedModal");
const endedHomeBtn = document.querySelector("#endedHomeBtn");

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
  lastProcessedNoMoveRollId: null,
  isChatOpen: false,
  unreadCount: 0,
  chatHistory: [],
};

let diceSpinTimer = null;
let diceSpinValue = 1;
let turnNoticeEl = null;

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

  // Manage chat visibility
  const chatToggleBtn = document.querySelector("#chatToggleBtn");
  const chatDrawer = document.querySelector("#chatDrawer");
  if (name === "lobby" || name === "game") {
    if (chatToggleBtn) chatToggleBtn.hidden = false;
  } else {
    if (chatToggleBtn) chatToggleBtn.hidden = true;
    if (chatDrawer) {
      chatDrawer.hidden = true;
      chatDrawer.classList.remove("open");
    }
    ui.isChatOpen = false;
    ui.unreadCount = 0;
    updateChatBadge();
  }
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
  setTimeout(() => { errorBanner.hidden = true; }, ERROR_BANNER_MS);
}

// --- Session persistence (per-tab) ---
// Stored in sessionStorage so it doesn't leak across browser tabs the way
// localStorage did. localStorage still holds the adminToken so a hard tab
// close + reopen can reclaim admin.
function loadSession(code) {
  try {
    const raw = sessionStorage.getItem(`session:${code}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveSession(code, data) {
  try { sessionStorage.setItem(`session:${code}`, JSON.stringify(data)); } catch {}
}
function clearSession(code) {
  try { sessionStorage.removeItem(`session:${code}`); } catch {}
}
function loadAdminToken(code) {
  try { return localStorage.getItem(`adminToken:${code}`) || null; } catch { return null; }
}

// --- Connection manager ---
// Auto-reconnects with exponential backoff, transparently rejoins the room
// on every reconnect using the cached session, and surfaces state via the
// corner pill. No reloads required.
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];
let socket = null;
let reconnectAttempt = 0;
let pillFlashTimer = null;
let noMoveNoticeTimer = null;
let manuallyClosed = false;

function setConnState(state) {
  if (!connPill) return;
  connPill.hidden = false;
  connPill.dataset.state = state;
  if (state === "connected") {
    connPill.textContent = "Connected";
    // Briefly show the green pill on first connect, then fade out.
    if (pillFlashTimer) clearTimeout(pillFlashTimer);
    pillFlashTimer = setTimeout(() => { connPill.hidden = true; }, CONNECTED_PILL_MS);
  } else if (state === "reconnecting") {
    connPill.textContent = "Reconnecting…";
  } else if (state === "connecting") {
    connPill.textContent = "Connecting…";
  } else {
    connPill.textContent = "Offline";
  }
}

function flashPillBriefly(text) {
  if (!connPill) return;
  if (pillFlashTimer) clearTimeout(pillFlashTimer);
  connPill.hidden = false;
  connPill.dataset.state = "offline";
  connPill.textContent = text;
  pillFlashTimer = setTimeout(() => {
    setConnState(ui.connected ? "connected" : "reconnecting");
  }, OFFLINE_PILL_MS);
}

function connect() {
  manuallyClosed = false;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;
  setConnState(reconnectAttempt > 0 ? "reconnecting" : "connecting");
  const sock = new WebSocket(url);
  socket = sock;
  sock.addEventListener("open", () => {
    ui.socket = sock;
    ui.connected = true;
    reconnectAttempt = 0;
    setConnState("connected");
    // If we were previously in a room, silently rejoin so the UI catches up.
    if (ui.roomCode && ui.myName) {
      sock.send(JSON.stringify({
        type: "joinRoom",
        code: ui.roomCode,
        name: ui.myName,
        adminToken: loadAdminToken(ui.roomCode) || undefined,
      }));
    }
  });
  sock.addEventListener("close", () => {
    ui.connected = false;
    if (manuallyClosed) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt += 1;
    setConnState("reconnecting");
    setTimeout(connect, delay);
  });
  sock.addEventListener("error", () => {
    // Let the close handler drive retry — error always precedes close.
  });
  sock.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  });
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }
  flashPillBriefly("Offline — wait to reconnect");
  return false;
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
      // Cache identity per-tab so a reload / brief disconnect rejoins silently.
      saveSession(msg.code, { name: msg.name, isAdmin: msg.isAdmin });
      break;
    case "lobbyState":
      ui.lobby = msg;
      if (ui.view !== "lobby") showView("lobby");
      renderLobby();
      break;
    case "gameState":
      const state = msg.state;
      ui.game = state;
      ui.pendingMoves = msg.movesFor === ui.myName ? msg.moves || null : null;
      if (ui.view !== "game") showView("game");

      renderGame();
      if (state.noMoveRoll && state.noMoveRoll.rollId !== ui.lastProcessedNoMoveRollId) {
        ui.lastProcessedNoMoveRollId = state.noMoveRoll.rollId;
        flashNoMoveNotice(state.noMoveRoll);
      }
      break;
    case "chatHistory":
      handleChatHistory(msg.chat);
      break;
    case "error":
      // Server restarted (cold start) — room no longer exists. Surface a
      // friendly modal and stop the auto-rejoin loop instead of looping
      // through "Game not found" errors forever.
      if (msg.message === "Game not found" && ui.roomCode) {
        clearSession(ui.roomCode);
        try { localStorage.removeItem(`adminToken:${ui.roomCode}`); } catch {}
        ui.roomCode = null;
        ui.myName = null;
        ui.isAdmin = false;
        if (endedModal) endedModal.hidden = false;
        return;
      }
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
    setTimeout(() => { copyLinkBtn.textContent = "Copy invite link"; }, COPY_CONFIRM_MS);
  } catch {
    showError("Copy failed; link: " + url);
  }
});

$on(startBtn, "click", () => send({ type: "startGame" }));
$on(leaveBtn, "click", () => {
  const code = ui.roomCode;
  send({ type: "leaveRoom" });
  if (code) {
    clearSession(code);
    try { localStorage.removeItem(`adminToken:${code}`); } catch {}
  }
  location.href = location.pathname;
});

$on(endedHomeBtn, "click", () => {
  if (endedModal) endedModal.hidden = true;
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

function moveTargetPoint(state, move, viewerSeat) {
  const marble = state.marbles[move.marbleIdx];
  return pointForMarbleState(
    state,
    marble.player,
    move.targetPlace,
    move.targetProgress ?? null,
    move.targetFinish ?? null,
    marble.index,
    viewerSeat,
  );
}

function moveTargetOccupant(state, move) {
  const marble = state.marbles[move.marbleIdx];
  if (move.targetPlace === PLACE.TRACK) {
    const targetAbs = (state.starts[marble.player] + move.targetProgress) % TRACK_LEN;
    const occupant = marbleAtTrack(state, targetAbs);
    return occupant && occupant.player !== marble.player ? occupant : null;
  }
  if (move.targetPlace === PLACE.CENTER) {
    const occupant = centerOccupant(state);
    return occupant && occupant.player !== marble.player ? occupant : null;
  }
  return null;
}

function moveAccessibleLabel(state, move) {
  const occupant = moveTargetOccupant(state, move);
  return occupant ? `${move.label}, bumps ${marbleToken(occupant)} home` : move.label;
}

function moveChipLabel(state, move) {
  const marble = state.marbles[move.marbleIdx];
  if (move.targetPlace === PLACE.CENTER) return "CTR";
  if (move.targetPlace === PLACE.FINISH) return `F${(move.targetFinish ?? 0) + 1}`;
  if (move.label.includes("jumps to corner")) {
    const match = move.label.match(/corner (\d+)/);
    return match ? `C${match[1]}` : "JMP";
  }
  if (move.label.includes("leaves home")) return marbleToken(marble);
  if (move.label.includes("backward")) return "BACK";
  return marbleToken(marble);
}

function moveDisplayLabel(state, move) {
  return moveAccessibleLabel(state, move);
}

function disablePendingMoveControls() {
  Array.from(movesPanel.querySelectorAll("button")).forEach((button) => {
    button.disabled = true;
  });
  Array.from(moveHintLayer.querySelectorAll("[role='button']")).forEach((button) => {
    button.classList.add("move-hint-disabled");
    button.setAttribute("aria-disabled", "true");
  });
}

function submitPendingMove(moveIdx) {
  disablePendingMoveControls();
  send({ type: "submitMove", moveIdx });
}

function addMoveHintActivation(group, moveIdx) {
  group.addEventListener("click", () => {
    if (group.getAttribute("aria-disabled") === "true") return;
    submitPendingMove(moveIdx);
  });
  group.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (group.getAttribute("aria-disabled") === "true") return;
    submitPendingMove(moveIdx);
  });
}

function groupedMoveTargets(state, moves, viewerSeat) {
  const groups = new Map();
  moves.forEach((move, moveIdx) => {
    const point = moveTargetPoint(state, move, viewerSeat);
    const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    if (!groups.has(key)) groups.set(key, { point, entries: [] });
    groups.get(key).entries.push({ move, moveIdx });
  });
  return [...groups.values()];
}

function chipOffset(index, count) {
  if (count === 1) return { x: 0, y: 0 };
  const spread = 31;
  const start = -((count - 1) * spread) / 2;
  return { x: start + index * spread, y: -23 };
}

function makeMoveChoiceChip(state, entry, x, y, isCapture, hitRadius) {
  const marble = state.marbles[entry.move.marbleIdx];
  const labelText = moveAccessibleLabel(state, entry.move);
  const group = svgEl("g", {
    class: `move-choice${isCapture ? " capture" : ""}`,
    role: "button",
    tabindex: "0",
    "aria-label": labelText,
    style: `--hint-color:${PLAYER_COLORS[marble.seat]};--hint-stroke:${PLAYER_STROKES[marble.seat]};--hint-ink:${tokenLabelColor(marble.seat)}`,
  });
  const title = svgEl("title");
  title.textContent = labelText;
  group.append(title);
  group.append(svgEl("circle", { class: "move-hit", cx: x, cy: y, r: hitRadius }));
  group.append(svgEl("circle", { class: "move-chip", cx: x, cy: y, r: 12.5 }));
  const text = svgEl("text", { class: "move-chip-label", x, y: y + 0.4 });
  text.textContent = moveChipLabel(state, entry.move);
  group.append(text);
  addMoveHintActivation(group, entry.moveIdx);
  return group;
}

function renderMoveHints(isMyTurn) {
  moveHintLayer.replaceChildren();
  const state = ui.game;
  if (!state || !isMyTurn || !ui.pendingMoves?.length) return;

  const viewerSeat = localSeat();
  const sourceIds = new Set(ui.pendingMoves.map((move) => move.marbleIdx));
  sourceIds.forEach((marbleIdx) => {
    const marble = state.marbles[marbleIdx];
    const point = pointForMarble(state, marble, viewerSeat);
    moveHintLayer.append(svgEl("circle", {
      class: "move-source-halo",
      cx: point.x,
      cy: point.y,
      r: 17,
      style: `--hint-color:${PLAYER_COLORS[marble.seat]};--hint-stroke:${PLAYER_STROKES[marble.seat]}`,
    }));
  });

  groupedMoveTargets(state, ui.pendingMoves, viewerSeat).forEach((target) => {
    const hasCapture = target.entries.some((entry) => moveTargetOccupant(state, entry.move));
    moveHintLayer.append(svgEl("circle", {
      class: `move-target-ring${hasCapture ? " capture" : ""}${target.entries.length > 1 ? " multi" : ""}`,
      cx: target.point.x,
      cy: target.point.y,
      r: 18,
    }));

    target.entries.forEach((entry, index) => {
      const offset = chipOffset(index, target.entries.length);
      const hitRadius = target.entries.length === 1 ? 21 : 14;
      moveHintLayer.append(makeMoveChoiceChip(
        state,
        entry,
        target.point.x + offset.x,
        target.point.y + offset.y,
        Boolean(moveTargetOccupant(state, entry.move)),
        hitRadius,
      ));
    });
  });
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
  if (state.pendingDieValue == null && diceSpinTimer) {
    stopDiceRollAnimation(null);
  }
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
  rollButton.disabled = !canRoll || Boolean(diceSpinTimer);

  // Moves panel
  movesPanel.replaceChildren();
  if (isMyTurn && ui.pendingMoves && ui.pendingMoves.length > 0) {
    ui.pendingMoves.forEach((m, idx) => {
      const b = document.createElement("button");
      b.className = "move-button";
      b.type = "button";
      b.textContent = moveDisplayLabel(state, m);
      b.addEventListener("click", () => submitPendingMove(idx));
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
    const playerMarbles = state.marbles.filter((m) => m.player === player);
    const atHome = playerMarbles.filter((m) => m.place === PLACE.HOME).length;
    const finished = playerMarbles.filter((m) => m.place === PLACE.FINISH).length;

    rows.push(
      `<div class="player-row">` +
        `<div class="player-info">` +
          `<span class="swatch" style="background:${PLAYER_COLORS[seat]};border:1px solid ${PLAYER_STROKES[seat]}"></span>` +
          `<span class="player-name">${escapeHTML(state.playerNames[player])}</span>` +
        `</div>` +
        `<div class="player-stats">` +
          `<span class="stat-badge home-badge" title="Marbles still at Home">🏠 ${atHome}</span>` +
          `<span class="stat-badge finish-badge" title="Marbles made it Home">🏁 ${finished}</span>` +
        `</div>` +
        `<span class="team-badge">${teamSuffix}</span>` +
      `</div>`,
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
  renderMoveHints(ui.game.currentPlayer === localPlayerIdx());
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

function ensureTurnNotice() {
  if (turnNoticeEl) return turnNoticeEl;
  turnNoticeEl = document.createElement("div");
  turnNoticeEl.className = "current-player turn-notice";
  turnNoticeEl.hidden = true;
  turnPanel.append(turnNoticeEl);
  return turnNoticeEl;
}

function flashNoMoveNotice(noMoveRoll) {
  if (noMoveNoticeTimer) clearTimeout(noMoveNoticeTimer);

  const rollingPlayerName = ui.game.playerNames[noMoveRoll.player];
  const seat = ui.game.seatColors[noMoveRoll.player];
  const notice = ensureTurnNotice();
  notice.style.setProperty("--player-color", PLAYER_COLORS[seat]);
  notice.style.setProperty("--player-stroke", PLAYER_STROKES[seat]);
  notice.style.setProperty("--player-ink", tokenLabelColor(seat));
  notice.textContent = `${rollingPlayerName}: No moves`;
  notice.hidden = false;
  notice.classList.remove("turn-notice-pulse");
  void notice.offsetWidth;
  notice.classList.add("turn-notice-pulse");

  noMoveNoticeTimer = setTimeout(() => {
    noMoveNoticeTimer = null;
    notice.hidden = true;
    notice.classList.remove("turn-notice-pulse");
  }, NO_MOVE_NOTICE_MS);
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
    const session = loadSession(ui.roomCode);
    if (session && session.name) {
      // We've been in this room before in this tab. Prime myName so the WS
      // onopen handler silently rejoins, and skip the name form. The
      // lobbyState / gameState message that follows will pick the right view.
      ui.myName = session.name;
      ui.isAdmin = !!session.isAdmin;
      for (const v of [homeView, lobbyView, gameView]) v.hidden = true;
    } else {
      showView("name");
    }
  } else {
    showView("home");
  }
  connect();
}

// --- Lobby Chat Logic ---
const chatMessages = document.querySelector("#chatMessages");
const chatToggleBtn = document.querySelector("#chatToggleBtn");
const chatCloseBtn = document.querySelector("#chatCloseBtn");
const chatDrawer = document.querySelector("#chatDrawer");
const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const chatBadge = document.querySelector("#chatBadge");

function handleChatHistory(chat) {
  const oldHistoryLength = ui.chatHistory.length;
  ui.chatHistory = chat;
  
  renderChat();

  // If the chat drawer is closed and we received new messages from someone else:
  if (!ui.isChatOpen && oldHistoryLength > 0 && chat.length > oldHistoryLength) {
    const newMessages = chat.slice(oldHistoryLength);
    const unreadFromOthers = newMessages.filter(m => m.sender !== ui.myName).length;
    ui.unreadCount += unreadFromOthers;
    updateChatBadge();
  }
}

function getColorForSender(senderName) {
  if (ui.game && ui.game.playerNames) {
    const pIdx = ui.game.playerNames.indexOf(senderName);
    if (pIdx >= 0 && ui.game.seatColors) {
      const seat = ui.game.seatColors[pIdx];
      if (seat !== undefined) return PLAYER_COLORS[seat];
    }
  } else if (ui.lobby && ui.lobby.players) {
    const pIdx = ui.lobby.players.findIndex(p => p.name === senderName);
    if (pIdx >= 0) return PLAYER_COLORS[pIdx % PLAYER_COLORS.length];
  }
  return "#c7b891"; // Default muted wood/gold color
}

function renderChat() {
  if (!chatMessages) return;

  chatMessages.innerHTML = "";
  for (const msg of ui.chatHistory) {
    const isMe = msg.sender === ui.myName;
    
    const msgEl = document.createElement("div");
    msgEl.className = `chat-msg ${isMe ? "me" : ""}`;

    const senderEl = document.createElement("div");
    senderEl.className = "chat-msg-sender";
    senderEl.textContent = msg.sender;
    senderEl.style.color = getColorForSender(msg.sender);

    const bubbleEl = document.createElement("div");
    bubbleEl.className = "chat-msg-bubble";
    bubbleEl.textContent = msg.text;

    const timeEl = document.createElement("div");
    timeEl.className = "chat-msg-time";
    const date = new Date(msg.timestamp);
    timeEl.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgEl.appendChild(senderEl);
    msgEl.appendChild(bubbleEl);
    msgEl.appendChild(timeEl);

    chatMessages.appendChild(msgEl);
  }

  // Auto-scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateChatBadge() {
  if (!chatBadge) return;
  if (ui.unreadCount > 0) {
    const countText = ui.unreadCount > 9 ? "9+" : String(ui.unreadCount);
    chatBadge.dataset.count = countText;
    chatBadge.textContent = "";
    chatBadge.hidden = false;
  } else {
    delete chatBadge.dataset.count;
    chatBadge.textContent = "";
    chatBadge.hidden = true;
  }
}

function toggleChat() {
  if (!chatDrawer) return;
  ui.isChatOpen = !ui.isChatOpen;
  if (ui.isChatOpen) {
    updateChatViewportInset();
    chatDrawer.hidden = false;
    if (chatToggleBtn) chatToggleBtn.hidden = true;
    // Force a reflow
    chatDrawer.offsetHeight;
    chatDrawer.classList.add("open");
    ui.unreadCount = 0;
    updateChatBadge();
    if (chatInput && !isMobileChatViewport()) chatInput.focus();
    if (chatMessages) {
      setTimeout(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }, 50);
    }
  } else {
    if (chatInput) chatInput.blur();
    chatDrawer.classList.remove("open");
    if (chatToggleBtn && (ui.view === "lobby" || ui.view === "game")) {
      chatToggleBtn.hidden = false;
    }
    setTimeout(() => {
      if (!ui.isChatOpen) chatDrawer.hidden = true;
    }, 350);
  }
}

function isMobileChatViewport() {
  return window.matchMedia?.("(max-width: 640px)").matches || window.matchMedia?.("(pointer: coarse)").matches;
}

function updateChatViewportInset() {
  const viewport = window.visualViewport;
  const inset = viewport
    ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
    : 0;
  document.documentElement.style.setProperty("--chat-keyboard-inset", `${Math.round(inset)}px`);
}

$on(chatToggleBtn, "click", toggleChat);
$on(chatCloseBtn, "click", () => {
  if (ui.isChatOpen) toggleChat();
});

$on(chatForm, "submit", (e) => {
  e.preventDefault();
  if (!chatInput) return;
  const text = chatInput.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  chatInput.value = "";
});

// Auto-scroll when keyboard opens on mobile devices
if (window.visualViewport) {
  const handleChatViewportChange = () => {
    updateChatViewportInset();
    if (ui.isChatOpen && chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  };
  window.visualViewport.addEventListener("resize", handleChatViewportChange);
  window.visualViewport.addEventListener("scroll", handleChatViewportChange);
}
$on(chatInput, "focus", () => {
  updateChatViewportInset();
  setTimeout(() => {
    if (ui.isChatOpen && chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }, 300);
});

init();
