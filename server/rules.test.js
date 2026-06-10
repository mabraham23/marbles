import test from "node:test";
import assert from "node:assert/strict";

import {
  MODES,
  validModes,
  assignSeats,
  createInitialState,
  teamDisplayGroups,
  rollAndCompute,
  advanceNoMoveRoll,
  applyMove,
  legalMoves,
  PLACE,
  MARBLES_PER_PLAYER,
  TRACK_LEN,
  playerDone,
  rankMoves,
  scoreMove,
  bumpInfoForMove,
  MOVE_SCORE_WEIGHTS,
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

test("teamDisplayGroups returns no groups for free-for-all", () => {
  assert.deepEqual(teamDisplayGroups({
    mode: MODES.SINGLE,
    playerNames: ["Admin", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6"],
  }), []);
});

test("teamDisplayGroups describes 4-player pairs", () => {
  const groups = teamDisplayGroups({
    mode: MODES.PAIRS,
    playerNames: ["Admin", "Player 2", "Player 3", "Player 4"],
  });

  assert.deepEqual(groups.map((group) => group.label), ["Team A", "Team B"]);
  assert.deepEqual(groups.map((group) => group.players.map((player) => player.name)), [
    ["Admin", "Player 3"],
    ["Player 2", "Player 4"],
  ]);
  assert.deepEqual(groups.map((group) => group.players.map((player) => player.colorName)), [
    ["Black", "Yellow"],
    ["Red", "Blue"],
  ]);
});

test("teamDisplayGroups describes 6-player pairs", () => {
  const groups = teamDisplayGroups({
    mode: MODES.PAIRS,
    playerNames: ["Admin", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6"],
  });

  assert.deepEqual(groups.map((group) => group.players.map((player) => player.name)), [
    ["Admin", "Player 4"],
    ["Player 2", "Player 5"],
    ["Player 3", "Player 6"],
  ]);
  assert.deepEqual(groups.map((group) => group.players.map((player) => player.colorName)), [
    ["Black", "Blue"],
    ["Red", "White"],
    ["Yellow", "Green"],
  ]);
});

test("teamDisplayGroups describes 6-player triads", () => {
  const groups = teamDisplayGroups({
    mode: MODES.TRIADS,
    playerNames: ["Admin", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6"],
  });

  assert.deepEqual(groups.map((group) => group.players.map((player) => player.name)), [
    ["Admin", "Player 3", "Player 5"],
    ["Player 2", "Player 4", "Player 6"],
  ]);
  assert.deepEqual(groups.map((group) => group.players.map((player) => player.colorName)), [
    ["Black", "Yellow", "White"],
    ["Red", "Blue", "Green"],
  ]);
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

test("home entry rule: only the leftmost home marble may leave on 1 or 6", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["A", "B"],
  });

  let leavesHome = legalMoves(state, 0, 6).filter((m) => m.label.includes("leaves home"));
  assert.deepEqual(leavesHome.map((m) => state.marbles[m.marbleIdx].index), [0]);

  state.marbles[0].place = PLACE.TRACK;
  state.marbles[0].progress = 2;
  state.marbles[1].place = PLACE.TRACK;
  state.marbles[1].progress = 4;

  leavesHome = legalMoves(state, 0, 1).filter((m) => m.label.includes("leaves home"));
  assert.deepEqual(leavesHome.map((m) => state.marbles[m.marbleIdx].index), [2]);
});

test("smoke: roll 0 moves with non-reroll waits, then advances player", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["A", "B"],
  });
  // 3 cannot get anyone out of home and there's nothing on the track.
  const moves = rollAndCompute(state, 3);
  assert.equal(moves.length, 0);
  assert.equal(state.currentPlayer, 0, "roller stays current while no-move roll is shown");
  assert.equal(state.pendingRoll, null);
  assert.equal(state.pendingDieValue, 3);
  assert.equal(state.noMoveRoll.shouldAdvance, true);

  assert.equal(advanceNoMoveRoll(state, state.noMoveRoll.rollId), true);
  assert.equal(state.currentPlayer, 1, "non-reroll with no moves advances after notice");
  assert.equal(state.pendingDieValue, null, "next player should not see the previous die");
});

