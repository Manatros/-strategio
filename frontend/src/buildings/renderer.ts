// src/buildings/renderer.ts
import * as PIXI from "pixi.js";
import type { Building, BuildingKind } from "./types";
import { axialToPixel } from "../hex/HexMath";

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
};

const CONSTRUCTION_MARKER_COLOR = 0xffd23f;

type Entry = { node: PIXI.Container; constructed: boolean };

export class BuildingRenderer {
  container = new PIXI.Container();
  private sprites = new Map<string, Entry>();
  private textures = new Map<BuildingKind, PIXI.Texture>();
  private loaded = false;

  constructor(private hexSize: number) {}

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

    const existing = this.sprites.get(id);
    if (existing) {
      if (!existing.constructed && isConstructed) {
        // Construction just finished — swap the fill marker for the real icon.
        this.container.removeChild(existing.node);
        existing.node.destroy();
        this.sprites.delete(id);
      } else if (!existing.constructed && !isConstructed) {
        // Still under construction — redraw the fill to match the current hp.
        this.drawMarkerFill(existing.node as PIXI.Graphics, b);
        return;
      } else {
        return; // already finished, nothing to update
      }
    }

    const { x, y } = axialToPixel({ q: b.q, r: b.r }, this.hexSize);
    const node = isConstructed ? this.buildFinishedNode(b) : this.buildMarkerNode(b);
    node.x = x;
    node.y = y;
    this.container.addChild(node);
    this.sprites.set(id, { node, constructed: isConstructed });
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
    this.sprites.delete(id);
  }

  setAlphaForHidden(hiddenSet: Set<string>, seenSet: Set<string>) {
    for (const [id, entry] of this.sprites) {
      if (!seenSet.has(id)) { entry.node.visible = false; continue; }
      entry.node.visible = true;
      entry.node.alpha = hiddenSet.has(id) ? 0.35 : 1;
    }
  }
}