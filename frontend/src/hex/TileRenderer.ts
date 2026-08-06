// src/hex/TileRenderer.ts
import * as PIXI from "pixi.js";
import { axialToPixel } from "./HexMath";
import { key, type Tile } from "./types";
import { key as tileKey } from "./types";
import type { RemoteTile } from "../net";

const TILE_KINDS: Tile["kind"][] = ["Grass", "Stone", "Water", "Fields", "Snow", "Forest", "Bridge", "HighMountain"];

/** Purely-visual, doesn't touch tile.kind or any real game logic — just picks a different overlay tint. */
export type TileVisualContext = {
  hasBuilding?: boolean;   // something is built here — "cleared/developed ground" tint
  scorched?: boolean;      // claimed by an Undead player — ashen "blighted" tint
  minedAdjacent?: boolean; // locked by an adjacent Dwarf Mine — "quarried" tint
};

function colorFor(kind: Tile["kind"]) {
  switch (kind) {
    case "Grass": return 0x3e7e2c;
    case "Stone": return 0x7d7d7d;
    case "Water": return 0x1a3e8a;
    case "Fields": return 0xcaa75c;
    case "Snow": return 0xdfe7ee;
    case "Forest": return 0x27531b;
    case "Bridge": return 0x6b4b2a;
    case "HighMountain": return 0xb8c4d0;
  }
}

function hexPoints(size: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(size * Math.cos(a), size * Math.sin(a));
  }
  return pts;
}

/**
 * Renders whatever tiles the server has actually told us about — it no
 * longer generates or owns terrain data itself. Every tile we've ever been
 * shown stays rendered forever (dimmed once out of current vision by fog
 * alpha) — there is no distance-based culling. That's a deliberate choice:
 * "already explored" should never disappear just because you walked away.
 * The tradeoff is memory/draw-call growth over a very long single session,
 * which is fine at the scale this game runs at.
 *
 * Textures are entirely optional: call loadTextures() once before the
 * first syncAll(). It looks for /tiles/<kind-lowercase>.png for each
 * terrain kind (e.g. /tiles/grass.png) — drop PNGs at those paths in
 * frontend/public/tiles/ and they're used automatically, masked to the
 * hex shape. Any terrain kind without an image just keeps the existing
 * flat-color rendering — nothing breaks if you don't supply any.
 */
export class TileRenderer {
  container = new PIXI.Container();
  private tileLayer = new PIXI.Container(); // always the bottom layer, regardless of when tiles are added
  private cache = new Map<string, PIXI.Container>(); // one wrapper per tile, so alpha/visibility toggles work uniformly either way
  private textures = new Map<string, PIXI.Texture>(); // terrain kind -> loaded texture, only for kinds that had an image to load
  hover = new PIXI.Graphics();
  private centered = false;

  constructor(private hexSize: number) {
    this.container.addChild(this.tileLayer);
    this.hover.visible = false;
    this.container.addChild(this.hover);
  }

  /** Best-effort: loads a texture per terrain kind if one exists at /tiles/<kind>.png. Safe to call even if none exist. */
  async loadTextures() {
    await Promise.all(TILE_KINDS.map(async (kind) => {
      try {
        const texture = await PIXI.Assets.load(`/tiles/${kind.toLowerCase()}.png`);
        this.textures.set(kind, texture);
      } catch { /* no image provided for this terrain kind — flat-color fallback, unchanged from before */ }
    }));
  }

  setAlphaByFog(hiddenSet: Set<string>, seenSet: Set<string>) {
    for (const [k, wrapper] of this.cache) {
      if (!seenSet.has(k)) { wrapper.visible = false; continue; }
      wrapper.visible = true;
      wrapper.alpha = hiddenSet.has(k) ? 0.25 : 1;
    }
  }

  tileId(q: number, r: number) { return tileKey(q, r); }

