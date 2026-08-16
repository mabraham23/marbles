#!/bin/bash
# Run the full autoplay battery. Requires a local server started with:
#   ROOM_STORE=memory DEBUG_HOOKS=1 NO_MOVE_DIE_DISPLAY_MS=40 NO_MOVE_NOTICE_MS=40 TURN_TIMEOUT_SWEEP_MS=50 BOT_STEP_DELAY_MS=50 npm start
# Usage: bash tools/run-sims.sh [runs]
cd "$(dirname "$0")"
RUNS=${1:-1}
for run in $(seq 1 "$RUNS"); do
  for cfg in "2 single" "3 single" "4 single" "4 pairs" "5 single" "6 single" "6 pairs" "6 triads"; do
    set -- $cfg
    node sim-full-game.mjs --players "$1" --mode "$2" --label "r$run-$1p-$2" 2>&1 |
      grep -E "RESULT|VIOLATION|FATAL|error to"
  done
done
