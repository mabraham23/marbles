// Client: rendering, animation, WebSocket plumbing.
import {
  FINISH_LEN,
  MARBLES_PER_PLAYER,
  SIDE_ROW_LEN,
  ARM_ROW_LEN,
  APEX_LEN,
  MODULE_LEN,
  TRACK_LEN,
  MAX_TRACK_PROGRESS,
  CENTER_PROGRESS,
  CORNER_PROGRESSES,
  PLAYER_NAMES,
  PLAYER_SHORT,
  PLAYER_COLORS,
  PLAYER_STROKES,
  PLACE,
  MODES,
  validModes,
  modeLabel,
  marbleToken,
} from "./shared/rules.js";

const ns = "http://www.w3.org/2000/svg";
const center = { x: 210, y: 222 };
const boardRadius = 190;
const trackRadius = 128;
const CORNER_INSET = 130;

const boardPoints = makeHexPoints(boardRadius, 0);
const baseTrackPoints = makeTrackPoints();

// DOM refs
const homeView = document.querySelector("#homeView");
const lobbyView = document.querySelector("#lobbyView");
const gameView = document.querySelector("#gameView");
const errorBanner = document.querySelector("#errorBanner");

const createBtn = document.querySelector("#createBtn");
const joinForm = document.querySelector("#joinForm");
const joinCodeInput = document.querySelector("#joinCodeInput");

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
const newGameBtn = document.querySelector("#newGameButton");

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
      try { localStorage.setItem(`name:${msg.code}`, msg.name); } catch {}
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

$on(joinForm, "submit", (e) => {
  e.preventDefault();
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) return;
  ui.roomCode = code;
  history.replaceState(null, "", `${location.pathname}?room=${code}`);
  showView("name");
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

// --- Game rendering ---
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(ns, tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

function makeHexPoints(radius, offsetDegrees) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = ((offsetDegrees + index * 60) * Math.PI) / 180;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  });
}

function makeTrackPoints() {
  const sideRows = makeSideRows();
  const corners = makeCornerTargets();
  const points = [];
  for (let side = 0; side < 6; side += 1) {
    points.push(...makeArmPoints(sideRows[side], 0, "in", corners[(side + 1) % 6]));
    points.push(...sideRows[side]);
    points.push(...makeArmPoints(sideRows[side], SIDE_ROW_LEN - 1, "out", corners[(side + 2) % 6]));
    points.push(corners[(side + 2) % 6]);
  }
  return points;
}

function makeCornerTargets() {
  return boardPoints.map((corner) => {
    const toCenter = normalize({ x: center.x - corner.x, y: center.y - corner.y });
    return {
      x: corner.x + toCenter.x * CORNER_INSET,
      y: corner.y + toCenter.y * CORNER_INSET,
    };
  });
}

function makeArmPoints(sideRow, endpointIndex, direction, target) {
  const endpoint = sideRow[endpointIndex];
  const segments = ARM_ROW_LEN + 1;
  return Array.from({ length: ARM_ROW_LEN }, (_, index) => {
    const t = (index + 1) / segments;
    return direction === "in" ? lerpPoint(target, endpoint, 1 - t) : lerpPoint(endpoint, target, t);
  });
}

