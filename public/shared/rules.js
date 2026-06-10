// Pure game logic. No DOM. Used by both browser client and Node server.

export const FINISH_LEN = 4;
export const MARBLES_PER_PLAYER = 4;
export const SIDE_ROW_LEN = 5;
export const ARM_ROW_LEN = 4;
export const APEX_LEN = 1;
export const MODULE_LEN = ARM_ROW_LEN + SIDE_ROW_LEN + ARM_ROW_LEN + APEX_LEN;
export const START_OFFSET_IN_MODULE = ARM_ROW_LEN + SIDE_ROW_LEN - 1;
export const TRACK_LEN = MODULE_LEN * 6;
export const MAX_TRACK_PROGRESS = TRACK_LEN - 2;
export const CENTER_PROGRESS = ARM_ROW_LEN + APEX_LEN + 1;
export const CORNER_PROGRESSES = Array.from({ length: 6 }, (_, i) => i * MODULE_LEN + ARM_ROW_LEN + APEX_LEN);

export const PLAYER_NAMES = ["Black", "Red", "Yellow", "Blue", "White", "Green"];
export const PLAYER_SHORT = ["K", "R", "Y", "B", "W", "G"];
export const PLAYER_COLORS = ["#171923", "#d9363e", "#f3c414", "#1e5bd8", "#f8fafc", "#7bdc79"];
export const PLAYER_STROKES = ["#05070b", "#8f1f27", "#a67707", "#123a8b", "#b8c0cd", "#3f9b43"];

export const PLACE = {
  HOME: "home",
  TRACK: "track",
  CENTER: "center",
  FINISH: "finish",
};

export const MODES = {
  SINGLE: "single",
  PAIRS: "pairs",
  TRIADS: "triads",
};

export function validModes(playerCount) {
  if (playerCount === 4) return [MODES.SINGLE, MODES.PAIRS];
  if (playerCount === 6) return [MODES.SINGLE, MODES.PAIRS, MODES.TRIADS];
  return [MODES.SINGLE];
}

export function modeLabel(mode, playerCount) {
  if (mode === MODES.SINGLE) return "Free-for-all";
  if (mode === MODES.PAIRS) {
    if (playerCount === 4) return "2 teams of 2";
    if (playerCount === 6) return "3 teams of 2 (opposites)";
  }
  if (mode === MODES.TRIADS) return "2 teams of 3 (alternating)";
  return mode;
}

export function assignSeats(playerCount, mode) {
  const validatedMode = validModes(playerCount).includes(mode) ? mode : MODES.SINGLE;
  if (playerCount === 2) {
    return { seatColors: [0, 3], teams: null, mode: validatedMode };
  }
  if (playerCount === 3) {
    return { seatColors: [0, 2, 4], teams: null, mode: validatedMode };
  }
  if (playerCount === 4) {
    if (validatedMode === MODES.PAIRS) {
      return { seatColors: [0, 1, 2, 3], teams: [[0, 2], [1, 3]], mode: validatedMode };
    }
    return { seatColors: [0, 1, 2, 3], teams: null, mode: validatedMode };
  }
  if (playerCount === 5) {
    return { seatColors: [0, 1, 2, 3, 4], teams: null, mode: validatedMode };
  }
  if (playerCount === 6) {
    if (validatedMode === MODES.TRIADS) {
      return { seatColors: [0, 1, 2, 3, 4, 5], teams: [[0, 2, 4], [1, 3, 5]], mode: validatedMode };
    }
    if (validatedMode === MODES.PAIRS) {
      return { seatColors: [0, 1, 2, 3, 4, 5], teams: [[0, 3], [1, 4], [2, 5]], mode: validatedMode };
    }
    return { seatColors: [0, 1, 2, 3, 4, 5], teams: null, mode: validatedMode };
  }
  throw new Error(`Unsupported player count: ${playerCount}`);
}

export function teamId(state, player) {
  if (!state.teams) return null;
  for (let t = 0; t < state.teams.length; t += 1) {
    if (state.teams[t].includes(player)) return t;
  }
  return null;
}

