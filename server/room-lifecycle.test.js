import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPLETED_ROOM_TTL_MS,
  INACTIVE_ROOM_TTL_MS,
  roomShouldExpire,
} from "./room-lifecycle.js";

test("room lifecycle: completed games expire after five minutes", () => {
  const now = 1_000_000;
  const room = {
    createdAt: now - 10_000,
    lastMoveAt: now - 10_000,
    completedAt: now - COMPLETED_ROOM_TTL_MS - 1,
    phase: "playing",
    gameState: { gameOver: true },
  };

  assert.equal(roomShouldExpire(room, now), true);

  room.completedAt = now - COMPLETED_ROOM_TTL_MS + 1;
  assert.equal(roomShouldExpire(room, now), false);
});

test("room lifecycle: active unfinished games expire after thirty inactive minutes", () => {
  const now = 1_000_000;
  const room = {
    createdAt: now - 50_000,
    lastMoveAt: now - INACTIVE_ROOM_TTL_MS - 1,
    completedAt: null,
    phase: "playing",
    gameState: { gameOver: false },
  };

  assert.equal(roomShouldExpire(room, now), true);

  room.lastMoveAt = now - INACTIVE_ROOM_TTL_MS + 1;
  assert.equal(roomShouldExpire(room, now), false);
});

test("room lifecycle: lobby rooms do not use game inactivity expiry", () => {
  const now = 1_000_000;
  const room = {
    createdAt: now - INACTIVE_ROOM_TTL_MS - 1,
    lastMoveAt: null,
    completedAt: null,
    phase: "lobby",
    gameState: null,
  };

  assert.equal(roomShouldExpire(room, now), false);
});
