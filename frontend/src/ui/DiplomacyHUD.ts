// src/ui/DiplomacyHUD.ts
// Notifications live in Toasts.ts now (always visible, no toggling needed).
// This panel is the "met players + take action" view — hidden by default,
// opened with the D key or the command-bar button, like a Warcraft menu.
import { makeDraggable } from "./draggable";
import type { RelationStatus, ResourceAmounts, ProposalType } from "../net";

export type MetPlayer = { id: string; name: string; tag: string; color: number };

export type DiplomacyRefs = {
  root: HTMLElement;
  panel: HTMLElement;
  playersEl: HTMLElement;
  visible: boolean;
};

const RES_KEYS = ["Wood", "Stone", "Bread", "Fish"] as const;

export function createDiplomacyHUD(
  mount: HTMLElement,
  onAction: (action: "war" | "open_borders" | "trade" | "demand", targetId: string, offer: ResourceAmounts | null, request: ResourceAmounts | null) => void
): DiplomacyRefs {
  const root = document.createElement("div");
  root.className = "hud";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.minWidth = "260px";
  panel.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <strong>Diplomacy</strong>
      <small>(D to toggle)</small>
    </div>
    <div id="dip-players" style="margin-top:6px"><small>Haven't met anyone yet</small></div>
  `;

  root.appendChild(panel);
  mount.appendChild(root);
  makeDraggable(panel, { id: "diplomacy-panel", defaultPos: () => ({ x: window.innerWidth / 2 - 130, y: 60 }) });

  const playersEl = panel.querySelector("#dip-players") as HTMLElement;

  playersEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const action = t.dataset.action as "war" | "open_borders" | "trade" | "demand" | undefined;
    const targetId = t.dataset.targetId;
    if (!action || !targetId) return;

    if (action === "war" || action === "open_borders") {
      onAction(action, targetId, null, null);
      return;
    }
    const row = t.closest(".dip-row") as HTMLElement | null;
    const offerRes = row?.querySelector<HTMLSelectElement>(".offer-res")?.value;
    const offerAmt = Number(row?.querySelector<HTMLInputElement>(".offer-amt")?.value || 0);
    const reqRes = row?.querySelector<HTMLSelectElement>(".req-res")?.value;
    const reqAmt = Number(row?.querySelector<HTMLInputElement>(".req-amt")?.value || 0);
    const offer = action === "trade" && offerRes && offerAmt > 0 ? { [offerRes]: offerAmt } : null;
    const request = reqRes && reqAmt > 0 ? { [reqRes]: reqAmt } : null;
    if (action === "trade" && (!offer || !request)) return;
    if (action === "demand" && !request) return;
    onAction(action, targetId, offer, request);
  });

  const refs: DiplomacyRefs = { root, panel, playersEl, visible: false };
  setDiplomacyVisible(refs, false);
  return refs;
}

export function setDiplomacyVisible(refs: DiplomacyRefs, visible: boolean) {
  refs.visible = visible;
  refs.panel.style.display = visible ? "block" : "none";
}

function resOptions(selected: string) {
  return RES_KEYS.map(k => `<option value="${k}" ${k === selected ? "selected" : ""}>${k}</option>`).join("");
}

export function refreshDiplomacyPlayers(refs: DiplomacyRefs, players: MetPlayer[], relations: Map<string, RelationStatus>) {
  if (!players.length) { refs.playersEl.innerHTML = "<small>Haven't met anyone yet</small>"; return; }
  refs.playersEl.innerHTML = players.map(p => {
    const rel = relations.get(p.id) || "neutral";
    const relLabel = rel === "war" ? "AT WAR" : rel === "open_borders" ? "Open Borders" : "Neutral (borders closed)";
    const swatch = "#" + p.color.toString(16).padStart(6, "0");
    return `
      <div class="dip-row" style="border-bottom:1px solid #222;padding:6px 0">
        <div class="row" style="justify-content:space-between">
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${swatch};margin-right:6px"></span>${escapeHtml(p.name)}<small style="opacity:0.6">#${p.tag}</small></span>
          <small>${relLabel}</small>
        </div>
        <div class="row" style="gap:4px;margin-top:4px;flex-wrap:wrap">
          <button class="btn" data-action="war" data-target-id="${p.id}" ${rel === "war" ? "disabled" : ""}>Declare War</button>
          <button class="btn" data-action="open_borders" data-target-id="${p.id}" ${rel !== "neutral" ? "disabled" : ""}>Open Borders</button>
        </div>
        <div class="row" style="gap:4px;margin-top:4px;align-items:center;flex-wrap:wrap">
          <select class="offer-res">${resOptions("Wood")}</select>
          <input class="offer-amt" type="number" min="0" style="width:50px" placeholder="0" />
          <span>for</span>
          <select class="req-res">${resOptions("Stone")}</select>
          <input class="req-amt" type="number" min="0" style="width:50px" placeholder="0" />
        </div>
        <div class="row" style="gap:4px;margin-top:4px">
          <button class="btn" data-action="trade" data-target-id="${p.id}">Propose Trade</button>
          <button class="btn" data-action="demand" data-target-id="${p.id}">Demand</button>
        </div>
      </div>
    `;
  }).join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}