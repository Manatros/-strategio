// src/hex/TileRenderer.ts
import * as PIXI from "pixi.js";
import { axialToPixel } from "./HexMath";
import { key, type MapData, type Tile } from "./types";
import { key as tileKey } from "./types";

function colorFor(kind: Tile["kind"]) {
  switch (kind) {
    case "Grass": return 0x3e7e2c;
    case "Stone": return 0x7d7d7d;
    case "Water": return 0x1a3e8a;
    case "Fields": return 0xcaa75c;
    case "Snow": return 0xdfe7ee;
    case "Forest": return 0x27531b;
    case "Bridge": return 0x6b4b2a;
  }
}

export class TileRenderer {
  container = new PIXI.Container();
  private cache = new Map<string, PIXI.Graphics>();
  hover = new PIXI.Graphics();

  constructor(public map: MapData) {
    this.hover.visible = false;
    this.container.addChild(this.hover);
  }

setAlphaByFog(hiddenSet: Set<string>, seenSet: Set<string>) {
  // hidden -> 0, seen -> 0.25, visible -> 1
  for (const [k, g] of this.cache) {
    if (!seenSet.has(k)) { g.visible = false; continue; }
    g.visible = true;
    g.alpha = hiddenSet.has(k) ? 0.25 : 1;
  }
}

tileId(q:number,r:number){ return tileKey(q,r); }
  drawAll() {
    const { hexSize } = this.map;
    for (const t of this.map.tiles.values()) {
      const k = key(t.q, t.r);
      const g = new PIXI.Graphics();
      const { x, y } = axialToPixel(t, hexSize);
      g.x = x; g.y = y;
      this.hex(g, hexSize, colorFor(t.kind));
      this.container.addChild(g);
      this.cache.set(k, g);
    }
    // center
    const b = this.container.getLocalBounds();
    this.container.x = -b.x + (globalThis.innerWidth || 1600) / 2 - b.width / 2;
    this.container.y = -b.y + (globalThis.innerHeight || 900) / 2 - b.height / 2;
  }

  highlight(q: number, r: number, color = 0xffffff) {
    const { hexSize } = this.map;
    const { x, y } = axialToPixel({ q, r }, hexSize);
    this.hover.clear();
    this.hover.x = x; this.hover.y = y;
    const s = hexSize + 1.5;
    const pts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      pts.push(s * Math.cos(a), s * Math.sin(a));
    }
    this.hover.poly(pts).stroke({ color, width: 2, alpha: 0.9 });
    this.hover.visible = true;
  }

  hideHighlight() { this.hover.visible = false; }

  private hex(g: PIXI.Graphics, size: number, color: number) {
    const pts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      pts.push(size * Math.cos(a), size * Math.sin(a));
    }
    g.poly(pts).fill(color).stroke({ color: 0x000000, width: 1, alpha: 0.25 });
  }
}
