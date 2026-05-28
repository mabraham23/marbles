// Client: rendering, animation, WebSocket plumbing.
import {
  MARBLES_PER_PLAYER,
  MAX_TRACK_PROGRESS,
  CENTER_PROGRESS,
  CORNER_PROGRESSES,
  TRACK_LEN,
  PLAYER_COLORS,
  PLAYER_STROKES,
  createInitialState,
  modeLabel,
  PLACE,
  centerOccupant,
  marbleAtTrack,
  marbleToken,
  playerDone,
} from "./shared/rules.js";

import { Sound } from "./sounds.js?v=1";

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
const entryFeeInput = document.querySelector("#entryFeeInput");
const joinForm = document.querySelector("#joinForm");
const joinCodeInput = document.querySelector("#joinCodeInput");
const handleField = document.querySelector("#handleField");
const handleFieldLabel = document.querySelector("#handleFieldLabel");
const venmoInput = document.querySelector("#venmoInput");
const lobbyFeeBanner = document.querySelector("#lobbyFeeBanner");
const settlementPanel = document.querySelector("#settlementPanel");
const LAST_VENMO_KEY = "lastVenmoHandle";
const ROOM_CODE_LENGTH = 4;
const ERROR_BANNER_MS = 2500;
const CONNECTED_PILL_MS = 900;
const OFFLINE_PILL_MS = 1200;
const COPY_CONFIRM_MS = 1000;
const NO_MOVE_NOTICE_MS = 1700;
const NO_MOVE_NOTICE_DELAY_MS = 1000;
const LOBBY_SYNC_MS = 5000;
const CAPTURE_FLARE_MS = 1200;
const TURN_TIME_LIMIT_OPTIONS = [0, 15, 30, 60];
const DEFAULT_TURN_TIME_LIMIT_SECONDS = 30;

const nameForm = document.querySelector("#nameForm");
const nameInput = document.querySelector("#nameInput");

const lobbyCodeLabel = document.querySelector("#lobbyCodeLabel");
const copyLinkBtn = document.querySelector("#copyLinkBtn");
const playerListEl = document.querySelector("#playerList");
const modePicker = document.querySelector("#modePicker");
const timeLimitPicker = document.querySelector("#timeLimitPicker");
const startBtn = document.querySelector("#startBtn");
const leaveBtn = document.querySelector("#leaveBtn");

const board = document.querySelector("#board");
const captureFlare = document.querySelector("#captureFlare");
const captureFlareText = document.querySelector("#captureFlareText");
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
const turnTimerChip = document.querySelector("#turnTimerChip");
const movesPanel = document.querySelector("#movesPanel");
const statusPanel = document.querySelector("#statusPanel");
const resetGameBtn = document.querySelector("#resetGameButton");
const endGameBtn = document.querySelector("#endGameButton");
const adminGameDetails = document.querySelector("#adminGameDetails");
const adminGameActions = document.querySelector("#adminGameActions");

const connPill = document.querySelector("#connPill");
const soundToggleBtn = document.querySelector("#soundToggleBtn");
const musicToggleBtn = document.querySelector("#musicToggleBtn");
const endedModal = document.querySelector("#endedModal");
const endedHomeBtn = document.querySelector("#endedHomeBtn");
const howToPlayButton = document.querySelector("#howToPlayButton");
const rulesModal = document.querySelector("#rulesModal");
const rulesCloseBtn = document.querySelector("#rulesCloseBtn");
const rulesGotItBtn = document.querySelector("#rulesGotItBtn");

// Client state
const ui = {
  view: "home", // 'home' | 'name' | 'lobby' | 'game'
  roomCode: null,
  myName: null,
  isAdmin: false,
  lobby: null, // {players, adminName, mode, validModes, entryFee, playerHandles}
  game: null, // game state snapshot
  pendingMoves: null, // moves for current roll (current player only)
  socket: null,
  connected: false,
  lastProcessedNoMoveRollId: null,
  isChatOpen: false,
  unreadCount: 0,
  chatHistory: [],
  // Entry-fee feature state
  entryFee: null,        // number | null (room's fee, mirrored from lobby/game)
  turnTimeLimitSeconds: DEFAULT_TURN_TIME_LIMIT_SECONDS,
  pendingMoveDeadlineAt: null,
  playerHandles: {},     // { name: { venmo } }
  settlement: null,      // { pot, perWinnerShare, transfers }
  pendingHandle: null,   // String handle user just typed; resent on auto-rejoin
  handleRequired: false, // Server told us this room needs a handle (before we know the fee)
};

let diceSpinTimer = null;
let diceSpinValue = 1;
let turnNoticeEl = null;
let lobbySyncTimer = null;
let turnTimerInterval = null;
let captureFlareTimer = null;

function $on(el, ev, fn) {
  if (el) el.addEventListener(ev, fn);
}

function showView(name) {
  ui.view = name;
  for (const v of [homeView, lobbyView, gameView]) v.hidden = true;
  if (name === "home" || name === "name") homeView.hidden = false;
  if (name === "lobby") lobbyView.hidden = false;
  if (name === "game") gameView.hidden = false;
  if (settlementPanel && (name === "home" || name === "name")) {
    settlementPanel.hidden = true;
  }
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

  // Sound toggle is available in lobby and game.
  if (soundToggleBtn) soundToggleBtn.hidden = !(name === "lobby" || name === "game");

  // Manage voice button visibility. Voice is available in lobby and game.
  const voiceToggleBtn = document.querySelector("#voiceToggleBtn");
  const voicePanel = document.querySelector("#voicePanel");
  if (name === "lobby" || name === "game") {
    if (voiceToggleBtn) voiceToggleBtn.hidden = false;
  } else {
    if (voiceToggleBtn) voiceToggleBtn.hidden = true;
    if (voicePanel) { voicePanel.hidden = true; voicePanel.classList.remove("open"); }
    // Leaving the room: stop the mic and tear down any voice connections.
    if (voice.active) leaveVoice();
    voice.isOpen = false;
  }
  if (name !== "game") {
    ui.pendingMoveDeadlineAt = null;
    updateTurnTimer();
  }
  updateLobbySyncTimer();
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
let noMoveNoticeDelayTimer = null;
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
      const payload = {
        type: "joinRoom",
        code: ui.roomCode,
        name: ui.myName,
        adminToken: loadAdminToken(ui.roomCode) || undefined,
      };
      if (ui.pendingHandle) payload.venmoHandle = ui.pendingHandle;
      sock.send(JSON.stringify(payload));
    }
    updateLobbySyncTimer();
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

function requestRoomSync() {
  if (!ui.roomCode || !ui.myName) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "syncRoom" }));
}

