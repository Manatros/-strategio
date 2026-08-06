// src/scene/GameScene.ts
import * as PIXI from "pixi.js";
import type { Scene } from "./SceneManager";
import type { SceneManager } from "./SceneManager";
import { GameOverScene } from "./GameOverScene";
import { TileRenderer, type TileVisualContext } from "../hex/TileRenderer";
import { attachHUD as attachDebugHUD } from "../ui/DebugHUD";
import { createBuildHUD, refreshHUD, setButtonsAffordable, updateBuildTooltips } from "../ui/BuildHUD";
import { createUnitHUD, refreshUnitHUD, refreshAbilities, updateTrainTooltips } from "../ui/UnitHUD";
import { createDiplomacyHUD, refreshDiplomacyPlayers, setDiplomacyVisible, type MetPlayer } from "../ui/DiplomacyHUD";
import { ToastStack } from "../ui/Toasts";
import { Minimap } from "../ui/Minimap";
import { createBuildingHUD, refreshBuildingHUD, type SelectedBuildingInfo } from "../ui/BuildingHUD";
import { DIRS, isPassable, keyFor } from "../hex/helpers";
import { axialToPixel, pixelToAxial, hexDistance, neighbors } from "../hex/HexMath";
import { bfsPath } from "../hex/Pathfinding";
import { Player } from "../entities/Player";
import { FogOfWar } from "../fow/Fog";
import { BuildingRenderer } from "../buildings/renderer";
import type { BuildingKind } from "../buildings/types";
import { canPlace } from "../buildings/rules";
import { emptyBank, canAfford, type Bank } from "../econ/resources";
import { BUILD_COST } from "../buildings/costs";
import { toPixiColor } from "../core/color";
import { raceDisplay } from "../core/races";
import { WORKER_EXEMPT, ATTACK_RANGE } from "../core/balance";
import { RESEARCH_OPTIONS } from "../core/research";
import { connectWS, type ServerMsg, type WS, type RemoteBuilding, type RemoteTile, type RemoteUnit, type RemotePlayer, type RelationStatus } from "../net";
import type { Axial } from "../hex/types";

function fmtResources(r: Record<string, number | undefined> | null): string {
  if (!r) return "nothing";
  return Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ");
}

export class GameScene implements Scene {
  private app: PIXI.Application | null = null;
  private el: HTMLElement | null = null;
  private mapRenderer: TileRenderer | null = null;
  private player!: Player;
  private plannedPath: { q: number; r: number }[] = [];

  private fow!: FogOfWar;
  private buildings!: BuildingRenderer;
  private buildingSprites = new Map<string, RemoteBuilding>();
  private otherPlayers = new Map<string, PIXI.Graphics>();
  private lastPlayers: RemotePlayer[] = [];
  private lastUnits: RemoteUnit[] = [];
  private units = new Map<string, Player>();
  private unitKinds = new Map<string, string>();
  private unitLevels = new Map<string, number>();
  private unitGuards = new Map<string, boolean>();
  private myResearch = new Set<string>();
  private otherUnits = new Map<string, PIXI.Graphics>();
  private selectedUnitId: string | null = null;
  private autoExploreUnits = new Set<string>();     // unit ids currently self-navigating toward unexplored territory
  private unitPaths = new Map<string, Axial[]>();    // per-unit background path, independent of the manually-controlled plannedPath
  private lastExploreAttempt = new Map<string, number>(); // throttles retries when a unit can't find a reachable frontier

  private ui!: ReturnType<typeof createBuildHUD>;
  private unitUi!: ReturnType<typeof createUnitHUD>;
  private bld!: ReturnType<typeof createBuildingHUD>;
  private selectedBuildingKey: string | null = null;
  private dip!: ReturnType<typeof createDiplomacyHUD>;
  private minimap!: Minimap;
  private dbg!: ReturnType<typeof attachDebugHUD>;
  private metPlayers = new Map<string, MetPlayer>();
  private relations = new Map<string, RelationStatus>();
  private toasts!: ToastStack;
  private bank = emptyBank();
  private popCap = 0;
  private workers = 0;
  private hp = 100;
  private maxHp = 100;
  private score = 0;
  private storageCap = 0;
  private buildCost: Record<string, Partial<Bank>> = BUILD_COST; // overwritten by the server's "config" message — this is just the pre-connection fallback
  private unitCost: Record<string, { cost: Partial<Bank>; popCost: number; minUsedWorkers: number }> = {};
  private buildKind: BuildingKind | null = null;
  private ghost = new PIXI.Graphics();

  private ws!: WS;
  private myId = "";
  private myColor = 0x3a86ff;
  private myRace = "Human";
  private hexSize = 22;
  private visionRadius = 5;
  private stepMillis = 260; // overwritten on connect with the server's real cooldown — see awaitWelcome
  private tiles = new Map<string, RemoteTile>();

  constructor(private sm: SceneManager, private mode: "new" | "auto" = "new") {}

