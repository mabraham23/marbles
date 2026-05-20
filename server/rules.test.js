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
  TRACK_LEN,
  playerDone,
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
  // Regression: when the turn advances, the previous player's roll must be
  // cleared so the new player doesn't see it on their dice.
  assert.equal(state.pendingRoll, null);
  assert.equal(state.pendingDieValue, null);
});

test("regression: stale pendingDieValue cleared after no-move turn pass", () => {
  // Scenario the user reported: with two players, Black rolls and has no
  // move; Blue's screen showed Black's die value as if Blue had already
  // rolled. After fix, Blue's view sees a clean dice state.
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });
  rollAndCompute(state, 3); // no-move + non-reroll → advances
  assert.equal(state.currentPlayer, 1, "advanced to Blue");
  assert.equal(state.pendingDieValue, null, "Blue should not see Black's die");
  // Then a re-roll (1 or 6) with no moves should KEEP pendingDieValue so the
  // player can see what they rolled while taking another roll.
  const state2 = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });
  // Force Black's start hole occupied so 6 yields no leave-home move and
  // there's no other legal action. Easiest: mark every Black marble as
  // already-finished so home is empty; then a 6 has no target.
  state2.marbles.filter((m) => m.player === 0).forEach((m, i) => {
    m.place = PLACE.FINISH;
    m.finish = i;
    m.progress = null;
  });
  // Now Black has nothing to do; rolling 6 should reroll and keep the die.
  rollAndCompute(state2, 6);
  assert.equal(state2.currentPlayer, 0, "reroll keeps the same player");
  assert.equal(state2.pendingDieValue, 6, "reroll keeps the die visible");
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

test("backward-3 rule: eligibility and execution on rolling 3 immediately after leaving home", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });

  // 1. Black rolls a 6 and leaves home
  const moves6 = rollAndCompute(state, 6);
  const leaveHomeMove = moves6.find((m) => m.label.includes("leaves home"));
  assert.ok(leaveHomeMove, "expected leave home move");
  applyMove(state, leaveHomeMove, 6);

  // Black marble index 0 is now at progress 0, and player is still Black (reroll)
  assert.equal(state.currentPlayer, 0);
  assert.equal(state.marbles[0].place, PLACE.TRACK);
  assert.equal(state.marbles[0].progress, 0);

  // 2. Black rolls a 3. Should have both forward 3 and backward-to-gateway moves.
  const moves3 = rollAndCompute(state, 3);
  const backwardMove = moves3.find((m) => m.label.includes("backward to gateway"));
  assert.ok(backwardMove, "expected backward-to-gateway move option");
  assert.equal(backwardMove.targetProgress, 81);

  // 3. Apply the backward move
  const res = applyMove(state, backwardMove, 3);
  assert.equal(state.marbles[0].progress, 81);
  assert.equal(res.wasReroll, false, "3 is not a reroll");
  assert.equal(state.currentPlayer, 1, "turn should advance to Blue");
});

test("backward-3 rule: blocked when own marble is at progress 83, 82, or 81", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });

  // Black rolls a 6 and leaves home
  const moves6 = rollAndCompute(state, 6);
  applyMove(state, moves6[0], 6);

  // Position another Black marble at progress 83
  state.marbles[1].place = PLACE.TRACK;
  state.marbles[1].progress = 83;

  // Black rolls a 3. Backward move should be blocked by marble at progress 83.
  const moves3 = rollAndCompute(state, 3);
  let backwardMove = moves3.find((m) => m.label.includes("backward to gateway"));
  assert.equal(backwardMove, undefined, "should not allow backward move when progress 83 is occupied");

  // Move that blocking marble to progress 82 instead
  state.marbles[1].progress = 82;
  const moves3_2 = legalMoves(state, 0, 3);
  backwardMove = moves3_2.find((m) => m.label.includes("backward to gateway"));
  assert.equal(backwardMove, undefined, "should not allow backward move when progress 82 is occupied");

  // Move that blocking marble to progress 81 instead
  state.marbles[1].progress = 81;
  const moves3_3 = legalMoves(state, 0, 3);
  backwardMove = moves3_3.find((m) => m.label.includes("backward to gateway"));
  assert.equal(backwardMove, undefined, "should not allow backward move when target progress 81 is occupied");
});

