import {
  legalMoves,
  applyMove,
  advanceNoMoveRoll,
  rollAndCompute,
  computeSettlement,
} from "../public/shared/rules.js";

export const TURN_TIME_LIMIT_OPTIONS = [0, 15, 30, 60];
export const DEFAULT_TURN_TIME_LIMIT_SECONDS = 30;
export const TURN_TIMEOUT_SWEEP_MS = 1000;
export const AUTO_CHAIN_STEP_LIMIT = 40;
export const NO_MOVE_DIE_DISPLAY_MS = 1000;
export const NO_MOVE_NOTICE_MS = 1800;

export function normalizeTurnTimeLimit(raw) {
  const seconds = Number(raw);
  if (!Number.isInteger(seconds)) return null;
  return TURN_TIME_LIMIT_OPTIONS.includes(seconds) ? seconds : null;
}

export function turnTimeLimitForRoom(room) {
  return normalizeTurnTimeLimit(room.turnTimeLimitSeconds) ?? DEFAULT_TURN_TIME_LIMIT_SECONDS;
}

// One deadline per roll-chain segment: armed when a (human) player's turn
// begins, NOT extended by rolling or choosing, but RESET when a 1/6 earns a
// reroll (state.turnSegment increments). When it expires,
// continueTimedOutAutoPlay rolls and plays for them. Call after every action
// that might have changed whose turn (or segment) it is.
export function syncTurnDeadline(room, now) {
  const state = room.gameState;
  if (room.phase !== "playing" || !state || state.gameOver) {
    room.pendingMoveDeadlineAt = null;
    room.turnDeadlineKey = null;
    return;
  }
  const key = `${state.turnNumber}:${state.currentPlayer}:${state.turnSegment || 0}`;
  if (room.turnDeadlineKey === key) return;
  room.turnDeadlineKey = key;
  const seconds = turnTimeLimitForRoom(room);
  const currentName = state.playerNames[state.currentPlayer];
  const isBot = (room.players || []).some((p) => p.isBot && p.name === currentName);
  room.pendingMoveDeadlineAt = seconds > 0 && !isBot ? now + seconds * 1000 : null;
}

export function rollForCurrentPlayer(room, dieValue, now) {
  const state = room.gameState;
  const currentName = state.playerNames[state.currentPlayer];
  const moves = rollAndCompute(state, dieValue);
  if (moves.length > 0) {
    room.pendingMoves = moves;
    room.pendingMovesFor = currentName;
    room.noMoveAdvanceAt = null;
  } else {
    room.pendingMoves = null;
    room.pendingMovesFor = null;
    if (state.noMoveRoll?.shouldAdvance) {
      state.noMoveRoll.noticeDelayMs = NO_MOVE_DIE_DISPLAY_MS;
      state.noMoveRoll.noticeDurationMs = NO_MOVE_NOTICE_MS;
      room.noMoveAdvanceAt = now + NO_MOVE_DIE_DISPLAY_MS + NO_MOVE_NOTICE_MS;
    } else {
      room.noMoveAdvanceAt = null;
    }
  }
  room.lastMoveAt = now;
  if (state.gameOver && !room.completedAt) room.completedAt = room.lastMoveAt;
  return moves;
}

export function continueDelayedNoMoveRoll(room, now) {
  if (
    room.phase !== "playing" ||
    !room.gameState ||
    !room.noMoveAdvanceAt ||
    room.noMoveAdvanceAt > now
  ) {
    return { changed: false };
  }

  const rollId = room.gameState.noMoveRoll?.rollId ?? null;
  const changed = advanceNoMoveRoll(room.gameState, rollId);
  room.noMoveAdvanceAt = null;
  room.pendingMoves = null;
  room.pendingMovesFor = null;
  room.pendingMoveDeadlineAt = null;
  room.timedOutAutoPlayer = null;
  if (changed) room.lastMoveAt = now;
  return { changed };
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
  // The turn deadline intentionally survives a reroll move — the limit covers
  // the whole turn. syncTurnDeadline re-arms it once the turn passes.
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
  // The deadline covers the whole turn, so it can expire before the player
  // has even rolled — auto-play then rolls AND picks for them.
  const hasExpiredDeadline =
    room.pendingMoveDeadlineAt && room.pendingMoveDeadlineAt <= now;

  if (!room.timedOutAutoPlayer) {
    if (!hasExpiredDeadline) return { changed, capped: false };
    room.timedOutAutoPlayer =
      room.pendingMovesFor || room.gameState.playerNames[room.gameState.currentPlayer];
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

    if (state.noMoveRoll?.shouldAdvance) {
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
      rollForCurrentPlayer(room, rollDie(), now);
      changed = true;
      continue;
    }

    clearAutoState();
    return { changed, capped: false };
  }

  room.pendingMoveDeadlineAt = now;
  return { changed, capped: true };
}