  async mount(root: HTMLElement) {
    const app = new PIXI.Application();
    await app.init({ resizeTo: window, background: 0x0f1116, antialias: true });
    this.app = app;

    const host = document.createElement("div");
    host.style.height = "100%";
    root.appendChild(host);
    host.appendChild(app.canvas);
    this.el = host;

    const name = localStorage.getItem("playerName") || "Player";
    const color = toPixiColor(localStorage.getItem("playerColor"));
    const race = localStorage.getItem("playerRace") || "Human";
    this.ws = connectWS({ name, color, race, mode: this.mode });
    const spawn = await this.awaitWelcome();

    localStorage.setItem("strategio_inGame", "1");

    this.mapRenderer = new TileRenderer(this.hexSize);
    await this.mapRenderer.loadTextures();
    app.stage.addChild(this.mapRenderer.container);

    this.fow = new FogOfWar(this.visionRadius);
    app.stage.addChild(this.ghost);
    this.ghost.visible = false;

    this.buildings = new BuildingRenderer(this.hexSize);
    await this.buildings.loadTextures();
    this.mapRenderer.container.addChild(this.buildings.container);

    this.player = new Player(spawn, this.hexSize, this.myColor);
    this.player.stepMillis = this.stepMillis;
    this.mapRenderer.container.addChild(this.player.container);

    this.ws.onMessage((msg) => this.handleServerMsg(msg));

    this.fow.recalc(this.player.pos, [...this.ownedBuildingCenters(), ...this.ownedUnitCenters()]);
    this.mapRenderer.syncAll(() => this.tiles.entries(), (t) => this.tileVisualContext(t));
    this.updateFogVisuals();
    this.renderMinimap();

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

    this.ui = createBuildHUD(root, (kind) => { this.buildKind = kind; });
    const rd = raceDisplay(this.myRace);
    for (const [kind, btn] of Object.entries(this.ui.btns)) {
      const label = rd.buildingNames[kind];
      if (label) btn.textContent = label;
    }
    this.unitUi = createUnitHUD(
      root,
      (id) => { this.selectedUnitId = id; this.refreshUnitPanel(); },
      (kind) => this.tryTrainUnit(kind),
      () => this.tryMergeUnits(),
      () => this.toggleAutoExplore(),
      () => this.toggleGuard()
    );
    if (rd.unitNames.Scout) this.unitUi.trainScoutBtn.textContent = rd.unitNames.Scout;
    if (rd.unitNames.Soldier) this.unitUi.trainSoldierBtn.textContent = rd.unitNames.Soldier;
    if (rd.unitNames.Archer) this.unitUi.trainArcherBtn.textContent = rd.unitNames.Archer;
    updateBuildTooltips(this.ui, this.buildCost);
    updateTrainTooltips(this.unitUi, this.unitCost);
    this.refreshUnitPanel();
    this.bld = createBuildingHUD(root, () => this.tryDemolishSelected(), (optionId) => this.tryResearch(optionId));
    this.toasts = new ToastStack(root);
    this.dip = createDiplomacyHUD(
      root,
      (action, targetId, offer, request) => {
        if (action === "war") this.ws.declareWar(targetId);
        else if (action === "open_borders") this.ws.propose("open_borders", targetId, null, null);
        else this.ws.propose(action, targetId, offer, request);
      }
    );
    this.minimap = new Minimap(this.ui.minimapEl, (q, r) => {
      const { x, y } = axialToPixel({ q, r }, this.hexSize);
      this.mapRenderer!.container.x = -x + innerWidth / 2;
      this.mapRenderer!.container.y = -y + innerHeight / 2;
    });
    this.dbg = attachDebugHUD(root);
    this.dbg.onCenter(() => {
      const b = this.mapRenderer!.container.getLocalBounds();
      this.mapRenderer!.container.x = -b.x + innerWidth / 2 - b.width / 2;
      this.mapRenderer!.container.y = -b.y + innerHeight / 2 - b.height / 2;
      this.mapRenderer!.container.scale.set(1);
    });
    refreshHUD(this.ui, this.bank, this.popCap, this.workers, this.hp, this.maxHp, this.score, this.storageCap);
    setButtonsAffordable(this.ui, (k) => canAfford(this.bank, this.buildCost[k] || {}) && this.hasPopulationFor(k));

    app.canvas.addEventListener("pointermove", (e) => {
      if (!this.mapRenderer) return;
      const world = this.screenToWorld(e.clientX, e.clientY);
      const a = pixelToAxial(world.x, world.y, this.hexSize);
      this.mapRenderer.highlight(a.q, a.r, 0xffffff);
      this.updateGhost(a.q, a.r);
    });
    app.canvas.addEventListener("pointerleave", () => { this.mapRenderer?.hideHighlight(); this.ghost.visible = false; });

    app.canvas.addEventListener("click", (e) => {
      const world = this.screenToWorld(e.clientX, e.clientY);
      const target = pixelToAxial(world.x, world.y, this.hexSize);
      const isAdj = this.hexAdj(this.player.pos, target);
      const tile = this.tiles.get(keyFor(target.q, target.r));
      const vis = this.fow.state(target.q, target.r);

      if (this.buildKind) {
        const cost = this.buildCost[this.buildKind] || {};
        const onSelf = target.q === this.player.pos.q && target.r === this.player.pos.r;
        const nearRequirement = this.buildKind === "TownHall" ? this.nearOwnSettler(target) : (isAdj || onSelf);
        if (vis === "visible" && nearRequirement && this.canBuildOn(this.buildKind, tile) && canAfford(this.bank, cost)) {
          this.ws.placeBuilding(this.buildKind, target.q, target.r);
        } else {
          console.warn("[Strategio] can't build there — back to walk mode");
        }
        this.buildKind = null;
        this.ghost.visible = false;
        return;
      }

      if (this.selectedUnitId && target.q === this.player.pos.q && target.r === this.player.pos.r) {
        this.selectedUnitId = null;
        this.refreshUnitPanel();
        return;
      }
      for (const [id, u] of this.units) {
        if (u.pos.q === target.q && u.pos.r === target.r) {
          this.selectedUnitId = id;
          this.selectedBuildingKey = null;
          this.refreshUnitPanel();
          this.refreshBuildingPanel();
          return;
        }
      }

      // A selected combat unit (Soldier/Archer) attacks an enemy within its range instead of moving there.
      if (this.selectedUnitId) {
        const kind = this.unitKinds.get(this.selectedUnitId);
        const range = kind ? ATTACK_RANGE[kind] : undefined;
        const soldier = this.units.get(this.selectedUnitId);
        if (range && soldier && hexDistance(soldier.pos, target) <= range) {
          const building = this.buildingSprites.get(keyFor(target.q, target.r));
          const enemyBuilding = building && building.ownerId !== this.myId;
          const enemyUnit = this.lastUnits.some(u => u.q === target.q && u.r === target.r && u.ownerId !== this.myId);
          const enemyPlayer = this.lastPlayers.some(p => p.q === target.q && p.r === target.r);
          if (enemyBuilding || enemyUnit || enemyPlayer) {
            this.ws.attack(this.selectedUnitId, target.q, target.r);
            return;
          }
        }
      }

      const building = this.buildingSprites.get(keyFor(target.q, target.r));
      if (building && building.ownerId === this.myId) {
        this.selectedBuildingKey = keyFor(target.q, target.r);
        this.selectedUnitId = null;
        this.refreshUnitPanel();
        this.refreshBuildingPanel();
        return;
      }

      if (!tile || vis === "hidden") return;
      const entity = this.activeEntity();
      const queueing = e.shiftKey && this.plannedPath.length > 0;
      const from = queueing
        ? this.plannedPath[this.plannedPath.length - 1]
        : ((entity.state.kind === "idle") ? entity.state.at : entity.state.to);
      const path = bfsPath((k) => this.tiles.get(k), from, target, 400, (t) => this.canEnterTile(t));
      if (path && path.length > 1) {
        if (queueing) this.plannedPath.push(...path.slice(1));
        else this.plannedPath = path.slice(1);
      }
    });

    const keys = new Set<string>();
    addEventListener("keydown", (e) => keys.add(e.key));
    addEventListener("keyup", (e) => keys.delete(e.key));

    // One-shot shortcuts (as opposed to the held-movement keys above), Warcraft-style.
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement) return;

