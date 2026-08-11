// src/fow/Fog.ts
import type { Axial } from "../hex/types";
import { key as tileKey } from "../hex/types";

export type Visibility = "hidden" | "seen" | "visible";

/**
 * Client-side fog is purely a rendering concern now — it decides what's
 * dimmed vs bright on screen. It has no bearing on what the client actually
 * *knows*; that's enforced server-side (the server simply never sends tiles
 * outside a player's vision in the first place).
 */
export class FogOfWar {
  visible = new Set<string>();
  seen = new Set<string>();

  constructor(public radius: number, public buildingRadius = 3) {}

  /** Recompute visibility: a disk around the player, plus a smaller disk around each extra center (owned buildings). */
  recalc(center: Axial, extraCenters: Axial[] = []) {
    this.visible.clear();
    const addDisk = (c: Axial, rad: number) => {
      for (let dq = -rad; dq <= rad; dq++) {
        const r1 = Math.max(-rad, -dq - rad);
        const r2 = Math.min(rad, -dq + rad);
        for (let dr = r1; dr <= r2; dr++) {
          const k = tileKey(c.q + dq, c.r + dr);
          this.visible.add(k);
          this.seen.add(k);
        }
      }
    };
    addDisk(center, this.radius);
    for (const c of extraCenters) addDisk(c, this.buildingRadius);
  }

  state(q: number, r: number): Visibility {
    const k = tileKey(q, r);
    if (this.visible.has(k)) return "visible";
    if (this.seen.has(k)) return "seen";
    return "hidden";
  }
}
