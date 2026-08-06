// src/hex/Pathfinding.ts
import type { Axial, Tile } from "./types";
import { neighbors } from "./HexMath";
import { isPassable } from "./helpers";

/**
 * getTile is whatever the caller has actually learned about the world —
 * for the live game that's the client's cache of server-sent tiles, so this
 * naturally only paths through terrain the player has actually seen.
 * canEnter defaults to plain terrain passability, but callers can layer
 * extra rules on top (e.g. "not through someone else's territory").
 */
export function bfsPath(
  getTile: (key: string) => Tile | undefined,
  start: Axial,
  goal: Axial,
  maxNodes = 400,
  canEnter: (t: Tile | undefined) => boolean = isPassable
): Axial[] | null {
  if (start.q === goal.q && start.r === goal.r) return [start];

  const seen = new Set<string>();
  const q: Axial[] = [];
  const parent = new Map<string, Axial>();

  const startK = `${start.q},${start.r}`;
  const goalK = `${goal.q},${goal.r}`;

  q.push(start);
  seen.add(startK);

  let nodes = 0;
  while (q.length && nodes++ < maxNodes) {
    const cur = q.shift()!;
    for (const n of neighbors(cur)) {
      const k = `${n.q},${n.r}`;
      if (seen.has(k)) continue;

      const t = getTile(k);
      if (!canEnter(t)) continue;

      parent.set(k, cur);
      if (k === goalK) {
        const path: Axial[] = [goal];
        let p: Axial | undefined = goal;
        while (p && !(p.q === start.q && p.r === start.r)) {
          const pk = `${p.q},${p.r}`;
          const pr = parent.get(pk);
          if (!pr) break;
          path.push(pr);
          p = pr;
        }
        path.reverse();
        return path;
      }
      seen.add(k);
      q.push(n);
    }
  }
  return null;
}