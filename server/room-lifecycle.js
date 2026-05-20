export const COMPLETED_ROOM_TTL_MS = 5 * 60 * 1000;
export const INACTIVE_ROOM_TTL_MS = 30 * 60 * 1000;
export const EMPTY_ROOM_TTL_MS = 60 * 60 * 1000;
export const ROOM_GC_INTERVAL_MS = 60 * 1000;

export function roomShouldExpire(room, now) {
  if (room.gameState?.gameOver) {
    const completedAt = room.completedAt || room.lastMoveAt || room.createdAt;
    return now - completedAt > COMPLETED_ROOM_TTL_MS;
  }
  if (room.phase === "playing") {
    const lastMoveAt = room.lastMoveAt || room.createdAt;
    return now - lastMoveAt > INACTIVE_ROOM_TTL_MS;
  }
  return false;
}