export function teamLabel(state, player) {
  if (!state.teams) return `P${player + 1}`;
  const t = teamId(state, player);
  return `Team ${String.fromCharCode(65 + t)}`;
}

export function teamDisplayGroups({ players, playerNames, mode }) {
  const names = (playerNames || players || []).map((player) => {
    if (typeof player === "string") return player;
    return player?.name || "";
  });
  if (names.length < 2) return [];

  const { seatColors, teams } = assignSeats(names.length, mode);
  if (!teams) return [];

  return teams.map((team, teamIndex) => ({
    index: teamIndex,
    label: `Team ${String.fromCharCode(65 + teamIndex)}`,
    players: team.map((playerIndex) => {
      const seat = seatColors[playerIndex];
      return {
        playerIndex,
        name: names[playerIndex] || `Player ${playerIndex + 1}`,
        seat,
        colorName: PLAYER_NAMES[seat],
        fill: PLAYER_COLORS[seat],
        stroke: PLAYER_STROKES[seat],
      };
    }),
  }));
}

export function marbleToken(marble) {
  return `${PLAYER_SHORT[marble.seat]}${marble.index + 1}`;
}

export function createInitialState({ playerCount, mode, playerNames }) {
  const { seatColors, teams } = assignSeats(playerCount, mode);
  const starts = seatColors.map((seat) => seat * MODULE_LEN + START_OFFSET_IN_MODULE);
  const marbles = [];
  for (let player = 0; player < playerCount; player += 1) {
    for (let index = 0; index < MARBLES_PER_PLAYER; index += 1) {
      marbles.push({
        player,
        seat: seatColors[player],
        index,
        place: PLACE.HOME,
        progress: null,
        finish: null,
      });
    }
  }
  return {
    playerCount,
    mode,
    seatColors,
    teams,
    playerNames: playerNames || seatColors.map((_, i) => `P${i + 1}`),
    starts,
    currentPlayer: 0,
    turnNumber: 1,
    pendingRoll: null,
    pendingDieValue: null,
    marbles,
    log: ["New game"],
    gameOver: false,
    winner: null,
    lastMove: null,
  };
}

export function startForPlayer(state, player) {
  return state.starts[player];
}

export function absTrackIndex(state, marble) {
  return (startForPlayer(state, marble.player) + marble.progress) % TRACK_LEN;
}

export function marbleAtTrack(state, trackIndex) {
  return state.marbles.find(
    (marble) => marble.place === PLACE.TRACK && absTrackIndex(state, marble) === trackIndex,
  );
}

export function centerOccupant(state) {
  return state.marbles.find((marble) => marble.place === PLACE.CENTER);
}

// Returns the marble that `move` would bump home (any occupant whose owner
// differs from the mover), or null. Covers track and center landings. In team
// modes a teammate is a different player, so they appear here too.
export function moveTargetOccupant(state, move) {
  const marble = state.marbles[move.marbleIdx];
  if (move.targetPlace === PLACE.TRACK) {
    const targetAbs = (startForPlayer(state, marble.player) + move.targetProgress) % TRACK_LEN;
    const occupant = marbleAtTrack(state, targetAbs);
    return occupant && occupant.player !== marble.player ? occupant : null;
  }
  if (move.targetPlace === PLACE.CENTER) {
    const occupant = centerOccupant(state);
    return occupant && occupant.player !== marble.player ? occupant : null;
  }
  return null;
}

// null when no bump; otherwise { occupantIdx, token, isTeammate }. In single
// mode teamId is null for everyone, so every bump is an opponent bump.
export function bumpInfoForMove(state, move) {
  const occupant = moveTargetOccupant(state, move);
  if (!occupant) return null;
  const mover = state.marbles[move.marbleIdx];
  const moverTeam = teamId(state, mover.player);
  const occupantTeam = teamId(state, occupant.player);
  const isTeammate = moverTeam !== null && moverTeam === occupantTeam;
  return {
    occupantIdx: state.marbles.indexOf(occupant),
    token: marbleToken(occupant),
    isTeammate,
  };
}