function updateLobbySyncTimer() {
  if (lobbySyncTimer) {
    clearInterval(lobbySyncTimer);
    lobbySyncTimer = null;
  }
  if (ui.view !== "lobby" || !ui.roomCode || !ui.myName) return;
  lobbySyncTimer = setInterval(requestRoomSync, LOBBY_SYNC_MS);
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "roomCreated":
      ui.roomCode = msg.code;
      ui.isAdmin = true;
      ui.entryFee = msg.entryFee || null;
      // Persist admin token
      try { localStorage.setItem(`adminToken:${msg.code}`, msg.adminToken); } catch {}
      // Update URL
      history.replaceState(null, "", `${location.pathname}?room=${msg.code}`);
      applyHandleFieldVisibility();
      showView("name");
      break;
    case "joinedRoom":
      // Re-baseline the lobby count: the next lobbyState is "the room as it is
      // now", not a new arrival — so joining a room that already has people in
      // it doesn't fire a spurious join ding.
      sndPrevLobbyCount = null;
      ui.roomCode = msg.code;
      ui.myName = msg.name;
      ui.isAdmin = msg.isAdmin;
      // Cache identity per-tab so a reload / brief disconnect rejoins silently.
      saveSession(msg.code, { name: msg.name, isAdmin: msg.isAdmin });
      requestRoomSync();
      // If we were in voice before a disconnect, rejoin now that the server has
      // bound this socket to the room (doing this in the socket 'open' handler
      // would race ahead of joinRoom finishing). Stale peer connections are torn
      // down so the mesh rebuilds; the local mic stream is preserved.
      if (voice.active) {
        for (const name of [...voice.peers.keys()]) closePeer(name);
        send({ type: "voiceJoin" });
      }
      break;
    case "lobbyState":
      // A new player appeared in the lobby (only after we've seen it once, so
      // the initial snapshot of existing players doesn't trigger a sound).
      if (sndPrevLobbyCount != null && msg.players && msg.players.length > sndPrevLobbyCount) {
        Sound.play("join");
      }
      sndPrevLobbyCount = msg.players ? msg.players.length : sndPrevLobbyCount;
      ui.lobby = msg;
      ui.entryFee = msg.entryFee || null;
      ui.turnTimeLimitSeconds = msg.turnTimeLimitSeconds ?? DEFAULT_TURN_TIME_LIMIT_SECONDS;
      ui.pendingMoveDeadlineAt = null;
      ui.playerHandles = msg.playerHandles || {};
      ui.settlement = null;
      if (ui.view !== "lobby") showView("lobby");
      renderLobby();
      renderChat();
      updateLobbySyncTimer();
      break;
    case "gameState":
      const state = msg.state;
      ui.game = state;
      ui.pendingMoves = msg.movesFor === ui.myName ? msg.moves || null : null;
      ui.entryFee = msg.entryFee || null;
      ui.turnTimeLimitSeconds = msg.turnTimeLimitSeconds ?? DEFAULT_TURN_TIME_LIMIT_SECONDS;
      ui.pendingMoveDeadlineAt = msg.pendingMoveDeadlineAt ?? null;
      ui.playerHandles = msg.playerHandles || {};
      ui.settlement = msg.settlement || null;
      const wasLobby = ui.view === "lobby";
      if (ui.view !== "game") showView("game");

      renderGame();
      renderChat();
      updateTurnTimer();
      playGameSounds(state, wasLobby);
      if (state.noMoveRoll && state.noMoveRoll.rollId !== ui.lastProcessedNoMoveRollId) {
        ui.lastProcessedNoMoveRollId = state.noMoveRoll.rollId;
        flashNoMoveNotice(state.noMoveRoll);
        Sound.play("noMove");
      } else if (!state.noMoveRoll) {
        clearNoMoveNotice();
      }
      break;
    case "chatHistory":
      handleChatHistory(msg.chat);
      break;
    case "voicePeers":
      // We just joined voice; open a connection to each existing participant.
      for (const peer of msg.peers || []) connectToPeer(peer, ui.myName > peer);
      renderVoice();
      break;
    case "voicePeerJoined":
      if (voice.active && msg.name !== ui.myName) connectToPeer(msg.name, ui.myName > msg.name);
      break;
    case "voicePeerLeft":
      closePeer(msg.name);
      break;
    case "voiceSignal":
      onVoiceSignal(msg.from, msg.data);
      break;
    case "error":
      // Server restarted (cold start) — room no longer exists. Surface a
      // friendly modal and stop the auto-rejoin loop instead of looping
      // through "Game not found" errors forever.
      if (msg.message === "Game not found" && ui.roomCode) {
        if (voice.active) leaveVoice();
        clearSession(ui.roomCode);
        try { localStorage.removeItem(`adminToken:${ui.roomCode}`); } catch {}
        ui.roomCode = null;
        ui.myName = null;
        ui.isAdmin = false;
        if (endedModal) endedModal.hidden = false;
        return;
      }
      // Server says this room needs a Venmo handle — flip the handle field
      // on and re-show the name view so the user can enter one.
      if (typeof msg.message === "string" && msg.message.startsWith("needHandle:")) {
        ui.handleRequired = true;
        applyHandleFieldVisibility();
        showView("name");
        showError(msg.message.slice("needHandle:".length));
        return;
      }
      showError(msg.message);
      break;
  }
}

// --- Entry-fee helpers ---
function normalizeHandleClient(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) return null;
  if (!/^[a-zA-Z0-9._-]{2,30}$/.test(trimmed)) return null;
  return trimmed;
}

