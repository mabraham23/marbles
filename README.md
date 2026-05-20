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
- Own marbles block landing or jumping past them on the track and in the finish lane.
- Opponent marbles can be bumped home (sent back to their starting pad).
- The finish lane needs an exact roll — no overshoot.
- A marble can enter the center on an exact roll that lands on it from the player's first stretch; only a roll of 1 exits the center, and only onto a corner hole.
- Corner-circuit shortcut: if you're sitting on a corner apex, a roll N jumps you N corners forward (capped at your own home-side corner).
- The local player's home row always renders at the bottom of the board (rotation is per-viewer, not per-turn).

## Multiplayer details

- Rooms live in memory only — a server restart wipes them. Acceptable for casual family use.
- Identity = name within a room. Reconnecting with the same name (and, for the admin, the same `adminToken` saved in `localStorage`) reclaims the seat.
- Color and team assignment is server-side and deterministic for each (player count, mode). Players don't pick colors, so team alternation constraints stay valid.
- Modes by player count: 2 → 1v1; 3 → free-for-all; 4 → free-for-all or 2 teams of 2; 5 → free-for-all; 6 → free-for-all, 2 teams of 3, or 3 teams of 2.

## Deploy to Render.com

1. Commit and push the repo to GitHub.
2. On Render, click **New → Web Service** and connect the repo.
3. Settings:
   - Environment: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Node version: leave on autodetect (the `engines.node >= 20` in `package.json` is enough).
4. Free tier is fine for family use, but note: the free instance **sleeps after 15 minutes of inactivity**. The first request after a sleep takes ~30 seconds to wake. Once awake, WebSockets work normally. If anyone tries to join during the wake-up window the lobby may look unresponsive — just give it a moment and reload.
5. Once deployed you'll get a `*.onrender.com` URL — that's what you text to family. Append `?room=CODE` after creating a game.

For an always-on alternative, Fly.io's free tier doesn't sleep but needs `fly.toml` and a Dockerfile (out of scope here).

## Out of scope / future work

- Chat in the lobby.
- Spectator mode.
- Auto-promote next-joined player to admin if the original admin abandons the lobby.
- Persistence across server restarts.
- Letting one player control multiple colors.