export function ownTrackProgresses(state, player) {
  return new Set(
    state.marbles
      .filter((m) => m.player === player && m.place === PLACE.TRACK)
      .map((m) => m.progress),
  );
}

export function ownFinishSlots(state, player) {
  return new Set(
    state.marbles
      .filter((m) => m.player === player && m.place === PLACE.FINISH)
      .map((m) => m.finish),
  );
}

export function leftmostHomeMarbleIndex(state, player) {
  const homeMarbles = state.marbles.filter((m) => m.player === player && m.place === PLACE.HOME);
  if (homeMarbles.length === 0) return null;
  return Math.min(...homeMarbles.map((m) => m.index));
}

export function pathCrossesOwnMarble(state, player, fromProgress, toProgress) {
  const occupied = ownTrackProgresses(state, player);
  for (let progress = fromProgress + 1; progress <= toProgress; progress += 1) {
    if (occupied.has(progress)) return true;
  }
  return false;
}

export function cornerJumpTarget(fromProgress, roll) {
  const idx = CORNER_PROGRESSES.indexOf(fromProgress);
  if (idx < 0) return null;
  const targetIdx = idx + roll;
  if (targetIdx > 5) return null;
  return { targetProgress: CORNER_PROGRESSES[targetIdx], targetIdx };
}

export function cornerJumpPathClear(state, player, fromProgress, toProgress) {
  const fromIdx = CORNER_PROGRESSES.indexOf(fromProgress);
  const toIdx = CORNER_PROGRESSES.indexOf(toProgress);
  for (let i = fromIdx + 1; i <= toIdx; i += 1) {
    const corner = CORNER_PROGRESSES[i];
    const abs = (startForPlayer(state, player) + corner) % TRACK_LEN;
    const occupant = marbleAtTrack(state, abs);
    if (occupant && occupant.player === player) return false;
  }
  return true;
}