function formatMoney(amount) {
  const n = Number(amount) || 0;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function venmoDeepLink(handle, amount, note) {
  // Venmo universal link. On mobile with the app installed this opens the app
  // and prefills; otherwise it falls back to the web flow in the same tab.
  const params = new URLSearchParams({
    txn: "pay",
    recipients: handle,
    amount: String(amount),
    note: note || "Marbles",
  });
  return `https://venmo.com/?${params.toString()}`;
}

function applyHandleFieldVisibility() {
  if (!handleField) return;
  const needed = Boolean(ui.entryFee || ui.handleRequired);
  handleField.hidden = !needed;
  if (needed && !venmoInput.value) {
    try {
      const last = localStorage.getItem(LAST_VENMO_KEY);
      if (last) venmoInput.value = last;
    } catch {}
  }
  if (handleFieldLabel) {
    handleFieldLabel.textContent = ui.entryFee
      ? `Venmo handle (required — buy-in ${formatMoney(ui.entryFee)})`
      : "Venmo handle";
  }
}

// --- Home / Join flow ---
$on(createBtn, "click", () => {
  const rawFee = entryFeeInput && entryFeeInput.value.trim();
  const feeNum = rawFee ? Number(rawFee) : 0;
  const payload = { type: "createRoom" };
  if (Number.isFinite(feeNum) && feeNum > 0) payload.entryFee = feeNum;
  send(payload);
});

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
  const payload = { type: "joinRoom", code: ui.roomCode, name, adminToken };
  if (venmoInput && venmoInput.value.trim()) {
    const normalized = normalizeHandleClient(venmoInput.value);
    if (!normalized) {
      showError("Invalid Venmo handle");
      return;
    }
    payload.venmoHandle = normalized;
    ui.pendingHandle = normalized;
    try { localStorage.setItem(LAST_VENMO_KEY, normalized); } catch {}
  }
  send(payload);
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

function demoMarbleIndex(player, index) {
  return player * MARBLES_PER_PLAYER + index;
}

function makeRulesDemoState() {
  return createInitialState({
    playerCount: 4,
    mode: "single",
    playerNames: ["Black", "Red", "Yellow", "Blue"],
  });
}

function setDemoMarble(state, player, index, place, progress = null, finish = null) {
  const marble = state.marbles[demoMarbleIndex(player, index)];
  marble.place = place;
  marble.progress = progress;
  marble.finish = finish;
  return marble;
}

function demoTrackProgressForAbs(state, player, absTrackIndex) {
  return (absTrackIndex - state.starts[player] + TRACK_LEN) % TRACK_LEN;
}

function demoMarbleBefore(marble) {
  return {
    player: marble.player,
    index: marble.index,
    seat: marble.seat,
    place: marble.place,
    progress: marble.progress,
    finish: marble.finish,
  };
}

function demoPathData(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function demoViewBox(points, { minWidth = 260, minHeight = 96, pad = 36, aspect = 3.05 } = {}) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  let minX = Math.min(...xs) - pad;
  let maxX = Math.max(...xs) + pad;
  let minY = Math.min(...ys) - pad;
  let maxY = Math.max(...ys) + pad;
  let width = Math.max(maxX - minX, minWidth);
  let height = Math.max(maxY - minY, minHeight);
  const currentAspect = width / height;
  if (currentAspect < aspect) {
    const nextWidth = height * aspect;
    const delta = (nextWidth - width) / 2;
    minX -= delta;
    width = nextWidth;
  } else if (currentAspect > aspect) {
    const nextHeight = width / aspect;
    const delta = (nextHeight - height) / 2;
    minY -= delta;
    height = nextHeight;
  }
  return `${minX.toFixed(1)} ${minY.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}`;
}

function makeDemoLastMove(marbleIdx, before, targetPlace, targetProgress, targetFinish = null, roll = null) {
  return {
    marbleIdx,
    roll,
    before,
    after: { place: targetPlace, progress: targetProgress ?? null, finish: targetFinish ?? null },
    targetPlace,
    targetProgress: targetProgress ?? null,
    targetFinish: targetFinish ?? null,
    bumpedIdx: null,
  };
}

function buildRulesDemo(kind) {
  const state = makeRulesDemoState();
  const viewerSeat = 0;
  let movingIdx = demoMarbleIndex(0, 0);
  let targetPoint = null;
  let capture = false;
  let bumpedIdx = null;
  let bumpedPath = null;
  let label = "";
  let path = [];
  let viewPoints = [];
  let targetClass = "";

  if (kind === "goal") {
    const moving = setDemoMarble(state, 0, 0, PLACE.TRACK, 0);
    movingIdx = demoMarbleIndex(0, 0);
    const before = demoMarbleBefore(moving);
    const lastMove = makeDemoLastMove(movingIdx, before, PLACE.FINISH, null, 3, 8);
    path = renderBuildMovePath(state, lastMove, viewerSeat);
    targetPoint = pointForMarbleState(state, 0, PLACE.FINISH, null, 3, 0, viewerSeat);
    viewPoints = path;
    label = "Black marble travels around the board and fills the finish spaces";
  } else if (kind === "traverse") {
    const moving = setDemoMarble(state, 0, 0, PLACE.TRACK, 7);
    movingIdx = demoMarbleIndex(0, 0);
    const before = demoMarbleBefore(moving);
    const lastMove = makeDemoLastMove(movingIdx, before, PLACE.TRACK, 13, null, 6);
    path = renderBuildMovePath(state, lastMove, viewerSeat);
    targetPoint = pointForMarbleState(state, 0, PLACE.TRACK, 13, null, 0, viewerSeat);
    viewPoints = path;
    label = "Black marble moves forward along connected track holes";
  } else if (kind === "blocked") {
    const moving = setDemoMarble(state, 0, 0, PLACE.TRACK, 7);
    setDemoMarble(state, 0, 1, PLACE.TRACK, 10);
    movingIdx = demoMarbleIndex(0, 0);
    path = [
      pointForMarbleState(state, 0, PLACE.TRACK, 7, null, 0, viewerSeat),
      pointForMarbleState(state, 0, PLACE.TRACK, 8, null, 0, viewerSeat),
      pointForMarbleState(state, 0, PLACE.TRACK, 9, null, 0, viewerSeat),
      pointForMarbleState(state, 0, PLACE.TRACK, 10, null, 0, viewerSeat),
    ];
    targetPoint = pointForMarbleState(state, 0, PLACE.TRACK, 10, null, 0, viewerSeat);
    targetClass = " blocked";
    viewPoints = path;
    label = "Black marble 1 cannot pass through Black marble 2";
  } else if (kind === "corner") {
    const fromProgress = CORNER_PROGRESSES[0];
    const toProgress = CORNER_PROGRESSES[3];
    const moving = setDemoMarble(state, 0, 0, PLACE.TRACK, fromProgress);
    movingIdx = demoMarbleIndex(0, 0);
    const before = demoMarbleBefore(moving);
    const lastMove = makeDemoLastMove(movingIdx, before, PLACE.TRACK, toProgress, null, 3);
    path = renderBuildMovePath(state, lastMove, viewerSeat);
    targetPoint = pointForMarbleState(state, 0, PLACE.TRACK, toProgress, null, 0, viewerSeat);
    viewPoints = path;
    label = "Black marble jumps from one corner to another corner";
  } else if (kind === "center") {
    const moving = setDemoMarble(state, 0, 0, PLACE.TRACK, CENTER_PROGRESS - 1);
    movingIdx = demoMarbleIndex(0, 0);
    path = [
      pointForMarbleState(state, 0, PLACE.TRACK, CENTER_PROGRESS - 1, null, 0, viewerSeat),
      pointForMarbleState(state, 0, PLACE.CENTER, null, null, 0, viewerSeat),
      pointForMarbleState(state, 0, PLACE.TRACK, CORNER_PROGRESSES[2], null, 0, viewerSeat),
    ];
    targetPoint = pointForMarbleState(state, 0, PLACE.CENTER, null, null, 0, viewerSeat);
    targetClass = " center";
    viewPoints = path;
    label = "Black marble enters the center, then exits to a corner on a later roll";
  } else if (kind === "leave") {
    const moving = state.marbles[movingIdx];
    const before = demoMarbleBefore(moving);
    const lastMove = makeDemoLastMove(movingIdx, before, PLACE.TRACK, 0, null, 1);
    path = renderBuildMovePath(state, lastMove, viewerSeat);
    targetPoint = pointForMarbleState(state, 0, PLACE.TRACK, 0, null, 0, viewerSeat);
    viewPoints = [
      ...path,
      ...Array.from({ length: MARBLES_PER_PLAYER }, (_, index) =>
        pointForMarbleState(state, 0, PLACE.HOME, null, null, index, viewerSeat),
      ),
    ];
    label = "Black marble 1 leaves home and moves to the start hole";
  } else if (kind === "capture") {
    const redStartAbs = state.starts[1];
    const targetProgress = demoTrackProgressForAbs(state, 0, redStartAbs);
    const sourceProgress = targetProgress - 3;
    const moving = setDemoMarble(state, 0, 0, PLACE.TRACK, sourceProgress);
    setDemoMarble(state, 1, 0, PLACE.TRACK, 0);
    movingIdx = demoMarbleIndex(0, 0);
    bumpedIdx = demoMarbleIndex(1, 0);
    const before = demoMarbleBefore(moving);
    const lastMove = makeDemoLastMove(movingIdx, before, PLACE.TRACK, targetProgress, null, 3);
    path = renderBuildMovePath(state, lastMove, viewerSeat);
    targetPoint = pointForMarbleState(state, 0, PLACE.TRACK, targetProgress, null, 0, viewerSeat);
    bumpedPath = [
      targetPoint,
      pointForMarbleState(state, 1, PLACE.HOME, null, null, 0, viewerSeat),
    ];
    capture = true;
    viewPoints = [
      ...path,
      ...bumpedPath,
      ...Array.from({ length: MARBLES_PER_PLAYER }, (_, index) =>
        pointForMarbleState(state, 1, PLACE.HOME, null, null, index, viewerSeat),
      ),
    ];
    label = "Black marble lands on Red marble 1 and bumps it home";
  } else if (kind === "finish") {
    const sourceProgress = MAX_TRACK_PROGRESS - 1;
    const moving = setDemoMarble(state, 0, 0, PLACE.TRACK, sourceProgress);
    movingIdx = demoMarbleIndex(0, 0);
    const before = demoMarbleBefore(moving);
    const lastMove = makeDemoLastMove(movingIdx, before, PLACE.FINISH, null, 0, 2);
    path = renderBuildMovePath(state, lastMove, viewerSeat);
    targetPoint = pointForMarbleState(state, 0, PLACE.FINISH, null, 0, 0, viewerSeat);
    viewPoints = [
      ...path,
      ...Array.from({ length: MARBLES_PER_PLAYER }, (_, slot) =>
        pointForMarbleState(state, 0, PLACE.FINISH, null, slot, 0, viewerSeat),
      ),
    ];
    label = "Black marble moves exactly into the first finish space";
  } else {
    const moving = setDemoMarble(state, 0, 0, PLACE.TRACK, 0);
    movingIdx = demoMarbleIndex(0, 0);
    const before = demoMarbleBefore(moving);
    const lastMove = makeDemoLastMove(movingIdx, before, PLACE.TRACK, 81, null, 3);
    path = renderBuildMovePath(state, lastMove, viewerSeat);
    targetPoint = pointForMarbleState(state, 0, PLACE.TRACK, 81, null, 0, viewerSeat);
    viewPoints = [
      ...path,
      pointForMarbleState(state, 0, PLACE.TRACK, 0, null, 0, viewerSeat),
      pointForMarbleState(state, 0, PLACE.FINISH, null, 0, 0, viewerSeat),
    ];
    label = "After leaving home with 1 or 6, Black marble 1 moves backward toward the gate on a 3";
  }

  return {
    state,
    viewerSeat,
    movingIdx,
    targetPoint,
    targetClass,
    capture,
    bumpedIdx,
    bumpedPath,
    label,
    path,
    viewBox: kind === "goal" ? "0 20 520 520" : demoViewBox(viewPoints),
  };
}

function demoTokenGroup(tokenLayerEl, marble) {
  return Array.from(tokenLayerEl.querySelectorAll("g")).find(
    (group) => group.getAttribute("aria-label") === marbleToken(marble),
  );
}

function appendAnimatedDemoToken(layer, marble, pathData, { dur = "2.4s", keyTimes = "0;0.68;1", keyPoints = "0;1;1" } = {}) {
  const group = svgEl("g", { class: "rules-demo-token", "aria-hidden": "true" });
  const motion = svgEl("animateMotion", {
    dur,
    repeatCount: "indefinite",
    path: pathData,
    keyTimes,
    keyPoints,
    calcMode: "linear",
  });
  group.append(motion);
  group.append(svgEl("circle", {
    class: "token",
    cx: 0,
    cy: 0,
    r: 10,
    fill: PLAYER_COLORS[marble.seat],
    stroke: PLAYER_STROKES[marble.seat],
  }));
  const label = svgEl("text", {
    class: "token-label",
    x: 0,
    y: 0.4,
    fill: tokenLabelColor(marble.seat),
  });
  label.textContent = String(marble.index + 1);
  group.append(label);
  layer.append(group);
}

function renderRulesDemo(container, kind) {
  const demo = buildRulesDemo(kind);
  const fillId = `rulesBoardFill-${kind}`;
  const clipId = `rulesBoardClip-${kind}`;
  const svg = svgEl("svg", {
    class: "rules-mini-board",
    viewBox: demo.viewBox,
    role: "img",
    "aria-label": demo.label,
  });

  const defs = svgEl("defs");
  const gradient = svgEl("linearGradient", { id: fillId, x1: "0", y1: "0", x2: "1", y2: "1" });
  gradient.append(svgEl("stop", { offset: "0%", "stop-color": "#f1d9aa" }));
  gradient.append(svgEl("stop", { offset: "100%", "stop-color": "#d9b572" }));
  const clipPath = svgEl("clipPath", { id: clipId });
  const boardClipShape = svgEl("polygon");
  clipPath.append(boardClipShape);
  defs.append(gradient, clipPath);
  svg.append(defs);

  const boardShapeEl = svgEl("polygon", {
    class: "rules-mini-board-shape",
    fill: `url(#${fillId})`,
  });
  const woodLayerEl = svgEl("g", { "clip-path": `url(#${clipId})` });
  const finishLayerEl = svgEl("g");
  const trackLayerEl = svgEl("g");
  const homeLayerEl = svgEl("g");
  const tokenLayerEl = svgEl("g");
  const overlayLayerEl = svgEl("g");
  svg.append(boardShapeEl, woodLayerEl, finishLayerEl, trackLayerEl, homeLayerEl, tokenLayerEl, overlayLayerEl);

  renderBoardLayers(
    {
      boardShape: boardShapeEl,
      boardClipShape,
      woodLayer: woodLayerEl,
      finishLayer: finishLayerEl,
      trackLayer: trackLayerEl,
      homeLayer: homeLayerEl,
      tokenLayer: tokenLayerEl,
    },
    demo.state,
    demo.viewerSeat,
  );

  const movingMarble = demo.state.marbles[demo.movingIdx];
  demoTokenGroup(tokenLayerEl, movingMarble)?.classList.add("rules-demo-dim-token");
  if (demo.bumpedIdx !== null) {
    demoTokenGroup(tokenLayerEl, demo.state.marbles[demo.bumpedIdx])?.classList.add("rules-demo-dim-token");
  }

  const movingPathData = demoPathData(demo.path);
  overlayLayerEl.append(svgEl("path", {
    class: "rules-demo-path",
    d: movingPathData,
  }));
  if (demo.bumpedPath) {
    overlayLayerEl.append(svgEl("path", {
      class: "rules-demo-path capture-return",
      d: demoPathData(demo.bumpedPath),
    }));
  }
  if (demo.targetPoint) {
    overlayLayerEl.append(svgEl("circle", {
      class: `rules-demo-target${demo.capture ? " capture" : ""}${demo.targetClass || ""}`,
      cx: demo.targetPoint.x,
      cy: demo.targetPoint.y,
      r: 16,
      style: `transform-origin:${demo.targetPoint.x}px ${demo.targetPoint.y}px`,
    }));
  }
  if (demo.targetClass !== " blocked") {
    appendAnimatedDemoToken(overlayLayerEl, movingMarble, movingPathData);
  }
  if (demo.bumpedPath && demo.bumpedIdx !== null) {
    appendAnimatedDemoToken(overlayLayerEl, demo.state.marbles[demo.bumpedIdx], demoPathData(demo.bumpedPath), {
      dur: "2.4s",
      keyTimes: "0;0.46;0.78;1",
      keyPoints: "0;0;1;1",
    });
  }

  container.replaceChildren(svg);
}

function renderRulesDemos() {
  if (!rulesModal) return;
  rulesModal.querySelectorAll("[data-rule-demo]").forEach((container) => {
    renderRulesDemo(container, container.dataset.ruleDemo);
  });
}

function openRulesModal() {
  if (!rulesModal) return;
  rulesModal.hidden = false;
  renderRulesDemos();
  rulesModal.querySelector(".rules-card")?.scrollTo({ top: 0 });
  rulesCloseBtn?.focus();
}

function closeRulesModal() {
  if (!rulesModal) return;
  rulesModal.hidden = true;
  howToPlayButton?.focus();
}

$on(howToPlayButton, "click", openRulesModal);
$on(rulesCloseBtn, "click", closeRulesModal);
$on(rulesGotItBtn, "click", closeRulesModal);
$on(rulesModal, "click", (event) => {
  if (event.target === rulesModal) closeRulesModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && rulesModal && !rulesModal.hidden) {
    closeRulesModal();
  }
});

