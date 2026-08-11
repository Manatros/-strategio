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

const BASE_ORDER: BuildingKind[] = ["TownHall","House","Lumberjack","Farm","Mine","FishingBoat","Bridge","Garrison","ArcherTower","Research","Warehouse","Outpost","Church"];

/** `topBarMount` is the fixed top resource bar (Warcraft-style — always visible, never overlaps anything else).
 *  `mount` is where the build menu + minimap panel go (still a draggable panel for now).
 *  `extraKinds` appends race-specific buildings (e.g. Road, Human-only) after the base roster. */
export function createBuildHUD(topBarMount: HTMLElement, mount: HTMLElement, onPick:(b:BuildingKind)=>void, extraKinds: BuildingKind[] = [], onDragStart:(b:BuildingKind)=>void = () => {}): UIRefs {
  const topBar = document.createElement("div");
  topBar.className = "top-bar";
  topBar.innerHTML = `
    <span class="res-item"><strong>Strategio</strong></span>
    <span class="res-item" id="res-wood">Wood: 0</span>
    <span class="res-item" id="res-stone">Stone: 0</span>
    <span class="res-item" id="res-bread">Bread: 0</span>
    <span class="res-item" id="res-fish">Fish: 0</span>
    <span class="res-item" id="res-gold">Gold: 0</span>
    <span class="res-item" id="res-pop">Pop: 0 / 0</span>
    <span class="res-item" id="res-hp">HP: 100/100</span>
    <span class="res-item" id="res-score">Score: 0</span>
  `;
  topBarMount.appendChild(topBar);

  const root = document.createElement("div");
  root.className = "hud";
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.minWidth = "260px";

  const label = document.createElement("div");
  label.textContent = "Build:";

  const grid = document.createElement("div");
  grid.className = "grid";
  grid.style.gridTemplateColumns = "1fr 1fr";
  const btns = {} as Record<BuildingKind, HTMLButtonElement>;
  for (const kind of [...BASE_ORDER, ...extraKinds]) {
    const b = document.createElement("button");
    b.className = "btn";
    b.title = JSON.stringify(BUILD_COST[kind] || {});
    b.textContent = `${kind}`;
    b.draggable = true;
    b.onclick = () => onPick(kind);
    b.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("application/x-strategio-building", kind);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      onDragStart(kind);
    });
    grid.appendChild(b);
    btns[kind] = b;
  }

  panel.appendChild(label);
  panel.appendChild(grid);

  const right = document.createElement("div");
  right.className = "panel";
  right.innerHTML = `<div class="minimap" style="width:180px;height:180px"></div>`;

  root.appendChild(panel);
  root.appendChild(right);
  mount.appendChild(root);

  // Clearly separated default positions (top-left / top-right, well below the fixed top bar) so
  // these two panels never start out overlapping each other or anything else.
  makeDraggable(panel, { id: "build-panel", defaultPos: () => ({ x: 12, y: 52 }) });
  makeDraggable(right, { id: "build-minimap-panel", defaultPos: (el) => ({ x: window.innerWidth - el.offsetWidth - 12, y: 52 }) });

  return {
    root,
    btns,
    res: {
      Wood:  topBar.querySelector("#res-wood") as HTMLElement,
      Stone: topBar.querySelector("#res-stone") as HTMLElement,
      Bread: topBar.querySelector("#res-bread") as HTMLElement,
      Fish:  topBar.querySelector("#res-fish") as HTMLElement,
      Gold:  topBar.querySelector("#res-gold") as HTMLElement,
    },
    pop: topBar.querySelector("#res-pop") as HTMLElement,
    hp: topBar.querySelector("#res-hp") as HTMLElement,
    score: topBar.querySelector("#res-score") as HTMLElement,
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

/** Fully hides build buttons for buildings that haven't been unlocked via building-unlock research
 *  yet — distinct from setButtonsAffordable's grey-out, which is for buildings you CAN see but
 *  can't currently afford. An un-researched building shouldn't appear in the menu at all. */
export function setButtonsUnlocked(ui: UIRefs, isUnlocked: (k: BuildingKind) => boolean) {
  for (const kind of Object.keys(ui.btns) as BuildingKind[]) {
    ui.btns[kind].style.display = isUnlocked(kind) ? "" : "none";
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
