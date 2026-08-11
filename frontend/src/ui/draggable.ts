// src/ui/draggable.ts
// Makes any HUD panel draggable by mouse/touch, pins it with position:fixed,
// and remembers where the player left it (per element id) across reloads.

const STORAGE_PREFIX = "strategio:hud-pos:";

type Point = { x: number; y: number };

function clampToViewport(x: number, y: number, el: HTMLElement): Point {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const maxX = window.innerWidth - w;
  const maxY = window.innerHeight - h;
  return {
    x: Math.min(Math.max(x, 0), Math.max(maxX, 0)),
    y: Math.min(Math.max(y, 0), Math.max(maxY, 0)),
  };
}

function loadPos(id: string): Point | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.x === "number" && typeof parsed.y === "number") return parsed;
  } catch { /* ignore corrupt/blocked storage */ }
  return null;
}

function savePos(id: string, pos: Point) {
  try { localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(pos)); } catch { /* ignore */ }
}

export type DraggableOptions = {
  /** Unique id used to remember this panel's position. Required. */
  id: string;
  /** Optional handle element to grab by (defaults to the panel itself). */
  handle?: HTMLElement;
  /** Where to place this panel the very first time (before any drag has been saved). Computed after the panel has its natural size. */
  defaultPos?: (el: HTMLElement) => Point;
};

/**
 * Turns `el` into a draggable, position-remembering HUD panel.
 * Clicks on <button>, <input>, <select>, <textarea>, or [data-no-drag]
 * inside the panel still work normally and won't start a drag.
 */
export function makeDraggable(el: HTMLElement, opts: DraggableOptions) {
  const { id } = opts;
  const handle = opts.handle ?? el;

  el.classList.add("draggable-panel");
  handle.classList.add("drag-handle");

  // Take the panel out of flex flow and pin it, restoring any saved spot.
  const rect = el.getBoundingClientRect();
  const fallback = opts.defaultPos ? opts.defaultPos(el) : { x: rect.left, y: rect.top };
  const start = loadPos(id) ?? clampToViewport(fallback.x, fallback.y, el);
  el.style.position = "fixed";
  el.style.left = `${start.x}px`;
  el.style.top = `${start.y}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
  el.style.margin = "0";

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const isInteractive = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest("button, input, select, textarea, [data-no-drag]");
  };

  const onPointerDown = (e: PointerEvent) => {
    if (isInteractive(e.target)) return;
    dragging = true;
    const r = el.getBoundingClientRect();
    offsetX = e.clientX - r.left;
    offsetY = e.clientY - r.top;
    el.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const { x, y } = clampToViewport(e.clientX - offsetX, e.clientY - offsetY, el);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    savePos(id, { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerUp);

  // Keep panels on-screen if the window is resized.
  window.addEventListener("resize", () => {
    const x = parseFloat(el.style.left || "0");
    const y = parseFloat(el.style.top || "0");
    const clamped = clampToViewport(x, y, el);
    el.style.left = `${clamped.x}px`;
    el.style.top = `${clamped.y}px`;
  });
}
