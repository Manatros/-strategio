// src/ui/UnitHUD.ts
import { makeDraggable } from "./draggable";

export type UnitHUDRefs = {
  root: HTMLElement;
  listEl: HTMLElement;
  abilitiesEl: HTMLElement;
  trainBtns: Record<string, HTMLButtonElement>; // keyed by unit kind — one button per trainable kind
  mergeBtn: HTMLButtonElement;
};

// The always-available roster. Race-specific extras (Necromancer for Undead, Brawler for Orc) are
// appended by the caller at creation time, once the player's race is known — see GameScene.mount().
const BASE_TRAINABLE_KINDS = ["Scout", "Soldier", "Archer", "Builder", "Priest"];

export function createUnitHUD(
  mount: HTMLElement,
  onSelect: (id: string | null) => void,
  onTrain: (kind: string) => void,
  onMerge: () => void,
  onToggleAutoExplore: () => void,
  onToggleGuard: () => void,
  extraTrainableKinds: string[] = []
): UnitHUDRefs {
  const root = document.createElement("div");
  root.className = "hud";
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.minWidth = "190px";

  const title = document.createElement("div");
  title.innerHTML = "<strong>Units</strong>";
  panel.appendChild(title);

  const listEl = document.createElement("div");
  listEl.className = "grid";
  listEl.style.gridTemplateColumns = "1fr";
  listEl.style.marginTop = "6px";
  panel.appendChild(listEl);

  const abilitiesLabel = document.createElement("div");
  abilitiesLabel.style.marginTop = "8px";
  abilitiesLabel.textContent = "Abilities:";
  panel.appendChild(abilitiesLabel);

  const abilitiesEl = document.createElement("div");
  abilitiesEl.style.marginTop = "4px";
  abilitiesEl.innerHTML = `<small>Select a unit to see what it can do</small>`;
  panel.appendChild(abilitiesEl);

  abilitiesEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.ability === "auto-explore") onToggleAutoExplore();
    if (t.dataset.ability === "guard") onToggleGuard();
  });

  const mergeBtn = document.createElement("button");
  mergeBtn.className = "btn";
  mergeBtn.textContent = "Merge 3 -> Level Up";
  mergeBtn.title = "Stack 3 of the same unit and level on one tile, then merge them into one stronger unit (max level 3)";
  mergeBtn.style.marginTop = "6px";
  mergeBtn.onclick = () => onMerge();
  panel.appendChild(mergeBtn);

  const trainLabel = document.createElement("div");
  trainLabel.style.marginTop = "8px";
  trainLabel.textContent = "Train:";
  panel.appendChild(trainLabel);

  const trainRow = document.createElement("div");
  trainRow.className = "grid";
  trainRow.style.gridTemplateColumns = "1fr 1fr";
  trainRow.style.gap = "6px";

  const trainBtns: Record<string, HTMLButtonElement> = {};
  for (const kind of [...BASE_TRAINABLE_KINDS, ...extraTrainableKinds]) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = kind;
    btn.onclick = () => onTrain(kind);
    trainRow.appendChild(btn);
    trainBtns[kind] = btn;
  }
  panel.appendChild(trainRow);

  root.appendChild(panel);
  mount.appendChild(root);
  makeDraggable(panel, { id: "unit-panel", defaultPos: (el) => ({ x: window.innerWidth / 2 - el.offsetWidth - 10, y: window.innerHeight - el.offsetHeight - 12 }) });

  listEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const id = target.dataset.unitId;
    if (id !== undefined) onSelect(id === "" ? null : id);
  });

  return { root, listEl, abilitiesEl, trainBtns, mergeBtn };
}

function fmtCost(cost: Record<string, number>): string {
  return Object.entries(cost).map(([k, v]) => `${k}: ${v}`).join(", ");
}