export function legalMoves(state, player, roll) {
  const moves = [];

  let allowedPlayers = new Set([player]);
  if (state.teams && playerDone(state, player)) {
    const team = state.teams.find((t) => t.includes(player));
    if (team) {
      allowedPlayers = new Set(team.filter((p) => !playerDone(state, p)));
    }
  }

  state.marbles.forEach((marble, marbleIdx) => {
    if (!allowedPlayers.has(marble.player)) return;

    const pOwner = marble.player;

    if (marble.place === PLACE.HOME) {
      if ([1, 6].includes(roll)) {
        if (marble.index !== leftmostHomeMarbleIndex(state, pOwner)) return;
        const occupant = marbleAtTrack(state, startForPlayer(state, pOwner));
        if (!occupant || occupant.player !== pOwner) {
          moves.push({
            marbleIdx,
            label: `${marbleToken(marble)} leaves home`,
            targetPlace: PLACE.TRACK,
            targetProgress: 0,
          });
        }
      }
      return;
    }

    if (marble.place === PLACE.TRACK) {
      // SPECIAL RULE: Backward-3 move from start space (progress 0)
      if (marble.progress === 0 && roll === 3 && state.lastMove) {
        if (
          state.lastMove.marbleIdx === marbleIdx &&
          state.lastMove.before.place === PLACE.HOME &&
          state.lastMove.after.place === PLACE.TRACK &&
          state.lastMove.after.progress === 0 &&
          state.lastMove.before.player === pOwner &&
          [1, 6].includes(state.lastMove.roll)
        ) {
          const ownProgresses = ownTrackProgresses(state, pOwner);
          const pathBlocked = ownProgresses.has(83) || ownProgresses.has(82) || ownProgresses.has(81);
          if (!pathBlocked) {
            moves.push({
              marbleIdx,
              label: `${marbleToken(marble)} moves backward to gateway`,
              targetPlace: PLACE.TRACK,
              targetProgress: 81,
            });
          }
        }
      }


      if (marble.progress < CENTER_PROGRESS && marble.progress + roll === CENTER_PROGRESS) {
        if (!pathCrossesOwnMarble(state, pOwner, marble.progress, CENTER_PROGRESS - 1)) {
          const occupant = centerOccupant(state);
          if (!occupant || occupant.player !== pOwner) {
            moves.push({
              marbleIdx,
              label: `${marbleToken(marble)} takes center`,
              targetPlace: PLACE.CENTER,
            });
          }
        }
      }

      const nextProgress = marble.progress + roll;
      if (nextProgress <= MAX_TRACK_PROGRESS) {
        if (!pathCrossesOwnMarble(state, pOwner, marble.progress, nextProgress)) {
          const occupant = marbleAtTrack(state, (startForPlayer(state, pOwner) + nextProgress) % TRACK_LEN);
          if (!occupant || occupant.player !== pOwner) {
            moves.push({
              marbleIdx,
              label: `${marbleToken(marble)} moves ${roll}`,
              targetPlace: PLACE.TRACK,
              targetProgress: nextProgress,
            });
          }
        }
      } else {
        const finishSlot = nextProgress - MAX_TRACK_PROGRESS - 1;
        if (finishSlot >= 0 && finishSlot < FINISH_LEN) {
          const finishes = ownFinishSlots(state, pOwner);
          const trackClear = !pathCrossesOwnMarble(state, pOwner, marble.progress, MAX_TRACK_PROGRESS);
          let finishClear = true;
          for (let slot = 0; slot <= finishSlot; slot += 1) {
            if (finishes.has(slot)) finishClear = false;
          }
          if (trackClear && finishClear) {
            moves.push({
              marbleIdx,
              label: `${marbleToken(marble)} enters finish ${finishSlot + 1}`,
              targetPlace: PLACE.FINISH,
              targetFinish: finishSlot,
            });
          }
        }
      }

      const jump = cornerJumpTarget(marble.progress, roll);
      if (jump && cornerJumpPathClear(state, pOwner, marble.progress, jump.targetProgress)) {
        const targetAbs = (startForPlayer(state, pOwner) + jump.targetProgress) % TRACK_LEN;
        const occupant = marbleAtTrack(state, targetAbs);
        if (!occupant || occupant.player !== pOwner) {
          moves.push({
            marbleIdx,
            label: `${marbleToken(marble)} jumps to corner ${jump.targetIdx + 1}`,
            targetPlace: PLACE.TRACK,
            targetProgress: jump.targetProgress,
          });
        }
      }
      return;
    }

    if (marble.place === PLACE.FINISH) {
      const nextSlot = marble.finish + roll;
      if (nextSlot < FINISH_LEN) {
        const finishes = ownFinishSlots(state, pOwner);
        let finishClear = true;
        for (let slot = marble.finish + 1; slot <= nextSlot; slot += 1) {
          if (finishes.has(slot)) finishClear = false;
        }
        if (finishClear) {
          moves.push({
            marbleIdx,
            label: `${marbleToken(marble)} moves to finish ${nextSlot + 1}`,
            targetPlace: PLACE.FINISH,
            targetFinish: nextSlot,
          });
        }
      }
      return;
    }

    if (marble.place === PLACE.CENTER && roll === 1) {
      CORNER_PROGRESSES.forEach((cornerProgress, idx) => {
        const targetAbs = (startForPlayer(state, pOwner) + cornerProgress) % TRACK_LEN;
        const occupant = marbleAtTrack(state, targetAbs);
        if (!occupant || occupant.player !== pOwner) {
          moves.push({
            marbleIdx,
            label: `${marbleToken(marble)} exits center to corner ${idx + 1}`,
            targetPlace: PLACE.TRACK,
            targetProgress: cornerProgress,
          });
        }
      });
    }
  });
  return moves;
}

