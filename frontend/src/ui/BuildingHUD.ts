// src/ui/BuildingHUD.ts
import { makeDraggable } from "./draggable";
import type { ResearchOption } from "../core/research";

// Placeholder text icons — swap these for real image assets later without touching anything else,
// since every call site just reads from this one map.
const RESOURCE_ICON: Record<string, string> = { Wood: "🪵", Stone: "🪨", Bread: "🍞", Fish: "🐟", Gold: "🪙" };

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
  buildingUnlockOptions: { id: string; name: string; building: string; cost: Record<string, number> }[] | null; // non-null only when the selected building offers building-unlock research (TownHall/Church)
  unlockedBuildings: Set<string>;
  roadLevel: number | null;         // non-null only for a Road (1 = basic, 2 = stone)
  canUpgradeHouse: boolean;         // true only for a constructed, not-yet-upgraded Human House with Urban Planning researched
  houseResidents: { living: number; employed: number } | null; // non-null only for a Human House
  gatheringLevel: number | null;    // non-null only for a Human gathering building (Lumberjack/Farm/Mine/FishingBoat)
  canUpgradeGathering: boolean;     // true if the next tier's research is unlocked and it's not maxed
  canConvertTiles: boolean;         // true only for a level-3 gathering building with enough workers staffed
  warehouseLevel: number | null;    // non-null only for a Human Warehouse
  canUpgradeWarehouse: boolean;
  workers: number | null;           // non-null only for buildings that take assigned civilians (gathering buildings, Warehouse)
  maxWorkers: number | null;
  canAssignWorker: boolean;         // true if this building can take another worker right now (Human, not full, not WORKER_EXEMPT)
  canUnassignWorker: boolean;       // true if this building has at least one worker to release
  inventory: { kind: string; amount: number; cap: number }[] | null; // null = no inventory concept for this building; [] = has the concept but genuinely empty; otherwise every resource currently stored (even 0-amount ones aren't included - only ones actually present) alongside this building's per-resource capacity
  trainQueue: { kind: string; ticksRemaining: number; totalTicks: number }[] | null; // null = this building can't train anything; [] = can train but queue is empty
};

export type BuildingHUDRefs = {
  root: HTMLElement;
  panel: HTMLElement;
  bodyEl: HTMLElement;
  researchEl: HTMLElement;
  demolishBtn: HTMLButtonElement;
  upgradeRoadBtn: HTMLButtonElement;
  upgradeHouseBtn: HTMLButtonElement;
  upgradeGatheringBtn: HTMLButtonElement;
  convertTileBtn: HTMLButtonElement;
  upgradeWarehouseBtn: HTMLButtonElement;
  collectBtn: HTMLButtonElement;
  assignWorkerBtn: HTMLButtonElement;
  unassignWorkerBtn: HTMLButtonElement;
  queueEl: HTMLElement;
};

