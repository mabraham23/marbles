# Agent Notes

## Local Marbles Browser Setup

Use this when a Codex agent needs to run Marbles locally and drive it in the Codex in-app browser.

This file is the central source of truth for agent-run Marbles setup, browser simulation, and local port safety. If another note or README gives a shorter local-start command, follow this file for agent work.

### Server

- Check for an existing local server with `lsof -nP -iTCP:3000 -sTCP:LISTEN`.
- Treat port `3000` as potentially owned by another live Marbles simulation. Do not kill, restart, reuse, or navigate an existing process on port `3000` unless the user explicitly asks you to take over that run.
- If port `3000` is already in use, inspect it with `lsof -nP -iTCP:3000 -sTCP:LISTEN` and choose another free port such as `3001`, `3002`, or `3003` for your own local run.
- Start the app with `npm start` from the repo or worktree you are testing. To use a non-default port, run `PORT=3001 npm start` and replace `3001` with the chosen free port.
- **Always start local/dev servers with `ROOM_STORE=memory npm start`.** The repo `.env` carries the production Upstash Redis credentials, and every server process sharing that database sweeps EVERY room in it (bot turns, timeouts, no-move advances) while broadcasting only to its own sockets. A plain local `npm start` therefore corrupts live games on the deployed instance and vice versa: players see frozen "Waiting for X to roll" UIs and bot moves that appear to use the wrong die value. `ROOM_STORE=memory` forces isolated in-memory storage regardless of `.env`.
- Verify the server with `curl -I http://localhost:PORT`, replacing `PORT` with the actual port for this run.
- Use the same chosen port consistently for browser URLs, invite links, WebSocket helper URLs, and room-state checks. For example, use `http://localhost:3001`, `http://127.0.0.1:3001/?room=CODE`, and `ws://localhost:3001/ws` when running on port `3001`.
- If stopping previous runs, kill only the actual Marbles server process that you started for the current task, not another agent's server and not Codex/editor/shell processes that merely have this repo as cwd.
- Rooms may persist through Upstash Redis, so use a fresh room code for new setup tests.

### Quick Six-Player Smoke Setup

Use this path when the user asks to quickly set up or simulate a full game:

1. Pick `PORT` using the Server section above, then run `PORT=3001 npm start` from the current repo/worktree.
2. Verify with `curl -I http://localhost:PORT`.
3. Set the in-app browser viewport to `390 x 844`, open `http://localhost:PORT`, and keep that visible browser on the Admin game.
4. Create the room visibly as `Admin`, click the real `Copy invite link` button, and use the fallback banner URL if clipboard access fails.
5. Join `Player 2` through `Player 6` with WebSocket helpers pointed at `ws://localhost:PORT/ws`.
6. Select `Free-for-all` for mode `single` unless the user asks for teams.
7. Start from the visible Admin tab when it is still connected.
8. For smoke-play, drive Admin turns through the visible UI and let helper sockets roll/submit for other players.
9. If the app is using local in-memory fallback storage, verify live gameplay state through the connected browser/WebSocket messages; a separate `node -e` process that imports `roomStore` will see a different empty in-memory store.
10. Stop helper sockets before reporting, changing shared context, or ending the task.

### In-App Browser

- For gameplay simulation, set the visible in-app browser to a mobile viewport first because this game is most commonly played on phones. The viewport that worked was `390 x 844`.
- With the Browser plugin, use `await (await browser.capabilities.get("viewport")).set({ width: 390, height: 844 });` and keep it set while simulating unless the user asks to reset it.
- Open `http://localhost:PORT`, replacing `PORT` with the port chosen in the Server section.
- Create a room as `Admin`.
- Click the real `Copy invite link` button in the lobby. If browser clipboard access fails, the app shows a fallback banner such as `Copy failed; link: http://localhost:PORT/?room=CODE`; use that displayed URL as the invite source.
- If text entry helpers fail with a virtual clipboard error, focus the input using `dom_cua.click` and type with repeated `cua.keypress` calls.
- Same-origin `localhost` tabs can inherit the admin `sessionStorage`. Use `http://127.0.0.1:PORT/?room=CODE` for a visible second player to get separate browser storage while hitting the same server.

### Multi-Player Setup

