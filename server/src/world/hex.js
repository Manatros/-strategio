export const key = (q, r) => `${q},${r}`;

export const neighbors = (q, r) => ([
  { q: q + 1, r },
  { q: q + 1, r: r - 1 },
  { q, r: r - 1 },
  { q: q - 1, r },
  { q: q - 1, r: r + 1 },
  { q, r: r + 1 },
]);

export const hexDistance = (a, b) =>
  (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;

/** All axial coords within `radius` of `center` (a filled hex disk, not just the ring). */
export function diskCoords(center, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const r1 = Math.max(-radius, -dq - radius);
    const r2 = Math.min(radius, -dq + radius);
    for (let dr = r1; dr <= r2; dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
}

export const isPassable = (t) => !!t && t.kind !== "Water" && t.kind !== "Snow" && t.kind !== "HighMountain";

/** Same as isPassable, but lets a caller allow HighMountain through (Dwarf Scouts can cross it). */
export function canEnterTerrain(t, allowHighMountain = false) {
  if (!t) return false;
  if (t.kind === "Water" || t.kind === "Snow") return false;
  if (t.kind === "HighMountain") return allowHighMountain;
  return true;
}

/**
 * Simple BFS path search through passable terrain — shared by anything server-side that needs
 * autonomous multi-tile movement (bots, civilians). The client has its own equivalent
 * (hex/Pathfinding.ts) for player-commanded movement; this is that same idea, server-side.
 * Returns the full path INCLUDING the start tile, or null if unreachable within maxNodes.
 */
export function bfsPath(tiles, start, goal, passable = false, maxNodes = 600) {
  const isPassable = typeof passable === "function" ? passable : (t) => canEnterTerrain(t, passable);
  if (start.q === goal.q && start.r === goal.r) return [start];
  const startK = key(start.q, start.r), goalK = key(goal.q, goal.r);
  const seen = new Set([startK]);
  const parent = new Map();
  const queue = [start];
  let head = 0, nodes = 0;

  while (head < queue.length && nodes++ < maxNodes) {
    const cur = queue[head++];
    for (const n of neighbors(cur.q, cur.r)) {
      const nk = key(n.q, n.r);
      if (seen.has(nk)) continue;
      if (!isPassable(tiles.getAt(n.q, n.r), n.q, n.r)) continue;
      seen.add(nk);
      parent.set(nk, cur);
      if (nk === goalK) {
        const path = [goal];
        let p = goal;
        while (key(p.q, p.r) !== startK) { p = parent.get(key(p.q, p.r)); path.push(p); }
        return path.reverse();
      }
      queue.push(n);
    }
  }
  return null; // unreachable within maxNodes -- caller should fall back to something else
}
