// Board geometry + SVG rendering. Pure of any specific client state — every
// function takes the game `state` and a `viewerSeat` (which seat sits at the
// bottom of the visual board).

import {
  FINISH_LEN,
  MARBLES_PER_PLAYER,
  SIDE_ROW_LEN,
  ARM_ROW_LEN,
  MODULE_LEN,
  TRACK_LEN,
  MAX_TRACK_PROGRESS,
  CENTER_PROGRESS,
  CORNER_PROGRESSES,
  START_OFFSET_IN_MODULE,
  PLAYER_COLORS,
  PLAYER_STROKES,
  PLACE,
  marbleToken,
} from "./rules.js";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const BOARD_CENTER = { x: 210, y: 222 };
export const BOARD_RADIUS = 190;
export const TRACK_RADIUS = 128;
export const CORNER_INSET = 130;

export const boardPoints = makeHexPoints(BOARD_RADIUS, 0);
export const baseTrackPoints = makeTrackPoints();

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

function makeHexPoints(radius, offsetDegrees) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = ((offsetDegrees + index * 60) * Math.PI) / 180;
    return {
      x: BOARD_CENTER.x + Math.cos(angle) * radius,
      y: BOARD_CENTER.y + Math.sin(angle) * radius,
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
    const toCenter = normalize({ x: BOARD_CENTER.x - corner.x, y: BOARD_CENTER.y - corner.y });
    return {
      x: corner.x + toCenter.x * CORNER_INSET,
      y: corner.y + toCenter.y * CORNER_INSET,
    };
  });
}