function renderLobby() {
  const { code, players, adminName, mode, validModes: vm } = ui.lobby;
  lobbyCodeLabel.textContent = code;

  // Entry fee banner
  if (lobbyFeeBanner) {
    if (ui.entryFee) {
      const pot = ui.entryFee * players.length;
      lobbyFeeBanner.hidden = false;
      lobbyFeeBanner.innerHTML = `Buy-in <strong>${escapeHTML(formatMoney(ui.entryFee))}</strong> per player · pot <strong>${escapeHTML(formatMoney(pot))}</strong>`;
    } else {
      lobbyFeeBanner.hidden = true;
      lobbyFeeBanner.innerHTML = "";
    }
  }

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
      const handle = ui.playerHandles?.[p.name]?.venmo || null;
      let handleTag = "";
      if (ui.entryFee) {
        handleTag = handle
          ? `<span class="tag tag-handle" title="Venmo: @${escapeHTML(handle)}">@${escapeHTML(handle)}</span>`
          : '<span class="tag tag-missing">no handle</span>';
      }
      li.innerHTML = `<span class="slot-num">${i + 1}</span><span class="slot-name">${escapeHTML(p.name)}</span>${handleTag}${adminTag}${youTag}`;
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

  if (timeLimitPicker) {
    timeLimitPicker.replaceChildren();
    const selectedLimit = ui.turnTimeLimitSeconds ?? DEFAULT_TURN_TIME_LIMIT_SECONDS;
    if (ui.isAdmin) {
      const label = document.createElement("div");
      label.className = "mode-label";
      label.textContent = "Turn limit:";
      timeLimitPicker.append(label);
      TURN_TIME_LIMIT_OPTIONS.forEach((seconds) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `mode-button${selectedLimit === seconds ? " selected" : ""}`;
        btn.textContent = seconds === 0 ? "Off" : `${seconds}s`;
        btn.addEventListener("click", () => send({ type: "setTurnTimeLimit", seconds }));
        timeLimitPicker.append(btn);
      });
    } else {
      timeLimitPicker.textContent = `Turn limit: ${selectedLimit === 0 ? "Off" : `${selectedLimit}s`}`;
    }
  }

  startBtn.hidden = !ui.isAdmin;
  const missingHandles = ui.entryFee
    ? players.some((p) => !ui.playerHandles?.[p.name]?.venmo)
    : false;
  startBtn.disabled = players.length < 2 || !mode || missingHandles;
  startBtn.title = missingHandles
    ? "All players must add a Venmo handle before starting"
    : "";

  renderSettlement();
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
  Sound.play("click");
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
  if (adminGameDetails) adminGameDetails.hidden = !ui.isAdmin;
  resetGameBtn.hidden = !ui.isAdmin;
  endGameBtn.hidden = !ui.isAdmin;
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
  const noMoveAdvancePending = Boolean(state.noMoveRoll?.shouldAdvance);
  const canRoll = !state.gameOver && isMyTurn && state.pendingRoll == null && !noMoveAdvancePending;
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
  // Settlement
  renderSettlement();
  // Board + animation
  renderBoard();
  if (state.lastMove) {
    animateLastMove(state.lastMove);
    showCaptureFlare(state.lastMove);
  }
}

