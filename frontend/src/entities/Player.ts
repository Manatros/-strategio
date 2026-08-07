// src/entities/Player.ts
import * as PIXI from "pixi.js";
import type { Axial } from "../hex/types";
import { axialToPixel } from "../hex/HexMath";

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
  private visualScale: number;

  constructor(start: Axial, hexSize: number, color = 0x3a86ff, visualScale = 1) {
    this.pos = start;
    this.state = { kind: "idle", at: start };
    this.size = hexSize;
    this.color = color;
    this.visualScale = visualScale;

    this.dot = new PIXI.Graphics();
    this.container.addChild(this.dot);
    this.redraw();
    this.updateWorldPos();
  }

  private redraw() {
    this.dot.clear();
    const outer = this.size * 0.45 * this.visualScale;
    const inner = outer * 0.55;
    this.dot.circle(0, 0, outer).stroke({ color: 0x000000, width: 2, alpha: 0.6 });
    this.dot.circle(0, 0, inner).fill(this.color);
  }

  private updateWorldPos() {
    const a = (this.state.kind === "idle") ? this.state.at : this.state.to;
    const { x, y } = axialToPixel(a, this.size);
    if (this.state.kind === "moving") {
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

  tryStep(to: Axial, millis = this.stepMillis): boolean {
    const cur = (this.state.kind === "idle") ? this.state.at : this.state.to;
    const dq = Math.abs(cur.q - to.q);
    const dr = Math.abs(cur.r - to.r);
    const ds = Math.abs((cur.q + cur.r) - (to.q + to.r));
    if ((dq + dr + ds) / 2 !== 1) return false;

    this.state = { kind: "moving", from: cur, to, t: 0, dur: millis };
    return true;
  }

  snapTo(at: Axial) {
    this.pos = at;
    this.state = { kind: "idle", at };
    this.updateWorldPos();
  }

  tick(dtMS: number) {
    if (this.state.kind === "moving") {
      this.state.t += dtMS;
      if (this.state.t >= this.state.dur) {
        this.pos = this.state.to;
        this.state = { kind: "idle", at: this.pos };
      }
      this.updateWorldPos();
    }
  }
}