function makeArmPoints(sideRow, endpointIndex, direction, target) {
  // For direction "in", the arm enters this module FROM the previous corner's
  // apex (= target) and progresses TOWARD this module's side row endpoint.
  // arm_in[0] should sit just past the apex; arm_in[ARM_ROW_LEN - 1] should
  // sit just before the side row endpoint. Both directions therefore lerp from
  // the apex/sideRow endpoint that the path is leaving toward the one it is
  // approaching, with t increasing along travel.
  const endpoint = sideRow[endpointIndex];
  const segments = ARM_ROW_LEN + 1;
  return Array.from({ length: ARM_ROW_LEN }, (_, index) => {
    const t = (index + 1) / segments;
    return direction === "in" ? lerpPoint(target, endpoint, t) : lerpPoint(endpoint, target, t);
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
      x: BOARD_CENTER.x + normal.x * TRACK_RADIUS,
      y: BOARD_CENTER.y + normal.y * TRACK_RADIUS,
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

export function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

// --- Viewer-aware geometry ---

export function visualSeatForPlayer(state, player, viewerSeat) {
  const actualSeat = state.seatColors[player];
  return (actualSeat - viewerSeat + 6) % 6;
}

export function visualTrackIndex(absTrackIndex, viewerSeat) {
  return (absTrackIndex - viewerSeat * MODULE_LEN + TRACK_LEN) % TRACK_LEN;
}

export function trackPoint(absTrackIndex, viewerSeat) {
  return baseTrackPoints[visualTrackIndex(absTrackIndex, viewerSeat)];
}

export function visualSideCenter(state, player, viewerSeat) {
  const visSeat = visualSeatForPlayer(state, player, viewerSeat);
  const sideCenterIndex = visSeat * MODULE_LEN + ARM_ROW_LEN + Math.floor(SIDE_ROW_LEN / 2);
  return baseTrackPoints[sideCenterIndex];
}

export function finishPoint(state, player, slot, viewerSeat) {
  const sideCenter = visualSideCenter(state, player, viewerSeat);
  return lerpPoint(sideCenter, BOARD_CENTER, 0.155 + slot * 0.11);
}

export function homePoint(state, player, index, viewerSeat) {
  const sideCenter = visualSideCenter(state, player, viewerSeat);
  const away = normalize({ x: sideCenter.x - BOARD_CENTER.x, y: sideCenter.y - BOARD_CENTER.y });
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

export function tokenLabelColor(seat) {
  return seat === 2 || seat === 4 || seat === 5 ? "#1d2939" : "#ffffff";
}

export function tokenRadius(place) {
  if (place === PLACE.HOME) return 9;
  if (place === PLACE.FINISH) return 6.5;
  if (place === PLACE.CENTER) return 9;
  return 6.5;
}

export function pointForMarbleState(state, player, place, progress, finish, index, viewerSeat) {
  if (place === PLACE.HOME) return homePoint(state, player, index, viewerSeat);
  if (place === PLACE.CENTER) return BOARD_CENTER;
  if (place === PLACE.FINISH) return finishPoint(state, player, finish, viewerSeat);
  // TRACK
  const start = state.starts[player];
  const absIdx = (start + progress) % TRACK_LEN;
  return trackPoint(absIdx, viewerSeat);
}

export function pointForMarble(state, marble, viewerSeat) {
  return pointForMarbleState(state, marble.player, marble.place, marble.progress, marble.finish, marble.index, viewerSeat);
}

// --- SVG rendering ---

function renderWoodGrain(woodLayer) {
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

function renderCornerLabels(trackLayer, state, viewerSeat) {
  // Corner labels are oriented to the local viewer (the seat at the bottom of
  // the rendered board), not the current-turn player — otherwise the numbers
  // would shuffle every turn as the perspective rotates. The viewer's start
  // hole sits at absolute index `viewerSeat * MODULE_LEN + START_OFFSET_IN_MODULE`.
  const viewerStart = viewerSeat * MODULE_LEN + START_OFFSET_IN_MODULE;

  CORNER_PROGRESSES.forEach((cornerProgress, index) => {
    const point = trackPoint((viewerStart + cornerProgress) % TRACK_LEN, viewerSeat);
    const away = normalize({ x: point.x - BOARD_CENTER.x, y: point.y - BOARD_CENTER.y });
    const labelPoint = {
      x: point.x + away.x * 25,
      y: point.y + away.y * 25,
    };
    const text = svgEl("text", {
      class: "corner-label",
      x: labelPoint.x,
      y: labelPoint.y + 0.4,
    });
    text.textContent = String(index + 1);
    trackLayer.append(text);
  });
}

/**
 * Render the entire board to the provided SVG layers.
 * layers = { boardShape, boardClipShape, woodLayer, finishLayer, trackLayer, homeLayer, tokenLayer }
 */
export function renderBoardLayers(layers, state, viewerSeat) {
  const { boardShape, boardClipShape, woodLayer, trackLayer, finishLayer, homeLayer, tokenLayer } = layers;
  const boardPointString = boardPoints.map((p) => `${p.x},${p.y}`).join(" ");
  boardShape.setAttribute("points", boardPointString);
  boardClipShape.setAttribute("points", boardPointString);
  renderWoodGrain(woodLayer);
  trackLayer.replaceChildren();
  finishLayer.replaceChildren();
  homeLayer.replaceChildren();
  tokenLayer.replaceChildren();

  // Track holes (with start-hole highlight on each player's first track slot).
  const startSet = new Map();
  for (let p = 0; p < state.playerCount; p += 1) {
    startSet.set(state.starts[p], state.seatColors[p]);
  }
  for (let i = 0; i < TRACK_LEN; i += 1) {
    const point = baseTrackPoints[visualTrackIndex(i, viewerSeat)];
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

  renderCornerLabels(trackLayer, state, viewerSeat);

  // Center hole.
  finishLayer.append(svgEl("circle", {
    class: "hole center-hole",
    cx: BOARD_CENTER.x,
    cy: BOARD_CENTER.y,
    r: 5.1,
  }));

  // Finish lanes + home pads per active player.
  for (let player = 0; player < state.playerCount; player += 1) {
    const seat = state.seatColors[player];
    for (let slot = 0; slot < FINISH_LEN; slot += 1) {
      const point = finishPoint(state, player, slot, viewerSeat);
      finishLayer.append(svgEl("circle", {
        class: "finish-hole",
        cx: point.x,
        cy: point.y,
        r: 6,
        stroke: PLAYER_COLORS[seat],
      }));
    }
    for (let index = 0; index < MARBLES_PER_PLAYER; index += 1) {
      const point = homePoint(state, player, index, viewerSeat);
      homeLayer.append(svgEl("circle", {
        class: "home-pad",
        cx: point.x,
        cy: point.y,
        r: 7.5,
      }));
    }
  }

  // Marbles.
  state.marbles.forEach((marble) => {
    drawToken(tokenLayer, state, marble, viewerSeat);
  });
}

export function drawToken(tokenLayer, state, marble, viewerSeat) {
  const point = pointForMarble(state, marble, viewerSeat);
  const group = svgEl("g", {
    "aria-label": marbleToken(marble),
  });
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

export function findTokenElement(tokenLayer, marble) {
  return Array.from(tokenLayer.querySelectorAll("g")).find(
    (g) => g.getAttribute("aria-label") === marbleToken(marble),
  );
}

export function setTokenPosition(tokenEl, x, y) {
  const circle = tokenEl.querySelector("circle");
  const text = tokenEl.querySelector("text");
  circle.setAttribute("cx", x);
  circle.setAttribute("cy", y);
  text.setAttribute("x", x);
  text.setAttribute("y", y + 0.4);
}

// --- Animation ---

export function buildMovePath(state, lastMove, viewerSeat) {
  const marble = state.marbles[lastMove.marbleIdx];
  const player = marble.player;
  const trackHole = (progress) =>
    baseTrackPoints[visualTrackIndex((state.starts[player] + progress) % TRACK_LEN, viewerSeat)];

  const fromPoint = pointForMarbleState(
    state,
    player,
    lastMove.before.place,
    lastMove.before.progress,
    lastMove.before.finish,
    marble.index,
    viewerSeat,
  );
  const points = [fromPoint];

  if (lastMove.before.place === PLACE.HOME && lastMove.targetPlace === PLACE.TRACK) {
    points.push(trackHole(lastMove.targetProgress));
    return points;
  }
  if (lastMove.before.place === PLACE.TRACK && lastMove.targetPlace === PLACE.TRACK) {
    const isBackwardToGateway = lastMove.before.progress === 0 && lastMove.targetProgress === 81;
    if (isBackwardToGateway) {
      points.push(trackHole(83));
      points.push(trackHole(82));
      points.push(trackHole(81));
    } else {
      const fromIdx = CORNER_PROGRESSES.indexOf(lastMove.before.progress);
      const toIdx = CORNER_PROGRESSES.indexOf(lastMove.targetProgress);
      const isCornerJump = fromIdx >= 0 && toIdx >= 0 && toIdx > fromIdx && lastMove.targetProgress - lastMove.before.progress > 1;
      if (isCornerJump) {
        for (let i = fromIdx + 1; i <= toIdx; i += 1) points.push(trackHole(CORNER_PROGRESSES[i]));
      } else {
        for (let p = lastMove.before.progress + 1; p <= lastMove.targetProgress; p += 1) points.push(trackHole(p));
      }
    }
    return points;
  }
  if (lastMove.before.place === PLACE.TRACK && lastMove.targetPlace === PLACE.CENTER) {
    for (let p = lastMove.before.progress + 1; p < CENTER_PROGRESS; p += 1) points.push(trackHole(p));
    points.push(BOARD_CENTER);
    return points;
  }
  if (lastMove.before.place === PLACE.TRACK && lastMove.targetPlace === PLACE.FINISH) {
    if (lastMove.before.progress < MAX_TRACK_PROGRESS) {
      for (let p = lastMove.before.progress + 1; p <= MAX_TRACK_PROGRESS; p += 1) points.push(trackHole(p));
    }
    for (let s = 0; s <= lastMove.targetFinish; s += 1) points.push(finishPoint(state, player, s, viewerSeat));
    return points;
  }
  if (lastMove.before.place === PLACE.FINISH && lastMove.targetPlace === PLACE.FINISH) {
    for (let s = lastMove.before.finish + 1; s <= lastMove.targetFinish; s += 1) points.push(finishPoint(state, player, s, viewerSeat));
    return points;
  }
  if (lastMove.before.place === PLACE.CENTER && lastMove.targetPlace === PLACE.TRACK) {
    points.push(trackHole(lastMove.targetProgress));
    return points;
  }
  return points;
}

let activeAnimationToken = 0;

export function animateAlongPath(tokenLayer, marble, path, onDone) {
  activeAnimationToken += 1;
  const myToken = activeAnimationToken;
  if (path.length < 2) { onDone(); return; }
  const tokenEl = findTokenElement(tokenLayer, marble);
  if (!tokenEl) { onDone(); return; }

  const metrics = buildPathMetrics(path);
  if (metrics.totalDistance === 0) {
    setTokenPosition(tokenEl, path[path.length - 1].x, path[path.length - 1].y);
    onDone();
    return;
  }

  const duration = Math.min(1100, Math.max(260, metrics.totalDistance * 6.5));
  const start = performance.now();
  setTokenPosition(tokenEl, path[0].x, path[0].y);

  function frame(now) {
    if (myToken !== activeAnimationToken || !tokenLayer.contains(tokenEl)) return;
    const rawT = Math.min(1, (now - start) / duration);
    const point = pointAtDistance(metrics, easeInOutCubic(rawT) * metrics.totalDistance);
    setTokenPosition(tokenEl, point.x, point.y);
    if (rawT < 1) {
      requestAnimationFrame(frame);
      return;
    }
    const finalPoint = path[path.length - 1];
    setTokenPosition(tokenEl, finalPoint.x, finalPoint.y);
    onDone();
  }
  requestAnimationFrame(frame);
}

function buildPathMetrics(path) {
  const segments = [];
  let totalDistance = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i];
    const to = path[i + 1];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    segments.push({ from, to, start: totalDistance, length });
    totalDistance += length;
  }
  return { segments, totalDistance };
}

function pointAtDistance(metrics, distance) {
  const target = Math.max(0, Math.min(metrics.totalDistance, distance));
  const segment = metrics.segments.find((item) => target <= item.start + item.length) || metrics.segments.at(-1);
  if (!segment || segment.length === 0) return segment?.to || { x: 0, y: 0 };
  const t = (target - segment.start) / segment.length;
  return lerpPoint(segment.from, segment.to, t);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}