function formatTurnLimit(seconds) {
  return seconds === 0 ? "Off" : `${seconds}s`;
}

function updateTurnTimer() {
  if (!turnTimerChip) return;
  if (!ui.pendingMoveDeadlineAt || ui.view !== "game") {
    turnTimerChip.hidden = true;
    turnTimerChip.textContent = "";
    turnTimerChip.classList.remove("is-active", "is-urgent");
    if (turnTimerInterval) {
      clearInterval(turnTimerInterval);
      turnTimerInterval = null;
    }
    return;
  }

  const remaining = Math.max(0, Math.ceil((ui.pendingMoveDeadlineAt - Date.now()) / 1000));
  const isMyTurn = ui.game?.currentPlayer === localPlayerIdx();
  turnTimerChip.hidden = false;
  turnTimerChip.textContent = `${remaining}s`;
  turnTimerChip.title = `Move timer: ${formatTurnLimit(ui.turnTimeLimitSeconds)}`;
  turnTimerChip.classList.toggle("is-active", Boolean(isMyTurn));
  turnTimerChip.classList.toggle("is-urgent", remaining <= 5);

  if (!turnTimerInterval) {
    turnTimerInterval = setInterval(updateTurnTimer, 250);
  }
}

function transferState(t) {
  if (t.sentAt && t.receivedAt) return "settled";
  if (t.sentAt) return "sent";
  return "pending";
}

