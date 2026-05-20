// Local debug harness — runs the game purely client-side via shared/rules.js
// so we can reproduce specific board states without spinning up the server +
// multiple browser tabs.

import {
  PLACE,
  PLAYER_COLORS,
  PLAYER_STROKES,
  PLAYER_NAMES,
  PLAYER_SHORT,
  TRACK_LEN,
  MODES,
  validModes,
  modeLabel,
  marbleToken,
  createInitialState,
  legalMoves,
  applyMove,
  rollAndCompute,
} from "./shared/rules.js";

import {
  renderBoardLayers,
  buildMovePath,
  animateAlongPath,
  tokenLabelColor,
} from "./shared/board-render.js?v=2";

// ---------- DOM refs ----------

const errorBanner = document.querySelector("#errorBanner");
const setupView = document.querySelector("#debugSetup");
const gameView = document.querySelector("#debugGame");

const playerCountSelect = document.querySelector("#dbgPlayerCount");
const modeSelect = document.querySelector("#dbgMode");
const namesGrid = document.querySelector("#dbgNamesGrid");
const startBtn = document.querySelector("#dbgStartBtn");
const restartBtn = document.querySelector("#dbgRestartBtn");

const turnLabel = document.querySelector("#dbgTurnLabel");
const currentPlayerSelect = document.querySelector("#dbgCurrentPlayer");

const forceDieInput = document.querySelector("#dbgForceDie");
const rollBtn = document.querySelector("#dbgRollBtn");
const endTurnBtn = document.querySelector("#dbgEndTurnBtn");
const dieReadout = document.querySelector("#dbgDieReadout");
const movesPanel = document.querySelector("#dbgMovesPanel");
const selectionInfo = document.querySelector("#dbgSelectionInfo");

const sendHomeBtn = document.querySelector("#dbgSendHome");
const sendCenterBtn = document.querySelector("#dbgSendCenter");
const sendFinishBtn = document.querySelector("#dbgSendFinish");
const finishSlotSelect = document.querySelector("#dbgFinishSlot");

const statusPanel = document.querySelector("#dbgStatusPanel");

const boardShape = document.querySelector("#boardShape");
const boardClipShape = document.querySelector("#boardClipShape");
const woodLayer = document.querySelector("#woodLayer");
const trackLayer = document.querySelector("#trackLayer");
const finishLayer = document.querySelector("#finishLayer");
const homeLayer = document.querySelector("#homeLayer");
const tokenLayer = document.querySelector("#tokenLayer");
const boardSvg = document.querySelector("#board");

const VIEWER_SEAT = 0;

// ---------- Debug state ----------

const dbg = {
  state: null,           // game state once started
  pendingMoves: null,    // moves from latest roll
  selectedMarbleIdx: null,
};

// ---------- Helpers ----------

function $on(el, ev, fn) {
  if (el) el.addEventListener(ev, fn);
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
  setTimeout(() => { errorBanner.hidden = true; }, 4000);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ---------- Setup phase ----------

function refreshModeOptions() {
  const count = Number(playerCountSelect.value);
  const allowed = validModes(count);
  const prev = modeSelect.value;
  modeSelect.replaceChildren();
  allowed.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = modeLabel(m, count);
    modeSelect.append(opt);
  });
  if (allowed.includes(prev)) modeSelect.value = prev;
}

function refreshNamesGrid() {
  const count = Number(playerCountSelect.value);
  const existing = Array.from(namesGrid.querySelectorAll("input")).map((i) => i.value);
  namesGrid.replaceChildren();
  const legend = document.createElement("legend");
  legend.textContent = "Player names";
  namesGrid.append(legend);
  for (let i = 0; i < count; i += 1) {
    const lab = document.createElement("label");
    lab.className = "inline-label";
    lab.textContent = `P${i + 1}`;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.maxLength = 20;
    inp.value = existing[i] || `P${i + 1}`;
    lab.append(inp);
    namesGrid.append(lab);
  }
}

$on(playerCountSelect, "change", () => {
  refreshModeOptions();
  refreshNamesGrid();
});

$on(startBtn, "click", () => {
  const playerCount = Number(playerCountSelect.value);
  const mode = modeSelect.value || MODES.SINGLE;
  const names = Array.from(namesGrid.querySelectorAll("input")).map((i) => i.value.trim() || "P?");
  try {
    dbg.state = createInitialState({ playerCount, mode, playerNames: names });
  } catch (e) {
    return showError(e.message);
  }
  dbg.pendingMoves = null;
  dbg.selectedMarbleIdx = null;
  setupView.hidden = true;
  gameView.hidden = false;
  populateCurrentPlayerSelect();
  render();
});

