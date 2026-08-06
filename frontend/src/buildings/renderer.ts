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
        this.container.removeChild(existing.node);
        existing.node.destroy();
        this.sprites.delete(id);
      } else {
        return;
      }
    }

    const { x, y } = axialToPixel({ q: b.q, r: b.r }, this.hexSize);
    const node = isConstructed ? this.buildFinishedNode(b) : this.buildMarkerNode();
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

  private buildMarkerNode(): PIXI.Container {
    const s = this.hexSize * 0.35;
    const g = new PIXI.Graphics();
    g.circle(0, 0, s).fill({ color: CONSTRUCTION_MARKER_COLOR, alpha: 0.85 }).stroke({ color: 0x000000, width: 2, alpha: 0.5 });
    return g;
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