function renderSettlement() {
  if (!settlementPanel) return;
  const s = ui.settlement;
  if (!s) {
    settlementPanel.hidden = true;
    settlementPanel.replaceChildren();
    return;
  }
  settlementPanel.hidden = false;
  settlementPanel.replaceChildren();

  const me = ui.myName;
  const handles = ui.playerHandles || {};
  const settledCount = s.transfers.filter((t) => transferState(t) === "settled").length;

  const header = document.createElement("header");
  header.className = "settlement-header";
  header.innerHTML = `
    <div>
      <span class="section-label">Settlement</span>
      <p class="settlement-summary">Pot <strong>${escapeHTML(formatMoney(s.pot))}</strong> · winner share <strong>${escapeHTML(formatMoney(s.perWinnerShare))}</strong> · ${settledCount}/${s.transfers.length} settled</p>
    </div>
  `;
  settlementPanel.append(header);

  // Personal section: things involving me
  const myDebts = [];
  const myCredits = [];
  const otherTransfers = [];
  s.transfers.forEach((t, idx) => {
    if (t.from === me) myDebts.push({ t, idx });
    else if (t.to === me) myCredits.push({ t, idx });
    else otherTransfers.push({ t, idx });
  });

  if (myDebts.length) {
    const list = document.createElement("div");
    list.className = "settlement-section";
    list.innerHTML = `<h3>You owe</h3>`;
    myDebts.forEach(({ t, idx }) => list.append(renderDebtCard(t, idx, handles)));
    settlementPanel.append(list);
  }
  if (myCredits.length) {
    const list = document.createElement("div");
    list.className = "settlement-section";
    list.innerHTML = `<h3>Owed to you</h3>`;
    myCredits.forEach(({ t, idx }) => list.append(renderCreditCard(t, idx)));
    settlementPanel.append(list);
  }
  if (otherTransfers.length) {
    const list = document.createElement("div");
    list.className = "settlement-section settlement-others";
    list.innerHTML = `<h3>Others</h3>`;
    otherTransfers.forEach(({ t }) => {
      const row = document.createElement("div");
      row.className = `settlement-row state-${transferState(t)}`;
      row.innerHTML = `<span class="settlement-flow"><strong>${escapeHTML(t.from)}</strong> → <strong>${escapeHTML(t.to)}</strong></span><span class="settlement-amount">${escapeHTML(formatMoney(t.amount))}</span><span class="settlement-state">${transferState(t)}</span>`;
      list.append(row);
    });
    settlementPanel.append(list);
  }
}

function renderDebtCard(t, idx, handles) {
  const recipientHandle = handles?.[t.to]?.venmo || null;
  const noteCode = ui.roomCode ? ` ${ui.roomCode}` : "";
  const state = transferState(t);
  const card = document.createElement("div");
  card.className = `settlement-card debt state-${state}`;

  const head = document.createElement("div");
  head.className = "settlement-card-head";
  head.innerHTML = `
    <div class="settlement-card-title">Pay <strong>${escapeHTML(formatMoney(t.amount))}</strong> to <strong>${escapeHTML(t.to)}</strong></div>
    <div class="settlement-card-sub">${recipientHandle ? `Venmo @${escapeHTML(recipientHandle)}` : "No Venmo handle on file"}</div>
  `;
  card.append(head);

  const actions = document.createElement("div");
  actions.className = "settlement-actions";

  if (recipientHandle) {
    const link = venmoDeepLink(recipientHandle, t.amount, `Marbles${noteCode}`);
    const a = document.createElement("a");
    a.className = "primary-button settlement-pay-btn";
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open Venmo";
    actions.append(a);
  }

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "secondary-button settlement-toggle";
  toggleBtn.textContent = t.sentAt ? "Unmark sent" : "I sent it";
  toggleBtn.addEventListener("click", () => {
    send({ type: "markSent", transferIndex: idx, sent: !t.sentAt });
  });
  actions.append(toggleBtn);

  card.append(actions);
  return card;
}

