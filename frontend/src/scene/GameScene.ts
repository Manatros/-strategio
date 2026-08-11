// src/scene/GameScene.ts
import * as PIXI from "pixi.js";
import type { Scene, SceneManager } from "./SceneManager";
import { GameOverScene } from "./GameOverScene";
import { TileRenderer, type TileVisualContext } from "../hex/TileRenderer";
import { attachHUD as attachDebugHUD } from "../ui/DebugHUD";
import { createBuildHUD, refreshHUD, setButtonsAffordable, setButtonsUnlocked, updateBuildTooltips } from "../ui/BuildHUD";
import { createUnitHUD, refreshUnitHUD, refreshAbilities, updateTrainTooltips } from "../ui/UnitHUD";
import { createDiplomacyHUD, refreshDiplomacyPlayers, setDiplomacyVisible, type MetPlayer } from "../ui/DiplomacyHUD";
import { ToastStack } from "../ui/Toasts";
import { TutorialOverlay, shouldShowTutorialAutomatically } from "../ui/TutorialOverlay";
import { InGameMenu } from "../ui/InGameMenu";
import { DEFAULT_KEYBINDINGS, fetchAndMergeServerKeybindings, type KeybindAction } from "../core/keybindings";
import { Minimap } from "../ui/Minimap";
import { createBuildingHUD, refreshBuildingHUD, type SelectedBuildingInfo } from "../ui/BuildingHUD";
import { DIRS, isPassable, keyFor } from "../hex/helpers";
import { axialToPixel, pixelToAxial, hexDistance, neighbors } from "../hex/HexMath";
import { fastestPath } from "../hex/Pathfinding";
import { Player } from "../entities/Player";
import { FogOfWar } from "../fow/Fog";
import { BuildingRenderer } from "../buildings/renderer";
import type { BuildingKind } from "../buildings/types";
import { canPlace } from "../buildings/rules";
import { emptyBank, canAfford, type Bank } from "../econ/resources";
import { BUILD_COST } from "../buildings/costs";
import { toPixiColor } from "../core/color";
import { raceDisplay } from "../core/races";
import { WORKER_EXEMPT, CIVILIAN_ASSIGN_EXEMPT, ATTACK_RANGE, TRAINING_BUILDING, BASE_TICKS_PER_TILE, ROAD_SPEED_TICKS, RACES_WITH_ROADS, maxWorkersFor, BUILDING_UNLOCK_RESEARCH, BUILDINGS_REQUIRING_UNLOCK, type BuildingUnlockOption, GATHERING_BUILDING_CAP, TOWNHALL_STORAGE_CAP, WAREHOUSE_STORAGE_CAP } from "../core/balance";
import { RESEARCH_OPTIONS } from "../core/research";
import { connectWS, getClientToken, type ServerMsg, type WS, type RemoteBuilding, type RemoteTile, type RemoteUnit, type RemotePlayer, type RelationStatus } from "../net";
import type { Axial } from "../hex/types";
import { SoundManager } from "../audio/SoundManager";

function fmtResources(r: Record<string, number | undefined> | null): string {
  if (!r) return "nothing";
  return Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ");
}

const SELF_KEY = "__self__"; // entityPaths key for the main character, distinct from any real unit id

/** Buildings a unit or the player character can manually collect stored resources from (Human-only mechanic). */
const GATHERING_KINDS = new Set(["Lumberjack", "Farm", "Mine", "FishingBoat"]);
const ROAD_NEEDING_KINDS = new Set(["Lumberjack", "Farm", "Mine", "FishingBoat", "Warehouse"]);

/** Draws a small floating health bar above a raw PIXI.Graphics entity — hidden at full HP, same convention as Player.setHealth(). */
function drawFloatingHealthBar(bar: PIXI.Graphics, hp: number, maxHp: number, radius: number) {
  bar.clear();
  if (maxHp <= 0 || hp >= maxHp) { bar.visible = false; return; }
  bar.visible = true;
  const w = radius * 2.2, h = 3.5, y = -radius * 2.1;
  const frac = Math.max(0, Math.min(1, hp / maxHp));
  const color = frac > 0.5 ? 0x4caf50 : frac > 0.25 ? 0xff9800 : 0xe53935;
  bar.rect(-w / 2, y, w, h).fill({ color: 0x000000, alpha: 0.6 });
  bar.rect(-w / 2, y, w * frac, h).fill(color);
}

/** How other players' and other players' units' positions are rendered — smoothly interpolated
 *  toward whatever the server most recently reported, instead of snapping instantly on each update.
 *  The server only sends position updates once per tick (500ms by default), so without this, every
 *  remote entity would visibly teleport between tiles instead of appearing to walk — this is what
 *  made movement look desynced. The local player's own units already tween via the Player class;
 *  this gives remote entities the equivalent for the lightweight raw-PIXI.Graphics they're rendered as. */
type RemoteEntry = {
  g: PIXI.Graphics;
  healthBar: PIXI.Graphics;
  fromX: number; fromY: number;
  toX: number; toY: number;
  startedAt: number;
};
// Slightly under the default 500ms tick interval so an interpolation finishes just before (rather
// than after) the next update would naturally arrive — avoids a visible "settle and wait" pause.
const REMOTE_INTERP_MS = 420;

function updateRemoteTarget(entry: RemoteEntry, targetX: number, targetY: number, now: number) {
  if (entry.toX === targetX && entry.toY === targetY) return; // no actual movement, nothing to do
  entry.fromX = entry.g.x; entry.fromY = entry.g.y; // continue smoothly from wherever it currently visually is
  entry.toX = targetX; entry.toY = targetY;
  entry.startedAt = now;
}

function advanceRemoteInterpolation(entry: RemoteEntry, now: number) {
  const t = Math.min(1, (now - entry.startedAt) / REMOTE_INTERP_MS);
  const x = entry.fromX + (entry.toX - entry.fromX) * t;
  const y = entry.fromY + (entry.toY - entry.fromY) * t;
  entry.g.x = x; entry.g.y = y;
  entry.healthBar.x = x; entry.healthBar.y = y;
}

export class GameScene implements Scene {
  private app: PIXI.Application | null = null;
  private el: HTMLElement | null = null;
  private mapRenderer: TileRenderer | null = null;
  private player!: Player;
  private entityPaths = new Map<string, Axial[]>(); // key: unitId, or SELF_KEY for the main character — each entity remembers its own queued path independently, which is what lets you control multiple units at once

  private fow!: FogOfWar;
  private buildings!: BuildingRenderer;
  private buildingSprites = new Map<string, RemoteBuilding>();
  private otherPlayers = new Map<string, RemoteEntry>();
  private lastPlayers: RemotePlayer[] = [];
  private lastUnits: RemoteUnit[] = [];
  private units = new Map<string, Player>();
  private unitKinds = new Map<string, string>();
  private unitLevels = new Map<string, number>();
  private unitGuards = new Map<string, boolean>();
  private unitAssignedTo = new Map<string, string | null>(); // Civilian id -> building id it's working, if any
  private myResearch = new Set<string>();
  private myBuildingUnlocks = new Set<string>();
  private otherUnits = new Map<string, RemoteEntry>();
  private selectedUnitId: string | null = null;
  private selectedUnitIds: Set<string> = new Set(); // the full selection group for move commands - selectedUnitId is just "the primary one" for HUD/ability display
  private autoExploreUnits = new Set<string>();     // unit ids currently self-navigating toward unexplored territory
  private lastExploreAttempt = new Map<string, number>(); // throttles retries when a unit can't find a reachable frontier

  private ui!: ReturnType<typeof createBuildHUD>;
  private unitUi!: ReturnType<typeof createUnitHUD>;
  private bld!: ReturnType<typeof createBuildingHUD>;
  private selectedBuildingKey: string | null = null;
  /** Non-null while waiting for the person to click a tile to convert — see startConvertTileMode(). */
  private convertTileMode: { buildingQ: number; buildingR: number } | null = null;
  private dip!: ReturnType<typeof createDiplomacyHUD>;
  private minimap!: Minimap;
  private dbg!: ReturnType<typeof attachDebugHUD>;
  private metPlayers = new Map<string, MetPlayer>();
  private relations = new Map<string, RelationStatus>();
  private toasts!: ToastStack;
  private inGameMenu: InGameMenu | null = null;
  private rootEl!: HTMLElement;
  private keybindings: Record<KeybindAction, string> = { ...DEFAULT_KEYBINDINGS };
  private sound = new SoundManager();
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
  private pendingBuildPlacement: { kind: BuildingKind; target: Axial; builderKey?: string } | null = null; // set when a placement was too far — walking a Builder toward it automatically (or the player character, for TownHall's Settler case), retried once in range
  private ghost = new PIXI.Graphics();
  private pathIndicator = new PIXI.Graphics(); // draws the currently-selected entity's queued movement path on the map
  private roadPreview = new PIXI.Graphics(); // previews the auto-generated road connection while placing a worker building