  /** Materializes every tile the client currently has data for. No culling — call this whenever new tiles arrive.
   *  `context` supplies purely-visual info the tile itself doesn't carry: is something built here, is it
   *  scorched-earth-claimed, is it locked by an adjacent Dwarf Mine. None of this changes tile.kind or any
   *  real game logic — it only picks a different overlay tint on top of the same terrain rendering. */
  syncAll(getAllTiles: () => IterableIterator<[string, RemoteTile]>, context?: (t: RemoteTile) => TileVisualContext) {
    for (const [k, t] of getAllTiles()) {
      if (this.cache.has(k)) continue;

      const wrapper = new PIXI.Container();
      const { x, y } = axialToPixel(t, this.hexSize);
      wrapper.x = x; wrapper.y = y;
      this.drawTile(wrapper, t, context?.(t) ?? {});
      this.tileLayer.addChild(wrapper);
      this.cache.set(k, wrapper);
    }

    if (!this.centered && this.cache.size > 0) {
      const b = this.container.getLocalBounds();
      this.container.x = -b.x + (globalThis.innerWidth || 1600) / 2 - b.width / 2;
      this.container.y = -b.y + (globalThis.innerHeight || 900) / 2 - b.height / 2;
      this.centered = true;
    }
  }

  /** Redraw a tile that's already on screen (e.g. a bridge just got built, or it just got claimed) without waiting for it to re-enter view. */
  refreshTile(t: RemoteTile, ctx: TileVisualContext = {}) {
    const wrapper = this.cache.get(key(t.q, t.r));
    if (!wrapper) return;
    // Properly destroy the old children (not just detach) — this tile gets refreshed constantly while its
    // resource is being gathered, so leaving textures/masks undestroyed here would leak GPU resources fast.
    while (wrapper.children.length > 0) {
      const child = wrapper.children[0];
      if (child instanceof PIXI.Sprite) child.mask = null;
      wrapper.removeChild(child);
      child.destroy();
    }
    this.drawTile(wrapper, t, ctx);
  }

  highlight(q: number, r: number, color = 0xffffff) {
    const { hexSize } = this;
    const { x, y } = axialToPixel({ q, r }, hexSize);
    this.hover.clear();
    this.hover.x = x; this.hover.y = y;
    this.hover.poly(hexPoints(hexSize + 1.5)).stroke({ color, width: 2, alpha: 0.9 });
    this.hover.visible = true;
  }

  hideHighlight() { this.hover.visible = false; }

  /** Draws one tile's fill (textured if available, else flat color), claim border, and any hybrid-state overlay tint. */
  private drawTile(wrapper: PIXI.Container, t: RemoteTile, ctx: TileVisualContext) {
    const texture = this.textures.get(t.kind);
    if (texture) {
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0.5);
      // Pointy-top hex bounding box: width = size*sqrt(3), height = size*2 — sized to this rather than a
      // square so the mask below clips a proportionally-correct crop of the source image.
      sprite.width = this.hexSize * Math.sqrt(3);
      sprite.height = this.hexSize * 2;

      const mask = new PIXI.Graphics().poly(hexPoints(this.hexSize)).fill(0xffffff);
      wrapper.addChild(sprite, mask);
      sprite.mask = mask;

      // A faint hex-edge line on top keeps individual tiles readable even with a busy texture.
      const edge = new PIXI.Graphics();
      edge.poly(hexPoints(this.hexSize)).stroke({ color: 0x000000, width: 1, alpha: 0.18 });
      wrapper.addChild(edge);
    } else {
      const g = new PIXI.Graphics();
      g.poly(hexPoints(this.hexSize)).fill(colorFor(t.kind)).stroke({ color: 0x000000, width: 1, alpha: 0.25 });
      wrapper.addChild(g);
    }

    // Hybrid-state overlays — layered fill tints, no separate texture files needed. If more than one applies,
    // scorched earth wins visually (most gameplay-significant: it's actively damaging you to stand there).
    if (ctx.scorched) {
      const overlay = new PIXI.Graphics();
      overlay.poly(hexPoints(this.hexSize)).fill({ color: 0x8b0000, alpha: 0.32 });
      wrapper.addChild(overlay);
    } else if (ctx.hasBuilding) {
      const overlay = new PIXI.Graphics();
      overlay.poly(hexPoints(this.hexSize)).fill({ color: 0x000000, alpha: 0.22 });
      wrapper.addChild(overlay);
    } else if (ctx.minedAdjacent) {
      const overlay = new PIXI.Graphics();
      overlay.poly(hexPoints(this.hexSize)).fill({ color: 0x5a4522, alpha: 0.28 });
      wrapper.addChild(overlay);
    }

    if (t.claimedBy) {
      const outline = new PIXI.Graphics();
      outline.poly(hexPoints(this.hexSize * 0.86)).stroke({ color: t.claimedBy.color, width: 2.5, alpha: 0.85 });
      wrapper.addChild(outline);
    }
  }
}