$on(restartBtn, "click", () => {
  dbg.state = null;
  dbg.pendingMoves = null;
  dbg.selectedMarbleIdx = null;
  gameView.hidden = true;
  setupView.hidden = false;
});

// ---------- Game phase ----------

function populateCurrentPlayerSelect() {
  currentPlayerSelect.replaceChildren();
  dbg.state.playerNames.forEach((name, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = `${idx + 1}. ${name}`;
    currentPlayerSelect.append(opt);
  });
  currentPlayerSelect.value = String(dbg.state.currentPlayer);
}

$on(currentPlayerSelect, "change", () => {
  if (!dbg.state) return;
  dbg.state.currentPlayer = Number(currentPlayerSelect.value);
  dbg.state.pendingRoll = null;
  dbg.state.pendingDieValue = null;
  dbg.pendingMoves = null;
  render();
});

$on(rollBtn, "click", () => {
  if (!dbg.state || dbg.state.gameOver) return;
  let dieValue;
  const forced = forceDieInput.value.trim();
  if (forced === "") {
    dieValue = Math.floor(Math.random() * 6) + 1;
  } else {
    dieValue = Math.max(1, Math.min(6, Math.floor(Number(forced))));
    if (!Number.isFinite(dieValue)) dieValue = 1;
  }
  // rollAndCompute resets pendingRoll first; we wipe it ourselves to allow re-roll.
  dbg.state.pendingRoll = null;
  dbg.state.pendingDieValue = null;
  dbg.pendingMoves = rollAndCompute(dbg.state, dieValue);
  if (dbg.pendingMoves.length === 0) dbg.pendingMoves = null;
  render();
});

$on(endTurnBtn, "click", () => {
  if (!dbg.state) return;
  dbg.state.currentPlayer = (dbg.state.currentPlayer + 1) % dbg.state.playerCount;
  if (dbg.state.currentPlayer === 0) dbg.state.turnNumber += 1;
  dbg.state.pendingRoll = null;
  dbg.state.pendingDieValue = null;
  dbg.pendingMoves = null;
  dbg.state.log.unshift(`(debug) advanced to ${dbg.state.playerNames[dbg.state.currentPlayer]}`);
  render();
});

function submitMove(idx) {
  if (!dbg.pendingMoves || !dbg.pendingMoves[idx]) return;
  const move = dbg.pendingMoves[idx];
  const dieValue = dbg.state.pendingDieValue;
  const lastMoveBefore = JSON.stringify(dbg.state.lastMove);
  applyMove(dbg.state, move, dieValue);
  dbg.pendingMoves = null;
  render();
  // Animate after render.
  if (dbg.state.lastMove && JSON.stringify(dbg.state.lastMove) !== lastMoveBefore) {
    const path = buildMovePath(dbg.state, dbg.state.lastMove, VIEWER_SEAT);
    const marble = dbg.state.marbles[dbg.state.lastMove.marbleIdx];
    animateAlongPath(tokenLayer, marble, path, () => {});
  }
}

// ---------- God mode (click-to-select + click-to-place) ----------

function deselect() {
  dbg.selectedMarbleIdx = null;
  updateGodControls();
  refreshSelectionHighlight();
}

function selectMarble(marbleIdx) {
  if (dbg.selectedMarbleIdx === marbleIdx) {
    deselect();
    return;
  }
  dbg.selectedMarbleIdx = marbleIdx;
  updateGodControls();
  refreshSelectionHighlight();
}

function updateGodControls() {
  const idx = dbg.selectedMarbleIdx;
  const selected = idx == null ? null : dbg.state.marbles[idx];
  selectionInfo.textContent = selected
    ? `Selected: ${marbleToken(selected)} (${dbg.state.playerNames[selected.player]}) — ${describePlace(selected)}`
    : "No marble selected.";
  for (const btn of [sendHomeBtn, sendCenterBtn, sendFinishBtn]) btn.disabled = !selected;
  finishSlotSelect.disabled = !selected;
}

