// src/buildings/renderer.ts
import * as PIXI from "pixi.js";
import type { Building, BuildingKind } from "./types";
import { axialToPixel } from "../hex/HexMath";
import { GATHERING_BUILDING_CAP } from "../core/balance";

const GATHERING_KINDS = new Set<BuildingKind>(["Lumberjack", "Farm", "Mine", "FishingBoat"]);
const RESOURCE_KEYS = ["Wood", "Stone", "Bread", "Fish", "Gold"] as const;

const ICON_URLS: Record<BuildingKind, string> = {
  TownHall:    "/buildings/townhall.png",
  House:       "/buildings/house.png",
  Lumberjack:  "/buildings/lumberjack.png",
  Farm:        "/buildings/farm.png",
  Mine:        "/buildings/mine.png",
  FishingBoat: "/buildings/fishingboat.png",
  Bridge:      "/buildings/bridge.png",
  Garrison:    "/buildings/garrison.png",
  ArcherTower: "/buildings/archertower.png",
  Research:    "/buildings/research.png",
  Warehouse:   "/buildings/warehouse.png",
  Outpost:     "/buildings/outpost.png",
  Church:      "/buildings/church.png",
  Road:        "/buildings/road.png",
  Monastery:   "/buildings/monastery.png",
};

const FALLBACK_COLORS: Record<BuildingKind, number> = {
  TownHall:    0xffc857,
  House:       0xb08968,
  Lumberjack:  0x2a9d8f,
  Farm:        0xe9c46a,
  Mine:        0x7d7d7d,
  FishingBoat: 0x1a8ae0,
  Bridge:      0x6b4b2a,
  Garrison:    0x7a1f1f,
  ArcherTower: 0x4a3f7a,
  Research:    0x1b998b,
  Warehouse:   0x8d6e63,
  Outpost:     0x5c8a3a,
  Church:      0xd4c5a3,
  Road:        0x8a7d6b,
  Monastery:   0xf0e6c8,
};

const CONSTRUCTION_MARKER_COLOR = 0xffd23f;

type Entry = { node: PIXI.Container; healthBar: PIXI.Graphics; gatherBar: PIXI.Graphics; constructed: boolean };

export class BuildingRenderer {
  container = new PIXI.Container();
  private sprites = new Map<string, Entry>();
  private textures = new Map<BuildingKind, PIXI.Texture>();
  private loaded = false;
  private roadLines = new PIXI.Graphics(); // drawn beneath everything else, so road/building icons sit on top

  constructor(private hexSize: number) {
    this.container.addChildAt(this.roadLines, 0);
  }

  async loadTextures(urls: Record<BuildingKind, string> = ICON_URLS): Promise<void> {
    await Promise.all(
      (Object.entries(urls) as [BuildingKind, string][]).map(async ([kind, url]) => {
        try {
          const texture = await PIXI.Assets.load(url);
          this.textures.set(kind, texture);
        } catch { /* falls back to a colored square */ }
      })
    );
    this.loaded = true;
  }

  upsert(b: Building) {
    const id = `${b.q},${b.r}`;
    const isConstructed = b.constructed !== false;
    const { x, y } = axialToPixel({ q: b.q, r: b.r }, this.hexSize);

    const existing = this.sprites.get(id);
    if (existing) {
      if (!existing.constructed && isConstructed) {
        // Construction just finished — swap the fill marker for the real icon, keep the health bar.
        this.container.removeChild(existing.node);
        existing.node.destroy();
        const node = this.buildFinishedNode(b);
        node.x = x; node.y = y;
        this.container.addChild(node);
        this.updateHealthBar(existing.healthBar, b);
        this.updateGatherBar(existing.gatherBar, b);
        this.sprites.set(id, { node, healthBar: existing.healthBar, gatherBar: existing.gatherBar, constructed: true });
      } else if (!existing.constructed && !isConstructed) {
        // Still under construction — redraw the fill to match the current hp.
        this.drawMarkerFill(existing.node as PIXI.Graphics, b);
      } else {
        // Already finished -- this is what actually shows/hides the damage/gather bars as they change.
        this.updateHealthBar(existing.healthBar, b);
        this.updateGatherBar(existing.gatherBar, b);
      }
      return;
    }

    const node = isConstructed ? this.buildFinishedNode(b) : this.buildMarkerNode(b);
    node.x = x;
    node.y = y;
    this.container.addChild(node);

    const healthBar = new PIXI.Graphics();
    healthBar.x = x; healthBar.y = y;
    healthBar.visible = false;
    this.container.addChild(healthBar);
    if (isConstructed) this.updateHealthBar(healthBar, b);

    const gatherBar = new PIXI.Graphics();
    gatherBar.x = x; gatherBar.y = y;
    gatherBar.visible = false;
    this.container.addChild(gatherBar);
    if (isConstructed) this.updateGatherBar(gatherBar, b);

    this.sprites.set(id, { node, healthBar, gatherBar, constructed: isConstructed });
  }

