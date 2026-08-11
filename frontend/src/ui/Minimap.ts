// src/ui/Minimap.ts
import type { RemoteTile } from "../net";

function colorFor(kind: string): string {
  switch (kind) {
    case "Grass": return "#3e7e2c";
    case "Stone": return "#7d7d7d";
    case "Water": return "#1a3e8a";
    case "Fields": return "#caa75c";
    case "Snow": return "#dfe7ee";
    case "Forest": return "#27531b";
    case "Bridge": return "#6b4b2a";
    case "HighMountain": return "#b8c4d0";
    default: return "#333333";
  }
}

/**
 * A top-down scaled view of every tile the player has ever explored (not
 * just what's currently in vision) — consistent with fog memory: once
 * you've seen it, it stays on the map. Draggable to pan, wheel to zoom,
 * and a plain click (not a drag) recenters the main view there.
 */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private lastTransform: { ox: number; oy: number; scale: number } | null = null;

  constructor(container: HTMLElement, private onRecenter?: (q: number, r: number) => void) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 180;
    this.canvas.height = 180;
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.borderRadius = "6px";
    this.canvas.style.cursor = "grab";
    container.innerHTML = "";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.wireInteraction();
  }

  private wireInteraction() {
    let dragging = false, moved = false, lastX = 0, lastY = 0;

    this.canvas.addEventListener("pointerdown", (e) => {
      dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
      this.canvas.style.cursor = "grabbing";
      e.stopPropagation();
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      this.panX += dx; this.panY += dy;
      lastX = e.clientX; lastY = e.clientY;
      e.stopPropagation();
    });
    this.canvas.addEventListener("pointerup", (e) => {
      if (dragging && !moved && this.onRecenter && this.lastTransform) {
        const rect = this.canvas.getBoundingClientRect();
        const cx = (e.clientX - rect.left) * (this.canvas.width / rect.width);
        const cy = (e.clientY - rect.top) * (this.canvas.height / rect.height);
        const { ox, oy, scale } = this.lastTransform;
        const worldY = (cy - oy) / scale;       // = r
        const worldX = (cx - ox) / scale;       // = q + r/2
        this.onRecenter(worldX - worldY / 2, worldY);
      }
      dragging = false;
      this.canvas.style.cursor = "grab";
      e.stopPropagation();
    });
    // Still need window-level pointerup/pointermove for drags that continue past the canvas edge —
    // but only act on them, don't let a canvas-scoped listener plus these double-fire the same event.
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      this.panX += dx; this.panY += dy;
      lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener("pointerup", (e) => {
      if (dragging && !moved && this.onRecenter && this.lastTransform) {
        const rect = this.canvas.getBoundingClientRect();
        const cx = (e.clientX - rect.left) * (this.canvas.width / rect.width);
        const cy = (e.clientY - rect.top) * (this.canvas.height / rect.height);
        const { ox, oy, scale } = this.lastTransform;
        const worldY = (cy - oy) / scale;
        const worldX = (cx - ox) / scale;
        this.onRecenter(worldX - worldY / 2, worldY);
      }
      dragging = false;
      this.canvas.style.cursor = "grab";
    });
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoom = Math.min(4, Math.max(0.5, this.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    }, { passive: false });
  }

  render(
    tiles: Map<string, RemoteTile>,
    self: { q: number; r: number },
    selfColor: number,
    otherPlayers: { q: number; r: number; color: number }[],
    buildings: { q: number; r: number; ownerId: string; color?: number }[]
  ) {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = "#0b0c10";
    ctx.fillRect(0, 0, w, h);
    if (tiles.size === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const t of tiles.values()) {
      const x = t.q + t.r / 2, y = t.r;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min((w - 10) / spanX, (h - 10) / spanY) * this.zoom;
    const ox = w / 2 - ((minX + maxX) / 2) * scale + this.panX;
    const oy = h / 2 - ((minY + maxY) / 2) * scale + this.panY;
    this.lastTransform = { ox, oy, scale };

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    for (const t of tiles.values()) {
      const x = ox + (t.q + t.r / 2) * scale;
      const y = oy + t.r * scale;
      ctx.fillStyle = t.claimedBy ? hex(t.claimedBy.color) : colorFor(t.kind);
      ctx.globalAlpha = t.claimedBy ? 0.9 : 0.7;
      ctx.fillRect(x, y, Math.max(1, scale), Math.max(1, scale));
    }
    ctx.globalAlpha = 1;

    for (const b of buildings) {
      const x = ox + (b.q + b.r / 2) * scale;
      const y = oy + b.r * scale;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }

    for (const p of otherPlayers) {
      const x = ox + (p.q + p.r / 2) * scale;
      const y = oy + p.r * scale;
      ctx.fillStyle = hex(p.color);
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    const sx = ox + (self.q + self.r / 2) * scale;
    const sy = oy + self.r * scale;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    ctx.fillStyle = hex(selfColor);
    ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    ctx.restore();
  }
}

function hex(c: number): string {
  return "#" + c.toString(16).padStart(6, "0");
}
