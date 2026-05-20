# Marbles

Hex-board marbles game with multiplayer lobby for family play (2–6 players, single or teams).

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser. The admin clicks **Create new game**, picks a name, then shares the `?room=CODE` URL with everyone else. Each joiner opens that link, enters a name, and lands in the lobby. When everyone's there, the admin chooses a mode and clicks **Start game**.

Set `PORT=8080 npm start` if port 3000 is taken.

## Run tests

```bash
npm test
```

Covers `assignSeats` for every (player count, mode), `validModes`, and a roll-and-apply smoke.

## Project layout

```
public/
  index.html        # home / lobby / game views, single page
  client.js         # rendering, animation, WS plumbing
  styles.css
  shared/rules.js   # pure game logic (constants, legalMoves, applyMove, etc.)
server/
  server.js         # http static + WS (path=/ws), in-memory rooms
  rules.test.js     # node --test
```

`public/shared/rules.js` is imported by both the browser and the Node server, so the game logic stays in one place and there's no risk of client/server divergence.

## Game rules

- Roll a 1 or 6 to leave home; both grant a re-roll.
- **Backward-3 Move Rule:** If you roll a `3` immediately after a marble leaves home, that marble can go backward `3` spaces (landing at progress `81` on the track, just before your finish lane).
- Own marbles block landing or jumping past them on the track and in the finish lane.
- Opponent marbles can be bumped home (sent back to their starting pad).
- The finish lane needs an exact roll — no overshoot.
- A marble can enter the center on an exact roll that lands on it from the player's first stretch; only a roll of 1 exits the center, and only onto a corner hole.
- Corner-circuit shortcut: if you're sitting on a corner apex, a roll N jumps you N corners forward (capped at your own home-side corner).
- **Team Play / Teammate Move Sharing:** When playing on teams, once you get all of your own marbles home, you can roll the dice on your turn and move teammate marbles on their behalf to help your team win.
- **Win Conditions:** In single play, a player wins when all of their own marbles are home. In team play, a team wins when all marbles for that entire team make it to their respective finish lanes.
- The local player's home row always renders at the bottom of the board (rotation is per-viewer, not per-turn).

## Multiplayer & State Persistence

- **Redis Integration:** Room and board state are stored in Upstash Redis with a 24-hour expiration TTL. This means active games and lobbies survive server restarts and sleep cycles.
- **In-Game Lobby Chat:** Includes a premium, real-time glassmorphic chat drawer with glowing unread badge notifications, autoscroll, and dynamic name colorization matching each player's board color.
- Identity = name within a room. Reconnecting with the same name (and, for the admin, the same `adminToken` saved in `localStorage`) reclaims the seat.
- Color and team assignment is server-side and deterministic for each (player count, mode). Players don't pick colors, so team alternation constraints stay valid.
- Modes by player count: 2 → 1v1; 3 → free-for-all; 4 → free-for-all or 2 teams of 2; 5 → free-for-all; 6 → free-for-all, 2 teams of 3, or 3 teams of 2.

## Out of scope / future work

- Spectator mode.
- Auto-promote next-joined player to admin if the original admin abandons the lobby.
- Letting one player control multiple colors.