  /**
   * Redraws the visual lines connecting each Road to its adjacent Roads/buildings, so a network of
   * roads reads as a connected path rather than isolated hex tiles sitting next to each other.
   * Only connects tiles under the SAME ownership — a road doesn't visually link to another player's
   * unrelated buildings just because they happen to be adjacent.
   * Takes its own minimal shape (not the Building/RemoteBuilding types) since those disagree on the
   * ownership field name (`owner` vs `ownerId`) — call sites just pass what they actually have.
   */
  redrawRoadConnections(all: { q: number; r: number; kind: BuildingKind; ownerId: string }[]) {
    this.roadLines.clear();
    const byKey = new Map(all.map((b) => [`${b.q},${b.r}`, b]));
    const NEIGHBOR_DIRS = [
      { dq: 1, dr: 0 }, { dq: 1, dr: -1 }, { dq: 0, dr: -1 },
      { dq: -1, dr: 0 }, { dq: -1, dr: 1 }, { dq: 0, dr: 1 },
    ];

    for (const b of all) {
      if (b.kind !== "Road") continue;
      const center = axialToPixel({ q: b.q, r: b.r }, this.hexSize);

      for (const { dq, dr } of NEIGHBOR_DIRS) {
        const n = byKey.get(`${b.q + dq},${b.r + dr}`);
        if (!n || n.ownerId !== b.ownerId) continue;

        // Draw only to the midpoint when connecting to another Road — the neighbor draws its own
        // half too, avoiding a doubled-up overlapping line. A connection to a non-Road building
        // (which never draws its own half) is drawn the full distance from this side alone.
        const nPos = axialToPixel({ q: b.q + dq, r: b.r + dr }, this.hexSize);
        const isRoadToRoad = n.kind === "Road";
        const endX = isRoadToRoad ? (center.x + nPos.x) / 2 : nPos.x;
        const endY = isRoadToRoad ? (center.y + nPos.y) / 2 : nPos.y;
        this.roadLines.moveTo(center.x, center.y).lineTo(endX, endY);
      }
    }
    this.roadLines.stroke({ color: 0x8a7d6b, width: 4, alpha: 0.7 });
  }

  /** Redraws a building's floating health bar — hidden entirely at full HP, same as units. */
  private updateHealthBar(bar: PIXI.Graphics, b: Building) {
    bar.clear();
    const maxHp = b.maxHp ?? 0;
    const hp = b.hp ?? maxHp;
    if (maxHp <= 0 || hp >= maxHp) { bar.visible = false; return; }
    bar.visible = true;

    const w = this.hexSize * 1.3;
    const h = 4;
    const yOff = -this.hexSize * 0.95;
    const frac = Math.max(0, Math.min(1, hp / maxHp));
    const color = frac > 0.5 ? 0x4caf50 : frac > 0.25 ? 0xff9800 : 0xe53935;
    bar.rect(-w / 2, yOff, w, h).fill({ color: 0x000000, alpha: 0.6 });
    bar.rect(-w / 2, yOff, w * frac, h).fill(color);
  }

