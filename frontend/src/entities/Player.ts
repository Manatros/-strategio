// src/entities/Player.ts
import * as PIXI from "pixi.js";
import type { Axial, MapData } from "../hex/types";
import { axialToPixel } from "../hex/HexMath";
import { isPassable, keyFor } from "../hex/helpers";

type MoveState =
  | { kind: "idle"; at: Axial }
  | { kind: "moving"; from: Axial; to: Axial; t: number; dur: number };

export class Player {
  container = new PIXI.Container();
  dot: PIXI.Graphics;
  pos: Axial;
  state: MoveState;
  size: number;
  color: number;
  stepMillis = 260;

  constructor(public map: MapData, start: Axial, hexSize: number, color = 0x3a86ff) {
    // ensure start is passable; if not, find nearest passable
    this.pos = this.findSpawn(start);
    this.state = { kind: "idle", at: this.pos };
    this.size = hexSize;
    this.color = color;

    // draw a small ring + dot
    this.dot = new PIXI.Graphics();
    this.container.addChild(this.dot);
    this.redraw();
    this.updateWorldPos();
  }

  private findSpawn(start: Axial): Axial {
    const k = keyFor(start.q, start.r);
    if (isPassable(this.map.tiles.get(k))) return start;
    // expand ring until we find a passable tile
    let radius = 1;
    while (radius < this.map.radius + 2) {
      for (let dq = -radius; dq <= radius; dq++) {
        for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
          const q = start.q + dq, r = start.r + dr;
          const t = this.map.tiles.get(keyFor(q, r));
          if (isPassable(t)) return { q, r };
        }
      }
      radius++;
    }
    return start;
  }

  private redraw() {
    this.dot.clear();
    const outer = this.size * 0.45;
    const inner = outer * 0.55;
    this.dot.circle(0, 0, outer).stroke({ color: 0x000000, width: 2, alpha: 0.6 });
    this.dot.circle(0, 0, inner).fill(this.color);
  }

  private updateWorldPos() {
    const a = (this.state.kind === "idle") ? this.state.at : this.state.to;
    const { x, y } = axialToPixel(a, this.size);
    if (this.state.kind === "moving") {
      // interpolate between from -> to
      const p0 = axialToPixel(this.state.from, this.size);
      const p1 = axialToPixel(this.state.to, this.size);
      const t = Math.min(1, this.state.t / this.state.dur);
      this.container.x = p0.x + (p1.x - p0.x) * t;
      this.container.y = p0.y + (p1.y - p0.y) * t;
    } else {
      this.container.x = x;
      this.container.y = y;
    }
  }

  /** Try to step to target axial (if passable and adjacent). Returns true if started moving. */
  tryStep(to: Axial, millis = this.stepMillis): boolean {
    const cur = (this.state.kind === "idle") ? this.state.at : this.state.to;
    const k = keyFor(to.q, to.r);
    if (!isPassable(this.map.tiles.get(k))) return false;
    // Only allow adjacent step
    const dq = Math.abs(cur.q - to.q);
    const dr = Math.abs(cur.r - to.r);
    const ds = Math.abs((cur.q + cur.r) - (to.q + to.r));
    const dist = (dq + dr + ds) / 2;
    if (dist !== 1) return false;

    this.state = { kind: "moving", from: cur, to, t: 0, dur: millis };
    return true;
  }

  tick(dtMS: number) {
    if (this.state.kind === "moving") {
      this.state.t += dtMS;
      if (this.state.t >= this.state.dur) {
        // snap to target
        this.pos = this.state.to;
        this.state = { kind: "idle", at: this.pos };
      }
      this.updateWorldPos();
    }
  }
}
