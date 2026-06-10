// The "back of the board": a permanent, global winners wall. Every player who
// wins (or is on the winning team) can sign it once per game — the first win
// writes their name, every later win adds a tally. Pure helpers here so the
// upsert rules are unit-testable; persistence lives in storage.js globals.

export const SIGNATURES_KEY = "boardSignatures";

// Upsert a signature. The signed name is permanent ink: later wins only add
// tallies, even if the player is using a different username by then.
export function applySignature(signatures, playerId, name, now) {
  const next = { ...(signatures || {}) };
  const existing = next[playerId];
  if (existing) {
    next[playerId] = { ...existing, tallies: existing.tallies + 1, lastWonAt: now };
  } else {
    next[playerId] = { name, tallies: 1, firstSignedAt: now, lastWonAt: now };
  }
  return next;
}

// Public view for clients: no player ids, ordered like ink accumulating on a
// real board — by when each name was first signed.
export function signatureList(signatures) {
  return Object.values(signatures || {})
    .map(({ name, tallies, firstSignedAt }) => ({ name, tallies, firstSignedAt }))
    .sort((a, b) => a.firstSignedAt - b.firstSignedAt);
}