  /** Redraws a gathering building's progress bar — how full its own inventory is toward
   *  GATHERING_BUILDING_CAP, i.e. how close it is to needing a delivery run. Only shown for
   *  buildings that actually gather (Lumberjack/Farm/Mine/FishingBoat) and are currently staffed;
   *  hidden entirely otherwise (unstaffed, unconstructed, or genuinely empty right now). */
  private updateGatherBar(bar: PIXI.Graphics, b: Building) {
    bar.clear();
    if (!GATHERING_KINDS.has(b.kind) || !b.inventory || !(b.workers ?? 0)) { bar.visible = false; return; }
    const amount = RESOURCE_KEYS.reduce((sum, k) => sum + (b.inventory?.[k] ?? 0), 0);
    if (amount <= 0) { bar.visible = false; return; }
    bar.visible = true;

    const w = this.hexSize * 1.3;
    const h = 4;
    const yOff = this.hexSize * 0.95; // below the building — health bar owns the space above it
    const frac = Math.max(0, Math.min(1, amount / GATHERING_BUILDING_CAP));
    bar.rect(-w / 2, yOff, w, h).fill({ color: 0x000000, alpha: 0.6 });
    bar.rect(-w / 2, yOff, w * frac, h).fill(0x4fc3f7); // a distinct blue, so it's never confused with the (green/orange/red) health bar
  }

  private buildFinishedNode(b: Building): PIXI.Container {
    const texture = this.textures.get(b.kind);
    if (texture) {
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0.5);
      const target = this.hexSize * 1.5;
      const scale = target / Math.max(sprite.texture.width, sprite.texture.height);
      sprite.scale.set(scale);
      return sprite;
    }
    const g = new PIXI.Graphics();
    const s = this.hexSize * 0.45;
    g.rect(-s * 0.6, -s * 0.6, s * 1.2, s * 1.2)
      .fill(FALLBACK_COLORS[b.kind])
      .stroke({ color: 0x000000, width: 2, alpha: 0.4 });
    const marker = new PIXI.Graphics().circle(0, 0, s * 0.25).fill(0x000000);
    marker.alpha = 0.6;
    g.addChild(marker);
    return g;
  }

  private buildMarkerNode(b: Building): PIXI.Container {
    const g = new PIXI.Graphics();
    this.drawMarkerFill(g, b);
    return g;
  }

  /** Draws (or redraws) the radial construction fill — grows clockwise from empty to full as hp climbs from 1 to maxHp. */
  private drawMarkerFill(g: PIXI.Graphics, b: Building) {
    g.clear();
    const s = this.hexSize * 0.4;
    const maxHp = b.maxHp || 1;
    const progress = Math.max(0, Math.min(1, (b.hp ?? 1) / maxHp));

    g.circle(0, 0, s).fill({ color: 0x333333, alpha: 0.5 }).stroke({ color: 0x000000, width: 2, alpha: 0.5 });

    if (progress > 0) {
      const start = -Math.PI / 2;
      const end = start + Math.PI * 2 * progress;
      g.moveTo(0, 0).arc(0, 0, s, start, end).lineTo(0, 0).fill({ color: CONSTRUCTION_MARKER_COLOR, alpha: 0.9 });
    }
  }

  /** Removes a building's rendered node entirely — e.g. destroyed, captured away, or demolished. */
  remove(q: number, r: number) {
    const id = `${q},${r}`;
    const existing = this.sprites.get(id);
    if (!existing) return;
    this.container.removeChild(existing.node);
    existing.node.destroy();
    this.container.removeChild(existing.healthBar);
    existing.healthBar.destroy();
    this.container.removeChild(existing.gatherBar);
    existing.gatherBar.destroy();
    this.sprites.delete(id);
  }

  setAlphaForHidden(hiddenSet: Set<string>, seenSet: Set<string>) {
    for (const [id, entry] of this.sprites) {
      const seen = seenSet.has(id);
      entry.node.visible = seen;
      entry.node.alpha = hiddenSet.has(id) ? 0.35 : 1;
      // Both bars' own base visibility is state-driven (damage / gather progress) — fog can only
      // dim them or force them off entirely when out of vision, never re-show one that shouldn't be up.
      if (!seen) { entry.healthBar.visible = false; entry.gatherBar.visible = false; }
      else {
        entry.healthBar.alpha = hiddenSet.has(id) ? 0.35 : 1;
        entry.gatherBar.alpha = hiddenSet.has(id) ? 0.35 : 1;
      }
    }
  }
}