test("regression: no-move die remains with roller, then clears after no-move turn pass", () => {
  // Scenario the user reported: with two players, Black rolls and has no
  // move; Blue's screen showed Black's die value as if Blue had already
  // rolled. After fix, Blue's view sees a clean dice state.
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });
  rollAndCompute(state, 3); // no-move + non-reroll → waits before advancing
  assert.equal(state.currentPlayer, 0, "Black stays current while the rolled die is shown");
  assert.equal(state.pendingDieValue, 3, "Black should see the no-move die");
  assert.equal(advanceNoMoveRoll(state, state.noMoveRoll.rollId), true);
  assert.equal(state.currentPlayer, 1, "advanced to Blue after no-move notice");
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

test("backward-3 rule: eligibility and execution on rolling 3 immediately after leaving home with a 1", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });

  // 1. Black rolls a 1 and leaves home
  const moves1 = rollAndCompute(state, 1);
  const leaveHomeMove = moves1.find((m) => m.label.includes("leaves home"));
  assert.ok(leaveHomeMove, "expected leave home move");
  applyMove(state, leaveHomeMove, 1);

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

test("backward-3 rule: eligibility after leaving home with a 6", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });

  const moves6 = rollAndCompute(state, 6);
  const leaveHomeMove = moves6.find((m) => m.label.includes("leaves home"));
  assert.ok(leaveHomeMove, "expected leave home move");
  applyMove(state, leaveHomeMove, 6);

  const moves3 = rollAndCompute(state, 3);
  const backwardMove = moves3.find((m) => m.label.includes("backward to gateway"));
  assert.ok(backwardMove, "6 out followed by 3 should allow backward move");
  assert.equal(backwardMove.targetProgress, 81);
});

test("backward-3 rule: blocked when own marble is at progress 83, 82, or 81", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });

  // Black rolls a 1 and leaves home
  const moves1 = rollAndCompute(state, 1);
  applyMove(state, moves1[0], 1);

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

  // Black rolls a 1 and leaves home
  const moves1 = rollAndCompute(state, 1);
  applyMove(state, moves1[0], 1);

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

test("finish entrance progress: normal forward traversal must reach progress 82", () => {
  const state = createInitialState({
    playerCount: 2,
    mode: MODES.SINGLE,
    playerNames: ["Black", "Blue"],
  });

  // Set up a marble at progress 74
  state.marbles[0].place = PLACE.TRACK;
  state.marbles[0].progress = 74;

  // Roll 2: should move to progress 76 on the track (NOT enter finish)
  const moves2 = legalMoves(state, 0, 2);
  const move2 = moves2.find((m) => m.label.includes("moves 2"));
  assert.ok(move2);
  assert.equal(move2.targetPlace, PLACE.TRACK);
  assert.equal(move2.targetProgress, 76);
  assert.equal(moves2.some((m) => m.targetPlace === PLACE.FINISH), false, "should not enter finish from progress 74 with roll 2");

  // Move marble to progress 82
  state.marbles[0].progress = 82;

  // Roll 1: should enter finish 1 (slot 0)
  const moves1 = legalMoves(state, 0, 1);
  const move1 = moves1.find((m) => m.label.includes("enters finish 1"));
  assert.ok(move1);
  assert.equal(move1.targetPlace, PLACE.FINISH);
  assert.equal(move1.targetFinish, 0);
});

// ---- Move ranking + bump surfacing ----

