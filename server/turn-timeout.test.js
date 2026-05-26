import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState, PLACE } from "../public/shared/rules.js";
import {
  DEFAULT_TURN_TIME_LIMIT_SECONDS,
  continueTimedOutAutoPlay,
  normalizeTurnTimeLimit,
  rollForCurrentPlayer,
  submitPendingMoveForRoom,
  turnTimeLimitForRoom,
} from "./turn-timeout.js";

function makeRoom(state, opts = {}) {
  return {
    code: "TEST",
    phase: "playing",
    gameState: state,
    pendingMoves: null,
    pendingMovesFor: null,
    pendingMoveDeadlineAt: null,
    timedOutAutoPlayer: null,
    turnTimeLimitSeconds: opts.turnTimeLimitSeconds ?? DEFAULT_TURN_TIME_LIMIT_SECONDS,
    entryFee: null,
    settlement: null,
    lastMoveAt: null,
    completedAt: null,
  };
}

function makeTwoPlayerState() {
  return createInitialState({
    playerCount: 2,
    mode: "single",
    playerNames: ["Admin", "Player 2"],
  });
}

test("turn timeout config accepts only supported lobby values", () => {
  assert.equal(normalizeTurnTimeLimit(0), 0);
  assert.equal(normalizeTurnTimeLimit(15), 15);
  assert.equal(normalizeTurnTimeLimit("30"), 30);
  assert.equal(normalizeTurnTimeLimit(60), 60);
  assert.equal(normalizeTurnTimeLimit(10), null);
  assert.equal(normalizeTurnTimeLimit("off"), null);
});

test("turn timeout defaults old rooms to 30 seconds", () => {
  assert.equal(turnTimeLimitForRoom({}), 30);
});

test("roll with moves creates deadline and manual submit clears it", () => {
  const room = makeRoom(makeTwoPlayerState(), { turnTimeLimitSeconds: 15 });

  const moves = rollForCurrentPlayer(room, 6, 1_000);

  assert.equal(moves.length > 0, true);
  assert.equal(room.pendingMovesFor, "Admin");
  assert.equal(room.pendingMoveDeadlineAt, 16_000);

  const submitted = submitPendingMoveForRoom(room, 0, 2_000);
  assert.equal(submitted.ok, true);
  assert.equal(room.pendingMoves, null);
  assert.equal(room.pendingMovesFor, null);
  assert.equal(room.pendingMoveDeadlineAt, null);
});

test("roll with no moves does not create deadline", () => {
  const state = makeTwoPlayerState();
  state.marbles
    .filter((m) => m.player === 0)
    .forEach((marble, idx) => {
      marble.place = PLACE.FINISH;
      marble.finish = idx;
    });
  const room = makeRoom(state, { turnTimeLimitSeconds: 15 });

  const moves = rollForCurrentPlayer(room, 2, 1_000);

  assert.equal(moves.length, 0);
  assert.equal(room.pendingMoveDeadlineAt, null);
});

test("expired deadline submits first pending move", () => {
  const state = makeTwoPlayerState();
  state.marbles[0].place = PLACE.TRACK;
  state.marbles[0].progress = 0;
  const room = makeRoom(state, { turnTimeLimitSeconds: 15 });
  rollForCurrentPlayer(room, 2, 1_000);

  const result = continueTimedOutAutoPlay(room, 16_001, () => 3);

  assert.equal(result.changed, true);
  assert.equal(room.gameState.marbles[0].progress, 2);
  assert.equal(room.gameState.currentPlayer, 1);
  assert.equal(room.pendingMoves, null);
  assert.equal(room.pendingMoveDeadlineAt, null);
  assert.equal(room.timedOutAutoPlayer, null);
});

test("timeout auto-continues reroll chain without a second delay", () => {
  const room = makeRoom(makeTwoPlayerState(), { turnTimeLimitSeconds: 15 });
  rollForCurrentPlayer(room, 6, 1_000);

  const result = continueTimedOutAutoPlay(room, 16_001, () => 2);

  assert.equal(result.changed, true);
  assert.equal(room.gameState.currentPlayer, 1);
  assert.equal(room.pendingMoves, null);
  assert.equal(room.pendingMoveDeadlineAt, null);
  assert.equal(room.timedOutAutoPlayer, null);
});
