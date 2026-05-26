import {
  legalMoves,
  applyMove,
  rollAndCompute,
  computeSettlement,
} from "../public/shared/rules.js";

export const TURN_TIME_LIMIT_OPTIONS = [0, 15, 30, 60];
export const DEFAULT_TURN_TIME_LIMIT_SECONDS = 30;
export const TURN_TIMEOUT_SWEEP_MS = 1000;
export const AUTO_CHAIN_STEP_LIMIT = 40;

export function normalizeTurnTimeLimit(raw) {
  const seconds = Number(raw);
  if (!Number.isInteger(seconds)) return null;
  return TURN_TIME_LIMIT_OPTIONS.includes(seconds) ? seconds : null;
}

export function turnTimeLimitForRoom(room) {
  return normalizeTurnTimeLimit(room.turnTimeLimitSeconds) ?? DEFAULT_TURN_TIME_LIMIT_SECONDS;
}

export function deadlineForRoom(room, now) {
  const seconds = turnTimeLimitForRoom(room);
  return seconds > 0 ? now + seconds * 1000 : null;
}

export function rollForCurrentPlayer(room, dieValue, now, opts = {}) {
  const state = room.gameState;
  const currentName = state.playerNames[state.currentPlayer];
  const moves = rollAndCompute(state, dieValue);
  if (moves.length > 0) {
    room.pendingMoves = moves;
    room.pendingMovesFor = currentName;
    room.pendingMoveDeadlineAt = opts.startDeadline === false ? null : deadlineForRoom(room, now);
  } else {
    room.pendingMoves = null;
    room.pendingMovesFor = null;
    room.pendingMoveDeadlineAt = null;
  }
  room.lastMoveAt = now;
  if (state.gameOver && !room.completedAt) room.completedAt = room.lastMoveAt;
  return moves;
}

export function submitPendingMoveForRoom(room, moveIdx, now) {
  if (!room.pendingMoves || !room.pendingMoves.length) {
    return { ok: false, error: "No pending move" };
  }
  if (!Number.isInteger(moveIdx) || moveIdx < 0 || moveIdx >= room.pendingMoves.length) {
    return { ok: false, error: "Invalid move index" };
  }

  const move = room.pendingMoves[moveIdx];
  const fresh = legalMoves(room.gameState, room.gameState.currentPlayer, room.gameState.pendingDieValue);
  const stillLegal = fresh.some(
    (m) =>
      m.marbleIdx === move.marbleIdx &&
      m.targetPlace === move.targetPlace &&
      (m.targetProgress ?? null) === (move.targetProgress ?? null) &&
      (m.targetFinish ?? null) === (move.targetFinish ?? null),
  );
  if (!stillLegal) return { ok: false, error: "Move no longer legal" };

  const result = applyMove(room.gameState, move, room.gameState.pendingDieValue);
  room.lastMoveAt = now;
  if (room.gameState.gameOver) {
    room.completedAt = room.lastMoveAt;
    if (room.entryFee && !room.settlement) {
      room.settlement = computeSettlement(room.gameState, room.entryFee);
    }
  }
  room.pendingMoves = null;
  room.pendingMovesFor = null;
  room.pendingMoveDeadlineAt = null;
  return { ok: true, result };
}

export function continueTimedOutAutoPlay(room, now, rollDie, opts = {}) {
  if (room.phase !== "playing" || !room.gameState) return { changed: false, capped: false };

  let changed = false;
  const clearAutoState = () => {
    if (room.timedOutAutoPlayer || room.pendingMoveDeadlineAt) changed = true;
    room.timedOutAutoPlayer = null;
    room.pendingMoveDeadlineAt = null;
  };
  const stepLimit = opts.stepLimit ?? AUTO_CHAIN_STEP_LIMIT;
  const hasExpiredDeadline =
    room.pendingMoveDeadlineAt &&
    room.pendingMoveDeadlineAt <= now &&
    room.pendingMoves &&
    room.pendingMoves.length > 0;

  if (!room.timedOutAutoPlayer) {
    if (!hasExpiredDeadline) return { changed, capped: false };
    room.timedOutAutoPlayer = room.pendingMovesFor;
  }

  for (let steps = 0; steps < stepLimit; steps += 1) {
    const state = room.gameState;
    if (state.gameOver) {
      clearAutoState();
      return { changed, capped: false };
    }

    const autoName = room.timedOutAutoPlayer;
    const currentName = state.playerNames[state.currentPlayer];
    if (!autoName || currentName !== autoName) {
      clearAutoState();
      return { changed, capped: false };
    }

    if (room.pendingMoves && room.pendingMoves.length > 0 && room.pendingMovesFor === autoName) {
      const submitted = submitPendingMoveForRoom(room, 0, now);
      if (!submitted.ok) {
        clearAutoState();
        return { changed, capped: false, error: submitted.error };
      }
      changed = true;
      continue;
    }

    if (state.pendingRoll == null) {
      rollForCurrentPlayer(room, rollDie(), now, { startDeadline: false });
      changed = true;
      continue;
    }

    clearAutoState();
    return { changed, capped: false };
  }

  room.pendingMoveDeadlineAt = now;
  return { changed, capped: true };
}