      if (e.key === "Escape") {
        this.buildKind = null;
        this.ghost.visible = false;
        this.selectedUnitId = null;
        this.selectedBuildingKey = null;
        this.refreshUnitPanel();
        this.refreshBuildingPanel();
        return;
      }
      if (e.key.toLowerCase() === "d") {
        setDiplomacyVisible(this.dip, !this.dip.visible);
        return;
      }
      if (e.key.toLowerCase() === "s") {
        // Stop: clear the active entity's queued movement.
        this.plannedPath = [];
        if (this.selectedUnitId) this.unitPaths.delete(this.selectedUnitId);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        this.cycleSelectedUnit();
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const btn = Object.values(this.ui.btns)[idx];
        if (btn && !btn.disabled) btn.click();
        return;
      }
    });

    let last = performance.now();
    app.ticker.add(() => {
      const now = performance.now();
      const dt = now - last; last = now;

      const activeNow = this.activeEntity();

      if (this.plannedPath.length > 0 && activeNow.state.kind === "idle") {
        const next = this.plannedPath.shift()!;
        if (!this.tryStepVisible(next.q, next.r)) this.plannedPath = [];
      }

      if (activeNow.state.kind === "idle" && this.plannedPath.length === 0) {
        const dir = this.readDirection(keys);
        if (dir) {
          const cur = activeNow.state.at;
          const to = { q: cur.q + dir.q, r: cur.r + dir.r };
          this.tryStepVisible(to.q, to.r);
        }
      }

      this.player.tick(dt);
      for (const u of this.units.values()) u.tick(dt);
      this.advanceAutoExplore();

      if (this.player.state.kind === "idle") {
        this.fow.recalc(this.player.state.at, [...this.ownedBuildingCenters(), ...this.ownedUnitCenters()]);
        this.updateFogVisuals();
        this.refreshUnitPanel();
      }
    });
  }

  private awaitWelcome(): Promise<Axial> {
    return new Promise((resolve) => {
      const off = this.ws.onMessage((msg) => {
        if (msg.type === "welcome") {
          this.myId = msg.playerId;
          this.hexSize = msg.hexSize;
          this.visionRadius = msg.visionRadius;
          this.myColor = msg.color;
          this.myRace = msg.race;
          // A small buffer above the server's real cooldown avoids spurious "too_soon" rejections from network jitter,
          // which is what caused multi-tile paths to silently stop after 1 tile before this was synced to the server value.
          this.stepMillis = msg.stepCooldownMs + 60;
          this.hp = msg.hp; this.maxHp = msg.maxHp;
          console.log(`[Strategio] ${msg.resumed ? "resumed" : "joined"} room ${msg.roomId}, seed ${msg.seed}`);
          off();
          resolve(msg.spawn);
        } else if (msg.type === "tiles_update") {
          for (const t of msg.tiles) this.tiles.set(keyFor(t.q, t.r), t);
        } else if (msg.type === "config") {
          this.buildCost = msg.buildCost;
          this.unitCost = msg.unitCost;
        } else if (msg.type === "bank") {
          this.bank = msg.bank; this.popCap = msg.popCap; this.workers = msg.workers;
          this.hp = msg.hp; this.maxHp = msg.maxHp; this.score = msg.score; this.storageCap = msg.storageCap;
          this.myResearch = new Set(msg.research);
        }
      });
    });
  }

  private handleServerMsg(msg: ServerMsg) {
    switch (msg.type) {
      case "tiles_update": {
        for (const t of msg.tiles) {
          this.tiles.set(keyFor(t.q, t.r), t);
          this.mapRenderer?.refreshTile(t, this.tileVisualContext(t));
          if (t.claimedBy && !this.metPlayers.has(t.claimedBy.id) && t.claimedBy.id !== this.myId) {
            this.metPlayers.set(t.claimedBy.id, { id: t.claimedBy.id, name: t.claimedBy.name || "Unknown", tag: "????", color: t.claimedBy.color });
            this.refreshDiplomacyPanel();
          }
        }
        this.mapRenderer?.syncAll(() => this.tiles.entries(), (t) => this.tileVisualContext(t));
        this.renderMinimap();
        this.refreshBuildingPanel();
        break;
      }
      case "config": {
        this.buildCost = msg.buildCost;
        this.unitCost = msg.unitCost;
        if (this.ui) {
          updateBuildTooltips(this.ui, this.buildCost);
          setButtonsAffordable(this.ui, (k) => canAfford(this.bank, this.buildCost[k] || {}) && this.hasPopulationFor(k));
        }
        if (this.unitUi) updateTrainTooltips(this.unitUi, this.unitCost);
        break;
      }
      case "bank": {
        this.bank = msg.bank; this.popCap = msg.popCap; this.workers = msg.workers;
        this.hp = msg.hp; this.maxHp = msg.maxHp; this.score = msg.score; this.storageCap = msg.storageCap;
        this.myResearch = new Set(msg.research);
        refreshHUD(this.ui, this.bank, this.popCap, this.workers, this.hp, this.maxHp, this.score, this.storageCap);
        setButtonsAffordable(this.ui, (k) => canAfford(this.bank, this.buildCost[k] || {}) && this.hasPopulationFor(k));
        this.refreshBuildingPanel();
        break;
      }
      case "state": {
        if (this.player.state.kind === "idle") {
          const { q, r } = msg.self;
          if (q !== this.player.pos.q || r !== this.player.pos.r) this.player.snapTo({ q, r });
        }
        this.lastPlayers = msg.players;
        this.lastUnits = msg.units;
        for (const p of msg.players) {
          const existing = this.metPlayers.get(p.id);
          if (!existing || existing.tag !== p.tag) {
            this.metPlayers.set(p.id, { id: p.id, name: p.name, tag: p.tag, color: p.color });
            this.refreshDiplomacyPanel();
          }
        }
        this.renderOtherPlayers(msg.players);
        this.renderBuildings(msg.buildings);
        for (const key of msg.removedBuildings) this.removeBuildingAt(key);
        this.renderUnits(msg.units);
        this.renderMinimap();
        this.refreshBuildingPanel();
        break;
      }
      case "step_rejected": {
        if (msg.unitId) {
          const u = this.units.get(msg.unitId);
          if (u) u.snapTo(u.pos);
          if (msg.unitId === this.selectedUnitId) {
            if (msg.reason === "too_soon") this.plannedPath.unshift({ q: msg.q, r: msg.r });
            else this.plannedPath = [];
          } else {
            // A background auto-exploring unit — drop its queued path, it'll pick a fresh target next idle tick.
            this.unitPaths.delete(msg.unitId);
          }
        } else {
          this.player.snapTo(this.player.pos);
          if (msg.reason === "too_soon") this.plannedPath.unshift({ q: msg.q, r: msg.r });
          else this.plannedPath = [];
        }
        console.warn(`[Strategio] step rejected: ${msg.reason}`);
        break;
      }
      case "build_rejected": {
        this.buildKind = null;
        this.ghost.visible = false;
        console.warn(`[Strategio] build rejected: ${msg.reason}`);
        break;
      }
      case "you_died": {
        this.sm.switch(new GameOverScene(this.sm, msg.finalScore, msg.reason));
        break;
      }
      case "relations_update": {
        this.relations.set(msg.withId, msg.status);
        this.refreshDiplomacyPanel();
        const who = this.metPlayers.get(msg.withId)?.name || "someone";
        const label = msg.status === "war" ? "war with" : msg.status === "open_borders" ? "open borders with" : "neutral with";
        this.toasts.show({ id: `rel-${msg.withId}`, title: "Diplomacy", body: `You are now at ${label} ${who}.`, autoDismissMs: 6000 });
        break;
      }
      case "proposal_received": {
        const desc = msg.proposalType === "open_borders"
          ? `wants Open Borders with you`
          : msg.proposalType === "trade"
            ? `offers ${fmtResources(msg.offer)} for ${fmtResources(msg.request)}`
            : `demands ${fmtResources(msg.request)}`;
        this.toasts.show({
          id: `proposal-${msg.id}`,
          title: msg.fromName,
          body: desc,
          actions: [
            { label: "Accept", onClick: () => this.ws.respondProposal(msg.id, true) },
            { label: "Refuse", onClick: () => this.ws.respondProposal(msg.id, false) },
          ],
        });
        break;
      }
      case "proposal_result": {
        const label = msg.accepted ? "accepted" : `refused${msg.reason ? ` (${msg.reason})` : ""}`;
        this.toasts.show({ id: `result-${msg.id}`, title: "Diplomacy", body: `Your ${msg.proposalType} proposal was ${label}.`, autoDismissMs: 6000 });
        break;
      }
      case "player_join":
      case "player_leave":
        break;
    }
  }

  private renderOtherPlayers(list: RemotePlayer[]) {
    const present = new Set(list.map(p => p.id));
    for (const [id, g] of this.otherPlayers) {
      if (!present.has(id)) { this.mapRenderer!.container.removeChild(g); g.destroy(); this.otherPlayers.delete(id); }
    }
    for (const p of list) {
      let g = this.otherPlayers.get(p.id);
      if (!g) {
        g = new PIXI.Graphics();
        const outer = this.hexSize * 0.4, inner = outer * 0.55;
        g.circle(0, 0, outer).stroke({ color: 0x000000, width: 2, alpha: 0.6 });
        g.circle(0, 0, inner).fill(p.color);
        this.mapRenderer!.container.addChild(g);
        this.otherPlayers.set(p.id, g);
      }
      const { x, y } = axialToPixel({ q: p.q, r: p.r }, this.hexSize);
      g.x = x; g.y = y;
    }
  }

  private renderBuildings(list: RemoteBuilding[]) {
    for (const b of list) {
      const k = keyFor(b.q, b.r);
      const isNew = !this.buildingSprites.has(k);
      this.buildingSprites.set(k, b);
      this.buildings.upsert(b);
      if (isNew) {
        const tile = this.tiles.get(k);
        if (tile) this.mapRenderer?.refreshTile(tile, this.tileVisualContext(tile));
      }
    }
  }

  private renderUnits(list: RemoteUnit[]) {
    const ownSeen = new Set<string>();
    const otherSeen = new Set<string>();
    let rosterChanged = false;

    for (const u of list) {
      if (u.ownerId === this.myId) {
        ownSeen.add(u.id);
        this.unitGuards.set(u.id, u.guard);
        let entity = this.units.get(u.id);
        if (!entity) {
          entity = new Player({ q: u.q, r: u.r }, this.hexSize, this.myColor, 0.7);
          entity.stepMillis = this.stepMillis;
          this.mapRenderer!.container.addChild(entity.container);
          this.units.set(u.id, entity);
          this.unitKinds.set(u.id, u.kind);
          this.unitLevels.set(u.id, u.level);
          rosterChanged = true;
        } else if (entity.state.kind === "idle" && (entity.pos.q !== u.q || entity.pos.r !== u.r)) {
          entity.snapTo({ q: u.q, r: u.r });
        }
      } else {
        otherSeen.add(u.id);
        let g = this.otherUnits.get(u.id);
        if (!g) {
          g = new PIXI.Graphics();
          const outer = this.hexSize * 0.28, inner = outer * 0.55;
          g.circle(0, 0, outer).stroke({ color: 0x000000, width: 2, alpha: 0.6 });
          g.circle(0, 0, inner).fill(u.color);
          this.mapRenderer!.container.addChild(g);
          this.otherUnits.set(u.id, g);
        }
        const { x, y } = axialToPixel({ q: u.q, r: u.r }, this.hexSize);
        g.x = x; g.y = y;
      }
    }

    for (const [id, g] of this.otherUnits) {
      if (!otherSeen.has(id)) { this.mapRenderer!.container.removeChild(g); g.destroy(); this.otherUnits.delete(id); }
    }
    for (const [id, entity] of this.units) {
      if (!ownSeen.has(id)) {
        this.mapRenderer!.container.removeChild(entity.container);
        entity.container.destroy();
        this.units.delete(id);
        this.unitKinds.delete(id);
        this.unitLevels.delete(id);
        this.unitGuards.delete(id);
        this.autoExploreUnits.delete(id);
        this.unitPaths.delete(id);
        this.lastExploreAttempt.delete(id);
        if (this.selectedUnitId === id) this.selectedUnitId = null;
        rosterChanged = true;
      }
    }

    if (rosterChanged) this.refreshUnitPanel();
  }

  private hasPopulationFor(kind: BuildingKind): boolean {
    if (WORKER_EXEMPT.has(kind)) return true;
    return this.popCap - this.workers >= 1;
  }

  private canBuildOn(kind: BuildingKind, tile: RemoteTile | undefined): boolean {
    if (!canPlace(kind, tile, this.myRace)) return false;
    if (!this.hasPopulationFor(kind)) return false;
    if (kind === "TownHall") return true;
    return tile?.claimedBy?.id === this.myId;
  }

  /** Purely-visual: does this tile have a building on it, is it scorched-earth-claimed (Undead), is it locked by an adjacent Dwarf Mine. */
  private tileVisualContext(t: RemoteTile): TileVisualContext {
    const hasBuilding = this.buildingSprites.has(keyFor(t.q, t.r));
    let scorched = false;
    if (t.claimedBy) {
      const owner = this.lastPlayers.find(p => p.id === t.claimedBy!.id);
      scorched = owner?.race === "Undead" || (t.claimedBy.id === this.myId && this.myRace === "Undead");
    }
    return { hasBuilding, scorched, minedAdjacent: !!t.blocked };
  }

  private ownedBuildingCenters(): Axial[] {
    const centers: Axial[] = [];
    for (const b of this.buildingSprites.values()) {
      if (b.ownerId === this.myId) centers.push({ q: b.q, r: b.r });
    }
    return centers;
  }

  private ownedUnitCenters(): Axial[] {
    return [...this.units.values()].map(u => u.pos);
  }

  /** Is one of the player's own Settlers on or next to this tile? Used for TownHall placement, which the server
   *  only requires a nearby Settler for — the main character doesn't need to be anywhere near it. */
  private nearOwnSettler(target: { q: number; r: number }): boolean {
    for (const [id, kind] of this.unitKinds) {
      if (kind !== "Settler") continue;
      const u = this.units.get(id);
      if (!u) continue;
      if ((u.pos.q === target.q && u.pos.r === target.r) || this.hexAdj(u.pos, target)) return true;
    }
    return false;
  }

  private nearOwnGarrison(): RemoteBuilding | null {
    for (const b of this.buildingSprites.values()) {
      if (b.kind !== "Garrison" || b.ownerId !== this.myId || !b.constructed) continue;
      const onSelf = b.q === this.player.pos.q && b.r === this.player.pos.r;
      if (onSelf || this.hexAdj(this.player.pos, { q: b.q, r: b.r })) return b;
    }
    return null;
  }

  private tryTrainUnit(kind: "Scout" | "Soldier" | "Archer") {
    const garrison = this.nearOwnGarrison();
    if (!garrison) { console.warn("[Strategio] no ready Garrison nearby"); return; }
    this.ws.trainUnit(kind, garrison.q, garrison.r);
  }

  private refreshUnitPanel() {
    const names = raceDisplay(this.myRace).unitNames;
    const list = [...this.unitKinds.entries()].map(([id, kind]) => ({
      id, kind: names[kind] || kind, level: this.unitLevels.get(id) ?? 1,
    }));
    refreshUnitHUD(this.unitUi, list, this.selectedUnitId, !!this.nearOwnGarrison(), this.canMergeAtSelected());
    const selectedKind = this.selectedUnitId ? this.unitKinds.get(this.selectedUnitId) ?? null : null;
    const guardOn = !!this.selectedUnitId && !!this.unitGuards.get(this.selectedUnitId);
    refreshAbilities(this.unitUi, selectedKind, !!this.selectedUnitId && this.autoExploreUnits.has(this.selectedUnitId), guardOn);
  }

  private toggleGuard() {
    if (!this.selectedUnitId) return;
    const current = !!this.unitGuards.get(this.selectedUnitId);
    this.unitGuards.set(this.selectedUnitId, !current); // optimistic — the next state message confirms it
    this.ws.setGuard(this.selectedUnitId, !current);
    this.refreshUnitPanel();
  }

  /** Does the currently selected unit's tile have 3+ of the same kind+level (and not already max level)? */
  private canMergeAtSelected(): boolean {
    if (!this.selectedUnitId) return false;
    const selected = this.units.get(this.selectedUnitId);
    if (!selected) return false;
    const kind = this.unitKinds.get(this.selectedUnitId);
    const level = this.unitLevels.get(this.selectedUnitId) ?? 1;
    if (level >= 3) return false;
    let count = 0;
    for (const [id, k] of this.unitKinds) {
      if (k !== kind) continue;
      if ((this.unitLevels.get(id) ?? 1) !== level) continue;
      const u = this.units.get(id);
      if (u && u.pos.q === selected.pos.q && u.pos.r === selected.pos.r) count++;
    }
    return count >= 3;
  }

  private toggleAutoExplore() {
    if (!this.selectedUnitId) return;
    if (this.autoExploreUnits.has(this.selectedUnitId)) {
      this.autoExploreUnits.delete(this.selectedUnitId);
      this.unitPaths.delete(this.selectedUnitId);
    } else {
      this.autoExploreUnits.add(this.selectedUnitId);
    }
    this.refreshUnitPanel();
  }

  /** Drives every auto-exploring unit toward unexplored territory. A unit stays under player control only while
   *  it's selected *and* has an actively queued manual path — otherwise auto-explore keeps driving it even while selected,
   *  since selecting a unit just to check its abilities/status shouldn't silently pause it. */
  private advanceAutoExplore() {
    for (const [unitId, entity] of this.units) {
      if (!this.autoExploreUnits.has(unitId)) continue;
      if (unitId === this.selectedUnitId && this.plannedPath.length > 0) continue; // player is actively manually pathing this one right now
      if (entity.state.kind !== "idle") continue;

      let path = this.unitPaths.get(unitId);
      if (!path || path.length === 0) {
        const now = performance.now();
        const lastTry = this.lastExploreAttempt.get(unitId) ?? 0;
        if (now - lastTry < 1000) continue; // don't hammer pathfinding every frame if the last attempt found nothing
        this.lastExploreAttempt.set(unitId, now);

        const target = this.findExploreTarget(entity.pos);
        if (!target) continue;
        const found = bfsPath((k) => this.tiles.get(k), entity.pos, target, 400, (t) => this.canEnterTile(t));
        path = found ? found.slice(1) : [];
        this.unitPaths.set(unitId, path);
      }
      if (path.length === 0) continue;

      const next = path.shift()!;
      const started = entity.tryStep(next, entity.stepMillis);
      if (started) this.ws.stepUnit(unitId, next.q, next.r);
      else this.unitPaths.set(unitId, []); // couldn't move there — recompute a fresh target next idle tick
    }
  }

  /** Picks the farthest known, passable tile that still borders unexplored territory — "the edge of the map, from here." */
  private findExploreTarget(from: Axial): Axial | null {
    let best: Axial | null = null;
    let bestDist = -1;
    for (const t of this.tiles.values()) {
      if (!isPassable(t)) continue;
      const hasUnknownNeighbor = neighbors({ q: t.q, r: t.r }).some(n => !this.tiles.has(keyFor(n.q, n.r)));
      if (!hasUnknownNeighbor) continue;
      const d = hexDistance(from, { q: t.q, r: t.r });
      if (d > bestDist && d > 0) { bestDist = d; best = { q: t.q, r: t.r }; }
    }
    return best;
  }

  private tryMergeUnits() {
    if (!this.selectedUnitId) return;
    const selected = this.units.get(this.selectedUnitId);
    if (!selected) return;
    this.ws.mergeUnits(selected.pos.q, selected.pos.r);
  }

  /** Tab cycles through the player's own units, wrapping back to the main character after the last one. */
  private cycleSelectedUnit() {
    const ids = [...this.units.keys()];
    if (ids.length === 0) { this.selectedUnitId = null; this.refreshUnitPanel(); return; }
    const curIdx = this.selectedUnitId ? ids.indexOf(this.selectedUnitId) : -1;
    const nextIdx = curIdx + 1;
    this.selectedUnitId = nextIdx < ids.length ? ids[nextIdx] : null;
    this.selectedBuildingKey = null;
    this.refreshUnitPanel();
    this.refreshBuildingPanel();
  }

  private activeEntity(): Player {
    if (this.selectedUnitId) {
      const u = this.units.get(this.selectedUnitId);
      if (u) return u;
    }
    return this.player;
  }

  /** Mirrors the server's terrain + territory rules for optimistic movement prediction — the server always has final say. */
  private canEnterTile(t: RemoteTile | undefined): boolean {
    if (t?.kind === "HighMountain" && this.myRace === "Dwarf") {
      // Dwarves can cross HighMountain race-wide (see races.js note on this simplification) — every other check still applies.
      if (t?.claimedBy && t.claimedBy.id !== this.myId) return false;
      return true;
    }
    if (!isPassable(t)) return false;
    if (t?.claimedBy && t.claimedBy.id !== this.myId) return false;
    return true;
  }

  private tryStepVisible(q: number, r: number): boolean {
    const vis = this.fow.state(q, r);
    if (vis === "hidden") return false;
    const tile = this.tiles.get(keyFor(q, r));
    if (!tile || !this.canEnterTile(tile)) return false;
    const entity = this.activeEntity();
    const started = entity.tryStep({ q, r }, entity.stepMillis);
    if (started) {
      if (this.selectedUnitId) this.ws.stepUnit(this.selectedUnitId, q, r);
      else this.ws.step(q, r);
    }
    return started;
  }

  private updateGhost(q: number, r: number) {
    if (!this.buildKind) { this.ghost.visible = false; return; }
    const tile = this.tiles.get(keyFor(q, r));
    const isAdj = this.hexAdj(this.player.pos, { q, r });
    const onSelf = q === this.player.pos.q && r === this.player.pos.r;
    const nearRequirement = this.buildKind === "TownHall" ? this.nearOwnSettler({ q, r }) : (isAdj || onSelf);
    const ok = nearRequirement && this.canBuildOn(this.buildKind, tile);

    const s = this.hexSize;
    const pts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      pts.push(s * Math.cos(a), s * Math.sin(a));
    }
    const c = ok ? 0x33ff88 : 0xff4444;
    this.ghost.clear();
    this.ghost.poly(pts).fill({ color: c, alpha: 0.35 }).stroke({ color: c, width: 2, alpha: 0.8 });
    const { x, y } = axialToPixel({ q, r }, this.hexSize);
    this.ghost.x = x; this.ghost.y = y;
    this.ghost.visible = true;
  }

  private hexAdj(a: { q: number; r: number }, b: { q: number; r: number }) {
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

  private refreshBuildingPanel() {
    if (!this.selectedBuildingKey) { refreshBuildingHUD(this.bld, null); return; }
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b) { this.selectedBuildingKey = null; refreshBuildingHUD(this.bld, null); return; }

    const displayName = raceDisplay(this.myRace).buildingNames[b.kind] || b.kind;
    const gatherResource: Record<string, string> = { Lumberjack: "Wood", Farm: "Bread", Mine: "Stone", FishingBoat: "Fish" };
    const resourceName = gatherResource[b.kind] ?? null;
    const tile = this.tiles.get(this.selectedBuildingKey);
    const info: SelectedBuildingInfo = {
      kind: displayName,
      hp: b.hp,
      maxHp: b.maxHp,
      constructed: b.constructed,
      ticksRemaining: b.ticksRemaining,
      gatherResLeft: resourceName ? (tile?.resLeft ?? 0) : null,
      gatherResourceName: resourceName,
      researchOptions: b.kind === "Research" ? (RESEARCH_OPTIONS[this.myRace] || null) : null,
      unlockedResearch: this.myResearch,
    };
    refreshBuildingHUD(this.bld, info);
  }

  private tryResearch(optionId: string) {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b || b.kind !== "Research") return;
    this.ws.research(optionId);
  }

  private tryDemolishSelected() {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b) return;
    this.ws.demolishBuilding(b.q, b.r);
  }

  private removeBuildingAt(key: string) {
    const b = this.buildingSprites.get(key);
    if (b) this.buildings.remove(b.q, b.r);
    this.buildingSprites.delete(key);
    const tile = this.tiles.get(key);
    if (tile) this.mapRenderer?.refreshTile(tile, this.tileVisualContext(tile));
    if (this.selectedBuildingKey === key) {
      this.selectedBuildingKey = null;
      this.refreshBuildingPanel();
    }
  }

  private renderMinimap() {
    if (!this.minimap) return;
    const others = this.lastPlayers.map(p => ({ q: p.q, r: p.r, color: p.color }));
    const buildings = [...this.buildingSprites.values()].map(b => ({ q: b.q, r: b.r, ownerId: b.ownerId }));
    this.minimap.render(this.tiles, this.player.pos, this.myColor, others, buildings);
  }

  private refreshDiplomacyPanel() {
    refreshDiplomacyPlayers(this.dip, [...this.metPlayers.values()], this.relations);
  }

  private updateFogVisuals() {
    const hidden = new Set<string>();
    for (const k of this.fow.seen) {
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
    this.ws?.close();
    if (this.app) { this.app.destroy(true); this.app = null; }
    this.mapRenderer = null!;
  }
}