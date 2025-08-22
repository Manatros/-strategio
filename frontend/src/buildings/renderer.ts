// src/buildings/renderer.ts
import * as PIXI from "pixi.js";
import type { Building } from "./types";
import type { MapData } from "../hex/types";
import { axialToPixel } from "../hex/HexMath";

const COLORS: Record<Building["kind"], number> = {
  TownHall:    0xffc857,
  Lumberjack:  0x2a9d8f,
  Farm:        0xe9c46a,
  Mine:        0x7d7d7d,
  FishingBoat: 0x1a8ae0,
  Bridge:      0x6b4b2a,
};

export class BuildingRenderer {
  container = new PIXI.Container();
  private sprites = new Map<string, PIXI.Graphics>();

  constructor(public map: MapData) {}

  upsert(b: Building) {
    const id = `${b.q},${b.r}`;
    if (this.sprites.has(id)) return;
    const g = new PIXI.Graphics();
    const { x, y } = axialToPixel({ q: b.q, r: b.r }, this.map.hexSize);
    g.x = x; g.y = y;

    // simple icon: small hex-ish diamond with a marker
    const s = this.map.hexSize * 0.45;
    g.rect(-s*0.6, -s*0.6, s*1.2, s*1.2).fill(COLORS[b.kind]).stroke({ color: 0x000000, width: 2, alpha: 0.4 });
    g.circle(0,0,s*0.25).fill(0x000000).alpha = 0.6;

    this.container.addChild(g);
    this.sprites.set(id, g);
  }

  setAlphaForHidden(hiddenSet: Set<string>, seenSet: Set<string>) {
    // buildings obey fog (hidden→0, seen→0.35, visible→1)
    for (const [id, g] of this.sprites) {
      if (!seenSet.has(id)) { g.visible = false; continue; }
      g.visible = true;
      g.alpha = hiddenSet.has(id) ? 0.35 : 1;
    }
  }
}