// Move-ranking weights. Category bases are spaced so a tier's base gap exceeds
// its within-tier refinement range (forward progress ≤ MAX_TRACK_PROGRESS; bump
// distance ≤ OPPONENT_BUMP_PER_PROGRESS * MAX_TRACK_PROGRESS). That keeps the
// confirmed priority order intact — refinements only reorder moves inside a
// single category, never across categories.
//
// Tuned by ~100k simulated games (FFA + team, all player counts). Three changes
// beat the original priority decisively (+25% FFA win edge, dominant in teams):
//   • bumping an opponent ranks ABOVE finishing your own marble — a bump resets
//     an opponent's tempo, which helps a team far more than banking one slot;
//   • LEAVE_HOME and TAKE_CENTER rank ABOVE ordinary forward progress — getting
//     marbles into play and seizing the center (a 1-roll shortcut to any corner)
//     are worth more than nudging an already-active marble. A game-winning move
//     still wins because WIN is added on top of FINISH.
//   • Tier order (high→low): WIN ≫ OPPONENT_BUMP > FINISH > LEAVE_HOME >
//     TAKE_CENTER > FORWARD > … > TEAMMATE_BUMP.
export const MOVE_SCORE_WEIGHTS = {
  WIN: 1_000_000,             // a move that wins the game (single or team), added on top
  OPPONENT_BUMP: 6500,        // + OPPONENT_BUMP_PER_PROGRESS * bumpedProgress (≤6910 < FINISH+WIN)
  OPPONENT_BUMP_PER_PROGRESS: 5,
  FINISH: 6000,               // + targetFinish
  LEAVE_HOME: 4500,           // above any FORWARD (≤4082)
  TAKE_CENTER: 4300,          // above any FORWARD, below LEAVE_HOME
  FORWARD: 4000,              // + resultingProgress (≤82; corner-6=4075 > corner-1=4005)
  TEAMMATE_BUMP: -1_000_000,  // always last
};

// How far along a move lands, used as the within-tier refinement. Finish slots
// rank above any track spot; center maps to its track progress.
function resultingProgress(move) {
  if (move.targetPlace === PLACE.FINISH) return MAX_TRACK_PROGRESS + 1 + (move.targetFinish ?? 0);
  if (move.targetPlace === PLACE.CENTER) return CENTER_PROGRESS;
  return move.targetProgress ?? 0;
}

function isLeaveHomeMove(state, move) {
  const marble = state.marbles[move.marbleIdx];
  return marble.place === PLACE.HOME && move.targetPlace === PLACE.TRACK;
}

// Higher = better. Exactly one category is assigned by precedence (a bump is
// checked before the destination type, since leaving home onto an occupied
// start square also bumps), then a winning move trumps everything.
export function scoreMove(state, move, roll) {
  const W = MOVE_SCORE_WEIGHTS;
  const bump = bumpInfoForMove(state, move);
  let score;

  if (bump && bump.isTeammate) {
    score = W.TEAMMATE_BUMP;
  } else if (bump) {
    const bumpedProgress = state.marbles[bump.occupantIdx].progress ?? 0;
    score = W.OPPONENT_BUMP + W.OPPONENT_BUMP_PER_PROGRESS * bumpedProgress;
  } else if (move.targetPlace === PLACE.FINISH) {
    score = W.FINISH + (move.targetFinish ?? 0);
  } else if (isLeaveHomeMove(state, move)) {
    score = W.LEAVE_HOME;
  } else if (move.targetPlace === PLACE.CENTER) {
    score = W.TAKE_CENTER;
  } else {
    score = W.FORWARD + resultingProgress(move);
  }

  // applyMove mutates and advances the turn, so score against a throwaway clone.
  const clone = structuredClone(state);
  applyMove(clone, move, roll);
  if (getWinner(clone)) score += W.WIN;

  return score;
}

// Returns a new array of move objects, best→worst, each annotated with a `bump`
// field (null | { occupantIdx, token, isTeammate }) for the client to render.
// Stable: ties keep their original relative order for deterministic output.
export function rankMoves(state, moves, roll) {
  const decorated = moves.map((move, originalIndex) => ({
    move,
    originalIndex,
    score: scoreMove(state, move, roll),
    bump: bumpInfoForMove(state, move),
  }));
  decorated.sort((a, b) => (b.score - a.score) || (a.originalIndex - b.originalIndex));
  return decorated.map(({ move, bump }) => ({ ...move, bump }));
}