// Absolute track index a marble of `player` reaches at `progress`.
const absFor = (state, player, progress) => (state.starts[player] + progress) % TRACK_LEN;
// Progress an occupant of `player` must sit at to occupy `targetAbs`.
const occProgressForAbs = (state, player, targetAbs) =>
  (((targetAbs - state.starts[player]) % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
const playerMarbles = (state, player) => state.marbles.filter((m) => m.player === player);

test("rankMoves: legalMoves stays unannotated/unsorted (pure layer untouched)", () => {
  const state = createInitialState({ playerCount: 2, mode: MODES.SINGLE, playerNames: ["A", "B"] });
  const lm = legalMoves(state, 0, 6);
  assert.ok(lm.length > 0);
  assert.equal("bump" in lm[0], false, "legalMoves must not annotate moves");
});

test("rankMoves: full-chain category order matches confirmed priority", () => {
  // 4-player single. One roll (1) that surfaces finish, opponent-bump, forward,
  // leave-home and take-center at once — the test that catches tier-crossing.
  const state = createInitialState({ playerCount: 4, mode: MODES.SINGLE, playerNames: ["A", "B", "C", "D"] });
  const p0 = playerMarbles(state, 0);
  p0[0].place = PLACE.TRACK; p0[0].progress = 82;   // roll 1 -> enters finish (slot 0)
  p0[1].place = PLACE.TRACK; p0[1].progress = 5;    // roll 1 -> take center + forward to 6 (+ corner jump)
  // p0[2] stays HOME -> leave home (leftmost home marble)
  p0[3].place = PLACE.TRACK; p0[3].progress = 30;   // roll 1 -> forward to 31, lands on opponent

  const opp = playerMarbles(state, 2)[0];
  opp.place = PLACE.TRACK;
  opp.progress = occProgressForAbs(state, 2, absFor(state, 0, 31)); // sit where p0[3] lands

  const ranked = rankMoves(state, legalMoves(state, 0, 1), 1);
  const iFinish = ranked.findIndex((m) => m.targetPlace === PLACE.FINISH);
  const iBump = ranked.findIndex((m) => m.bump && !m.bump.isTeammate);
  const iForward = ranked.findIndex((m) => m.targetPlace === PLACE.TRACK && m.targetProgress === 6 && !m.bump);
  const iLeave = ranked.findIndex((m) => m.label.includes("leaves home"));
  const iCenter = ranked.findIndex((m) => m.targetPlace === PLACE.CENTER);

  // Tuned priority (high→low): opponent-bump > finish > leave-home > take-center > forward.
  assert.ok([iFinish, iBump, iForward, iLeave, iCenter].every((i) => i >= 0), "all categories present");
  assert.ok(iBump < iFinish, "opponent bump ranks above finish");
  assert.ok(iFinish < iLeave, "finish ranks above leave home");
  assert.ok(iLeave < iCenter, "leave home ranks above take center");
  assert.ok(iCenter < iForward, "take center ranks above plain forward");
  assert.equal(ranked[iBump].bump.isTeammate, false);
});

test("rankMoves: corner 6 (closest to finish) ranks before corner 1", () => {
  const state = createInitialState({ playerCount: 2, mode: MODES.SINGLE, playerNames: ["A", "B"] });
  playerMarbles(state, 0)[0].place = PLACE.CENTER;
  playerMarbles(state, 0)[0].progress = null;

  const ranked = rankMoves(state, legalMoves(state, 0, 1), 1);
  const c6 = ranked.findIndex((m) => m.targetPlace === PLACE.TRACK && m.targetProgress === 75);
  const c1 = ranked.findIndex((m) => m.targetPlace === PLACE.TRACK && m.targetProgress === 5);
  assert.ok(c6 >= 0 && c1 >= 0, "both corner exits present");
  assert.ok(c6 < c1, "corner 6 ranks before corner 1");
});

test("rankMoves: a winning move ranks first with WIN-tier score", () => {
  const state = createInitialState({ playerCount: 4, mode: MODES.SINGLE, playerNames: ["A", "B", "C", "D"] });
  const p0 = playerMarbles(state, 0);
  p0[1].place = PLACE.FINISH; p0[1].finish = 1; p0[1].progress = null;
  p0[2].place = PLACE.FINISH; p0[2].finish = 2; p0[2].progress = null;
  p0[3].place = PLACE.FINISH; p0[3].finish = 3; p0[3].progress = null;
  p0[0].place = PLACE.TRACK; p0[0].progress = 82;   // roll 1 -> finish slot 0 -> all home -> win

  const ranked = rankMoves(state, legalMoves(state, 0, 1), 1);
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].targetPlace, PLACE.FINISH);
  assert.ok(scoreMove(state, ranked[0], 1) >= MOVE_SCORE_WEIGHTS.WIN, "winning move scores at WIN tier");
});