function describePlace(marble) {
  switch (marble.place) {
    case PLACE.HOME: return `home pad #${marble.index + 1}`;
    case PLACE.TRACK: return `track progress ${marble.progress}`;
    case PLACE.FINISH: return `finish slot ${marble.finish + 1}`;
    case PLACE.CENTER: return "center";
    default: return marble.place;
  }
}

function refreshSelectionHighlight() {
  tokenLayer.querySelectorAll("g").forEach((g) => {
    const i = Number(g.dataset.marbleIdx);
    g.classList.toggle("selected", i === dbg.selectedMarbleIdx);
  });
}

function teleportSelectedTo(target) {
  if (dbg.selectedMarbleIdx == null) return;
  const marble = dbg.state.marbles[dbg.selectedMarbleIdx];
  const before = { place: marble.place, progress: marble.progress, finish: marble.finish, index: marble.index };
  marble.place = target.place;
  marble.progress = target.progress ?? null;
  marble.finish = target.finish ?? null;

  // If teleporting to track or finish, send any existing occupant home (cosmetic — debug only).
  if (target.place === PLACE.TRACK) {
    const start = dbg.state.starts[marble.player];
    const abs = (start + target.progress) % TRACK_LEN;
    for (const m of dbg.state.marbles) {
      if (m === marble) continue;
      if (m.place === PLACE.TRACK) {
        const mStart = dbg.state.starts[m.player];
        const mAbs = (mStart + m.progress) % TRACK_LEN;
        if (mAbs === abs) {
          m.place = PLACE.HOME;
          m.progress = null;
          m.finish = null;
        }
      }
    }
  } else if (target.place === PLACE.CENTER) {
    for (const m of dbg.state.marbles) {
      if (m !== marble && m.place === PLACE.CENTER) {
        m.place = PLACE.HOME;
        m.progress = null;
        m.finish = null;
      }
    }
  } else if (target.place === PLACE.FINISH) {
    for (const m of dbg.state.marbles) {
      if (m !== marble && m.place === PLACE.FINISH && m.player === marble.player && m.finish === target.finish) {
        m.place = PLACE.HOME;
        m.progress = null;
        m.finish = null;
      }
    }
  }

  dbg.state.log.unshift(
    `(debug) ${marbleToken(marble)} ${describeBefore(before)} → ${describePlace(marble)}`,
  );
  dbg.pendingMoves = null; // moves invalidated
  deselect();
  render();
}

function describeBefore(before) {
  switch (before.place) {
    case PLACE.HOME: return `from home #${before.index + 1}`;
    case PLACE.TRACK: return `from progress ${before.progress}`;
    case PLACE.FINISH: return `from finish slot ${before.finish + 1}`;
    case PLACE.CENTER: return "from center";
    default: return `from ${before.place}`;
  }
}

// Click anywhere on the SVG: figure out what was clicked via data attrs.
$on(boardSvg, "click", (ev) => {
  if (!dbg.state) return;
  const el = ev.target;
  if (!(el instanceof Element)) return;

  // Marble token group?
  const tokenGroup = el.closest("g[data-marble-idx]");
  if (tokenGroup) {
    selectMarble(Number(tokenGroup.dataset.marbleIdx));
    return;
  }

  // Hole / pad with data-place?
  const placed = el.closest("[data-place]");
  if (placed && dbg.selectedMarbleIdx != null) {
    const place = placed.dataset.place;
    if (place === PLACE.TRACK) {
      const absIdx = Number(placed.dataset.absIdx);
      const marble = dbg.state.marbles[dbg.selectedMarbleIdx];
      const start = dbg.state.starts[marble.player];
      const progress = (absIdx - start + TRACK_LEN) % TRACK_LEN;
      teleportSelectedTo({ place: PLACE.TRACK, progress });
    } else if (place === PLACE.HOME) {
      const player = Number(placed.dataset.player);
      const index = Number(placed.dataset.index);
      const marble = dbg.state.marbles[dbg.selectedMarbleIdx];
      // We don't reassign player ownership here — teleport into THIS player's home
      // only if the marble belongs to this player; otherwise send to its own home.
      if (player === marble.player) {
        marble.index = index;
      }
      teleportSelectedTo({ place: PLACE.HOME });
    } else if (place === PLACE.FINISH) {
      const player = Number(placed.dataset.player);
      const slot = Number(placed.dataset.slot);
      const marble = dbg.state.marbles[dbg.selectedMarbleIdx];
      if (player !== marble.player) {
        showError("Marble can only go to its own finish lane.");
        return;
      }
      teleportSelectedTo({ place: PLACE.FINISH, finish: slot });
    } else if (place === PLACE.CENTER) {
      teleportSelectedTo({ place: PLACE.CENTER });
    }
    return;
  }
  // Clicked empty board area → deselect.
  deselect();
});

