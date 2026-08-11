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

/**
 * Weighted "fastest path" search (Dijkstra) — cost-aware, because roads make some tiles cheaper to
 * enter than others, so the fastest route isn't always the one with the fewest tiles. With a uniform
 * getCost (the default), this produces exactly the same route as bfsPath — it's a strict superset,
 * used specifically where road-aware routing matters (currently: Human movement).
 */
export function fastestPath(
  getTile: (key: string) => Tile | undefined,
  start: Axial,
  goal: Axial,
  maxNodes = 400,
  canEnter: (t: Tile | undefined) => boolean = isPassable,
  getCost: (k: string, t: Tile | undefined) => number = () => 1
): Axial[] | null {
  if (start.q === goal.q && start.r === goal.r) return [start];

  const startK = `${start.q},${start.r}`;
  const goalK = `${goal.q},${goal.r}`;

  const dist = new Map<string, number>([[startK, 0]]);
  const parent = new Map<string, Axial>();
  const visited = new Set<string>();

  let nodes = 0;
  while (nodes++ < maxNodes) {
    let curK: string | null = null;
    let curDist = Infinity;
    for (const [k, d] of dist) {
      if (visited.has(k) || d >= curDist) continue;
      curDist = d; curK = k;
    }
    if (curK === null) break; // nothing left reachable within maxNodes

    if (curK === goalK) {
      const path: Axial[] = [goal];
      let p = goalK;
      while (p !== startK) {
        const pr = parent.get(p);
        if (!pr) break;
        path.push(pr);
        p = `${pr.q},${pr.r}`;
      }
      path.reverse();
      return path;
    }

    visited.add(curK);
    const [cq, cr] = curK.split(",").map(Number);
    for (const n of neighbors({ q: cq, r: cr })) {
      const nk = `${n.q},${n.r}`;
      if (visited.has(nk)) continue;
      const t = getTile(nk);
      if (!canEnter(t)) continue;
      const newDist = curDist + getCost(nk, t);
      if (newDist < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, newDist);
        parent.set(nk, { q: cq, r: cr });
      }
    }
  }
  return null;
}