test("rankMoves: bumping a more-advanced opponent scores higher", () => {
  const state = createInitialState({ playerCount: 4, mode: MODES.SINGLE, playerNames: ["A", "B", "C", "D"] });
  const p0 = playerMarbles(state, 0);
  p0[0].place = PLACE.TRACK; p0[0].progress = 0;    // occupies start; roll 1 -> land progress 1
  p0[1].place = PLACE.TRACK; p0[1].progress = 10;   // roll 1 -> land progress 11

  playerMarbles(state, 1)[0].place = PLACE.TRACK;
  playerMarbles(state, 1)[0].progress = occProgressForAbs(state, 1, absFor(state, 0, 1));   // opp at p0[0] landing
  playerMarbles(state, 2)[0].place = PLACE.TRACK;
  playerMarbles(state, 2)[0].progress = occProgressForAbs(state, 2, absFor(state, 0, 11));  // opp at p0[1] landing

  const ranked = rankMoves(state, legalMoves(state, 0, 1), 1);
  const bumps = ranked.filter((m) => m.bump && !m.bump.isTeammate);
  assert.equal(bumps.length, 2, "two opponent bumps");
  const progFirst = state.marbles[bumps[0].bump.occupantIdx].progress;
  const progSecond = state.marbles[bumps[1].bump.occupantIdx].progress;
  assert.ok(progFirst > progSecond, "the more-advanced opponent bump ranks first");
});

test("rankMoves: teammate bump is ranked last and flagged", () => {
  // PAIRS -> teams [[0,2],[1,3]]; player 0 lands on teammate player 2.
  const state = createInitialState({ playerCount: 4, mode: MODES.PAIRS, playerNames: ["A", "B", "C", "D"] });
  const p0 = playerMarbles(state, 0);
  p0[0].place = PLACE.TRACK; p0[0].progress = 0;    // roll 1 -> land on teammate
  p0[1].place = PLACE.TRACK; p0[1].progress = 20;   // roll 1 -> plain forward

  const mate = playerMarbles(state, 2)[0];
  mate.place = PLACE.TRACK;
  mate.progress = occProgressForAbs(state, 2, absFor(state, 0, 1));

  const ranked = rankMoves(state, legalMoves(state, 0, 1), 1);
  const last = ranked[ranked.length - 1];
  assert.ok(last.bump, "last move is the bump");
  assert.equal(last.bump.isTeammate, true, "teammate bump flagged");
  assert.ok(!ranked[0].bump || !ranked[0].bump.isTeammate, "a non-teammate-bump move ranks above it");
});

test("bumpInfoForMove: single mode classifies every bump as opponent", () => {
  const state = createInitialState({ playerCount: 4, mode: MODES.SINGLE, playerNames: ["A", "B", "C", "D"] });
  playerMarbles(state, 0)[0].place = PLACE.TRACK;
  playerMarbles(state, 0)[0].progress = 0;
  const other = playerMarbles(state, 2)[0];
  other.place = PLACE.TRACK;
  other.progress = occProgressForAbs(state, 2, absFor(state, 0, 1));

  const bumpMove = legalMoves(state, 0, 1).find((m) => bumpInfoForMove(state, m));
  assert.ok(bumpMove, "a bump move exists");
  assert.equal(bumpInfoForMove(state, bumpMove).isTeammate, false);
});

test("rankMoves: deterministic across repeated calls", () => {
  const state = createInitialState({ playerCount: 4, mode: MODES.SINGLE, playerNames: ["A", "B", "C", "D"] });
  const p0 = playerMarbles(state, 0);
  p0[0].place = PLACE.TRACK; p0[0].progress = 82;
  p0[1].place = PLACE.TRACK; p0[1].progress = 5;
  p0[3].place = PLACE.TRACK; p0[3].progress = 30;

  const a = rankMoves(state, legalMoves(state, 0, 1), 1);
  const b = rankMoves(state, legalMoves(state, 0, 1), 1);
  assert.deepEqual(a, b);
});

test("rankMoves: finished player's teammate moves are ranked (move sharing)", () => {
  // PAIRS -> teams [[0,2],[1,3]]. Player 0 is fully finished, so on their turn
  // they move teammate player 2's marbles. Ranking must still apply to those.
  const state = createInitialState({ playerCount: 4, mode: MODES.PAIRS, playerNames: ["A", "B", "C", "D"] });
  playerMarbles(state, 0).forEach((m, i) => {
    m.place = PLACE.FINISH; m.finish = i; m.progress = null;
  });
  assert.ok(playerDone(state, 0));

  const p2 = playerMarbles(state, 2);
  p2[0].place = PLACE.TRACK; p2[0].progress = 82;   // roll 1 -> teammate marble enters finish
  // p2[1..3] stay HOME -> leave home (lower-value)

  const ranked = rankMoves(state, legalMoves(state, 0, 1), 1);
  assert.ok(ranked.length >= 2, "teammate has a finish and a leave-home option");
  assert.equal(ranked[0].targetPlace, PLACE.FINISH, "teammate finish entry ranks first");
  assert.equal(state.marbles[ranked[0].marbleIdx].player, 2, "the ranked move is a teammate's marble");
  const iLeave = ranked.findIndex((m) => m.label.includes("leaves home"));
  assert.ok(iLeave > 0, "teammate leave-home ranks below the finish entry");
});