export function createBuildingHUD(
  mount: HTMLElement,
  onDemolish: () => void,
  onResearch: (optionId: string) => void,
  onResearchBuilding: (optionId: string) => void,
  onUpgradeRoad: () => void,
  onUpgradeHouse: () => void,
  onUpgradeGathering: () => void,
  onConvertTile: () => void,
  onUpgradeWarehouse: () => void,
  onCollect: () => void,
  onAssignWorker: () => void,
  onUnassignWorker: () => void,
  onCancelTraining: (index: number) => void
): BuildingHUDRefs {
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

  const assignWorkerBtn = document.createElement("button");
  assignWorkerBtn.className = "btn";
  assignWorkerBtn.textContent = "Assign Worker";
  assignWorkerBtn.title = "Sends the nearest idle Civilian (from whichever House still has one) to staff this building — no need to pick one manually";
  assignWorkerBtn.style.marginTop = "6px";
  assignWorkerBtn.style.display = "none";
  assignWorkerBtn.onclick = () => onAssignWorker();
  panel.appendChild(assignWorkerBtn);

  const unassignWorkerBtn = document.createElement("button");
  unassignWorkerBtn.className = "btn";
  unassignWorkerBtn.textContent = "Unassign Worker";
  unassignWorkerBtn.title = "Releases one worker (the most recently assigned) back to idle, so you can send them to staff a different building instead";
  unassignWorkerBtn.style.marginTop = "6px";
  unassignWorkerBtn.style.display = "none";
  unassignWorkerBtn.onclick = () => onUnassignWorker();
  panel.appendChild(unassignWorkerBtn);

  const queueEl = document.createElement("div");
  queueEl.style.marginTop = "8px";
  panel.appendChild(queueEl);
  queueEl.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("[data-cancel-index]") as HTMLElement | null;
    if (t) onCancelTraining(Number(t.dataset.cancelIndex));
  });

  const collectBtn = document.createElement("button");
  collectBtn.className = "btn";
  collectBtn.textContent = "Collect Resources";
  collectBtn.title = "Grab whatever this building has gathered so far, right now — an instant alternative to waiting for a Civilian's delivery run";
  collectBtn.style.marginTop = "6px";
  collectBtn.style.display = "none";
  collectBtn.onclick = () => onCollect();
  panel.appendChild(collectBtn);

  const upgradeRoadBtn = document.createElement("button");
  upgradeRoadBtn.className = "btn";
  upgradeRoadBtn.textContent = "Upgrade to Stone Road";
  upgradeRoadBtn.title = "Stone roads let Humans move at full normal speed, not just twice their base speed";
  upgradeRoadBtn.style.marginTop = "6px";
  upgradeRoadBtn.style.display = "none";
  upgradeRoadBtn.onclick = () => onUpgradeRoad();
  panel.appendChild(upgradeRoadBtn);

  const upgradeHouseBtn = document.createElement("button");
  upgradeHouseBtn.className = "btn";
  upgradeHouseBtn.textContent = "Upgrade House (+2 Civilians)";
  upgradeHouseBtn.title = "Costs 20 Wood, 20 Stone — requires the Urban Planning research";
  upgradeHouseBtn.style.marginTop = "6px";
  upgradeHouseBtn.style.display = "none";
  upgradeHouseBtn.onclick = () => onUpgradeHouse();
  panel.appendChild(upgradeHouseBtn);

  const upgradeGatheringBtn = document.createElement("button");
  upgradeGatheringBtn.className = "btn";
  upgradeGatheringBtn.textContent = "Upgrade Tier";
  upgradeGatheringBtn.title = "Raises the max staffable workers and, at higher tiers, adds a gathering radius bonus or unlocks tile conversion — needs research";
  upgradeGatheringBtn.style.marginTop = "6px";
  upgradeGatheringBtn.style.display = "none";
  upgradeGatheringBtn.onclick = () => onUpgradeGathering();
  panel.appendChild(upgradeGatheringBtn);

  const convertTileBtn = document.createElement("button");
  convertTileBtn.className = "btn";
  convertTileBtn.textContent = "Convert Nearby Tile";
  convertTileBtn.title = "Click, then click a nearby tile to convert it to this building's resource terrain — costs Gold";
  convertTileBtn.style.marginTop = "6px";
  convertTileBtn.style.display = "none";
  convertTileBtn.onclick = () => onConvertTile();
  panel.appendChild(convertTileBtn);

  const upgradeWarehouseBtn = document.createElement("button");
  upgradeWarehouseBtn.className = "btn";
  upgradeWarehouseBtn.textContent = "Upgrade Warehouse Tier";
  upgradeWarehouseBtn.title = "Raises the max staffable workers and storage capacity";
  upgradeWarehouseBtn.style.marginTop = "6px";
  upgradeWarehouseBtn.style.display = "none";
  upgradeWarehouseBtn.onclick = () => onUpgradeWarehouse();
  panel.appendChild(upgradeWarehouseBtn);

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
    const unlockId = t.dataset.unlockId;
    if (unlockId) onResearchBuilding(unlockId);
  });

  const refs = { root, panel, bodyEl: panel.querySelector("#bld-body") as HTMLElement, researchEl, demolishBtn, upgradeRoadBtn, upgradeHouseBtn, upgradeGatheringBtn, convertTileBtn, upgradeWarehouseBtn, collectBtn, assignWorkerBtn, unassignWorkerBtn, queueEl };
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

  const roadLine = info.roadLevel !== null ? `<div>Road level: ${info.roadLevel === 2 ? "Stone (max)" : "Basic"}</div>` : "";
  const tierLine = info.gatheringLevel !== null ? `<div>Tier: ${info.gatheringLevel}${info.gatheringLevel >= 3 ? " (max)" : ""}</div>`
    : info.warehouseLevel !== null ? `<div>Tier: ${info.warehouseLevel}${info.warehouseLevel >= 3 ? " (max)" : ""}</div>` : "";
  const residentsLine = info.houseResidents
    ? `<div>Residents: <strong>${info.houseResidents.living}</strong> living here, <strong>${info.houseResidents.employed}</strong> with jobs</div>`
    : "";
  const workersLine = info.workers !== null
    ? `<div>Workers: <strong>${info.workers}</strong>${info.maxWorkers !== null ? ` / ${info.maxWorkers}` : ""}${info.canAssignWorker ? " — use Assign Worker below" : ""}</div>`
    : "";
  const inventoryLine = info.inventory === null
    ? ""
    : info.inventory.length === 0
      ? `<div>Inventory: <small>Empty</small></div>`
      : `<div><strong>Inventory:</strong></div>` + info.inventory.map(item => {
          const free = item.cap - item.amount;
          return `<div>${RESOURCE_ICON[item.kind] ?? ""} ${item.kind}: <strong>${Math.round(item.amount)}/${item.cap}</strong> <small>(${free} free)</small></div>`;
        }).join("");
  refs.bodyEl.innerHTML = `<div><strong>${info.kind}</strong></div><div>${statusLine}</div>${gatherLine}${workersLine}${inventoryLine}${roadLine}${tierLine}${residentsLine}`;
  refs.demolishBtn.style.display = "inline-block";
  refs.assignWorkerBtn.style.display = info.canAssignWorker ? "inline-block" : "none";
  refs.unassignWorkerBtn.style.display = info.canUnassignWorker ? "inline-block" : "none";
  refs.collectBtn.style.display = (info.inventory && info.inventory.some(item => item.amount > 0)) ? "inline-block" : "none";
  if (info.trainQueue === null) {
    refs.queueEl.innerHTML = "";
  } else if (info.trainQueue.length === 0) {
    refs.queueEl.innerHTML = `<div><strong>Training Queue:</strong> <small>empty</small></div>`;
  } else {
    const slots = info.trainQueue.map((item, i) => {
      const pct = Math.round(100 * (1 - item.ticksRemaining / Math.max(1, item.totalTicks)));
      return `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
        <span style="flex:1">${i + 1}. ${item.kind} ${i === 0 ? `(${pct}%)` : "(waiting)"}</span>
        <button class="btn" style="padding:2px 6px" data-cancel-index="${i}">✕</button>
      </div>`;
    }).join("");
    refs.queueEl.innerHTML = `<div><strong>Training Queue</strong> (${info.trainQueue.length}/4):</div>${slots}`;
  }
  refs.upgradeRoadBtn.style.display = (info.roadLevel === 1 && info.constructed) ? "inline-block" : "none";
  refs.upgradeHouseBtn.style.display = info.canUpgradeHouse ? "inline-block" : "none";
  refs.upgradeGatheringBtn.style.display = info.canUpgradeGathering ? "inline-block" : "none";
  refs.convertTileBtn.style.display = info.canConvertTiles ? "inline-block" : "none";
  refs.upgradeWarehouseBtn.style.display = (info.warehouseLevel !== null && info.warehouseLevel < 3) ? "inline-block" : "none";

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
  } else if (info.buildingUnlockOptions && info.constructed) {
    refs.researchEl.innerHTML = `<div style="margin-top:4px"><strong>Research buildings:</strong></div>` + info.buildingUnlockOptions.map(opt => {
      const done = info.unlockedBuildings.has(opt.id);
      const costStr = Object.entries(opt.cost).map(([k, v]) => `${v} ${k}`).join(", ");
      return `
        <div style="border-top:1px solid #222;padding:4px 0">
          <div><strong>${opt.name}</strong>${done ? " (unlocked)" : ""}</div>
          ${done ? "" : `<div style="margin-top:2px"><button class="btn" data-unlock-id="${opt.id}">Unlock (${costStr})</button></div>`}
        </div>
      `;
    }).join("");
  } else {
    refs.researchEl.innerHTML = "";
  }
}