function sendHome(marble) {
  marble.place = PLACE.HOME;
  marble.progress = null;
  marble.finish = null;
}

export function playerDone(state, player) {
  const slots = new Set(
    state.marbles
      .filter((m) => m.player === player && m.place === PLACE.FINISH)
      .map((m) => m.finish),
  );
  return slots.size === FINISH_LEN && [...slots].every((slot) => slot >= 0 && slot < FINISH_LEN);
}

export function getWinner(state) {
  if (state.teams) {
    for (let t = 0; t < state.teams.length; t += 1) {
      if (state.teams[t].every((p) => playerDone(state, p))) return `Team ${String.fromCharCode(65 + t)}`;
    }
    return null;
  }
  for (let player = 0; player < state.playerCount; player += 1) {
    if (playerDone(state, player)) return state.playerNames[player] || PLAYER_NAMES[state.seatColors[player]];
  }
  return null;
}

// Returns indices into playerNames for the winning side. Empty when no winner.
export function getWinningPlayers(state) {
  if (!state || !state.gameOver || !state.winner) return [];
  if (state.teams) {
    const match = /^Team ([A-Z])$/.exec(state.winner);
    if (!match) return [];
    const idx = match[1].charCodeAt(0) - 65;
    return Array.isArray(state.teams[idx]) ? [...state.teams[idx]] : [];
  }
  const idx = state.playerNames.indexOf(state.winner);
  return idx >= 0 ? [idx] : [];
}

// Pure: builds a pairwise settlement plan from a finished game + entry fee.
// Returns { pot, perWinnerShare, transfers: [{from, to, amount, sentAt, receivedAt}] }
// or null if the game isn't over or there's no fee. All currency math is done
// in cents internally so equal splits don't produce floating-point drift.
export function computeSettlement(state, entryFee) {
  const feeNumber = Number(entryFee);
  if (!Number.isFinite(feeNumber) || feeNumber <= 0) return null;
  if (!state || !state.gameOver || !state.winner) return null;

  const winners = getWinningPlayers(state);
  if (winners.length === 0) return null;

  const cents = Math.round(feeNumber * 100);
  const N = state.playerNames.length;
  const potCents = N * cents;
  const baseShareCents = Math.floor(potCents / winners.length);
  const remainderCents = potCents - baseShareCents * winners.length;

  const net = new Array(N).fill(-cents);
  winners.forEach((p, i) => {
    net[p] = baseShareCents - cents + (i === 0 ? remainderCents : 0);
  });

  const debtors = [];
  const creditors = [];
  for (let i = 0; i < N; i += 1) {
    if (net[i] < 0) debtors.push({ player: i, owed: -net[i] });
    else if (net[i] > 0) creditors.push({ player: i, credit: net[i] });
  }
  debtors.sort((a, b) => b.owed - a.owed);
  creditors.sort((a, b) => b.credit - a.credit);

  const transfers = [];
  let di = 0;
  let ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const d = debtors[di];
    const c = creditors[ci];
    const amt = Math.min(d.owed, c.credit);
    transfers.push({
      from: state.playerNames[d.player],
      to: state.playerNames[c.player],
      amount: amt / 100,
      sentAt: null,
      receivedAt: null,
    });
    d.owed -= amt;
    c.credit -= amt;
    if (d.owed === 0) di += 1;
    if (c.credit === 0) ci += 1;
  }

  return {
    pot: potCents / 100,
    perWinnerShare: baseShareCents / 100,
    transfers,
  };
}

function nextPlayer(state) {
  state.currentPlayer = (state.currentPlayer + 1) % state.playerCount;
  if (state.currentPlayer === 0) state.turnNumber += 1;
  // Turn advanced — drop any lingering die value so the new player doesn't
  // see the previous player's roll displayed as their own.
  state.pendingRoll = null;
  state.pendingDieValue = null;
}