function makeSideRows() {
  const normalAngles = [90, 150, 210, 270, 330, 30];
  const rowSpacing = 14;
  return normalAngles.map((degrees) => {
    const angle = (degrees * Math.PI) / 180;
    const normal = { x: Math.cos(angle), y: Math.sin(angle) };
    const sideDirection = { x: -normal.y, y: normal.x };
    const sideCenter = {
      x: center.x + normal.x * trackRadius,
      y: center.y + normal.y * trackRadius,
    };
    return Array.from({ length: SIDE_ROW_LEN }, (_, index) => {
      const offset = (index - (SIDE_ROW_LEN - 1) / 2) * rowSpacing;
      return {
        x: sideCenter.x + sideDirection.x * offset,
        y: sideCenter.y + sideDirection.y * offset,
      };
    });
  });
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
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

function visualSeatForPlayer(player) {
  if (!ui.game) return player;
  const actualSeat = ui.game.seatColors[player];
  return (actualSeat - localSeat() + 6) % 6;
}

function visualTrackIndex(absTrackIndex) {
  return (absTrackIndex - localSeat() * MODULE_LEN + TRACK_LEN) % TRACK_LEN;
}

function trackPoint(absTrackIndex) {
  return baseTrackPoints[visualTrackIndex(absTrackIndex)];
}

function visualSideCenter(player) {
  const visSeat = visualSeatForPlayer(player);
  const sideCenterIndex = visSeat * MODULE_LEN + ARM_ROW_LEN + Math.floor(SIDE_ROW_LEN / 2);
  return baseTrackPoints[sideCenterIndex];
}

function finishPoint(player, slot) {
  const sideCenter = visualSideCenter(player);
  return lerpPoint(sideCenter, center, 0.155 + slot * 0.11);
}

function homePoint(player, index) {
  const sideCenter = visualSideCenter(player);
  const away = normalize({ x: sideCenter.x - center.x, y: sideCenter.y - center.y });
  let sideDirection = normalize({ x: away.y, y: -away.x });
  const readsRightToLeft = Math.abs(sideDirection.x) >= Math.abs(sideDirection.y) && sideDirection.x < 0;
  const readsBottomToTop = Math.abs(sideDirection.y) > Math.abs(sideDirection.x) && sideDirection.y < 0;
  if (readsRightToLeft || readsBottomToTop) {
    sideDirection = { x: -sideDirection.x, y: -sideDirection.y };
  }
  const rowOutset = 20;
  const rowCenter = { x: sideCenter.x + away.x * rowOutset, y: sideCenter.y + away.y * rowOutset };
  const spacing = 22;
  const offset = (index - (MARBLES_PER_PLAYER - 1) / 2) * spacing;
  return { x: rowCenter.x + sideDirection.x * offset, y: rowCenter.y + sideDirection.y * offset };
}

function tokenLabelColor(seat) {
  return seat === 2 || seat === 4 || seat === 5 ? "#1d2939" : "#ffffff";
}

function tokenRadius(place) {
  if (place === PLACE.HOME) return 9;
  if (place === PLACE.FINISH) return 6.5;
  if (place === PLACE.CENTER) return 9;
  return 6.5;
}

function pointForMarbleState(player, place, progress, finish, index) {
  if (place === PLACE.HOME) return homePoint(player, index);
  if (place === PLACE.CENTER) return center;
  if (place === PLACE.FINISH) return finishPoint(player, finish);
  // TRACK
  const start = ui.game.starts[player];
  const absIdx = (start + progress) % TRACK_LEN;
  return trackPoint(absIdx);
}

function pointForMarble(marble) {
  return pointForMarbleState(marble.player, marble.place, marble.progress, marble.finish, marble.index);
}

function renderGame() {
  const state = ui.game;
  if (!state) return;
  const cp = state.currentPlayer;
  const seat = state.seatColors[cp];
  const isMyTurn = state.currentPlayer === localPlayerIdx();

  rollButton.style.setProperty("--dice-color", PLAYER_COLORS[seat]);
  rollButton.style.setProperty("--dice-stroke", PLAYER_STROKES[seat]);
  rollButton.style.setProperty("--dice-ink", tokenLabelColor(seat));

  // Turn panel
  if (state.gameOver) {
    turnLabel.innerHTML = `<span class="winner">${state.winner} wins</span>`;
  } else {
    turnLabel.innerHTML = `<span class="current-player" style="color:${PLAYER_COLORS[seat]};text-shadow:0 0 1px ${PLAYER_STROKES[seat]}">${escapeHTML(
      state.playerNames[cp],
    )}</span><span class="turn-meta">Turn ${state.turnNumber}${isMyTurn ? " · Your roll" : ""}</span>`;
  }

  // Dice
  const canRoll = !state.gameOver && isMyTurn && state.pendingRoll == null;
  rollButton.disabled = !canRoll || Boolean(diceSpinTimer);
  if (state.pendingDieValue != null) {
    stopDiceRollAnimation(state.pendingDieValue);
    dieValueEl.textContent = isMyTurn && ui.pendingMoves?.length ? `Rolled ${state.pendingDieValue} · choose a move` : `Rolled ${state.pendingDieValue}`;
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
  } else if (isMyTurn && state.pendingDieValue != null) {
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
  const state = ui.game;
  const boardPointString = boardPoints.map((p) => `${p.x},${p.y}`).join(" ");
  boardShape.setAttribute("points", boardPointString);
  boardClipShape.setAttribute("points", boardPointString);
  renderWoodGrain();
  trackLayer.replaceChildren();
  finishLayer.replaceChildren();
  homeLayer.replaceChildren();
  tokenLayer.replaceChildren();
  // Track holes — fixed background positions (regardless of rotation)
  const startSet = new Map(); // absTrackIndex -> seat
  for (let p = 0; p < state.playerCount; p += 1) {
    startSet.set(state.starts[p], state.seatColors[p]);
  }
  for (let i = 0; i < TRACK_LEN; i += 1) {
    const point = baseTrackPoints[visualTrackIndex(i)];
    const seat = startSet.get(i);
    const circle = svgEl("circle", {
      class: seat !== undefined ? "hole start-hole" : "hole",
      cx: point.x,
      cy: point.y,
      r: 5.1,
    });
    if (seat !== undefined) circle.setAttribute("stroke", PLAYER_COLORS[seat]);
    trackLayer.append(circle);
  }
  renderCornerLabels(state);
  // Center hole
  finishLayer.append(svgEl("circle", { class: "hole center-hole", cx: center.x, cy: center.y, r: 5.1 }));
  // Finish lanes + home pads (per active player)
  for (let player = 0; player < state.playerCount; player += 1) {
    const seat = state.seatColors[player];
    for (let slot = 0; slot < FINISH_LEN; slot += 1) {
      const point = finishPoint(player, slot);
      finishLayer.append(svgEl("circle", { class: "finish-hole", cx: point.x, cy: point.y, r: 6, stroke: PLAYER_COLORS[seat] }));
    }
    for (let index = 0; index < MARBLES_PER_PLAYER; index += 1) {
      const point = homePoint(player, index);
      homeLayer.append(svgEl("circle", { class: "home-pad", cx: point.x, cy: point.y, r: 7.5 }));
    }
  }
  // Marbles
  state.marbles.forEach((m) => drawToken(m));
}

function renderCornerLabels(state) {
  const playerStart = state.starts[state.currentPlayer];
  if (playerStart === undefined) return;

  CORNER_PROGRESSES.forEach((cornerProgress, index) => {
    const point = trackPoint((playerStart + cornerProgress) % TRACK_LEN);
    const away = normalize({ x: point.x - center.x, y: point.y - center.y });
    const labelPoint = {
      x: point.x + away.x * 15,
      y: point.y + away.y * 15,
    };
    trackLayer.append(svgEl("circle", {
      class: "corner-label-bg",
      cx: labelPoint.x,
      cy: labelPoint.y,
      r: 7.2,
    }));
    const text = svgEl("text", {
      class: "corner-label",
      x: labelPoint.x,
      y: labelPoint.y + 0.4,
    });
    text.textContent = String(index + 1);
    trackLayer.append(text);
  });
}

function renderWoodGrain() {
  woodLayer.replaceChildren();
  for (let y = 70; y <= 382; y += 12) {
    const wave = 3 + ((y / 12) % 4);
    const d = [
      `M 28 ${y.toFixed(1)}`,
      `C 92 ${(y - wave).toFixed(1)} 126 ${(y + wave).toFixed(1)} 190 ${y.toFixed(1)}`,
      `S 298 ${(y - wave).toFixed(1)} 392 ${y.toFixed(1)}`,
    ].join(" ");
    woodLayer.append(svgEl("path", { class: "wood-line", d }));
    if (y % 36 === 10) {
      woodLayer.append(svgEl("path", {
        class: "wood-line soft",
        d: `M 42 ${y + 5} C 118 ${y + 1} 190 ${y + 10} 276 ${y + 4} S 350 ${y + 2} 382 ${y + 6}`,
      }));
    }
  }
}

function drawToken(marble) {
  const point = pointForMarble(marble);
  const group = svgEl("g", { "aria-label": marbleToken(marble) });
  group.append(svgEl("circle", {
    class: "token",
    cx: point.x,
    cy: point.y,
    r: tokenRadius(marble.place),
    fill: PLAYER_COLORS[marble.seat],
    stroke: PLAYER_STROKES[marble.seat],
  }));
  const label = svgEl("text", {
    class: "token-label",
    x: point.x,
    y: point.y + 0.4,
    fill: tokenLabelColor(marble.seat),
  });
  label.textContent = String(marble.index + 1);
  group.append(label);
  tokenLayer.append(group);
}

// --- Animation ---
function buildMovePathFromLast(lastMove) {
  const marble = ui.game.marbles[lastMove.marbleIdx];
  const player = marble.player;
  const trackHole = (progress) => baseTrackPoints[visualTrackIndex((ui.game.starts[player] + progress) % TRACK_LEN)];

  const fromPoint = pointForMarbleState(player, lastMove.before.place, lastMove.before.progress, lastMove.before.finish, marble.index);
  const points = [fromPoint];

  if (lastMove.before.place === PLACE.HOME && lastMove.targetPlace === PLACE.TRACK) {
    points.push(trackHole(lastMove.targetProgress));
    return points;
  }
  if (lastMove.before.place === PLACE.TRACK && lastMove.targetPlace === PLACE.TRACK) {
    const fromIdx = CORNER_PROGRESSES.indexOf(lastMove.before.progress);
    const toIdx = CORNER_PROGRESSES.indexOf(lastMove.targetProgress);
    const isCornerJump = fromIdx >= 0 && toIdx >= 0 && toIdx > fromIdx && lastMove.targetProgress - lastMove.before.progress > 1;
    if (isCornerJump) {
      for (let i = fromIdx + 1; i <= toIdx; i += 1) points.push(trackHole(CORNER_PROGRESSES[i]));
    } else {
      for (let p = lastMove.before.progress + 1; p <= lastMove.targetProgress; p += 1) points.push(trackHole(p));
    }
    return points;
  }
  if (lastMove.before.place === PLACE.TRACK && lastMove.targetPlace === PLACE.CENTER) {
    for (let p = lastMove.before.progress + 1; p < CENTER_PROGRESS; p += 1) points.push(trackHole(p));
    points.push(center);
    return points;
  }
  if (lastMove.before.place === PLACE.TRACK && lastMove.targetPlace === PLACE.FINISH) {
    for (let p = lastMove.before.progress + 1; p <= MAX_TRACK_PROGRESS; p += 1) points.push(trackHole(p));
    for (let s = 0; s <= lastMove.targetFinish; s += 1) points.push(finishPoint(player, s));
    return points;
  }
  if (lastMove.before.place === PLACE.FINISH && lastMove.targetPlace === PLACE.FINISH) {
    for (let s = lastMove.before.finish + 1; s <= lastMove.targetFinish; s += 1) points.push(finishPoint(player, s));
    return points;
  }
  if (lastMove.before.place === PLACE.CENTER && lastMove.targetPlace === PLACE.TRACK) {
    points.push(trackHole(lastMove.targetProgress));
    return points;
  }
  return points;
}

function findTokenElement(marble) {
  return Array.from(tokenLayer.querySelectorAll("g")).find(
    (g) => g.getAttribute("aria-label") === marbleToken(marble),
  );
}

function setTokenPosition(token, x, y) {
  const circle = token.querySelector("circle");
  const text = token.querySelector("text");
  circle.setAttribute("cx", x);
  circle.setAttribute("cy", y);
  text.setAttribute("x", x);
  text.setAttribute("y", y + 0.4);
}

let activeAnimationToken = 0;
let lastAnimatedMoveSig = null;

function animateLastMove(lastMove) {
  // Avoid replaying the same lastMove if state arrives again
  const sig = JSON.stringify(lastMove);
  if (sig === lastAnimatedMoveSig) return;
  lastAnimatedMoveSig = sig;
  const path = buildMovePathFromLast(lastMove);
  const marble = ui.game.marbles[lastMove.marbleIdx];
  animateAlongPath(marble, path, () => {});
}

function animateAlongPath(marble, path, onDone) {
  activeAnimationToken += 1;
  const myToken = activeAnimationToken;
  if (path.length < 2) { onDone(); return; }
  const tokenEl = findTokenElement(marble);
  if (!tokenEl) { onDone(); return; }
  const stepMs = 90;
  const subStepMs = 18;
  const subSteps = Math.max(1, Math.round(stepMs / subStepMs));
  let seg = 0;
  let sub = 0;
  function tick() {
    if (myToken !== activeAnimationToken) return;
    const a = path[seg];
    const b = path[seg + 1];
    const t = sub / subSteps;
    setTokenPosition(tokenEl, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    sub += 1;
    if (sub > subSteps) {
      sub = 0;
      seg += 1;
      if (seg >= path.length - 1) {
        setTokenPosition(tokenEl, path[path.length - 1].x, path[path.length - 1].y);
        onDone();
        return;
      }
    }
    setTimeout(tick, subStepMs);
  }
  tick();
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

$on(newGameBtn, "click", () => {
  send({ type: "leaveRoom" });
  try { localStorage.removeItem(`adminToken:${ui.roomCode}`); } catch {}
  location.href = location.pathname;
});

// --- Init ---
function init() {
  const params = new URLSearchParams(location.search);
  const room = params.get("room");
  if (room) {
    ui.roomCode = room.toUpperCase();
    showView("name");
    let savedName = null;
    try { savedName = localStorage.getItem(`name:${ui.roomCode}`); } catch {}
    if (savedName) nameInput.value = savedName;
  } else {
    showView("home");
  }
  connectSocket();
}

init();