function renderCreditCard(t, idx) {
  const state = transferState(t);
  const card = document.createElement("div");
  card.className = `settlement-card credit state-${state}`;
  card.innerHTML = `
    <div class="settlement-card-head">
      <div class="settlement-card-title"><strong>${escapeHTML(t.from)}</strong> owes you <strong>${escapeHTML(formatMoney(t.amount))}</strong></div>
      <div class="settlement-card-sub">${t.sentAt ? "Sender marked sent" : "Awaiting payment"}</div>
    </div>
  `;
  const actions = document.createElement("div");
  actions.className = "settlement-actions";
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "secondary-button settlement-toggle";
  toggleBtn.textContent = t.receivedAt ? "Unmark received" : "Received";
  toggleBtn.addEventListener("click", () => {
    send({ type: "markReceived", transferIndex: idx, received: !t.receivedAt });
  });
  actions.append(toggleBtn);
  card.append(actions);
  return card;
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
let lastCaptureFlareSig = null;

function animateLastMove(lastMove) {
  const sig = JSON.stringify(lastMove);
  if (sig === lastAnimatedMoveSig) return;
  lastAnimatedMoveSig = sig;
  const path = renderBuildMovePath(ui.game, lastMove, localSeat());
  const marble = ui.game.marbles[lastMove.marbleIdx];
  renderAnimateAlongPath(tokenLayer, marble, path, () => {});
}

function showCaptureFlare(lastMove) {
  if (!captureFlare || !captureFlareText || !ui.game || lastMove.bumpedIdx == null) return;
  const sig = JSON.stringify({
    lastMove,
    turnNumber: ui.game.turnNumber,
    logEntry: ui.game.log?.[0] || "",
  });
  if (sig === lastCaptureFlareSig) return;
  lastCaptureFlareSig = sig;

  const killer = ui.game.marbles[lastMove.marbleIdx];
  const killee = ui.game.marbles[lastMove.bumpedIdx];
  const killerName = ui.game.playerNames[killer?.player] || "Someone";
  const killeeName = ui.game.playerNames[killee?.player] || "someone";

  captureFlareText.textContent = `${killerName} smoked ${killeeName}`;
  captureFlare.hidden = false;
  captureFlare.classList.remove("is-showing");
  void captureFlare.offsetWidth;
  captureFlare.classList.add("is-showing");

  if (captureFlareTimer) clearTimeout(captureFlareTimer);
  captureFlareTimer = setTimeout(() => {
    captureFlare.hidden = true;
    captureFlare.classList.remove("is-showing");
  }, CAPTURE_FLARE_MS);
}

// --- Sound effect orchestration ---
// Compares the incoming gameState against tracked baselines and plays one
// sound per detected event. The first snapshot only seeds baselines (so a
// mid-game rejoin never fires spurious roll/win/your-turn sounds).
let sndPrevLobbyCount = null;
let sndPrevDieValue = null;
let sndPrevGameOver = false;
let sndPrevWasMyTurn = false;
let sndPrevDonePlayers = new Set();
let sndLastMoveSig = null;
let sndBaselineReady = false;

function donePlayersSet(state) {
  const out = new Set();
  for (let p = 0; p < state.playerNames.length; p += 1) {
    if (playerDone(state, p)) out.add(p);
  }
  return out;
}

function playGameSounds(state, wasLobby) {
  const isMyTurn = state.currentPlayer === localPlayerIdx() && !state.gameOver;
  let majorEventPlayed = false;

  // Game begins: a real lobby->game transition (never a mid-game rejoin).
  if (wasLobby) {
    Sound.play("start");
    majorEventPlayed = true;
  }

  if (!sndBaselineReady) {
    // Seed baselines without firing diff-derived sounds.
    sndBaselineReady = true;
    sndPrevDieValue = state.pendingDieValue ?? null;
    sndPrevGameOver = Boolean(state.gameOver);
    sndPrevWasMyTurn = isMyTurn;
    sndPrevDonePlayers = donePlayersSet(state);
    sndLastMoveSig = state.lastMove ? JSON.stringify(state.lastMove) : null;
    return;
  }

  // Dice roll: value transitions from none to 1..6.
  const die = state.pendingDieValue ?? null;
  if (die != null && sndPrevDieValue == null) Sound.play("roll");
  sndPrevDieValue = die;

  // One sound per move, by priority: capture > finish > leave-home > move.
  if (state.lastMove) {
    const sig = JSON.stringify(state.lastMove);
    if (sig !== sndLastMoveSig) {
      sndLastMoveSig = sig;
      const lm = state.lastMove;
      if (lm.bumpedIdx != null) Sound.play("capture");
      else if (lm.after?.place === PLACE.FINISH) Sound.play("finish");
      else if (lm.before?.place === PLACE.HOME && lm.after?.place === PLACE.TRACK) Sound.play("leaveHome");
      else Sound.play("move");
    }
  }

  // A player just got all their marbles home (distinct from the final win).
  const done = donePlayersSet(state);
  for (const p of done) {
    if (!sndPrevDonePlayers.has(p)) {
      Sound.play("playerDone");
      majorEventPlayed = true;
      break;
    }
  }
  sndPrevDonePlayers = done;

  // Win.
  if (state.gameOver && !sndPrevGameOver) {
    Sound.play("win");
    majorEventPlayed = true;
  }
  sndPrevGameOver = Boolean(state.gameOver);

  // Your-turn cue (local player only), suppressed if a bigger event just fired.
  if (isMyTurn && !sndPrevWasMyTurn && !majorEventPlayed) {
    Sound.play("yourTurn");
    if (navigator.vibrate) navigator.vibrate(200);
  }
  sndPrevWasMyTurn = isMyTurn;
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
  if (noMoveNoticeDelayTimer) clearTimeout(noMoveNoticeDelayTimer);
  if (noMoveNoticeTimer) clearTimeout(noMoveNoticeTimer);

  noMoveNoticeDelayTimer = setTimeout(() => {
    noMoveNoticeDelayTimer = null;

    const seat = ui.game.seatColors[noMoveRoll.player];
    const notice = ensureTurnNotice();
    notice.style.setProperty("--player-color", PLAYER_COLORS[seat]);
    notice.style.setProperty("--player-stroke", PLAYER_STROKES[seat]);
    notice.style.setProperty("--player-ink", tokenLabelColor(seat));
    notice.classList.add("no-move-turn-notice");
    notice.textContent = `Rolled ${noMoveRoll.dieValue}: no valid moves`;
    notice.hidden = false;
    notice.classList.remove("turn-notice-pulse");
    void notice.offsetWidth;
    notice.classList.add("turn-notice-pulse");

    noMoveNoticeTimer = setTimeout(() => {
      noMoveNoticeTimer = null;
      notice.hidden = true;
      notice.classList.remove("turn-notice-pulse", "no-move-turn-notice");
    }, noMoveRoll.noticeDurationMs ?? NO_MOVE_NOTICE_MS);
  }, noMoveRoll.noticeDelayMs ?? NO_MOVE_NOTICE_DELAY_MS);
}

function clearNoMoveNotice() {
  if (noMoveNoticeDelayTimer) {
    clearTimeout(noMoveNoticeDelayTimer);
    noMoveNoticeDelayTimer = null;
  }
  if (noMoveNoticeTimer) {
    clearTimeout(noMoveNoticeTimer);
    noMoveNoticeTimer = null;
  }
  if (turnNoticeEl) {
    turnNoticeEl.hidden = true;
    turnNoticeEl.classList.remove("turn-notice-pulse", "no-move-turn-notice");
  }
}

// --- Roll button ---
$on(rollButton, "click", () => {
  if (!ui.game || ui.game.gameOver) return;
  if (ui.game.currentPlayer !== localPlayerIdx()) return;
  if (ui.game.pendingRoll != null || diceSpinTimer) return;
  Sound.play("click");
  startDiceRollAnimation();
  send({ type: "roll" });
});

$on(resetGameBtn, "click", () => {
  if (!ui.isAdmin) return;
  if (!window.confirm("Reset this game and start over from the beginning?")) return;
  send({ type: "resetGame" });
});

$on(endGameBtn, "click", () => {
  if (!ui.isAdmin) return;
  if (!window.confirm("End this game and return everyone to the lobby?")) return;
  send({ type: "endGame" });
});

window.addEventListener("focus", () => {
  if (ui.view === "lobby") requestRoomSync();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && ui.view === "lobby") requestRoomSync();
  // Pause background music in a backgrounded tab (setTimeout throttling would
  // otherwise starve the scheduler) and resume it on return.
  if (document.hidden) {
    Sound.stopMusic();
  } else {
    Sound.startMusic();
  }
});

// Browsers require a user gesture before audio can play. Resume the audio
// context on the first interaction, start the background music, then stop
// listening.
function unlockAudioOnce() {
  Sound.unlock();
  Sound.startMusic();
  window.removeEventListener("pointerdown", unlockAudioOnce);
  window.removeEventListener("keydown", unlockAudioOnce);
}
window.addEventListener("pointerdown", unlockAudioOnce);
window.addEventListener("keydown", unlockAudioOnce);

function updateSoundToggle() {
  if (!soundToggleBtn) return;
  soundToggleBtn.classList.toggle("is-muted", Sound.muted);
  soundToggleBtn.setAttribute("aria-label", Sound.muted ? "Unmute sound effects" : "Mute sound effects");
}
$on(soundToggleBtn, "click", () => {
  Sound.unlock();
  const nowMuted = Sound.toggleMuted();
  updateSoundToggle();
  if (!nowMuted) Sound.play("click"); // brief confirmation when turning sound on
});

function updateMusicToggle() {
  if (!musicToggleBtn) return;
  musicToggleBtn.classList.toggle("is-muted", Sound.musicMuted);
  musicToggleBtn.setAttribute("aria-label", Sound.musicMuted ? "Turn music on" : "Turn music off");
}
$on(musicToggleBtn, "click", () => {
  Sound.unlock();
  Sound.toggleMusic();
  updateMusicToggle();
});

