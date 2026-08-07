// src/ui/BuildHUD.ts
import type { Bank } from "../econ/resources";
import type { BuildingKind } from "../buildings/types";
import { BUILD_COST } from "../buildings/costs";
import { makeDraggable } from "./draggable";

export type UIRefs = {
  root: HTMLElement;
  btns: Record<BuildingKind, HTMLButtonElement>;
  res: Record<keyof Bank, HTMLElement>;
  pop: HTMLElement;
  hp: HTMLElement;
  score: HTMLElement;
  minimapEl: HTMLElement;
};

const ORDER: BuildingKind[] = ["TownHall","House","Lumberjack","Farm","Mine","FishingBoat","Bridge","Garrison","ArcherTower","Research","Warehouse","Outpost","Church"];

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
    <span id="res-gold">Gold: 0</span>
    <span id="res-pop">Pop: 0 / 0</span>
    <span id="res-hp">HP: 100/100</span>
    <span id="res-score">Score: 0</span>
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

  const right = document.createElement("div");
  right.className = "panel";
  right.innerHTML = `<div class="minimap" style="width:180px;height:180px"></div>`;

  root.appendChild(panel);
  root.appendChild(right);
  mount.appendChild(root);

  makeDraggable(panel, { id: "build-panel", defaultPos: (el) => ({ x: 12, y: window.innerHeight - el.offsetHeight - 12 }) });
  makeDraggable(right, { id: "build-minimap-panel", defaultPos: (el) => ({ x: window.innerWidth - el.offsetWidth - 12, y: window.innerHeight - el.offsetHeight - 12 }) });

  return {
    root,
    btns,
    res: {
      Wood:  resRow.querySelector("#res-wood") as HTMLElement,
      Stone: resRow.querySelector("#res-stone") as HTMLElement,
      Bread: resRow.querySelector("#res-bread") as HTMLElement,
      Fish:  resRow.querySelector("#res-fish") as HTMLElement,
      Gold:  resRow.querySelector("#res-gold") as HTMLElement,
    },
    pop: resRow.querySelector("#res-pop") as HTMLElement,
    hp: resRow.querySelector("#res-hp") as HTMLElement,
    score: resRow.querySelector("#res-score") as HTMLElement,
    minimapEl: right.querySelector(".minimap") as HTMLElement,
  };
}

export function refreshHUD(ui: UIRefs, bank: Bank, popCap = 0, workers = 0, hp = 0, maxHp = 0, score = 0, storageCap = 0) {
  const capStr = storageCap ? `/${Math.round(storageCap)}` : "";
  ui.res.Wood.textContent  = `Wood: ${bank.Wood.toFixed(0)}${capStr}`;
  ui.res.Stone.textContent = `Stone: ${bank.Stone.toFixed(0)}${capStr}`;
  ui.res.Bread.textContent = `Bread: ${bank.Bread.toFixed(0)}${capStr}`;
  ui.res.Fish.textContent  = `Fish: ${bank.Fish.toFixed(0)}${capStr}`;
  ui.res.Gold.textContent  = `Gold: ${bank.Gold.toFixed(0)}${capStr}`;
  ui.pop.textContent = `Pop: ${workers} / ${popCap}`;
  ui.hp.textContent = `HP: ${Math.max(0, Math.round(hp))}/${Math.round(maxHp)}`;
  ui.score.textContent = `Score: ${Math.round(score)}`;
}

export function setButtonsAffordable(ui: UIRefs, affordable:(k:BuildingKind)=>boolean) {
  for (const kind of Object.keys(ui.btns) as BuildingKind[]) {
    const btn = ui.btns[kind];
    const ok = affordable(kind);
    btn.disabled = !ok;
    btn.style.opacity = ok ? "1" : "0.5";
  }
}

/** Refreshes every build button's cost tooltip from the server-sent costs — called once "config" arrives,
 *  so the HUD always matches balance.js exactly with no separately-maintained client copy to drift out of sync. */
export function updateBuildTooltips(ui: UIRefs, buildCost: Record<string, Partial<Bank>>) {
  for (const kind of Object.keys(ui.btns) as BuildingKind[]) {
    const cost = buildCost[kind];
    if (cost) ui.btns[kind].title = JSON.stringify(cost);
  }
}