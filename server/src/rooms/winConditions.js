// Win conditions are a pluggable list: each is a function(room) that
// returns null (no winner yet) or { winnerId, reason }. To add a new win
// condition later, write one function and add it to WIN_CONDITIONS below —
// checkWinConditions() and everything that calls it doesn't need to change.
import { key, hexDistance, canEnterTerrain } from "../world/hex.js";

// The world generates lazily and is unbounded, so "no spawn possible
// ANYWHERE" isn't literally checkable without generating an infinite map.
// This treats a MAP_RADIUS-tile arena around the origin as "the map" for
// domination purposes — a deliberate, honest bound that makes the win
// condition actually achievable in a real game.
export const DOMINATION_MAP_RADIUS = 60;
export const DOMINATION_MIN_DISCOVERED_TILES = 150; // avoid an early-game false trigger before enough is even explored

/**
 * Domination Victory: every passable tile discovered so far within
 * DOMINATION_MAP_RADIUS of the origin is claimed by a single player, and
 * enough of the arena has actually been explored for that to be meaningful.
 * Deliberately conservative: HighMountain doesn't count as "passable" here
 * even though Dwarves can spawn on it — an unclaimed HighMountain tile
 * means a new Dwarf really could still spawn, so domination correctly
 * doesn't trigger in that case.
 */
export function checkDomination(room) {
  if (room.players.size < 2) return null; // nothing to "dominate" with only one player in the room

  let discoveredPassable = 0;
  let unclaimedPassable = 0;
  const claimCounts = new Map(); // ownerId -> count of passable tiles they hold within the arena

  for (const t of room.tiles.cache.values()) {
    if (hexDistance({ q: 0, r: 0 }, { q: t.q, r: t.r }) > DOMINATION_MAP_RADIUS) continue;
    if (!canEnterTerrain(t, false)) continue;
    discoveredPassable++;
    const claim = room.claims.get(key(t.q, t.r));
    if (claim) claimCounts.set(claim.ownerId, (claimCounts.get(claim.ownerId) || 0) + 1);
    else unclaimedPassable++;
  }

  if (discoveredPassable < DOMINATION_MIN_DISCOVERED_TILES) return null;
  if (unclaimedPassable > 0) return null; // spawn room still exists somewhere within the discovered arena

  let bestOwner = null, bestCount = 0;
  for (const [owner, count] of claimCounts) {
    if (count > bestCount) { bestCount = count; bestOwner = owner; }
  }
  if (!bestOwner || bestCount !== discoveredPassable) return null; // must be ALL of it, not just the most

  return { winnerId: bestOwner, reason: "domination" };
}

export const WIN_CONDITIONS = [checkDomination];

export function checkWinConditions(room) {
  for (const check of WIN_CONDITIONS) {
    const result = check(room);
    if (result) return result;
  }
  return null;
}
