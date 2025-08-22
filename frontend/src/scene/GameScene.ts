// src/scene/GameScene.ts
import * as PIXI from "pixi.js";
import type { Scene } from "./SceneManager";
import { generateMap } from "../hex/MapData";
import { TileRenderer } from "../hex/TileRenderer";
import { attachHUD as attachDebugHUD } from "../ui/DebugHUD";
import { createBuildHUD, refreshHUD, setButtonsAffordable } from "../ui/BuildHUD";
import { DIRS, isPassable, keyFor } from "../hex/helpers";
import { axialToPixel, pixelToAxial } from "../hex/HexMath";
import { bfsPath } from "../hex/Pathfinding";
import { Player } from "../entities/Player";
import { FogOfWar } from "../fow/Fog";
import { BuildingRenderer } from "../buildings/renderer";
import type { BuildingKind } from "../buildings/types";
import { canPlace } from "../buildings/rules";
import { emptyBank, canAfford, spend } from "../econ/resources";
import { BUILD_COST } from "../buildings/costs";
import { gatherTick } from "../buildings/logic";
import { toPixiColor } from "../core/color";

export class GameScene implements Scene {
  private app: PIXI.Application | null = null;
  private el: HTMLElement | null = null;
  private mapRenderer: TileRenderer | null = null;
  private player!: Player;
  private plannedPath: { q: number; r: number }[] = [];

  // Fog + Buildings
  private fow!: FogOfWar;
  private buildings!: BuildingRenderer;
  private placed: { kind: BuildingKind; q:number; r:number }[] = [];

  // HUD + Economy
  private ui!: ReturnType<typeof createBuildHUD>;
  private dbg!: ReturnType<typeof attachDebugHUD>;
  private bank = emptyBank();
  private buildKind: BuildingKind | null = null;
  private ghost = new PIXI.Graphics();

  async mount(root: HTMLElement) {
    const app = new PIXI.Application();
    await app.init({ resizeTo: window, background: 0x0f1116, antialias: true });
    this.app = app;

    const host = document.createElement("div");
    host.style.height = "100%";
    root.appendChild(host);
    host.appendChild(app.canvas);
    this.el = host;

    // world (BIGGER MAP)
    const map = generateMap(40, 22, 20250822);
    this.mapRenderer = new TileRenderer(map);
    app.stage.addChild(this.mapRenderer.container);
    this.mapRenderer.drawAll();

    // fog
    this.fow = new FogOfWar(map, 5);
    app.stage.addChild(this.ghost);
    this.ghost.visible = false;

    // buildings
    this.buildings = new BuildingRenderer(map);
    this.mapRenderer.container.addChild(this.buildings.container);

    // player (SLOWER STEP)
    const center = { q: 0, r: 0 };
    const color = toPixiColor(localStorage.getItem("playerColor"));
    this.player = new Player(map, center, map.hexSize, color);
    (this.player as any).stepMillis = 260; // override default; Player.tryStep uses the provided duration
    this.mapRenderer.container.addChild(this.player.container);

    // initial fog calc
    this.fow.recalc(this.player.pos);
    this.updateFogVisuals();

    // Camera drag + zoom
    let dragging = false, lastX = 0, lastY = 0;
    app.canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener("pointerup", () => { dragging = false; });
    window.addEventListener("pointermove", (e) => {
      if (!dragging || !this.mapRenderer) return;
      const dx = e.clientX - lastX; const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.mapRenderer.container.x += dx;
      this.mapRenderer.container.y += dy;
    });
    window.addEventListener("wheel", (e) => {
      if (!this.mapRenderer) return;
      const c = this.mapRenderer.container;
      const k = e.deltaY < 0 ? 1.1 : 0.9;
      const ns = Math.min(3, Math.max(0.3, c.scale.x * k));
      c.scale.set(ns);
    }, { passive: true });

    // HUDs
    this.ui = createBuildHUD(root, (kind) => { this.buildKind = kind; });
    this.dbg = attachDebugHUD(root);
    this.dbg.onCenter(() => {
      const b = this.mapRenderer!.container.getLocalBounds();
      this.mapRenderer!.container.x = -b.x + innerWidth / 2 - b.width / 2;
      this.mapRenderer!.container.y = -b.y + innerHeight / 2 - b.height / 2;
      this.mapRenderer!.container.scale.set(1);
    });
    refreshHUD(this.ui, this.bank);
    setButtonsAffordable(this.ui, (k)=> canAfford(this.bank, BUILD_COST[k] || {}));

    // Hover + ghost
    app.canvas.addEventListener("pointermove", (e) => {
      if (!this.mapRenderer) return;
      const world = this.screenToWorld(e.clientX, e.clientY);
      const a = pixelToAxial(world.x, world.y, map.hexSize);
      this.mapRenderer.highlight(a.q, a.r, 0xffffff);
      this.updateGhost(a.q, a.r);
    });
    app.canvas.addEventListener("pointerleave", () => { this.mapRenderer?.hideHighlight(); this.ghost.visible = false; });

    // Click to move or place building
    app.canvas.addEventListener("click", (e) => {
      const world = this.screenToWorld(e.clientX, e.clientY);
      const target = pixelToAxial(world.x, world.y, map.hexSize);
      const isAdj = this.hexAdj(this.player.pos, target);
      const tile = map.tiles.get(keyFor(target.q, target.r));
      const vis = this.fow.state(target.q, target.r);

      if (this.buildKind) {
        const cost = BUILD_COST[this.buildKind] || {};
        if (vis === "visible" && (isAdj || (target.q===this.player.pos.q && target.r===this.player.pos.r)) && canPlace(this.buildKind, tile) && canAfford(this.bank, cost)) {
          // spend + place
          spend(this.bank, cost);
          this.placed.push({ kind: this.buildKind, q: target.q, r: target.r });
          this.buildings.upsert({ kind: this.buildKind, q: target.q, r: target.r });

          if (this.buildKind === "Bridge" && tile && tile.kind === "Water") {
            tile.kind = "Bridge"; // traversable now
          }
          this.buildKind = null;
          this.ghost.visible = false;
          refreshHUD(this.ui, this.bank);
          setButtonsAffordable(this.ui, (k)=> canAfford(this.bank, BUILD_COST[k] || {}));
          return;
        }
        return;
      }

      // movement
      if (!tile || vis === "hidden") return;
      const from = (this.player.state.kind === "idle") ? this.player.state.at : this.player.state.to;
      const path = bfsPath(map, from, target);
      if (path && path.length > 1) this.plannedPath = path.slice(1);
    });

    // Keyboard (WASD + QE)
    const keys = new Set<string>();
    addEventListener("keydown", (e) => keys.add(e.key));
    addEventListener("keyup", (e) => keys.delete(e.key));

    // Give starting resources so the player can try building
    this.bank.Wood = 50; this.bank.Stone = 40; this.bank.Bread = 20; this.bank.Fish = 10;
    refreshHUD(this.ui, this.bank);
    setButtonsAffordable(this.ui, (k)=> canAfford(this.bank, BUILD_COST[k] || {}));

    // ticker
    let last = performance.now();
    app.ticker.add(() => {
      const now = performance.now();
      const dt = now - last; last = now;

      // planned path
      if (this.plannedPath.length > 0 && this.player.state.kind === "idle") {
        const next = this.plannedPath.shift()!;
        if (!this.tryStepVisible(next.q, next.r)) this.plannedPath = [];
      }

      // direct step
      if (this.player.state.kind === "idle" && this.plannedPath.length === 0) {
        const dir = this.readDirection(keys);
        if (dir) {
          const cur = this.player.state.at;
          const to = { q: cur.q + dir.q, r: cur.r + dir.r };
          this.tryStepVisible(to.q, to.r);
        }
      }

      // building gather tick
      const dtSec = dt / 1000;
      for (const b of this.placed) gatherTick(map, b, dtSec, this.bank);
      refreshHUD(this.ui, this.bank);
      setButtonsAffordable(this.ui, (k)=> canAfford(this.bank, BUILD_COST[k] || {}));

      this.player.tick(dt);

      // fog
      if (this.player.state.kind === "idle") {
        this.fow.recalc(this.player.state.at);
        this.updateFogVisuals();
      }
    });
  }

