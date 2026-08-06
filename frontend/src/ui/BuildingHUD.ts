// src/ui/BuildingHUD.ts
import { makeDraggable } from "./draggable";
import type { ResearchOption } from "../core/research";

export type SelectedBuildingInfo = {
  kind: string;                     // race-flavored display name
  hp: number;
  maxHp: number;
  constructed: boolean;
  ticksRemaining: number;
  gatherResLeft: number | null;     // null if this building kind doesn't single-tile-gather
  gatherResourceName: string | null;
  researchOptions: ResearchOption[] | null; // non-null only when a constructed Research building is selected
  unlockedResearch: Set<string>;
};

export type BuildingHUDRefs = {
  root: HTMLElement;
  panel: HTMLElement;
  bodyEl: HTMLElement;
  researchEl: HTMLElement;
  demolishBtn: HTMLButtonElement;
};

export function createBuildingHUD(mount: HTMLElement, onDemolish: () => void, onResearch: (optionId: string) => void): BuildingHUDRefs {
  const root = document.createElement("div");
  root.className = "hud";
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.minWidth = "230px";
  panel.innerHTML = `
    <div><strong>Building</strong></div>
    <div id="bld-body" style="margin-top:6px"><small>Select one of your buildings</small></div>
    <div id="bld-research" style="margin-top:6px"></div>
  `;

  const demolishBtn = document.createElement("button");
  demolishBtn.className = "btn";
  demolishBtn.textContent = "Demolish";
  demolishBtn.title = "Refunds half the resources it cost and frees the population it used";
  demolishBtn.style.marginTop = "6px";
  demolishBtn.style.display = "none";
  demolishBtn.onclick = () => onDemolish();
  panel.appendChild(demolishBtn);

  root.appendChild(panel);
  mount.appendChild(root);
  makeDraggable(panel, { id: "building-panel", defaultPos: (el) => ({ x: window.innerWidth / 2 + 10, y: window.innerHeight - el.offsetHeight - 12 }) });

  const researchEl = panel.querySelector("#bld-research") as HTMLElement;
  researchEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const optionId = t.dataset.researchId;
    if (optionId) onResearch(optionId);
  });

  const refs = { root, panel, bodyEl: panel.querySelector("#bld-body") as HTMLElement, researchEl, demolishBtn };
  panel.style.display = "none";
  return refs;
}

export function refreshBuildingHUD(refs: BuildingHUDRefs, info: SelectedBuildingInfo | null) {
  if (!info) {
    refs.panel.style.display = "none";
    return;
  }
  refs.panel.style.display = "block";

  const statusLine = info.constructed
    ? `HP: ${Math.max(0, Math.round(info.hp))}/${info.maxHp}`
    : `Under construction — ${info.ticksRemaining} ticks left`;

  const gatherLine = info.gatherResLeft !== null
    ? `<div>${info.gatherResourceName} left on this tile: <strong>${Math.max(0, Math.round(info.gatherResLeft))}</strong></div>`
    : "";

  refs.bodyEl.innerHTML = `<div><strong>${info.kind}</strong></div><div>${statusLine}</div>${gatherLine}`;
  refs.demolishBtn.style.display = "inline-block";

  if (info.researchOptions && info.constructed) {
    refs.researchEl.innerHTML = `<div style="margin-top:4px"><strong>Research:</strong></div>` + info.researchOptions.map(opt => {
      const done = info.unlockedResearch.has(opt.id);
      const costStr = Object.entries(opt.cost).map(([k, v]) => `${v} ${k}`).join(", ");
      return `
        <div style="border-top:1px solid #222;padding:4px 0">
          <div><strong>${opt.name}</strong>${done ? " (unlocked)" : ""}</div>
          <small>${opt.description}</small>
          ${done ? "" : `<div style="margin-top:2px"><button class="btn" data-research-id="${opt.id}">Unlock (${costStr})</button></div>`}
        </div>
      `;
    }).join("");
  } else {
    refs.researchEl.innerHTML = "";
  }
}