test("backward-3 rule: bumps opponent at progress 81", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });

  // Black rolls a 6 and leaves home
  const moves6 = rollAndCompute(state, 6);
  applyMove(state, moves6[0], 6);

  // Place Blue's marble at absolute index corresponding to Black's progress 81
  // Black's start index is 8. Black's progress 81 is (8 + 81) % 84 = 5.
  const targetAbsIdx = 5;
  const blueMarble = state.marbles.find((m) => m.player === 1);
  blueMarble.place = PLACE.TRACK;
  blueMarble.progress = (targetAbsIdx - state.starts[1] + TRACK_LEN) % TRACK_LEN;

  // Black rolls a 3. Backward move should be available.
  const moves3 = rollAndCompute(state, 3);
  const backwardMove = moves3.find((m) => m.label.includes("backward to gateway"));
  assert.ok(backwardMove);

  // Apply backward move. Opponent should be bumped home.
  const res = applyMove(state, backwardMove, 3);
  assert.equal(res.bumpedIdx, state.marbles.indexOf(blueMarble));
  assert.equal(blueMarble.place, PLACE.HOME);
  assert.equal(state.marbles[0].progress, 81);
});

test("backward-3 rule: not allowed if the marble was not just moved out", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });

  // Place a marble at progress 0 manually, but with NO lastMove state
  state.marbles[0].place = PLACE.TRACK;
  state.marbles[0].progress = 0;
  state.lastMove = null;

  // Roll 3. Backward move should not be available.
  const moves3 = rollAndCompute(state, 3);
  const backwardMove = moves3.find((m) => m.label.includes("backward to gateway"));
  assert.equal(backwardMove, undefined);
});

test("backward-3 rule: subsequent moves from progress 81 and 82", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });

  // Set up a marble at progress 81
  state.marbles[0].place = PLACE.TRACK;
  state.marbles[0].progress = 81;

  // Roll 1: should move to progress 82 on the track
  const moves1 = legalMoves(state, 0, 1);
  const move1 = moves1.find((m) => m.label.includes("moves 1"));
  assert.ok(move1);
  assert.equal(move1.targetPlace, PLACE.TRACK);
  assert.equal(move1.targetProgress, 82);

  // Roll 2: should enter finish 1 (slot 0)
  const moves2 = legalMoves(state, 0, 2);
  const move2 = moves2.find((m) => m.label.includes("enters finish 1"));
  assert.ok(move2);
  assert.equal(move2.targetPlace, PLACE.FINISH);
  assert.equal(move2.targetFinish, 0);

  // Roll 5: should enter finish 4 (slot 3)
  const moves5 = legalMoves(state, 0, 5);
  const move5 = moves5.find((m) => m.label.includes("enters finish 4"));
  assert.ok(move5);
  assert.equal(move5.targetPlace, PLACE.FINISH);
  assert.equal(move5.targetFinish, 3);

  // Test blocking at progress 82
  state.marbles[1].place = PLACE.TRACK;
  state.marbles[1].progress = 82;
  const moves2Blocked = legalMoves(state, 0, 2);
  const move2B = moves2Blocked.find((m) => m.label.includes("enters finish 1"));
  assert.equal(move2B, undefined, "should be blocked by own marble at progress 82");
});

test("team play teammate move sharing rule: finished player can move unfinished teammate marbles", () => {
  const state = createInitialState({
    playerCount: 4,
    mode: MODES.PAIRS, // Team 0 is [0, 2], Team 1 is [1, 3]
    playerNames: ["Yellow", "Blue", "Black", "White"],
  });

  // 1. Manually move all of Yellow's (player 0) marbles into finish slots so they are done.
  const yellowMarbles = state.marbles.filter((m) => m.player === 0);
  yellowMarbles.forEach((m, idx) => {
    m.place = PLACE.FINISH;
    m.finish = idx;
  });

  // Verify that Yellow is done
  assert.ok(playerDone(state, 0));

  // 2. Yellow (player 0) rolls a 6.
  // Their teammate is Black (player 2), who has marbles in HOME.
  const moves6 = legalMoves(state, 0, 6);

  // Moves list should contain Black's marbles leaving home
  const blackLeavesHome = moves6.find((m) => m.label.includes("leaves home") && state.marbles[m.marbleIdx].player === 2);
  assert.ok(blackLeavesHome, "Yellow should be able to move Black's marble out of home");

  // 3. Apply the move
  applyMove(state, blackLeavesHome, 6);

  // Black's marble should now be on the track
  const blackMarble = state.marbles[blackLeavesHome.marbleIdx];
  assert.equal(blackMarble.place, PLACE.TRACK);
  assert.equal(blackMarble.progress, 0);
  assert.equal(blackMarble.player, 2);
});
