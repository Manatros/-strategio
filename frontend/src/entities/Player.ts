// src/entities/Player.ts
import * as PIXI from "pixi.js";
import type { Axial } from "../hex/types";
import { axialToPixel } from "../hex/HexMath";

type MoveState =
  | { kind: "idle"; at: Axial }
  | { kind: "moving"; from: Axial; to: Axial; t: number; dur: number };

/**
 * No sprite sheets exist for this game, so "animation" here is procedural:
 * motion, scale, and color feedback instead of frame-by-frame art. If real
 * spritesheets get added later, swapping this out for a proper animated
 * sprite is a contained change — everything else that calls into Player
 * (position, health, selection) stays the same.
 */
export class Player {
  container = new PIXI.Container();
  dot: PIXI.Graphics;
  private healthBar: PIXI.Graphics;
  private guardRing: PIXI.Graphics;
  private jobLabel: PIXI.Text | null = null; // lazily created — only Civilians actually use this
  pos: Axial;
  state: MoveState;
  size: number;
  color: number;
  stepMillis = 260;
  private visualScale: number;
  private hp = 1;
  private maxHp = 1;
  private guarding = false;
  private idleClockMs = Math.random() * 1000; // randomized phase so units don't all breathe in unison
  private attackFlashMs = 0;

  constructor(start: Axial, hexSize: number, color = 0x3a86ff, visualScale = 1) {
    this.pos = start;
    this.state = { kind: "idle", at: start };
    this.size = hexSize;
    this.color = color;
    this.visualScale = visualScale;

    this.guardRing = new PIXI.Graphics();
    this.guardRing.visible = false;
    this.container.addChild(this.guardRing);
    this.dot = new PIXI.Graphics();
    this.container.addChild(this.dot);
    this.healthBar = new PIXI.Graphics();
    this.healthBar.visible = false;
    this.container.addChild(this.healthBar);
    this.redraw();
    this.updateWorldPos();
  }

  /** Redraws the floating health bar above this unit — hidden entirely at full HP, so a healthy
   *  battlefield doesn't get cluttered with bars nobody needs to read. */
  setHealth(hp: number, maxHp: number) {
    this.hp = hp; this.maxHp = maxHp;
    this.healthBar.clear();
    if (maxHp <= 0 || hp >= maxHp) { this.healthBar.visible = false; return; }
    this.healthBar.visible = true;

    const w = this.size * 0.85 * this.visualScale;
    const h = 3.5;
    const y = -this.size * 0.75 * this.visualScale;
    const frac = Math.max(0, Math.min(1, hp / maxHp));
    const color = frac > 0.5 ? 0x4caf50 : frac > 0.25 ? 0xff9800 : 0xe53935;

    this.healthBar.rect(-w / 2, y, w, h).fill({ color: 0x000000, alpha: 0.6 });
    this.healthBar.rect(-w / 2, y, w * frac, h).fill(color);
  }

  /** Toggles the pulsing guard-mode ring — the visual state for "watching for a target," distinct from idle. */
  setGuarding(on: boolean) {
    this.guarding = on;
    this.guardRing.visible = on;
    if (!on) this.guardRing.clear();
  }

  /** Shows a small floating tag below this unit naming what it's currently assigned to do (e.g. a
   *  Civilian's job) — pass null to hide it entirely. Only ever meaningfully used for Civilians. */
  setJobLabel(text: string | null) {
    if (!text) {
      if (this.jobLabel) this.jobLabel.visible = false;
      return;
    }
    if (!this.jobLabel) {
      this.jobLabel = new PIXI.Text({
        text: "",
        style: { fontFamily: "sans-serif", fontSize: 10, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
      });
      this.jobLabel.anchor.set(0.5, 0);
      this.container.addChild(this.jobLabel);
    }
    this.jobLabel.text = text;
    this.jobLabel.y = this.size * 0.55 * this.visualScale;
    this.jobLabel.visible = true;
  }

  /** Brief flash + punch-scale on attacking — the closest thing to an "attack animation" without sprite frames. */
  playAttackFlash() {
    this.attackFlashMs = 220;
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
      // A small vertical bob while walking — sin() over the step's progress, peaking mid-step,
      // back to baseline at both ends so it blends cleanly step-to-step.
      const bob = Math.sin(t * Math.PI) * this.size * 0.06 * this.visualScale;
      this.container.y = p0.y + (p1.y - p0.y) * t - bob;
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
    } else {
      // Idle: a very subtle breathing scale — mostly to make a large group of standing units
      // not look like a completely frozen screenshot.
      this.idleClockMs += dtMS;
      const breathe = 1 + Math.sin(this.idleClockMs / 900) * 0.03;
      this.dot.scale.set(breathe);
    }

    if (this.attackFlashMs > 0) {
      this.attackFlashMs = Math.max(0, this.attackFlashMs - dtMS);
      const p = this.attackFlashMs / 220; // 1 -> 0 over the flash duration
      this.dot.tint = p > 0 ? 0xffdddd : 0xffffff;
      this.dot.scale.set((this.state.kind === "idle" ? this.dot.scale.x : 1) + p * 0.25);
    } else if (this.dot.tint !== 0xffffff) {
      this.dot.tint = 0xffffff;
    }

    if (this.guarding) {
      this.guardRing.clear();
      const r = this.size * 0.6 * this.visualScale + Math.sin(this.idleClockMs / 400) * 2;
      this.guardRing.circle(0, 0, r).stroke({ color: 0xffcc44, width: 1.5, alpha: 0.55 });
    }
  }
}
