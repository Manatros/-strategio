// src/fow/Fog.ts
import type { Axial, MapData } from "../hex/types";
import { hexDistance } from "../hex/HexMath";
import { key as tileKey } from "../hex/types";

export type Visibility = "hidden" | "seen" | "visible";

/** Tracks which tiles are currently visible and which have been seen before. */
export class FogOfWar {
  visible = new Set<string>();
  seen = new Set<string>();
  radius: number;

  constructor(public map: MapData, visionRadius = 5) {
    this.radius = visionRadius;
  }

  /** Recompute visibility around a center (e.g., player), mark those tiles as seen. */
  recalc(center: Axial) {
    this.visible.clear();
    for (const t of this.map.tiles.values()) {
      if (hexDistance(center, t) <= this.radius) {
        const k = tileKey(t.q, t.r);
        this.visible.add(k);
        this.seen.add(k);
      }
    }
  }

  /** What should the tile render state be? */
  state(q: number, r: number): Visibility {
    const k = tileKey(q, r);
    if (this.visible.has(k)) return "visible";
    if (this.seen.has(k)) return "seen";
    return "hidden";
  }
}