$on(sendHomeBtn, "click", () => teleportSelectedTo({ place: PLACE.HOME }));
$on(sendCenterBtn, "click", () => teleportSelectedTo({ place: PLACE.CENTER }));
$on(sendFinishBtn, "click", () => teleportSelectedTo({
  place: PLACE.FINISH,
  finish: Number(finishSlotSelect.value),
}));

// ---------- Rendering ----------

function render() {
  const state = dbg.state;
  if (!state) return;

  // Turn label
  const cp = state.currentPlayer;
  const seat = state.seatColors[cp];
  movesPanel.style.setProperty("--current-player-color", PLAYER_COLORS[seat]);
  movesPanel.style.setProperty("--current-player-stroke", PLAYER_STROKES[seat]);
  movesPanel.style.setProperty("--current-player-ink", tokenLabelColor(seat));
  if (state.gameOver) {
    turnLabel.innerHTML = `<span class="winner">${escapeHTML(state.winner)} wins</span>`;
  } else {
    turnLabel.innerHTML = `<span class="section-label">Current turn</span><span class="current-player" style="--player-color:${PLAYER_COLORS[seat]};--player-stroke:${PLAYER_STROKES[seat]};--player-ink:${tokenLabelColor(seat)}">${escapeHTML(state.playerNames[cp])}</span>`;
  }
  currentPlayerSelect.value = String(state.currentPlayer);

  // Die readout
  if (state.pendingDieValue != null) {
    dieReadout.textContent = `Rolled ${state.pendingDieValue}${dbg.pendingMoves ? " — choose a move below" : " — no legal move"}`;
  } else {
    dieReadout.textContent = "No roll yet.";
  }

  // Moves
  movesPanel.replaceChildren();
  if (dbg.pendingMoves && dbg.pendingMoves.length > 0) {
    dbg.pendingMoves.forEach((m, idx) => {
      const b = document.createElement("button");
      b.className = "move-button";
      b.type = "button";
      b.textContent = m.label;
      b.addEventListener("click", () => submitMove(idx));
      movesPanel.append(b);
    });
  } else if (state.pendingDieValue != null) {
    const p = document.createElement("p");
    p.className = "moves-note";
    p.textContent = "No legal move for that roll.";
    movesPanel.append(p);
  }

  // Board
  renderBoardLayers(
    { boardShape, boardClipShape, woodLayer, trackLayer, finishLayer, homeLayer, tokenLayer },
    state,
    VIEWER_SEAT,
  );
  refreshSelectionHighlight();
  updateGodControls();

  // Status panel
  renderStatus();
}

function renderStatus() {
  const state = dbg.state;
  const rows = [];
  for (let player = 0; player < state.playerCount; player += 1) {
    const seat = state.seatColors[player];
    const marbles = state.marbles.filter((m) => m.player === player);
    const home = marbles.filter((m) => m.place === PLACE.HOME).length;
    const track = marbles.filter((m) => m.place === PLACE.TRACK).length;
    const fin = marbles.filter((m) => m.place === PLACE.FINISH).length;
    const cen = marbles.filter((m) => m.place === PLACE.CENTER).length;
    const teamSuffix = state.teams ? ` · Team ${String.fromCharCode(65 + state.teams.findIndex((t) => t.includes(player)))}` : "";
    rows.push(
      `<div class="player-row"><span><span class="swatch" style="background:${PLAYER_COLORS[seat]};border:1px solid ${PLAYER_STROKES[seat]}"></span>${escapeHTML(state.playerNames[player])} (${PLAYER_SHORT[seat]})</span><span>home ${home} · track ${track} · finish ${fin}${cen ? " · CENTER" : ""}${teamSuffix}</span></div>`,
    );
  }
  const recent = state.log.slice(0, 10).map((e) => `<div class="log-row">${escapeHTML(e)}</div>`).join("");
  statusPanel.innerHTML = `<div class="info-group"><h2>Players</h2>${rows.join("")}</div><div class="info-group"><h2>History</h2>${recent}</div>`;
}

// ---------- Init ----------

refreshModeOptions();
refreshNamesGrid();
