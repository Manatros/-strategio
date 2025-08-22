
// src/hex/Pathfinding.ts
import type { Axial, MapData, Tile } from "./types";
import { neighbors } from "./HexMath";
import { isPassable } from "./helpers";

export function bfsPath(map: MapData, start: Axial, goal: Axial, maxNodes = 400): Axial[] | null {
  if (start.q === goal.q && start.r === goal.r) return [start];

  const tiles = map.tiles;
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

      const t = tiles.get(k);
      if (!isPassable(t)) continue;

      parent.set(k, cur);
      if (k === goalK) {
        // reconstruct
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