/** Refreshes every train button's tooltip from the server-sent unit costs — same drift-proofing as BuildHUD's version. */
export function updateTrainTooltips(ui: UnitHUDRefs, unitCost: Record<string, { cost: Record<string, number>; popCost: number; minUsedWorkers: number }>) {
  for (const kind of Object.keys(ui.trainBtns)) {
    const info = unitCost[kind];
    if (!info) continue;
    const rangeNote = kind === "Archer" ? " — 3x range" : "";
    ui.trainBtns[kind].title = `${fmtCost(info.cost)}, Pop: ${info.popCost}${info.minUsedWorkers ? ` (needs ${info.minUsedWorkers} population already in use)` : ""}${rangeNote}`;
  }
}

export function refreshAbilities(
  refs: UnitHUDRefs,
  selectedKind: string | null, // null = main character selected (or nothing)
  autoExploreOn: boolean,
  guardOn: boolean
) {
  if (!selectedKind) {
    refs.abilitiesEl.innerHTML = `<small>Select a unit to see what it can do</small>`;
    return;
  }
  if (selectedKind === "Soldier" || selectedKind === "Archer") {
    refs.abilitiesEl.innerHTML = `<small>Attack: click an enemy unit, building, or player within range</small>`;
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.dataset.ability = "guard";
    btn.textContent = guardOn ? "Guard: ON" : "Guard: OFF";
    btn.title = "While on, this unit automatically attacks any enemy that comes within its range — no clicking needed";
    btn.style.marginTop = "4px";
    if (guardOn) btn.style.outline = "2px solid #fff";
    refs.abilitiesEl.appendChild(btn);
    return;
  }
  if (selectedKind === "Settler") {
    refs.abilitiesEl.innerHTML = `<small>Found Town: build a Town Hall while I'm next to it — I'll be used up</small>`;
    return;
  }
  if (selectedKind === "Builder") {
    refs.abilitiesEl.innerHTML = `<small>Can place buildings just like you can — select me, then use the build menu near me instead of near your character</small>`;
    return;
  }
  if (selectedKind === "Priest") {
    refs.abilitiesEl.innerHTML = `<small>Passive — no clicking needed. Standing on enemy scorched-earth territory cleanses it; standing on an enemy building you're at war with slowly captures it.</small>`;
    return;
  }
  if (selectedKind === "Scout" || selectedKind === "Necromancer") {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.dataset.ability = "auto-explore";
    btn.textContent = autoExploreOn ? "Auto-Explore: ON" : "Auto-Explore: OFF";
    if (autoExploreOn) btn.style.outline = "2px solid #fff";
    refs.abilitiesEl.innerHTML = "";
    refs.abilitiesEl.appendChild(btn);
    if (selectedKind === "Necromancer") {
      const note = document.createElement("div");
      note.innerHTML = `<small>Attack: click a fallen enemy's tile to raise it as your own</small>`;
      note.style.marginTop = "4px";
      refs.abilitiesEl.appendChild(note);
    }
    return;
  }
  refs.abilitiesEl.innerHTML = `<small>No special abilities</small>`;
}

export function refreshUnitHUD(
  ui: UnitHUDRefs,
  units: { id: string; kind: string; level: number }[],
  selectedId: string | null,
  canTrainKind: (kind: string) => boolean,
  canMergeHere: boolean
) {
  ui.listEl.innerHTML = "";

  const mainBtn = document.createElement("button");
  mainBtn.className = "btn";
  mainBtn.textContent = (selectedId === null ? "\u25B6 " : "") + "Main (you)";
  mainBtn.dataset.unitId = "";
  if (selectedId === null) mainBtn.style.outline = "2px solid #fff";
  ui.listEl.appendChild(mainBtn);

  for (const u of units) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = (u.id === selectedId ? "\u25B6 " : "") + `${u.kind} (Lv.${u.level})`;
    b.dataset.unitId = u.id;
    if (u.id === selectedId) b.style.outline = "2px solid #fff";
    ui.listEl.appendChild(b);
  }

  for (const kind of Object.keys(ui.trainBtns)) {
    const ok = canTrainKind(kind);
    ui.trainBtns[kind].disabled = !ok;
    ui.trainBtns[kind].style.opacity = ok ? "1" : "0.5";
  }
  ui.mergeBtn.disabled = !canMergeHere;
  ui.mergeBtn.style.opacity = canMergeHere ? "1" : "0.5";
}