  private tryStepVisible(q: number, r: number) {
    const map = this.mapRenderer!.map;
    const tile = map.tiles.get(keyFor(q, r));
    const vis = this.fow.state(q, r);
    if (vis === "hidden") return false;
    if (tile && isPassable(tile)) {
      return this.player.tryStep({ q, r }, (this.player as any).stepMillis ?? 260);
    }
    return false;
  }

  private hexAdj(a: {q:number;r:number}, b:{q:number;r:number}) {
    const dq = Math.abs(a.q - b.q);
    const dr = Math.abs(a.r - b.r);
    const ds = Math.abs((a.q + a.r) - (b.q + b.r));
    return (dq + dr + ds) / 2 === 1;
  }

  private screenToWorld(screenX: number, screenY: number) {
    const r = this.mapRenderer!.container;
    const invScale = 1 / r.scale.x;
    return { x: (screenX - r.x) * invScale, y: (screenY - r.y) * invScale };
  }

  private updateFogVisuals() {
    const hidden = new Set<string>();
    for (const t of this.mapRenderer!.map.tiles.values()) {
      const k = keyFor(t.q, t.r);
      if (this.fow.visible.has(k)) continue;
      hidden.add(k);
    }
    this.mapRenderer!.setAlphaByFog(hidden, this.fow.seen);
    this.buildings.setAlphaForHidden(hidden, this.fow.seen);
  }

  private readDirection(keys: Set<string>) {
    const left   = keys.has("ArrowLeft")  || keys.has("a") || keys.has("A");
    const right  = keys.has("ArrowRight") || keys.has("d") || keys.has("D");
    const up     = keys.has("ArrowUp")    || keys.has("w") || keys.has("W");
    const down   = keys.has("ArrowDown")  || keys.has("s") || keys.has("S");
    const qKey   = keys.has("q") || keys.has("Q");
    const eKey   = keys.has("e") || keys.has("E");
    if (right && !left && !up && !down) return DIRS[0];
    if (eKey)                                return DIRS[1];
    if (up && !down && !left && !right)     return DIRS[2];
    if (left && !right && !up && !down)     return DIRS[3];
    if (qKey)                                return DIRS[4];
    if (down && !up && !left && !right)     return DIRS[5];
    return null;
  }

  unmount() {
    this.el?.remove(); this.el = null;
    if (this.app) { this.app.destroy(true); this.app = null; }
    this.mapRenderer = null!;
  }
}