  private ws!: WS;
  private myId = "";
  private myColor = 0x3a86ff;
  private myRace = "Human";
  private isAdmin = false;
  private mapRevealed = false;
  private hexSize = 22;
  private visionRadius = 5;
  private stepMillis = 260; // overwritten on connect with the server's real cooldown — see awaitWelcome
  private tiles = new Map<string, RemoteTile>();

  constructor(private sm: SceneManager, private mode: "new" | "auto" = "new") {}

  async mount(root: HTMLElement) {
    this.rootEl = root;
    fetchAndMergeServerKeybindings(getClientToken()).then((kb) => { this.keybindings = kb; });
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
    this.sound.setMusic("theme");
    this.sound.setAmbience("wind");

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
    this.player.setHealth(this.hp, this.maxHp);
    this.player.stepMillis = this.stepMillis;
    this.mapRenderer.container.addChild(this.player.container);
    this.mapRenderer.container.addChild(this.pathIndicator);
    this.mapRenderer.container.addChild(this.roadPreview);

    this.ws.onMessage((msg) => this.handleServerMsg(msg));

    this.fow.recalc(this.player.pos, [...this.ownedBuildingCenters(), ...this.ownedUnitCenters()]);
    this.mapRenderer.syncAll(() => this.tiles.entries(), (t) => this.tileVisualContext(t));
    this.updateFogVisuals();
    this.renderMinimap();

    // Right-drag pans the map (dragDistance also disambiguates a genuine right-click action from
    // the release of a pan, in the contextmenu handler below). Left-drag draws a selection box
    // instead — a plain click still does normal single selection (see the click handler below).
    let panDragging = false, panLastX = 0, panLastY = 0, panDragDistance = 0;
    let boxSelecting = false, boxStartX = 0, boxStartY = 0, leftWasBoxDrag = false;
    const DRAG_THRESHOLD = 6; // px of total movement before a pointerdown->up counts as a drag, not a click

    const selectionBoxEl = document.createElement("div");
    selectionBoxEl.style.cssText = "position:fixed; border:1px solid #7fd4ff; background:rgba(127,212,255,0.15); pointer-events:none; display:none; z-index:50;";
    document.body.appendChild(selectionBoxEl);

    app.canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2) {
        panDragging = true; panDragDistance = 0; panLastX = e.clientX; panLastY = e.clientY;
      } else if (e.button === 0) {
        boxSelecting = true; boxStartX = e.clientX; boxStartY = e.clientY; leftWasBoxDrag = false;
      }
    });
    window.addEventListener("pointerup", (e) => {
      if (e.button === 2) {
        panDragging = false;
        if (panDragDistance <= DRAG_THRESHOLD) this.performRightClickAction(e.clientX, e.clientY, e.shiftKey);
      }
      if (e.button === 0 && boxSelecting) {
        boxSelecting = false;
        selectionBoxEl.style.display = "none";
        const dist = Math.hypot(e.clientX - boxStartX, e.clientY - boxStartY);
        if (dist > DRAG_THRESHOLD) { leftWasBoxDrag = true; this.finishBoxSelect(boxStartX, boxStartY, e.clientX, e.clientY); }
      }
    });
    window.addEventListener("pointermove", (e) => {
      if (panDragging && this.mapRenderer) {
        const dx = e.clientX - panLastX; const dy = e.clientY - panLastY;
        panDragDistance += Math.abs(dx) + Math.abs(dy);
        panLastX = e.clientX; panLastY = e.clientY;
        this.mapRenderer.container.x += dx;
        this.mapRenderer.container.y += dy;
      }
      if (boxSelecting) {
        const x = Math.min(boxStartX, e.clientX), y = Math.min(boxStartY, e.clientY);
        const w = Math.abs(e.clientX - boxStartX), h = Math.abs(e.clientY - boxStartY);
        if (w > 3 || h > 3) {
          selectionBoxEl.style.display = "block";
          selectionBoxEl.style.left = `${x}px`;
          selectionBoxEl.style.top = `${y}px`;
          selectionBoxEl.style.width = `${w}px`;
          selectionBoxEl.style.height = `${h}px`;
        }
      }
    });
    window.addEventListener("wheel", (e) => {
      if (!this.mapRenderer) return;
      if (e.target !== app.canvas) return; // don't zoom the map while scrolling inside a HUD panel on top of it
      const c = this.mapRenderer.container;
      const rect = app.canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left, screenY = e.clientY - rect.top;
      const worldBefore = this.screenToWorld(screenX, screenY);
      const k = e.deltaY < 0 ? 1.1 : 0.9;
      const ns = Math.min(3, Math.max(0.3, c.scale.x * k));
      c.scale.set(ns);
      // Keep the same world point under the cursor after the scale change — without this, the map
      // visibly drifts on every scroll (it always zooms around the container's origin instead of
      // wherever you're actually pointing), making zooming and clicking/panning feel like they
      // fight each other since the map shifts out from under your cursor mid-interaction.
      c.x = screenX - worldBefore.x * ns;
      c.y = screenY - worldBefore.y * ns;
    }, { passive: true });

    const extraBuildingKinds: BuildingKind[] = this.myRace === "Human" ? ["Road", "Monastery"] : [];
    this.ui = createBuildHUD(root, root, (kind) => { this.buildKind = kind; }, extraBuildingKinds, (kind) => { this.buildKind = kind; });
    const rd = raceDisplay(this.myRace);
    for (const [kind, btn] of Object.entries(this.ui.btns)) {
      const label = rd.buildingNames[kind];
      if (label) btn.textContent = label;
    }
    const extraTrainableKinds = this.myRace === "Undead" ? ["Necromancer"] : this.myRace === "Orc" ? ["Brawler"] : [];
    this.unitUi = createUnitHUD(
      root,
      (id) => { this.setSingleSelection(id); this.refreshUnitPanel(); },
      (kind) => this.tryTrainUnit(kind),
      () => this.tryMergeUnits(),
      () => this.toggleAutoExplore(),
      () => this.toggleGuard(),
      extraTrainableKinds
    );
    for (const kind of Object.keys(this.unitUi.trainBtns)) {
      const label = rd.unitNames[kind];
      if (label) this.unitUi.trainBtns[kind].textContent = label;
    }
    updateBuildTooltips(this.ui, this.buildCost);
    updateTrainTooltips(this.unitUi, this.unitCost);
    this.refreshUnitPanel();
    this.bld = createBuildingHUD(root, () => this.tryDemolishSelected(), (optionId) => this.tryResearch(optionId), (optionId) => this.tryResearchBuilding(optionId), () => this.tryUpgradeRoad(), () => this.tryUpgradeHouse(),
      () => this.tryUpgradeGathering(), () => this.startConvertTileMode(), () => this.tryUpgradeWarehouse(), () => this.tryCollectSelected(), () => this.tryAssignWorker(), () => this.tryUnassignWorker(),
      (index) => this.tryCancelTraining(index));
    this.toasts = new ToastStack(root);
    if (shouldShowTutorialAutomatically()) new TutorialOverlay(root, () => {});

    const menuBtn = document.createElement("button");
    menuBtn.className = "btn";
    menuBtn.textContent = "☰ Menu";
    menuBtn.style.position = "fixed";
    menuBtn.style.top = "10px";
    menuBtn.style.right = "10px";
    menuBtn.style.zIndex = "400";
    menuBtn.onclick = () => this.toggleInGameMenu();
    root.appendChild(menuBtn);

    const diplomacyBtn = document.createElement("button");
    diplomacyBtn.className = "btn";
    diplomacyBtn.textContent = "Diplomacy";
    diplomacyBtn.style.position = "fixed";
    diplomacyBtn.style.top = "10px";
    diplomacyBtn.style.right = "90px";
    diplomacyBtn.style.zIndex = "400";
    diplomacyBtn.onclick = () => setDiplomacyVisible(this.dip, !this.dip.visible);
    root.appendChild(diplomacyBtn);

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
    this.dbg = attachDebugHUD(root, this.isAdmin);
    this.ws.onDebugLog((entry) => this.dbg.appendLog(entry));
    this.dbg.onCheatApply((amounts) => this.ws.adminCheatResources(amounts));
    this.dbg.onRevealToggle((reveal) => {
      this.mapRevealed = reveal;
      this.ws.adminToggleReveal(reveal);
      this.updateFogVisuals(); // take effect immediately, don't wait for the next natural fog recalc
    });
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

    // Drag-and-drop from the build menu — buildKind gets set on dragstart (see the onDragStart
    // callback passed to createBuildHUD) so this reuses exactly the same ghost preview and
    // placement validation as clicking a build button then clicking the map.
    app.canvas.addEventListener("dragover", (e) => {
      if (!this.buildKind) return;
      e.preventDefault(); // required for drop to fire at all
      const world = this.screenToWorld(e.clientX, e.clientY);
      const a = pixelToAxial(world.x, world.y, this.hexSize);
      this.mapRenderer?.highlight(a.q, a.r, 0xffffff);
      this.updateGhost(a.q, a.r);
    });
    app.canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.buildKind) return;
      const world = this.screenToWorld(e.clientX, e.clientY);
      const target = pixelToAxial(world.x, world.y, this.hexSize);
      this.attemptPlaceBuilding(this.buildKind, target);
      this.buildKind = null;
      this.ghost.visible = false;
    });
    // Safety net: if the drag ends outside the canvas (dropped on the HUD, off-window, or
    // cancelled), clear build mode rather than leaving a stuck ghost preview and armed buildKind.
    window.addEventListener("dragend", () => {
      this.buildKind = null;
      this.ghost.visible = false;
      this.mapRenderer?.hideHighlight();
    });

    // Native right-click context menu would otherwise pop up over the game — right-click is now a
    // real game action (move/attack/assign), so it must never trigger the browser's own menu.
    // Left click: selection only (a unit, a building, or completing a pending build/convert-tile
    // placement) — never moves anything and never issues an action against a target.
    app.canvas.addEventListener("click", (e) => {
      if (leftWasBoxDrag) return; // this click is really the release of a box-select drag, not an intentional single click
      const world = this.screenToWorld(e.clientX, e.clientY);
      const target = pixelToAxial(world.x, world.y, this.hexSize);
      const vis = this.fow.state(target.q, target.r);

      if (this.convertTileMode) {
        const { buildingQ, buildingR } = this.convertTileMode;
        this.convertTileMode = null;
        if (vis === "visible") this.ws.convertTile(buildingQ, buildingR, target.q, target.r);
        return;
      }

      if (this.buildKind) {
        this.attemptPlaceBuilding(this.buildKind, target);
        this.buildKind = null;
        this.ghost.visible = false;
        return;
      }

      if (this.selectedUnitId && target.q === this.player.pos.q && target.r === this.player.pos.r) {
        this.setSingleSelection(null);
        this.selectedBuildingKey = null;
        this.refreshUnitPanel();
        this.refreshBuildingPanel();
        return;
      }

      // Buildings take priority over units standing on the same tile — an assigned Civilian (or a
      // roving one mid-delivery) visually sits right at its workplace's position, so without this,
      // clicking a staffed building would select the worker instead of the building itself.
      const building = this.buildingSprites.get(keyFor(target.q, target.r));
      if (building && building.ownerId === this.myId) {
        this.selectedBuildingKey = keyFor(target.q, target.r);
        this.setSingleSelection(null);
        this.refreshUnitPanel();
        this.refreshBuildingPanel();
        return;
      }

      for (const [id, u] of this.units) {
        if (u.pos.q === target.q && u.pos.r === target.r) {
          this.setSingleSelection(id);
          this.selectedBuildingKey = null;
          this.refreshUnitPanel();
          this.refreshBuildingPanel();
          return;
        }
      }

      // Empty/unowned ground — nothing to select, so clear whatever was selected before.
      this.setSingleSelection(null);
      this.selectedBuildingKey = null;
      this.refreshUnitPanel();
      this.refreshBuildingPanel();
    });

    // Right-click is handled via pointerup (button 2) rather than the contextmenu event — some
    // browsers (Firefox notably) force their native context menu on Shift+Right-click specifically,
    // bypassing preventDefault() on contextmenu entirely. pointerup isn't subject to that, so this
    // is what makes shift+right-click-to-queue actually work reliably. contextmenu is kept only to
    // suppress the native menu on an ordinary right-click.
    app.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    const keys = new Set<string>();
    const normalizeKey = (k: string) => (k.length === 1 ? k.toLowerCase() : k); // single chars case-insensitive; Tab/Arrow*/etc left as-is
    addEventListener("keydown", (e) => keys.add(normalizeKey(e.key)));
    addEventListener("keyup", (e) => keys.delete(normalizeKey(e.key)));

    // One-shot shortcuts (as opposed to the held-movement keys above), Warcraft-style.
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement) return;

      if (e.key === "Escape") {
        if (this.inGameMenu) { this.toggleInGameMenu(); return; }
        const hadSomethingToCancel = !!(this.buildKind || this.pendingBuildPlacement || this.selectedUnitId || this.selectedBuildingKey || this.convertTileMode || this.selectedUnitIds.size > 0);
        this.buildKind = null;
        this.pendingBuildPlacement = null;
        this.ghost.visible = false;
        this.setSingleSelection(null);
        this.selectedBuildingKey = null;
        this.convertTileMode = null;
        this.refreshUnitPanel();
        this.refreshBuildingPanel();
        if (!hadSomethingToCancel) this.toggleInGameMenu(); // nothing to cancel — Escape opens the menu instead
        return;
      }
      if (e.key.toLowerCase() === this.keybindings.diplomacy.toLowerCase()) {
        setDiplomacyVisible(this.dip, !this.dip.visible);
        return;
      }
      if (e.key.toLowerCase() === this.keybindings.stop.toLowerCase()) {
        // Stop: clear the active entity's queued movement.
        this.entityPaths.set(this.activeKey(), []);
        return;
      }
      const cycleBinding = this.keybindings.cycleUnit;
      const cycleMatches = cycleBinding.length === 1 ? e.key.toLowerCase() === cycleBinding.toLowerCase() : e.key === cycleBinding;
      if (cycleMatches) {
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

      const activeKey = this.activeKey();
      const activeNow = this.activeEntity();
      const activePath = this.entityPaths.get(activeKey);
      this.updatePathIndicator();

      if (activePath && activePath.length > 0 && activeNow.state.kind === "idle") {
        const next = activePath.shift()!;
        if (!this.tryStepEntity(activeKey, activeNow, next.q, next.r)) this.entityPaths.set(activeKey, []);
      } else if (activeNow.state.kind === "idle" && (!activePath || activePath.length === 0) && this.unitKinds.get(this.selectedUnitId ?? "") !== "Civilian") {
        const dir = this.readDirection(keys);
        if (dir) {
          const cur = activeNow.state.at;
          const to = { q: cur.q + dir.q, r: cur.r + dir.r };
          this.tryStepVisible(to.q, to.r);
        }
      }

      // Every other entity keeps moving toward wherever it was told to go, independent of whichever
      // one is currently selected — this is what lets you actually control multiple units at once.
      if (activeKey !== SELF_KEY) this.advanceEntityQueuedPath(SELF_KEY, this.player);
      for (const [unitId, entity] of this.units) {
        if (unitId === activeKey) continue;
        this.advanceEntityQueuedPath(unitId, entity);
      }

      this.player.tick(dt);
      for (const [id, u] of this.units) {
        u.tick(dt);
        if (this.unitKinds.get(id) === "Civilian") this.updateCivilianVisibility(id, u);
      }
      this.advanceAutoExplore();

      const nowMs = performance.now();
      for (const entry of this.otherPlayers.values()) advanceRemoteInterpolation(entry, nowMs);
      for (const entry of this.otherUnits.values()) advanceRemoteInterpolation(entry, nowMs);

      if (this.player.state.kind === "idle") {
        this.fow.recalc(this.player.state.at, [...this.ownedBuildingCenters(), ...this.ownedUnitCenters()]);
        this.updateFogVisuals();
        this.refreshUnitPanel();
        this.checkPendingBuildPlacement();
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
          this.isAdmin = msg.isAdmin;
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
            this.metPlayers.set(t.claimedBy.id, { id: t.claimedBy.id, name: t.claimedBy.name || "Unknown", tag: "????", color: t.claimedBy.color, race: t.claimedBy.race || "Human" });
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
        this.myBuildingUnlocks = new Set(msg.buildingUnlocks ?? []);
        this.player.setHealth(this.hp, this.maxHp);
        refreshHUD(this.ui, this.bank, this.popCap, this.workers, this.hp, this.maxHp, this.score, this.storageCap);
        setButtonsAffordable(this.ui, (k) => canAfford(this.bank, this.buildCost[k] || {}) && this.hasPopulationFor(k));
        setButtonsUnlocked(this.ui, (k) => this.isBuildingUnlockedLocally(k));
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
            this.metPlayers.set(p.id, { id: p.id, name: p.name, tag: p.tag, color: p.color, race: p.race });
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
        const key = msg.unitId ?? SELF_KEY;
        if (msg.unitId) {
          const u = this.units.get(msg.unitId);
          if (u) u.snapTo(u.pos);
        } else {
          this.player.snapTo(this.player.pos);
        }
        if (msg.reason === "too_soon") {
          const path = this.entityPaths.get(key) ?? [];
          this.entityPaths.set(key, [{ q: msg.q, r: msg.r }, ...path]);
        } else {
          this.entityPaths.set(key, []);
        }
        console.warn(`[Strategio] step rejected: ${msg.reason}`);
        break;
      }
      case "build_rejected": {
        this.buildKind = null;
        this.pendingBuildPlacement = null;
        this.ghost.visible = false;
        console.warn(`[Strategio] build rejected: ${msg.reason}`);
        break;
      }
      case "you_died": {
        this.sound.playSfx("defeat");
        this.sm.switch(new GameOverScene(this.sm, msg.finalScore, msg.reason));
        break;
      }
      case "game_over": {
        this.sound.playSfx(msg.youWon ? "victory" : "defeat");
        this.sm.switch(new GameOverScene(this.sm, msg.finalScore, msg.reason, {
          youWon: msg.youWon, winnerName: msg.winnerName, winnerRace: msg.winnerRace, reason: msg.reason, bonus: msg.bonus,
        }));
        break;
      }
      case "research_unlocked": {
        this.sound.playSfx("research_unlocked");
        const opt = (RESEARCH_OPTIONS[this.myRace] || []).find(o => o.id === msg.optionId);
        this.toasts.show({
          id: `research-${msg.optionId}`,
          title: "Research Complete",
          body: opt ? opt.name : msg.optionId,
          autoDismissMs: 6000,
        });
        break;
      }
      case "achievement_unlocked": {
        this.sound.playSfx("achievement");
        this.toasts.show({
          id: `achievement-${msg.id}`,
          title: `🏆 ${msg.name}`,
          body: msg.description,
          autoDismissMs: 8000,
        });
        break;
      }
      case "admin_debug": {
        this.dbg.updateServerInfo(msg);
        break;
      }
      case "relations_update": {
        this.relations.set(msg.withId, msg.status);
        this.refreshDiplomacyPanel();
        if (msg.status === "war") this.sound.playSfx("war_declared");
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
    for (const [id, entry] of this.otherPlayers) {
      if (!present.has(id)) {
        this.mapRenderer!.container.removeChild(entry.g, entry.healthBar);
        entry.g.destroy(); entry.healthBar.destroy();
        this.otherPlayers.delete(id);
      }
    }
    for (const p of list) {
      let entry = this.otherPlayers.get(p.id);
      const { x, y } = axialToPixel({ q: p.q, r: p.r }, this.hexSize);
      if (!entry) {
        const g = new PIXI.Graphics();
        const outer = this.hexSize * 0.4, inner = outer * 0.55;
        g.circle(0, 0, outer).stroke({ color: 0x000000, width: 2, alpha: 0.6 });
        g.circle(0, 0, inner).fill(p.color);
        const healthBar = new PIXI.Graphics();
        healthBar.visible = false;
        this.mapRenderer!.container.addChild(g, healthBar);
        g.x = x; g.y = y; healthBar.x = x; healthBar.y = y;
        entry = { g, healthBar, fromX: x, fromY: y, toX: x, toY: y, startedAt: performance.now() };
        this.otherPlayers.set(p.id, entry);
      }
      updateRemoteTarget(entry, x, y, performance.now());
      drawFloatingHealthBar(entry.healthBar, p.hp, p.maxHp, this.hexSize * 0.4);
    }
  }

  private renderBuildings(list: RemoteBuilding[]) {
    let anyChanged = false;
    for (const b of list) {
      const k = keyFor(b.q, b.r);
      const isNew = !this.buildingSprites.has(k);
      this.buildingSprites.set(k, b);
      this.buildings.upsert(b);
      if (isNew) {
        const tile = this.tiles.get(k);
        if (tile) this.mapRenderer?.refreshTile(tile, this.tileVisualContext(tile));
      }
      if (isNew || b.kind === "Road") anyChanged = true; // a Road's own level/hp changing doesn't affect connections, but cheap enough to just redraw on any Road update
    }
    if (anyChanged) this.redrawRoadConnections();
  }

  /** Rebuilds the road-connection lines from everything currently known — called whenever the
   *  building set actually changes (new/removed buildings), not every frame. */
  private redrawRoadConnections() {
    this.buildings.redrawRoadConnections(
      [...this.buildingSprites.values()].map((b) => ({ q: b.q, r: b.r, kind: b.kind, ownerId: b.ownerId }))
    );
  }

  private renderUnits(list: RemoteUnit[]) {
    const ownSeen = new Set<string>();
    const otherSeen = new Set<string>();
    let rosterChanged = false;

    for (const u of list) {
      if (u.ownerId === this.myId) {
        ownSeen.add(u.id);
        this.unitGuards.set(u.id, u.guard);
        this.unitAssignedTo.set(u.id, u.assignedTo ?? null);
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
          if (!entity.tryStep({ q: u.q, r: u.r })) entity.snapTo({ q: u.q, r: u.r });
        }
        entity.setHealth(u.hp, u.maxHp);
        entity.setGuarding(u.guard);
        if (u.kind === "Civilian") {
          entity.setJobLabel(this.civilianJobLabel(u));
          // Civilians stay inside their house while idle, and inside whatever they're assigned to
          // while working — only actually visible while walking (a fresh assignment, a delivery
          // run, roving, or heading home), or while selected so you never lose track of them.
          entity.container.visible = !!u.moving || u.id === this.selectedUnitId;
        }
      } else {
        otherSeen.add(u.id);
        let entry = this.otherUnits.get(u.id);
        const { x, y } = axialToPixel({ q: u.q, r: u.r }, this.hexSize);
        if (!entry) {
          const g = new PIXI.Graphics();
          const outer = this.hexSize * 0.28, inner = outer * 0.55;
          g.circle(0, 0, outer).stroke({ color: 0x000000, width: 2, alpha: 0.6 });
          g.circle(0, 0, inner).fill(u.color);
          const healthBar = new PIXI.Graphics();
          healthBar.visible = false;
          this.mapRenderer!.container.addChild(g, healthBar);
          g.x = x; g.y = y; healthBar.x = x; healthBar.y = y;
          entry = { g, healthBar, fromX: x, fromY: y, toX: x, toY: y, startedAt: performance.now() };
          this.otherUnits.set(u.id, entry);
        }
        updateRemoteTarget(entry, x, y, performance.now());
        drawFloatingHealthBar(entry.healthBar, u.hp, u.maxHp, this.hexSize * 0.28);
      }
    }

    for (const [id, entry] of this.otherUnits) {
      if (!otherSeen.has(id)) {
        this.mapRenderer!.container.removeChild(entry.g, entry.healthBar);
        entry.g.destroy(); entry.healthBar.destroy();
        this.otherUnits.delete(id);
      }
    }
    for (const [id, entity] of this.units) {
      if (!ownSeen.has(id)) {
        this.mapRenderer!.container.removeChild(entity.container);
        entity.container.destroy();
        this.units.delete(id);
        this.unitKinds.delete(id);
        this.unitLevels.delete(id);
        this.unitGuards.delete(id);
        this.unitAssignedTo.delete(id);
        this.autoExploreUnits.delete(id);
        this.entityPaths.delete(id);
        this.lastExploreAttempt.delete(id);
        this.selectedUnitIds.delete(id);
        if (this.selectedUnitId === id) this.selectedUnitId = this.selectedUnitIds.values().next().value ?? null;
        rosterChanged = true;
      }
    }

    if (rosterChanged) this.refreshUnitPanel();
  }

  private hasPopulationFor(kind: BuildingKind): boolean {
    if (WORKER_EXEMPT.has(kind)) return true;
    return this.popCap - this.workers >= 1;
  }

  /** Whether `kind` is actually placeable right now — true for anything not gated at all (the vast
   *  majority of buildings, and every non-Human race's whole roster), otherwise only once the
   *  specific unlock research covering it has been purchased. Mirrors the server's own check. */
  private isBuildingUnlockedLocally(kind: BuildingKind): boolean {
    const gated = BUILDINGS_REQUIRING_UNLOCK[this.myRace];
    if (!gated || !gated.has(kind)) return true;
    const raceOptions = BUILDING_UNLOCK_RESEARCH[this.myRace];
    const relevant = Object.values(raceOptions).flat().find(o => o.building === kind);
    if (!relevant) return true;
    return this.myBuildingUnlocks.has(relevant.id);
  }

  private canBuildOn(kind: BuildingKind, tile: RemoteTile | undefined): boolean {
    if (!canPlace(kind, tile, this.myRace)) return false;
    if (!this.hasPopulationFor(kind)) return false;
    if (kind === "TownHall") return true;
    return tile?.claimedBy?.id === this.myId;
  }

  /** Attempts to place `kind` at `target`, doing the same validity/affordability checks the ghost
   *  preview already does — shared by click-to-place and drag-and-drop from the build menu, so both
   *  paths always agree on what's actually placeable. Returns whether the attempt was sent. */
  private attemptPlaceBuilding(kind: BuildingKind, target: Axial): boolean {
    const tile = this.tiles.get(keyFor(target.q, target.r));
    const vis = this.fow.state(target.q, target.r);
    const cost = this.buildCost[kind] || {};

    if (vis !== "visible" || !this.canBuildOn(kind, tile) || !canAfford(this.bank, cost)) {
      console.warn("[Strategio] can't build there");
      this.pendingBuildPlacement = null;
      return false;
    }

    if (kind === "TownHall") {
      if (this.nearOwnSettler(target)) {
        this.ws.placeBuilding(kind, target.q, target.r);
        this.sound.playSfx("build_place");
        this.pendingBuildPlacement = null;
        return true;
      }
      console.warn("[Strategio] no Settler nearby");
      this.pendingBuildPlacement = null;
      return false;
    }

    // Every other building needs an available Builder (not already locked to another
    // construction) within 1 tile. If the closest available one isn't there yet, walk it into
    // range instead of the player character — the server is the actual authority on this and will
    // reject if we're wrong about who's available by the time this arrives.
    const builder = this.closestAvailableBuilder(target);
    if (builder && hexDistance(builder.pos, target) <= 1) {
      this.ws.placeBuilding(kind, target.q, target.r);
      this.sound.playSfx("build_place");
      this.pendingBuildPlacement = null;
      return true;
    }
    if (!builder) {
      console.warn("[Strategio] no available Builder");
      this.pendingBuildPlacement = null;
      return false;
    }

    const path = fastestPath((k) => this.tiles.get(k), builder.pos, target, 4000, (t) => this.canEnterTile(t), (k) => this.stepCostByKey(k));
    if (!path || path.length < 2) {
      console.warn("[Strategio] Builder can't reach that spot");
      this.pendingBuildPlacement = null;
      return false;
    }
    this.entityPaths.set(builder.key, path.slice(1));
    this.pendingBuildPlacement = { kind, target, builderKey: builder.key };
    return false;
  }

  /** The closest of this player's own Builder units not already locked to constructing something
   *  else — the one that will walk toward a pending placement. Returns its render entity plus the
   *  key entityPaths/queueMoveFor use to address it, or null if no Builder is currently free. */
  private closestAvailableBuilder(target: Axial): { pos: Axial; key: string } | null {
    let best: { pos: Axial; key: string } | null = null, bestDist = Infinity;
    for (const remote of this.lastUnits) {
      if (remote.ownerId !== this.myId || remote.kind !== "Builder" || remote.constructingBuildingId) continue;
      const entity = this.units.get(remote.id);
      if (!entity) continue;
      const d = hexDistance(entity.pos, target);
      if (d < bestDist) { bestDist = d; best = { pos: entity.pos, key: remote.id }; }
    }
    return best;
  }

  /** Checked every idle tick — once a Builder has walked within range of a pending auto-move
   *  placement, fires it for real. Cancelled if the spot stops being valid (afforded, terrain,
   *  visibility) while en route, rather than silently placing something no longer intended. */
  private checkPendingBuildPlacement() {
    if (!this.pendingBuildPlacement) return;
    const { kind, target } = this.pendingBuildPlacement;
    let inRange: boolean;
    if (kind === "TownHall") {
      inRange = this.nearOwnSettler(target);
    } else {
      const builder = this.closestAvailableBuilder(target);
      inRange = !!builder && hexDistance(builder.pos, target) <= 1;
    }
    if (inRange) {
      this.pendingBuildPlacement = null;
      this.attemptPlaceBuilding(kind, target);
      return;
    }
    // Not in range yet — if there's still a queued path heading there, keep waiting. If the path
    // has run out (arrived somewhere, or got stuck/rejected en route) without reaching range, give
    // up rather than leave this pending forever.
    const pathKey = this.pendingBuildPlacement.builderKey ?? SELF_KEY;
    const path = this.entityPaths.get(pathKey);
    if (!path || path.length === 0) {
      console.warn("[Strategio] couldn't reach that spot to build");
      this.pendingBuildPlacement = null;
    }
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

  /** Is one of the player's own Builder units on or next to this tile? Builders can place buildings the same way the player character can. */
  private nearOwnBuilder(target: { q: number; r: number }): boolean {
    for (const [id, kind] of this.unitKinds) {
      if (kind !== "Builder") continue;
      const u = this.units.get(id);
      if (!u) continue;
      if ((u.pos.q === target.q && u.pos.r === target.r) || this.hexAdj(u.pos, target)) return true;
    }
    return false;
  }

  private nearOwnBuildingOfKind(kind: BuildingKind): RemoteBuilding | null {
    for (const b of this.buildingSprites.values()) {
      if (b.kind !== kind || b.ownerId !== this.myId || !b.constructed) continue;
      const onSelf = b.q === this.player.pos.q && b.r === this.player.pos.r;
      if (onSelf || this.hexAdj(this.player.pos, { q: b.q, r: b.r })) return b;
    }
    return null;
  }

  private tryTrainUnit(kind: string) {
    const requiredKind = TRAINING_BUILDING[kind] ?? "Garrison";
    const building = this.nearOwnBuildingOfKind(requiredKind);
    if (!building) { console.warn(`[Strategio] no ready ${requiredKind} nearby`); return; }
    this.ws.trainUnit(kind, building.q, building.r);
  }

  private refreshUnitPanel() {
    const names = raceDisplay(this.myRace).unitNames;
    const QUICK_SELECT_KINDS = new Set(["Soldier", "Archer", "Scout", "Necromancer", "Brawler", "Builder", "Settler"]);
    const list = [...this.unitKinds.entries()]
      .filter(([id, kind]) => id === this.selectedUnitId || QUICK_SELECT_KINDS.has(kind))
      .map(([id, kind]) => ({ id, kind: names[kind] || kind, level: this.unitLevels.get(id) ?? 1 }));
    const canTrainKind = (kind: string) => !!this.nearOwnBuildingOfKind(TRAINING_BUILDING[kind] ?? "Garrison");
    refreshUnitHUD(this.unitUi, list, this.selectedUnitId, canTrainKind, this.canMergeAtSelected());
    const selectedKind = this.selectedUnitId ? this.unitKinds.get(this.selectedUnitId) ?? null : null;
    const guardOn = !!this.selectedUnitId && !!this.unitGuards.get(this.selectedUnitId);
    let stats: { hp: number; maxHp: number; level: number } | null = null;
    let carrying: { kind: string; amount: number } | null = null;
    if (this.selectedUnitId) {
      const remote = this.lastUnits.find(u => u.id === this.selectedUnitId);
      if (remote) {
        stats = { hp: remote.hp, maxHp: remote.maxHp, level: this.unitLevels.get(this.selectedUnitId) ?? 1 };
        carrying = remote.carrying ?? null;
      }
    } else {
      stats = { hp: this.hp, maxHp: this.maxHp, level: 1 };
    }
    refreshAbilities(this.unitUi, selectedKind, !!this.selectedUnitId && this.autoExploreUnits.has(this.selectedUnitId), guardOn, stats, carrying, this.myRace, () => this.tryForage(), () => this.entityPaths.set(this.activeKey(), []));
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
      this.entityPaths.delete(this.selectedUnitId);
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
      if (unitId === this.selectedUnitId && (this.entityPaths.get(unitId)?.length ?? 0) > 0) continue; // player is actively manually pathing this one right now
      if (entity.state.kind !== "idle") continue;

      let path = this.entityPaths.get(unitId);
      if (!path || path.length === 0) {
        const now = performance.now();
        const lastTry = this.lastExploreAttempt.get(unitId) ?? 0;
        if (now - lastTry < 1000) continue; // don't hammer pathfinding every frame if the last attempt found nothing
        this.lastExploreAttempt.set(unitId, now);

        const target = this.findExploreTarget(entity.pos);
        if (!target) continue;
        const found = fastestPath((k) => this.tiles.get(k), entity.pos, target, 4000, (t) => this.canEnterTile(t), (k) => this.stepCostByKey(k));
        path = found ? found.slice(1) : [];
        this.entityPaths.set(unitId, path);
      }
      if (path.length === 0) continue;

      const next = path.shift()!;
      const started = entity.tryStep(next, this.stepCost(next.q, next.r));
      if (started) this.ws.stepUnit(unitId, next.q, next.r);
      else this.entityPaths.set(unitId, []); // couldn't move there — recompute a fresh target next idle tick
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
    if (ids.length === 0) { this.setSingleSelection(null); this.refreshUnitPanel(); return; }
    const curIdx = this.selectedUnitId ? ids.indexOf(this.selectedUnitId) : -1;
    const nextIdx = curIdx + 1;
    this.setSingleSelection(nextIdx < ids.length ? ids[nextIdx] : null);
    this.selectedBuildingKey = null;
    this.refreshUnitPanel();
    this.refreshBuildingPanel();
  }

  /** Sets a single selected unit (or clears selection entirely with null), keeping selectedUnitIds
   *  in sync — the single source of truth for "select just this one thing" used throughout, as
   *  opposed to finishBoxSelect which populates a real multi-unit group. */
  private setSingleSelection(id: string | null) {
    this.selectedUnitId = id;
    this.selectedUnitIds = new Set(id ? [id] : []);
  }

  private activeKey(): string {
    return this.selectedUnitId ?? SELF_KEY;
  }

  private activeEntity(): Player {
    if (this.selectedUnitId) {
      const u = this.units.get(this.selectedUnitId);
      if (u) return u;
    }
    return this.player;
  }

  /** Mirrors the server's race-based relation floors (Orc always at war, Elf always open borders) on top of
   *  explicit relations_update messages, so movement prediction matches what the server will actually allow. */
  private getRelationTo(otherId: string): RelationStatus {
    const otherRace = this.lastPlayers.find(p => p.id === otherId)?.race;
    if (this.myRace === "Orc" || otherRace === "Orc") return "war";
    const stored = this.relations.get(otherId);
    if (stored) return stored;
    if (this.myRace === "Elf" || otherRace === "Elf") return "open_borders";
    return "neutral";
  }

  /** Mirrors the server's terrain + territory rules for optimistic movement prediction — the server always has final say. */
  private canEnterTile(t: RemoteTile | undefined): boolean {
    const crossable = (claimedBy: RemoteTile["claimedBy"]) => {
      if (!claimedBy || claimedBy.id === this.myId) return true;
      const rel = this.getRelationTo(claimedBy.id);
      return rel === "war" || rel === "open_borders";
    };
    if (t?.kind === "HighMountain" && this.myRace === "Dwarf") {
      // Dwarves can cross HighMountain race-wide (see races.js note on this simplification) — every other check still applies.
      return crossable(t?.claimedBy);
    }
    if (!isPassable(t)) return false;
    return crossable(t?.claimedBy);
  }

  /** How long (ms) a step to (q,r) should visually take — mirrors the server's stepCooldownFor()
   *  so the movement tween matches actual server-enforced pacing instead of a fixed guess. If this
   *  ever drifts from the server's own value, the tween is briefly wrong for one step and self-corrects
   *  next step — the server's own check is what actually gates movement either way. */
  private stepCost(q: number, r: number): number {
    const baseTicks = BASE_TICKS_PER_TILE[this.myRace] ?? 1;
    let ticks = baseTicks;
    if (RACES_WITH_ROADS.has(this.myRace)) {
      const road = this.buildingSprites.get(keyFor(q, r));
      if (road && road.kind === "Road" && road.constructed) {
        ticks = ROAD_SPEED_TICKS[road.level ?? 1] ?? baseTicks;
      }
    }
    // this.stepMillis is "1 tick + a 60ms jitter buffer" (see awaitWelcome) — undo the buffer before
    // scaling by ticks, then add it back exactly once, so the buffer doesn't get multiplied by ticks too.
    const tickDurationMs = Math.max(1, this.stepMillis - 60);
    return ticks * tickDurationMs + 60;
  }

  /** Same as stepCost but taking a "q,r" key — the shape fastestPath's getCost callback expects. */
  private stepCostByKey(k: string): number {
    const [q, r] = k.split(",").map(Number);
    return this.stepCost(q, r);
  }

  /** Shows a brief toast estimating how long a just-queued path will take to walk, summing the same
   *  per-step cost the movement system itself uses (so it reflects roads/race speed accurately). */
  private showPathETA(path: Axial[]) {
    let totalMs = 0;
    for (const step of path) totalMs += this.stepCost(step.q, step.r);
    const seconds = totalMs / 1000;
    const label = seconds < 1 ? "<1s" : `~${seconds.toFixed(1)}s`;
    this.toasts?.show({ id: "path-eta", title: "Route queued", body: `${path.length} tile${path.length === 1 ? "" : "s"} · ETA ${label}`, autoDismissMs: 2500 });
  }

  /** Redraws the currently-selected entity's queued movement path as a line across the tiles it's
   *  heading through, with a small dot at each waypoint — called every frame so it always reflects
   *  the live path regardless of which of the many places mutates it (queueing, stepping, rejection). */
  private updatePathIndicator() {
    this.pathIndicator.clear();
    const path = this.entityPaths.get(this.activeKey());
    if (!path || path.length === 0) return;

    const entity = this.activeEntity();
    const start = entity.state.kind === "idle" ? entity.state.at : entity.state.to;
    const startPx = axialToPixel(start, this.hexSize);
    this.pathIndicator.moveTo(startPx.x, startPx.y);
    for (const p of path) {
      const px = axialToPixel(p, this.hexSize);
      this.pathIndicator.lineTo(px.x, px.y);
    }
    this.pathIndicator.stroke({ color: 0x7fd4ff, width: 3, alpha: 0.7 });
    for (const p of path) {
      const px = axialToPixel(p, this.hexSize);
      this.pathIndicator.circle(px.x, px.y, 3).fill({ color: 0x7fd4ff, alpha: 0.9 });
    }
  }

  private tryStepEntity(key: string, entity: Player, q: number, r: number): boolean {
    const vis = this.fow.state(q, r);
    if (vis === "hidden") return false;
    const tile = this.tiles.get(keyFor(q, r));
    if (!tile || !this.canEnterTile(tile)) return false;
    const started = entity.tryStep({ q, r }, this.stepCost(q, r));
    if (started) {
      if (key === SELF_KEY) this.ws.step(q, r);
      else this.ws.stepUnit(key, q, r);
    }
    return started;
  }

  /** Advances one entity's queued path by one step, if it's idle and has one. Used for every entity that
   *  isn't the currently-active one, so switching selection never interrupts a unit's own movement. */
  private advanceEntityQueuedPath(key: string, entity: Player) {
    if (entity.state.kind !== "idle") return;
    const path = this.entityPaths.get(key);
    if (!path || path.length === 0) return;
    const next = path.shift()!;
    if (!this.tryStepEntity(key, entity, next.q, next.r)) this.entityPaths.set(key, []);
  }

  private tryStepVisible(q: number, r: number): boolean {
    return this.tryStepEntity(this.activeKey(), this.activeEntity(), q, r);
  }

  private updateGhost(q: number, r: number) {
    if (!this.buildKind) { this.ghost.visible = false; this.roadPreview.clear(); return; }
    const tile = this.tiles.get(keyFor(q, r));
    let nearRequirement: boolean;
    if (this.buildKind === "TownHall") {
      nearRequirement = this.nearOwnSettler({ q, r });
    } else {
      const builder = this.closestAvailableBuilder({ q, r });
      nearRequirement = !!builder && hexDistance(builder.pos, { q, r }) <= 1;
    }
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

    this.updateRoadPreview(q, r, ok);
  }

  /** Previews the auto-generated road connection a worker building would get if placed here — a
   *  client-side mirror of the server's cheapestRoadPath (existing roads free, everything else
   *  costs 1, restricted to claimed territory), using whatever the client currently knows (fog of
   *  war may leave this incomplete, but the actual connection is server-authoritative regardless —
   *  this is a preview, not a guarantee). Silently shows nothing if this building kind doesn't need
   *  a road, or no connection is found. */
  private updateRoadPreview(q: number, r: number, placementOk: boolean) {
    this.roadPreview.clear();
    if (!placementOk || this.myRace !== "Human" || !this.buildKind || !ROAD_NEEDING_KINDS.has(this.buildKind)) return;

    const nearStorage = new Set<string>();
    const storageGoals: Axial[] = [];
    for (const b of this.buildingSprites.values()) {
      if (b.ownerId !== this.myId || !b.constructed) continue;
      if (b.kind !== "TownHall" && b.kind !== "Warehouse") continue;
      nearStorage.add(keyFor(b.q, b.r));
      storageGoals.push({ q: b.q, r: b.r });
      for (const n of neighbors({ q: b.q, r: b.r })) nearStorage.add(keyFor(n.q, n.r));
    }
    if (storageGoals.length === 0) return;
    if (nearStorage.has(keyFor(q, r))) return; // already adjacent to storage, no road needed

    const path = this.previewCheapestRoadPath({ q, r }, storageGoals);
    if (!path || path.length < 2) return;

    const startPx = axialToPixel(path[0], this.hexSize);
    this.roadPreview.moveTo(startPx.x, startPx.y);
    for (let i = 1; i < path.length; i++) {
      const { x: px, y: py } = axialToPixel(path[i], this.hexSize);
      this.roadPreview.lineTo(px, py);
    }
    this.roadPreview.stroke({ color: 0xd9a86c, width: 4, alpha: 0.75 });
    for (const p of path) {
      const { x: px, y: py } = axialToPixel(p, this.hexSize);
      this.roadPreview.circle(px, py, 3).fill({ color: 0xd9a86c, alpha: 0.9 });
    }
  }

  /** Client-side mirror of the server's civilians.js cheapestRoadPath — small weighted Dijkstra,
   *  existing roads cost 0 (free reuse), everything else costs 1, restricted to claimed territory.
   *  Preview only; the server computes the real connection independently when the building is
   *  actually placed. */
  private previewCheapestRoadPath(start: Axial, goals: Axial[]): Axial[] | null {
    const goalKeys = new Set(goals.map((g) => keyFor(g.q, g.r)));
    const startK = keyFor(start.q, start.r);
    if (goalKeys.has(startK)) return [start];
    const dist = new Map<string, number>([[startK, 0]]);
    const parent = new Map<string, string>();
    const posOf = new Map<string, Axial>([[startK, start]]);
    const frontier: { k: string; d: number }[] = [{ k: startK, d: 0 }];
    let nodes = 0;

    while (frontier.length && nodes++ < 400) {
      frontier.sort((a, b) => a.d - b.d);
      const cur = frontier.shift()!;
      if (cur.d > (dist.get(cur.k) ?? Infinity)) continue;
      if (goalKeys.has(cur.k)) {
        const path = [posOf.get(cur.k)!];
        let k = cur.k;
        while (k !== startK) { const p = parent.get(k)!; path.push(posOf.get(p)!); k = p; }
        return path.reverse();
      }
      const curPos = posOf.get(cur.k)!;
      for (const n of neighbors(curPos)) {
        const nk = keyFor(n.q, n.r);
        const isGoal = goalKeys.has(nk);
        const tile = this.tiles.get(nk);
        if (!isGoal && !this.canEnterTile(tile)) continue;
        if (!isGoal && tile?.claimedBy?.id !== this.myId) continue;
        const occupant = this.buildingSprites.get(nk);
        const isExistingRoad = !!(occupant && occupant.kind === "Road" && occupant.ownerId === this.myId);
        if (occupant && !isExistingRoad && !isGoal) continue;
        const stepCost = isExistingRoad ? 0 : 1;
        const nd = cur.d + stepCost;
        if (nd < (dist.get(nk) ?? Infinity)) {
          dist.set(nk, nd);
          parent.set(nk, cur.k);
          posOf.set(nk, n);
          frontier.push({ k: nk, d: nd });
        }
      }
    }
    return null;
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

  private worldToScreen(worldX: number, worldY: number) {
    const r = this.mapRenderer!.container;
    return { x: worldX * r.scale.x + r.x, y: worldY * r.scale.x + r.y };
  }

  /** Populates the selection group from every one of the player's own (non-Civilian — they can't be
   *  manually moved anyway) units whose screen position falls within the dragged box. Sets
   *  selectedUnitId to one of them (for HUD/ability display) while selectedUnitIds holds the whole
   *  group that a subsequent move command will apply to. */
  private finishBoxSelect(x1: number, y1: number, x2: number, y2: number) {
    if (!this.mapRenderer) return;
    const left = Math.min(x1, x2), right = Math.max(x1, x2);
    const top = Math.min(y1, y2), bottom = Math.max(y1, y2);

    const found: string[] = [];
    for (const [id, entity] of this.units) {
      if (this.unitKinds.get(id) === "Civilian") continue;
      const screen = this.worldToScreen(entity.container.x, entity.container.y);
      if (screen.x >= left && screen.x <= right && screen.y >= top && screen.y <= bottom) found.push(id);
    }

    if (found.length === 0) return; // an empty box shouldn't clear an existing selection
    this.selectedUnitIds = new Set(found);
    this.selectedUnitId = found[0];
    this.selectedBuildingKey = null;
    this.refreshUnitPanel();
    this.refreshBuildingPanel();
  }

  /** Computes and queues a path to `target` for one entity — shared by single-unit right-click
   *  movement and the multi-unit group case, so both always agree on pathfinding/queueing rules.
   *  Only shows the path-ETA overlay for the primary selection, so a large group move doesn't
   *  paper the screen with overlapping ETA labels. */
  private queueMoveFor(entityKey: string, entity: Player, target: Axial, shiftQueue: boolean) {
    const existingPath = this.entityPaths.get(entityKey) ?? [];
    const queueing = shiftQueue && existingPath.length > 0;
    const from = queueing
      ? existingPath[existingPath.length - 1]
      : ((entity.state.kind === "idle") ? entity.state.at : entity.state.to);
    const path = fastestPath((k) => this.tiles.get(k), from, target, 4000, (t) => this.canEnterTile(t), (k) => this.stepCostByKey(k));
    if (path && path.length > 1) {
      const fullPath = queueing ? [...existingPath, ...path.slice(1)] : path.slice(1);
      this.entityPaths.set(entityKey, fullPath);
      if (entityKey === this.activeKey()) this.showPathETA(fullPath);
    }
  }

  /** The action for whatever's currently selected — move, attack an enemy in range, or assign a
   *  selected Civilian to a building. Shift queues onto an existing path instead of replacing it.
   *  Triggered from pointerup rather than contextmenu — see the setup comment where it's wired. */
  private performRightClickAction(clientX: number, clientY: number, shiftKey: boolean) {
    const world = this.screenToWorld(clientX, clientY);
    const target = pixelToAxial(world.x, world.y, this.hexSize);
    const tile = this.tiles.get(keyFor(target.q, target.r));
    const vis = this.fow.state(target.q, target.r);

    // Right-click is also the natural "cancel" gesture for a pending build/convert placement.
    if (this.convertTileMode || this.buildKind || this.pendingBuildPlacement) {
      this.convertTileMode = null;
      this.buildKind = null;
      this.pendingBuildPlacement = null;
      this.ghost.visible = false;
      return;
    }

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
          this.sound.playSfx(kind === "Archer" ? "attack_archer" : "attack_soldier");
          soldier.playAttackFlash();
          return;
        }
      }
    }

    const selectedKind = this.selectedUnitId ? this.unitKinds.get(this.selectedUnitId) : null;
    const building = this.buildingSprites.get(keyFor(target.q, target.r));
    if (building && building.ownerId === this.myId && selectedKind === "Civilian" && !CIVILIAN_ASSIGN_EXEMPT.has(building.kind)) {
      this.ws.assignCivilian(this.selectedUnitId!, target.q, target.r);
      return;
    }

    if (!tile || vis === "hidden") return;
    if (selectedKind === "Civilian") return; // Civilians are automatically driven — assign them to a building instead of walking them

    if (this.selectedUnitIds.size > 1) {
      // Move every selected unit to the same target, each pathfinding from its own position.
      for (const id of this.selectedUnitIds) {
        const entity = this.units.get(id);
        if (!entity || this.unitKinds.get(id) === "Civilian") continue;
        this.queueMoveFor(id, entity, target, shiftKey);
      }
      return;
    }
    this.queueMoveFor(this.activeKey(), this.activeEntity(), target, shiftKey);
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
      buildingUnlockOptions: (BUILDING_UNLOCK_RESEARCH[this.myRace]?.[b.kind] ?? null),
      unlockedBuildings: this.myBuildingUnlocks,
      roadLevel: b.kind === "Road" ? (b.level ?? 1) : null,
      canUpgradeHouse: b.kind === "House" && b.constructed && !b.level2 && this.myRace === "Human" && this.myResearch.has("urban_planning"),
      houseResidents: b.kind === "House" ? this.computeHouseResidents(b.id) : null,
      gatheringLevel: GATHERING_KINDS.has(b.kind) ? (b.level ?? 1) : null,
      canUpgradeGathering: this.canUpgradeGatheringBuilding(b),
      canConvertTiles: GATHERING_KINDS.has(b.kind) && (b.level ?? 1) >= 3 && (b.workers ?? 0) >= 5,
      warehouseLevel: b.kind === "Warehouse" ? (b.level ?? 1) : null,
      canUpgradeWarehouse: b.kind === "Warehouse" && b.constructed && (b.level ?? 1) < 3 && this.myRace === "Human",
      workers: (GATHERING_KINDS.has(b.kind) || b.kind === "Warehouse" || b.kind === "TownHall") ? (b.workers ?? 0) : null,
      maxWorkers: (GATHERING_KINDS.has(b.kind) || b.kind === "Warehouse" || b.kind === "TownHall") ? maxWorkersFor(b.kind, b.level) : null,
      canAssignWorker: this.myRace === "Human" && b.constructed && !CIVILIAN_ASSIGN_EXEMPT.has(b.kind) && (b.workers ?? 0) < maxWorkersFor(b.kind, b.level),
      canUnassignWorker: this.myRace === "Human" && !CIVILIAN_ASSIGN_EXEMPT.has(b.kind) && (b.workers ?? 0) > 0,
      inventory: this.computeInventoryDisplay(b),
      trainQueue: this.computeTrainQueueDisplay(b),
    };
    refreshBuildingHUD(this.bld, info);
  }

  /** Whether this building kind trains anything at all (is the target of some unit's
   *  TRAINING_BUILDING mapping), and if so, its current queue — always returns [] (not null) for a
   *  training-capable building with nothing queued, so the panel can show "empty" instead of hiding
   *  the section entirely. */
  private computeTrainQueueDisplay(b: RemoteBuilding): { kind: string; ticksRemaining: number; totalTicks: number }[] | null {
    const trainsHere = Object.values(TRAINING_BUILDING).includes(b.kind) || b.kind === "Garrison";
    if (!trainsHere) return null;
    return (b.trainQueue ?? []).map(item => ({ kind: item.kind, ticksRemaining: item.ticksRemaining, totalTicks: item.totalTicks }));
  }

  /** Whichever resource (if any) this building's inventory currently holds, ready for a Civilian's
   *  delivery run or an explicit manual Collect — Human only, mirrors the server's "first resource
   *  kind with a positive amount" pick (a gathering building only ever holds one kind at a time).
   *  Always returns a value (amount 0 if empty or not yet gathered anything) for any building kind
   *  that has an inventory concept at all, so the panel can show "Empty" instead of hiding the line. */
  private computeInventoryDisplay(b: RemoteBuilding): { kind: string; amount: number; cap: number }[] | null {
    if (this.myRace !== "Human") return null;

    if (GATHERING_KINDS.has(b.kind)) {
      // A gathering building only ever holds ONE resource kind at a time — show whichever one
      // currently has stock (with its capacity, so free room is visible), or nothing yet.
      if (b.inventory) {
        for (const kind of ["Wood", "Stone", "Bread", "Fish", "Gold"] as const) {
          const amount = b.inventory[kind] ?? 0;
          if (amount > 0) return [{ kind, amount, cap: GATHERING_BUILDING_CAP }];
        }
      }
      return [];
    }

    if (b.kind === "Warehouse" || b.kind === "TownHall") {
      // A storage building can hold every resource kind simultaneously — show all of them (even at
      // 0) so free capacity per resource is always visible, not just whichever one happens to be
      // non-empty right now.
      const cap = b.kind === "TownHall" ? TOWNHALL_STORAGE_CAP : WAREHOUSE_STORAGE_CAP;
      return (["Wood", "Stone", "Bread", "Fish", "Gold"] as const).map((kind) => ({ kind, amount: b.inventory?.[kind] ?? 0, cap }));
    }

    return null;
  }

  /** Whether the next tier's research (if any is needed) is unlocked and the building isn't already maxed. */
  private canUpgradeGatheringBuilding(b: RemoteBuilding): boolean {
    if (!GATHERING_KINDS.has(b.kind) || !b.constructed || this.myRace !== "Human") return false;
    const nextLevel = (b.level ?? 1) + 1;
    if (nextLevel > 3) return false;
    const requiredResearch = nextLevel === 2 ? "advanced_gathering" : "tile_conversion_tech";
    return this.myResearch.has(requiredResearch);
  }

  /** How many of the player's own Civilians call this House/TownHall home, and how many of those
   *  currently have a job (assignedTo set). Only ever meaningful for the player's own buildings —
   *  civilian home/assignment data for other players isn't something this needs to show anyway. */
  /** What to show as a Civilian's floating job tag: the race-flavored name of whatever they're
   *  assigned to, or "Idle" if they aren't working anything yet. */
  private civilianJobLabel(u: RemoteUnit): string {
    if (!u.assignedTo) return "Idle";
    const building = [...this.buildingSprites.values()].find(b => b.id === u.assignedTo);
    if (!building) return "Idle";
    return raceDisplay(this.myRace).buildingNames[building.kind] || building.kind;
  }

  /** A Civilian "goes inside" its assigned building — hidden from view — for as long as it's idle
   *  right there gathering/collecting, and only becomes visible again once it actually steps away
   *  to deliver resources or travel somewhere else. Purely visual; doesn't affect anything server-side. */
  private updateCivilianVisibility(id: string, entity: Player) {
    const buildingId = this.unitAssignedTo.get(id);
    if (!buildingId || entity.state.kind !== "idle") { entity.container.visible = true; return; }
    const building = [...this.buildingSprites.values()].find(b => b.id === buildingId);
    const isHome = !!building && entity.pos.q === building.q && entity.pos.r === building.r;
    entity.container.visible = !isHome;
  }

  private computeHouseResidents(houseId: string): { living: number; employed: number } {
    let living = 0, employed = 0;
    for (const u of this.lastUnits) {
      if (u.kind !== "Civilian" || u.ownerId !== this.myId || u.homeBuildingId !== houseId) continue;
      living++;
      if (u.assignedTo) employed++;
    }
    return { living, employed };
  }

  private tryCollectSelected() {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b) return;
    this.ws.collectResources(null, b.q, b.r); // null = collect with the player character, matching the server's contract
  }

  private tryAssignWorker() {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b) return;
    this.ws.assignNearestWorker(b.q, b.r);
  }

  private tryUnassignWorker() {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b) return;
    this.ws.unassignWorker(b.q, b.r);
  }

  private tryForage() {
    if (!this.selectedUnitId) return;
    this.ws.forage(this.selectedUnitId);
  }

  private toggleInGameMenu() {
    if (this.inGameMenu) {
      this.inGameMenu.close();
      this.inGameMenu = null;
      return;
    }
    this.inGameMenu = new InGameMenu(this.rootEl, () => {
      this.ws.surrender();
      this.inGameMenu?.close();
      this.inGameMenu = null;
    });
  }

  private tryCancelTraining(index: number) {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b) return;
    this.ws.cancelTraining(b.q, b.r, index);
  }

  private tryResearch(optionId: string) {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b || b.kind !== "Research") return;
    this.ws.research(optionId);
  }

  private tryResearchBuilding(optionId: string) {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b) return;
    this.ws.researchBuilding(b.q, b.r, optionId);
  }

  private tryUpgradeRoad() {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b || b.kind !== "Road") return;
    this.ws.upgradeRoad(b.q, b.r);
  }

  private tryUpgradeHouse() {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b || b.kind !== "House") return;
    this.ws.upgradeHouse(b.q, b.r);
  }

  private tryUpgradeGathering() {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b || !GATHERING_KINDS.has(b.kind)) return;
    this.ws.upgradeGatheringBuilding(b.q, b.r);
  }

  private tryUpgradeWarehouse() {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b || b.kind !== "Warehouse") return;
    this.ws.upgradeWarehouse(b.q, b.r);
  }

  /** Enters "click a nearby tile to convert it" mode for the currently-selected level-3 gathering
   *  building. The next tile click (within range) sends the conversion request instead of moving. */
  private startConvertTileMode() {
    if (!this.selectedBuildingKey) return;
    const b = this.buildingSprites.get(this.selectedBuildingKey);
    if (!b || !GATHERING_KINDS.has(b.kind)) return;
    this.convertTileMode = { buildingQ: b.q, buildingR: b.r };
    this.toasts?.show({ id: "convert-tile-mode", title: "Convert Tile", body: "Click a nearby tile to convert it, or press Escape to cancel.", autoDismissMs: 4000 });
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
    if (b) this.redrawRoadConnections();
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
    if (this.mapRevealed) {
      const allKnown = new Set(this.tiles.keys());
      this.mapRenderer!.setAlphaByFog(new Set(), allKnown); // nothing hidden, everything counted as seen
      this.buildings.setAlphaForHidden(new Set(), allKnown);
      return;
    }
    const hidden = new Set<string>();
    for (const k of this.fow.seen) {
      if (this.fow.visible.has(k)) continue;
      hidden.add(k);
    }
    this.mapRenderer!.setAlphaByFog(hidden, this.fow.seen);
    this.buildings.setAlphaForHidden(hidden, this.fow.seen);
  }

  private readDirection(keys: Set<string>) {
    const kb = this.keybindings;
    const left   = keys.has("ArrowLeft")  || keys.has(kb.moveLeft.toLowerCase());
    const right  = keys.has("ArrowRight") || keys.has(kb.moveRight.toLowerCase());
    const up     = keys.has("ArrowUp")    || keys.has(kb.moveUp.toLowerCase());
    const down   = keys.has("ArrowDown")  || keys.has(kb.moveDown.toLowerCase());
    const qKey   = keys.has(kb.moveDownLeft.toLowerCase());
    const eKey   = keys.has(kb.moveUpRight.toLowerCase());
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
    this.sound.stopAll();
    if (this.app) { this.app.destroy(true); this.app = null; }
    this.mapRenderer = null!;
  }
}