- For 2 players: join the second visible tab/origin as `Player 2`, then start from the admin tab.
- For 6 players: create the admin room visibly, then add `Player 2` through `Player 6` using WebSocket `joinRoom` calls to `ws://localhost:PORT/ws`.
- The server acknowledges helper joins with `{ "type": "joinedRoom" }`, not `roomJoined`.
- In the lobby, helper clients should wait for `joinedRoom` or `lobbyState`; they will not receive `gameState` until after the game starts.
- Keep helper sockets open until the visible admin lobby shows all six players and the game has started. Closing helper sockets while still in the lobby can leave later setup checks racing against socket cleanup.
- Joined players remain in the room's `players` list even after their WebSocket helpers close, unless they explicitly leave or the room is deleted.
- For 6 players, select a valid mode before starting; `Free-for-all` corresponds to mode `single`.
- If `Start game` stays disabled with six players visible, select a mode first.
- Prefer using the visible admin tab to start the game if it is still connected. A second admin WebSocket reclaim can fail with `Name taken` while the browser admin socket is live.
- After helper joins or game start, verify room state with:

```bash
node --input-type=module -e "import { roomStore } from './server/storage.js'; const room = await roomStore.get('CODE'); console.log(JSON.stringify({ phase: room.phase, mode: room.mode, players: room.players.map(p => p.name), currentPlayer: room.gameState?.playerNames?.[room.gameState?.currentPlayer] }, null, 2));"
```

### Gameplay Simulation

- Keep the in-app browser visible on the admin board in mobile viewport (`390 x 844`) so the user can watch board updates in the layout that most closely matches real play.
- Use background WebSocket helper clients for `Player 2` through `Player 6`.
- Each helper should listen for `gameState`; when `state.playerNames[state.currentPlayer]` matches that helper name and `state.pendingRoll == null`, send `{ "type": "roll" }`.
- If the helper receives `gameState` with a non-empty `moves` array, choose a move with `{ "type": "submitMove", "moveIdx": 0 }`. Picking index `0` is enough for smoke simulation.
- No-move turns and rerolls are handled by the server state. If a player rolls `1` or `6` with no move, the same player may get another roll; helpers should keep reacting to `pendingRoll == null`.
- For Admin turns, drive the visible browser UI: click `Roll dice`, then click the first `.move-button` when move choices appear.
- If helper autoplay stalls, clear old helper `message` listeners, attach one fresh listener per helper socket, send `syncRoom`, and continue from the current state. Reused dedupe keys/listeners can make a helper ignore the next legal roll or move.
- To prove a dice-specific bugfix quickly, run a targeted WebSocket harness on the same live server and create fresh short-lived six-player rooms until the natural dice sequence appears. This is faster and more reliable than waiting for the visible room to hit a rare sequence, while the visible room still verifies the UI/gameplay flow.
- If the user interrupts a gameplay simulation, stop any background helper process before doing follow-up work.

### Chat Testing

- Test chat in the same mobile viewport used for gameplay simulation (`390 x 844`).
- Open chat from the visible Admin board with the `Toggle Chat` button.
- Send at least one Admin message through the visible UI so the actual mobile input and submit controls are exercised.
- Send additional messages as `Player 2` through `Player 6` using WebSocket helpers: join the room with `{ type: "joinRoom", code, name }`, then send `{ type: "chat", text }`.
- Test both open-drawer behavior with several messages and closed-drawer unread behavior by closing chat, sending a message from another player, and checking the unread badge.
- On mobile, inspect whether the chat header, close control, message list, and input are reachable without pinch-zooming. Pay special attention to keyboard/focus behavior.

### Useful Local Commands

Read room state and admin token:

```bash
node --input-type=module -e "import { roomStore } from './server/storage.js'; const room = await roomStore.get('CODE'); console.log(JSON.stringify(room, null, 2));"
```

This only works for the same persistent backend the server is using, such as Upstash Redis. If the server logs `RoomStore: Using local in-memory fallback storage`, inspect state through existing WebSocket clients or the visible browser instead.

Start as admin over WebSocket when no visible admin tab is available:

```bash
node --input-type=module -e "import WebSocket from 'ws'; const ws = new WebSocket('ws://localhost:PORT/ws'); ws.on('open', () => { ws.send(JSON.stringify({ type: 'joinRoom', code: 'CODE', name: 'Admin', adminToken: 'ADMIN_TOKEN' })); setTimeout(() => ws.send(JSON.stringify({ type: 'startGame' })), 250); setTimeout(() => ws.close(), 1000); }); ws.on('message', (data) => console.log(String(data))); ws.on('error', (err) => { console.error(err); process.exit(1); });"
```

### Stop Condition

When asked to make the game ready to play, stop once the board is visible and the first turn is waiting. Do not roll dice unless asked.
