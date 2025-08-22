// src/ui/BuildHUD.ts
import type { Bank } from "../econ/resources";
import type { BuildingKind } from "../buildings/types";
import { BUILD_COST } from "../buildings/costs";

export type UIRefs = {
  root: HTMLElement;
  btns: Record<BuildingKind, HTMLButtonElement>;
  res: Record<keyof Bank, HTMLElement>;
};

const ORDER: BuildingKind[] = ["TownHall","Lumberjack","Farm","Mine","FishingBoat","Bridge"];

export function createBuildHUD(mount: HTMLElement, onPick:(b:BuildingKind)=>void): UIRefs {
  const root = document.createElement("div");
  root.className = "hud";
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.minWidth = "260px";

  const resRow = document.createElement("div");
  resRow.className = "row";
  resRow.style.justifyContent = "space-between";
  resRow.style.gap = "12px";
  resRow.innerHTML = `
    <span><strong>Resources</strong></span>
    <span id="res-wood">Wood: 0</span>
    <span id="res-stone">Stone: 0</span>
    <span id="res-bread">Bread: 0</span>
    <span id="res-fish">Fish: 0</span>
  `;

  const label = document.createElement("div");
  label.style.marginTop = "8px";
  label.textContent = "Build:";

  const grid = document.createElement("div");
  grid.className = "grid";
  grid.style.gridTemplateColumns = "1fr 1fr";
  const btns = {} as Record<BuildingKind, HTMLButtonElement>;
  for (const kind of ORDER) {
    const b = document.createElement("button");
    b.className = "btn";
    b.title = JSON.stringify(BUILD_COST[kind] || {});
    b.textContent = `${kind}`;
    b.onclick = () => onPick(kind);
    grid.appendChild(b);
    btns[kind] = b;
  }

  panel.appendChild(resRow);
  panel.appendChild(label);
  panel.appendChild(grid);

  // right side placeholder panel (minimap etc.)
  const right = document.createElement("div");
  right.className = "panel";
  right.innerHTML = `<div class="minimap"></div>`;

  root.appendChild(panel);
  root.appendChild(right);
  mount.appendChild(root);

  return {
    root,
    btns,
    res: {
      Wood:  resRow.querySelector("#res-wood") as HTMLElement,
      Stone: resRow.querySelector("#res-stone") as HTMLElement,
      Bread: resRow.querySelector("#res-bread") as HTMLElement,
      Fish:  resRow.querySelector("#res-fish") as HTMLElement,
    }
  };
}

export function refreshHUD(ui: UIRefs, bank: Bank) {
  ui.res.Wood.textContent  = `Wood: ${bank.Wood.toFixed(0)}`;
  ui.res.Stone.textContent = `Stone: ${bank.Stone.toFixed(0)}`;
  ui.res.Bread.textContent = `Bread: ${bank.Bread.toFixed(0)}`;
  ui.res.Fish.textContent  = `Fish: ${bank.Fish.toFixed(0)}`;
}

export function setButtonsAffordable(ui: UIRefs, affordable:(k:BuildingKind)=>boolean) {
  for (const kind of Object.keys(ui.btns) as BuildingKind[]) {
    const btn = ui.btns[kind];
    const ok = affordable(kind);
    btn.disabled = !ok;
    btn.style.opacity = ok ? "1" : "0.5";
  }
}