// --- Init ---
function init() {
  updateSoundToggle();
  updateMusicToggle();
  // Music plays app-wide, so its toggle is always available.
  if (musicToggleBtn) musicToggleBtn.hidden = false;
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

function getChatSenderColorForSeat(seat) {
  return seat === 0 ? tokenLabelColor(seat) : PLAYER_COLORS[seat];
}

function getColorForSender(senderName) {
  if (ui.game && ui.game.playerNames) {
    const pIdx = ui.game.playerNames.indexOf(senderName);
    if (pIdx >= 0 && ui.game.seatColors) {
      const seat = ui.game.seatColors[pIdx];
      if (seat !== undefined) return getChatSenderColorForSeat(seat);
    }
  } else if (ui.lobby && ui.lobby.players) {
    const pIdx = ui.lobby.players.findIndex(p => p.name === senderName);
    if (pIdx >= 0) {
      const seat = pIdx % PLAYER_COLORS.length;
      return getChatSenderColorForSeat(seat);
    }
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

// --- Voice Chat (WebRTC audio mesh) ---
// Each participant opens a direct RTCPeerConnection to every other one. Audio
// flows peer-to-peer; the /ws WebSocket only relays signaling. Nothing about
// voice is persisted server-side.
const voiceToggleBtn = document.querySelector("#voiceToggleBtn");
const voicePanel = document.querySelector("#voicePanel");
const voiceCloseBtn = document.querySelector("#voiceCloseBtn");
const voiceJoinBtn = document.querySelector("#voiceJoinBtn");
const voiceMuteBtn = document.querySelector("#voiceMuteBtn");
const voiceParticipantsEl = document.querySelector("#voiceParticipants");
const voiceAudioContainer = document.querySelector("#voiceAudioContainer");

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  // STUN-only for now. If players on restrictive home networks can't hear each
  // other, add a free TURN relay here (e.g. ExpressTURN) — one block, no other
  // changes needed:
  // { urls: "turn:relay1.expressturn.com:3478", username: "<id>", credential: "<key>" },
];

const voice = {
  active: false,      // have we joined voice (mic on)?
  muted: false,
  isOpen: false,      // is the panel open?
  localStream: null,
  peers: new Map(),   // peerName -> { pc, audioEl, pendingCandidates: [] }
};

function getPeer(name) {
  let peer = voice.peers.get(name);
  if (peer) return peer;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.dataset.peer = name;
  if (voiceAudioContainer) voiceAudioContainer.appendChild(audioEl);

  peer = { pc, audioEl, pendingCandidates: [] };
  voice.peers.set(name, peer);

  if (voice.localStream) {
    for (const track of voice.localStream.getTracks()) pc.addTrack(track, voice.localStream);
  }
  pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "voiceSignal", to: name, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => { renderVoice(); };
  return peer;
}

async function connectToPeer(name, isInitiator) {
  // Drop any stale connection to this peer first. This matters on reconnect:
  // a returning player builds fresh peer connections, so everyone must discard
  // the old one and renegotiate rather than reuse a dead RTCPeerConnection.
  if (voice.peers.has(name)) closePeer(name);
  const { pc } = getPeer(name);
  if (!isInitiator) return; // the other side will send us an offer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "voiceSignal", to: name, data: { sdp: pc.localDescription } });
  } catch (err) {
    console.warn("voice offer failed", err);
  }
}

async function onVoiceSignal(from, data) {
  if (!voice.active || !data) return;
  const peer = getPeer(from);
  const { pc } = peer;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      // Flush any ICE candidates that arrived before the description was set.
      for (const c of peer.pendingCandidates) {
        try { await pc.addIceCandidate(c); } catch {}
      }
      peer.pendingCandidates = [];
      if (data.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: "voiceSignal", to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(data.candidate); } catch {}
      } else {
        peer.pendingCandidates.push(data.candidate);
      }
    }
  } catch (err) {
    console.warn("voice signal handling failed", err);
  }
}

function closePeer(name) {
  const peer = voice.peers.get(name);
  if (!peer) return;
  try { peer.pc.close(); } catch {}
  if (peer.audioEl) {
    peer.audioEl.srcObject = null;
    peer.audioEl.remove();
  }
  voice.peers.delete(name);
  renderVoice();
}

function applyMute() {
  if (!voice.localStream) return;
  for (const t of voice.localStream.getAudioTracks()) t.enabled = !voice.muted;
}

async function joinVoice() {
  if (voice.active) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError("Voice chat isn't supported in this browser.");
    return;
  }
  try {
    voice.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showError("Microphone access is needed to join voice.");
    return;
  }
  voice.active = true;
  voice.muted = false;
  applyMute();
  send({ type: "voiceJoin" });
  renderVoice();
}

function leaveVoice() {
  if (!voice.active) return;
  send({ type: "voiceLeave" });
  for (const name of [...voice.peers.keys()]) closePeer(name);
  if (voice.localStream) {
    for (const t of voice.localStream.getTracks()) t.stop();
    voice.localStream = null;
  }
  voice.active = false;
  voice.muted = false;
  renderVoice();
}

function toggleMute() {
  if (!voice.active) return;
  voice.muted = !voice.muted;
  applyMute();
  renderVoice();
}

function toggleVoicePanel() {
  if (!voicePanel) return;
  voice.isOpen = !voice.isOpen;
  voicePanel.hidden = !voice.isOpen;
  voicePanel.classList.toggle("open", voice.isOpen);
  if (voice.isOpen) renderVoice();
}

function renderVoice() {
  if (voiceToggleBtn) voiceToggleBtn.classList.toggle("active", voice.active);
  if (voiceJoinBtn) {
    voiceJoinBtn.textContent = voice.active ? "Leave voice" : "Join voice";
    voiceJoinBtn.classList.toggle("active", voice.active);
  }
  if (voiceMuteBtn) {
    voiceMuteBtn.hidden = !voice.active;
    voiceMuteBtn.textContent = voice.muted ? "Unmute" : "Mute";
    voiceMuteBtn.classList.toggle("muted", voice.muted);
  }
  if (!voiceParticipantsEl) return;

  voiceParticipantsEl.innerHTML = "";
  const names = [];
  if (voice.active) names.push(ui.myName);
  for (const n of voice.peers.keys()) if (!names.includes(n)) names.push(n);

  if (names.length === 0) {
    const empty = document.createElement("div");
    empty.className = "voice-empty";
    empty.textContent = voice.active ? "Waiting for others to join…" : "No one in voice yet.";
    voiceParticipantsEl.appendChild(empty);
    return;
  }

  for (const n of names) {
    const row = document.createElement("div");
    row.className = "voice-participant";

    const dot = document.createElement("span");
    dot.className = "voice-dot";
    dot.style.background = getColorForSender(n);

    const label = document.createElement("span");
    label.className = "voice-name";
    label.textContent = n === ui.myName ? `${n} (you)` : n;

    row.appendChild(dot);
    row.appendChild(label);

    if (n === ui.myName && voice.muted) {
      const tag = document.createElement("span");
      tag.className = "voice-muted-tag";
      tag.textContent = "muted";
      row.appendChild(tag);
    }
    voiceParticipantsEl.appendChild(row);
  }
}

$on(voiceToggleBtn, "click", toggleVoicePanel);
$on(voiceCloseBtn, "click", () => { if (voice.isOpen) toggleVoicePanel(); });
$on(voiceJoinBtn, "click", () => { voice.active ? leaveVoice() : joinVoice(); });
$on(voiceMuteBtn, "click", toggleMute);

init();
