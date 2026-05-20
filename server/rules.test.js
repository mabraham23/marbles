import test from "node:test";
import assert from "node:assert/strict";

import {
  MODES,
  validModes,
  assignSeats,
  createInitialState,
  rollAndCompute,
  applyMove,
  legalMoves,
  PLACE,
  MARBLES_PER_PLAYER,
} from "../public/shared/rules.js";

test("validModes by player count", () => {
  assert.deepEqual(validModes(2), [MODES.SINGLE]);
  assert.deepEqual(validModes(3), [MODES.SINGLE]);
  assert.deepEqual(validModes(4), [MODES.SINGLE, MODES.PAIRS]);
  assert.deepEqual(validModes(5), [MODES.SINGLE]);
  assert.deepEqual(validModes(6), [MODES.SINGLE, MODES.PAIRS, MODES.TRIADS]);
});

test("assignSeats — 2 players: opposite seats", () => {
  const { seatColors, teams } = assignSeats(2, MODES.SINGLE);
  assert.deepEqual(seatColors, [0, 3]);
  assert.equal(teams, null);
});

test("assignSeats — 3 players: alternating evens", () => {
  const { seatColors, teams } = assignSeats(3, MODES.SINGLE);
  assert.deepEqual(seatColors, [0, 2, 4]);
  assert.equal(teams, null);
});

test("assignSeats — 4 players single vs pairs", () => {
  const solo = assignSeats(4, MODES.SINGLE);
  assert.deepEqual(solo.seatColors, [0, 1, 2, 3]);
  assert.equal(solo.teams, null);

  const pairs = assignSeats(4, MODES.PAIRS);
  assert.deepEqual(pairs.seatColors, [0, 1, 2, 3]);
  assert.deepEqual(pairs.teams, [[0, 2], [1, 3]]);
});

test("assignSeats — 5 players: single only, all 5 seats", () => {
  const { seatColors, teams } = assignSeats(5, MODES.SINGLE);
  assert.deepEqual(seatColors, [0, 1, 2, 3, 4]);
  assert.equal(teams, null);
});

test("assignSeats — 6 players: all modes", () => {
  const solo = assignSeats(6, MODES.SINGLE);
  assert.deepEqual(solo.seatColors, [0, 1, 2, 3, 4, 5]);
  assert.equal(solo.teams, null);

  const triads = assignSeats(6, MODES.TRIADS);
  assert.deepEqual(triads.seatColors, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(triads.teams, [[0, 2, 4], [1, 3, 5]]);

  const pairs = assignSeats(6, MODES.PAIRS);
  assert.deepEqual(pairs.seatColors, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(pairs.teams, [[0, 3], [1, 4], [2, 5]]);
});

test("assignSeats — invalid mode falls back to single", () => {
  const { seatColors, teams } = assignSeats(3, MODES.PAIRS);
  assert.deepEqual(seatColors, [0, 2, 4]);
  assert.equal(teams, null);
});

test("assignSeats — unsupported player count throws", () => {
  assert.throws(() => assignSeats(7, MODES.SINGLE));
  assert.throws(() => assignSeats(1, MODES.SINGLE));
});

test("createInitialState shape", () => {
  const state = createInitialState({
    playerCount: 4,
    mode: MODES.PAIRS,
    playerNames: ["A", "B", "C", "D"],
  });
  assert.equal(state.playerCount, 4);
  assert.equal(state.marbles.length, 4 * MARBLES_PER_PLAYER);
  assert.equal(state.currentPlayer, 0);
  assert.equal(state.turnNumber, 1);
  assert.equal(state.pendingRoll, null);
  assert.equal(state.gameOver, false);
  assert.deepEqual(state.playerNames, ["A", "B", "C", "D"]);
  assert.deepEqual(state.teams, [[0, 2], [1, 3]]);
  // Every marble starts at home.
  assert.ok(state.marbles.every((m) => m.place === PLACE.HOME));
});

test("smoke: roll a 6 then apply 'leaves home' move", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["A", "B"],
  });
  const moves = rollAndCompute(state, 6);
  assert.ok(moves.length >= 1, "expected leave-home move on a 6");
  const leave = moves.find((m) => m.label.includes("leaves home"));
  assert.ok(leave, "expected a leaves-home move");
  applyMove(state, leave, 6);
  // One marble should be on the track at progress 0.
  const onTrack = state.marbles.filter((m) => m.place === PLACE.TRACK);
  assert.equal(onTrack.length, 1);
  assert.equal(onTrack[0].progress, 0);
  // Rolling a 6 grants a re-roll: same player still up.
  assert.equal(state.currentPlayer, 0);
});

test("smoke: roll 0 moves with non-reroll advances player", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["A", "B"],
  });
  // 3 cannot get anyone out of home and there's nothing on the track.
  const moves = rollAndCompute(state, 3);
  assert.equal(moves.length, 0);
  assert.equal(state.currentPlayer, 1, "non-reroll with no moves advances");
});

test("smoke: legalMoves consistent with rollAndCompute", () => {
  const state = createInitialState({
    playerCount: 4,
    mode: MODES.SINGLE,
    playerNames: ["A", "B", "C", "D"],
  });
  const computed = rollAndCompute(state, 6);
  const direct = legalMoves(state, state.currentPlayer, 6);
  assert.equal(computed.length, direct.length);
});