export function advanceNoMoveRoll(state, rollId = null) {
  if (!state.noMoveRoll) return false;
  if (rollId && state.noMoveRoll.rollId !== rollId) return false;

  const shouldAdvance = state.noMoveRoll.shouldAdvance;
  state.noMoveRoll = null;
  state.pendingRoll = null;
  state.pendingDieValue = null;
  if (shouldAdvance) nextPlayer(state);
  return true;
}

// Apply a move (mutates state). Returns metadata about what happened.
// `move` is a move object returned by legalMoves. `roll` was the dice value.
export function applyMove(state, move, roll) {
  state.noMoveRoll = null;
  const movingMarble = state.marbles[move.marbleIdx];
  const beforeMarble = {
    player: movingMarble.player,
    index: movingMarble.index,
    seat: movingMarble.seat,
    place: movingMarble.place,
    progress: movingMarble.progress,
    finish: movingMarble.finish,
  };

  let bumpedIdx = null;
  if (move.targetPlace === PLACE.TRACK) {
    const targetAbs = (startForPlayer(state, movingMarble.player) + move.targetProgress) % TRACK_LEN;
    const occupant = marbleAtTrack(state, targetAbs);
    if (occupant && occupant.player !== movingMarble.player) {
      bumpedIdx = state.marbles.indexOf(occupant);
      sendHome(occupant);
    }
  } else if (move.targetPlace === PLACE.CENTER) {
    const occupant = centerOccupant(state);
    if (occupant && occupant.player !== movingMarble.player) {
      bumpedIdx = state.marbles.indexOf(occupant);
      sendHome(occupant);
    }
  }

  movingMarble.place = move.targetPlace;
  movingMarble.progress = move.targetProgress ?? null;
  movingMarble.finish = move.targetFinish ?? null;

  const bumpedText =
    bumpedIdx !== null ? `, bumped ${marbleToken(state.marbles[bumpedIdx])} home` : "";
  state.log.unshift(`${move.label}${bumpedText}`);
  state.pendingRoll = null;
  state.pendingDieValue = null;

  const wasReroll = roll === 1 || roll === 6;
  const winner = getWinner(state);
  if (winner) {
    state.gameOver = true;
    state.winner = winner;
    state.log.unshift(`${winner} wins`);
  } else if (!wasReroll) {
    nextPlayer(state);
  } else {
    state.log.unshift(`${state.playerNames[state.currentPlayer]} rolls again`);
  }

  state.lastMove = {
    marbleIdx: move.marbleIdx,
    roll,
    before: beforeMarble,
    after: {
      place: movingMarble.place,
      progress: movingMarble.progress,
      finish: movingMarble.finish,
    },
    targetPlace: move.targetPlace,
    targetProgress: move.targetProgress ?? null,
    targetFinish: move.targetFinish ?? null,
    bumpedIdx,
  };

  return { wasReroll, winner, bumpedIdx };
}

// Roll: dice value + computed legal moves. Caller handles state mutation
// (sets pendingRoll/pendingDieValue, advances player if no moves and not reroll).
export function rollAndCompute(state, dieValue) {
  state.pendingDieValue = dieValue;
  state.pendingRoll = dieValue;
  state.noMoveRoll = null;
  const moves = rankMoves(state, legalMoves(state, state.currentPlayer, dieValue), dieValue);
  if (moves.length === 0) {
    state.log.unshift(
      `${state.playerNames[state.currentPlayer]} rolled ${dieValue}: no move`,
    );
    state.noMoveRoll = {
      player: state.currentPlayer,
      dieValue: dieValue,
      shouldAdvance: dieValue !== 1 && dieValue !== 6,
      rollId: Math.random().toString(36).substring(2),
    };
    state.pendingRoll = null;
    state.pendingDieValue = dieValue;
    state.lastMove = null;
  }
  return moves;
}