test("rankMoves: bump annotation survives JSON serialization (WS round-trip)", () => {
  const state = createInitialState({ playerCount: 4, mode: MODES.SINGLE, playerNames: ["A", "B", "C", "D"] });
  playerMarbles(state, 0)[0].place = PLACE.TRACK;
  playerMarbles(state, 0)[0].progress = 0;
  const opp = playerMarbles(state, 2)[0];
  opp.place = PLACE.TRACK;
  opp.progress = occProgressForAbs(state, 2, absFor(state, 0, 1));

  const ranked = rankMoves(state, legalMoves(state, 0, 1), 1);
  const overWire = JSON.parse(JSON.stringify(ranked)); // mirrors broadcast -> client
  assert.deepEqual(overWire, ranked, "move.bump is plain JSON and survives the wire");
  const bumpMove = overWire.find((m) => m.bump);
  assert.ok(bumpMove && bumpMove.bump.token && typeof bumpMove.bump.isTeammate === "boolean");
});

test("rollAndCompute returns moves in non-increasing score order", () => {
  const state = createInitialState({ playerCount: 4, mode: MODES.SINGLE, playerNames: ["A", "B", "C", "D"] });
  const p0 = playerMarbles(state, 0);
  p0[0].place = PLACE.TRACK; p0[0].progress = 82;
  p0[1].place = PLACE.TRACK; p0[1].progress = 5;
  p0[3].place = PLACE.TRACK; p0[3].progress = 30;

  const moves = rollAndCompute(state, 1);
  assert.ok(moves.length > 1, "multiple moves to order");
  for (let i = 1; i < moves.length; i += 1) {
    assert.ok(
      scoreMove(state, moves[i - 1], 1) >= scoreMove(state, moves[i], 1),
      "moves are ranked best -> worst",
    );
  }
});

test("stats: rolls, sixes, reroll chains, captures, center and first home", () => {
  const state = createInitialState({ playerCount: 2, mode: MODES.SINGLE, playerNames: ["A", "B"] });

  // A rolls 6, leaves home, rolls again (2) and moves — one turn, two rolls.
  let moves = rollAndCompute(state, 6);
  applyMove(state, moves.find((m) => m.label.includes("leaves home")), 6);
  moves = rollAndCompute(state, 2);
  applyMove(state, moves[0], 2);

  const a = state.stats.players[0];
  assert.equal(a.rolls, 2);
  assert.equal(a.sixes, 1);
  assert.equal(a.bestTurn, 2, "reroll chain counted as one turn");
  assert.equal(state.turnRollCount, 0, "chain reset when the turn passed");

  // B leaves home onto a hole occupied by A: a capture.
  const aMarble = state.marbles.find((m) => m.player === 0 && m.place === PLACE.TRACK);
  aMarble.progress = (state.starts[1] - state.starts[0] + TRACK_LEN) % TRACK_LEN; // B's start hole
  assert.equal(state.currentPlayer, 1);
  moves = rollAndCompute(state, 6);
  applyMove(state, moves.find((m) => m.label.includes("leaves home")), 6);
  assert.equal(state.stats.players[1].captures, 1);
  assert.equal(state.stats.players[0].captured, 1);

  // B takes the center on an exact roll.
  moves = rollAndCompute(state, 6);
  const center = moves.find((m) => m.targetPlace === PLACE.CENTER);
  assert.ok(center, "center take available from progress 0 with a 6");
  applyMove(state, center, 6);
  assert.equal(state.stats.players[1].centerTakes, 1);

  // First marble home is recorded once.
  const bMarble = state.marbles.find((m) => m.player === 1 && m.place === PLACE.CENTER);
  bMarble.place = PLACE.TRACK;
  bMarble.progress = 82; // MAX_TRACK_PROGRESS
  moves = rollAndCompute(state, 1);
  const finish = moves.find((m) => m.targetPlace === PLACE.FINISH);
  assert.ok(finish, "finish entry available");
  applyMove(state, finish, 1);
  assert.deepEqual(state.stats.firstHome.player, 1);
});
