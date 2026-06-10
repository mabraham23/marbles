import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState, PLACE } from "../public/shared/rules.js";
import {
  DEFAULT_TURN_TIME_LIMIT_SECONDS,
  NO_MOVE_DIE_DISPLAY_MS,
  NO_MOVE_NOTICE_MS,
  continueDelayedNoMoveRoll,
  continueTimedOutAutoPlay,
  normalizeTurnTimeLimit,
  rollForCurrentPlayer,
  submitPendingMoveForRoom,
  syncTurnDeadline,
  turnTimeLimitForRoom,
} from "./turn-timeout.js";

function makeRoom(state, opts = {}) {
  return {
    code: "TEST",
    phase: "playing",
    players: (state?.playerNames || []).map((name) => ({ name })),
    gameState: state,
    pendingMoves: null,
    pendingMovesFor: null,
    pendingMoveDeadlineAt: null,
    turnDeadlineKey: null,
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

test("turn deadline covers roll + move, and a reroll resets the clock", () => {
  const room = makeRoom(makeTwoPlayerState(), { turnTimeLimitSeconds: 15 });

  syncTurnDeadline(room, 1_000);
  assert.equal(room.pendingMoveDeadlineAt, 16_000);

  // Rolling does not restart the clock.
  const moves = rollForCurrentPlayer(room, 6, 5_000);
  assert.equal(moves.length > 0, true);
  assert.equal(room.pendingMovesFor, "Admin");
  syncTurnDeadline(room, 5_000);
  assert.equal(room.pendingMoveDeadlineAt, 16_000);

  // A reroll move (rolled 6) keeps the turn but grants a fresh window.
  const submitted = submitPendingMoveForRoom(room, 0, 6_000);
  assert.equal(submitted.ok, true);
  syncTurnDeadline(room, 6_000);
  assert.equal(room.gameState.currentPlayer, 0);
  assert.equal(room.pendingMoveDeadlineAt, 21_000);

  // A non-reroll move passes the turn and re-arms for the next player.
  rollForCurrentPlayer(room, 2, 7_000);
  const second = submitPendingMoveForRoom(room, 0, 8_000);
  assert.equal(second.ok, true);
  syncTurnDeadline(room, 8_000);
  assert.equal(room.gameState.currentPlayer, 1);
  assert.equal(room.pendingMoveDeadlineAt, 23_000);
});

test("a 1/6 no-move reroll also resets the clock", () => {
  const state = makeTwoPlayerState();
  state.marbles
    .filter((m) => m.player === 0)
    .forEach((marble, idx) => {
      marble.place = PLACE.FINISH;
      marble.finish = idx;
    });
  const room = makeRoom(state, { turnTimeLimitSeconds: 15 });
  syncTurnDeadline(room, 1_000);
  assert.equal(room.pendingMoveDeadlineAt, 16_000);

  const moves = rollForCurrentPlayer(room, 6, 5_000);
  assert.equal(moves.length, 0);
  assert.equal(state.noMoveRoll.shouldAdvance, false);
  syncTurnDeadline(room, 5_000);
  assert.equal(room.pendingMoveDeadlineAt, 20_000);
});

test("bot turns do not get a deadline", () => {
  const state = makeTwoPlayerState();
  state.currentPlayer = 1;
  const room = makeRoom(state, { turnTimeLimitSeconds: 15 });
  room.players[1].isBot = true;

  syncTurnDeadline(room, 1_000);
  assert.equal(room.pendingMoveDeadlineAt, null);
});

test("roll with no moves schedules the delayed advance", () => {
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
  assert.equal(room.noMoveAdvanceAt, 1_000 + NO_MOVE_DIE_DISPLAY_MS + NO_MOVE_NOTICE_MS);
  assert.equal(room.gameState.currentPlayer, 0);
  assert.equal(room.gameState.pendingDieValue, 2);
});

test("delayed no-move advance clears die and passes turn after notice window", () => {
  const state = makeTwoPlayerState();
  state.marbles
    .filter((m) => m.player === 0)
    .forEach((marble, idx) => {
      marble.place = PLACE.FINISH;
      marble.finish = idx;
    });
  const room = makeRoom(state, { turnTimeLimitSeconds: 15 });

  rollForCurrentPlayer(room, 2, 1_000);
  const early = continueDelayedNoMoveRoll(room, room.noMoveAdvanceAt - 1);
  assert.equal(early.changed, false);
  assert.equal(room.gameState.currentPlayer, 0);

  const done = continueDelayedNoMoveRoll(room, room.noMoveAdvanceAt);
  assert.equal(done.changed, true);
  assert.equal(room.noMoveAdvanceAt, null);
  assert.equal(room.gameState.currentPlayer, 1);
  assert.equal(room.gameState.pendingDieValue, null);
  assert.equal(room.gameState.noMoveRoll, null);
});

test("expired deadline submits first pending move", () => {
  const state = makeTwoPlayerState();
  state.marbles[0].place = PLACE.TRACK;
  state.marbles[0].progress = 0;
  const room = makeRoom(state, { turnTimeLimitSeconds: 15 });
  syncTurnDeadline(room, 1_000);
  rollForCurrentPlayer(room, 2, 2_000);

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
  syncTurnDeadline(room, 1_000);
  rollForCurrentPlayer(room, 6, 2_000);

  const result = continueTimedOutAutoPlay(room, 16_001, () => 2);

  assert.equal(result.changed, true);
  assert.equal(room.gameState.currentPlayer, 1);
  assert.equal(room.pendingMoves, null);
  assert.equal(room.pendingMoveDeadlineAt, null);
  assert.equal(room.timedOutAutoPlayer, null);
});

test("expired deadline rolls and plays for a player who never rolled", () => {
  const room = makeRoom(makeTwoPlayerState(), { turnTimeLimitSeconds: 30 });
  syncTurnDeadline(room, 1_000);
  assert.equal(room.pendingMoveDeadlineAt, 31_000);

  const rolls = [6, 2];
  const result = continueTimedOutAutoPlay(room, 31_001, () => rolls.shift() ?? 2);

  assert.equal(result.changed, true);
  assert.equal(room.gameState.marbles[0].place, PLACE.TRACK);
  assert.equal(room.gameState.marbles[0].progress, 2);
  assert.equal(room.gameState.currentPlayer, 1);
  assert.equal(room.timedOutAutoPlayer, null);
});
