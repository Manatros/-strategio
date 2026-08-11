// src/core/balance.ts
//
// The server (server/src/config/balance.js) is the only authority on game
// balance — everything here is a client-side *mirror*, used purely for
// instant UI feedback (greying out a button, picking a ghost color) before
// the server's response arrives. If a value here drifts out of sync with
// the server, the worst case is a wrong-looking button for one click; the
// server's own check always has the final say.
import type { BuildingKind } from "../buildings/types";

/** Buildings that don't need an assigned worker — mirrors WORKER_EXEMPT in balance.js. */
export const WORKER_EXEMPT = new Set<BuildingKind>(["TownHall", "House", "Road", "Monastery"]);

/** Buildings a Civilian specifically can't be assigned to — mirrors CIVILIAN_ASSIGN_EXEMPT in
 *  civilians.js. Deliberately narrower than WORKER_EXEMPT: TownHall now takes an assigned worker
 *  too (works like a Warehouse), so it must NOT be excluded here even though it's still exempt
 *  from the unrelated placement-time population check WORKER_EXEMPT itself covers. */
export const CIVILIAN_ASSIGN_EXEMPT = new Set<BuildingKind>(["House", "Road", "Monastery"]);

/** Max staffable workers per tier — mirrors GATHERING_MAX_WORKERS / WAREHOUSE_MAX_WORKERS in balance.js. */
export const GATHERING_MAX_WORKERS: Record<number, number> = { 1: 2, 2: 3, 3: 5 };
export const WAREHOUSE_MAX_WORKERS: Record<number, number> = { 1: 1, 2: 2, 3: 3 };
const GATHERING_BUILDING_KINDS = new Set(["Lumberjack", "Farm", "Mine", "FishingBoat"]);

/** Mirrors civilians.js's maxWorkersFor — how many workers a building can hold at its current tier. */
export function maxWorkersFor(kind: string, level: number | undefined): number {
  if (level === undefined) return 2;
  if (GATHERING_BUILDING_KINDS.has(kind)) return GATHERING_MAX_WORKERS[level] ?? 2;
  if (kind === "Warehouse") return WAREHOUSE_MAX_WORKERS[level] ?? 1;
  return 2;
}

/** How far each combat unit can attack — mirrors ATTACK_RANGE in balance.js (units only; ArcherTower fires on its own). */
export const ATTACK_RANGE: Record<string, number> = { Soldier: 1, Archer: 3, Necromancer: 1, Brawler: 1 };

/** Which building trains which unit — mirrors TRAINING_BUILDING in balance.js. Falls back to "Garrison" for anything unlisted. */
export const TRAINING_BUILDING: Record<string, BuildingKind> = {
  Scout: "Garrison", Soldier: "Garrison", Archer: "Garrison", Necromancer: "Garrison", Brawler: "Garrison",
  Settler: "Outpost", Builder: "Outpost",
  Priest: "Church",
};

// ---- Movement speed (Human-only mechanic — every other race just uses 1 tick/tile) ----
// Purely for predicting how long the client-side movement tween should take — the server's own
// stepCooldownFor() is what actually enforces pacing; if this mirror ever drifts, the visual tween
// duration would just be briefly wrong for one step, nothing more, since the server corrects on its
// own next tick regardless.
export const BASE_TICKS_PER_TILE: Record<string, number> = { Human: 4 };
export const ROAD_SPEED_TICKS: Record<number, number> = { 1: 2, 2: 1 };
export const RACES_WITH_ROADS = new Set(["Human"]);

/** How full a gathering building's own inventory gets before it's "full" (waiting on delivery) —
 *  mirrors GATHERING_BUILDING_CAP in balance.js, purely for the client-side progress bar fill. */
export const GATHERING_BUILDING_CAP = 15;
export const TOWNHALL_STORAGE_CAP = 60;
export const WAREHOUSE_STORAGE_CAP = 50;

/** Mirrors BUILDING_UNLOCK_RESEARCH in balance.js — which buildings need research before they're
 *  placeable, and at which building (TownHall/Church) that research happens. Only Human currently
 *  has entries; every other race's full build menu stays unlocked from the start. */
export type BuildingUnlockOption = { id: string; name: string; building: BuildingKind; cost: Partial<Record<"Wood" | "Stone" | "Bread" | "Fish" | "Gold", number>> };
export const BUILDING_UNLOCK_RESEARCH: Record<string, Record<string, BuildingUnlockOption[]>> = {
  Human: {
    TownHall: [
      { id: "unlock_garrison",  name: "Garrison",  building: "Garrison",  cost: { Gold: 15 } },
      { id: "unlock_bridge",    name: "Bridge",     building: "Bridge",    cost: { Gold: 10 } },
      { id: "unlock_warehouse", name: "Warehouse",  building: "Warehouse", cost: { Gold: 20 } },
      { id: "unlock_outpost",   name: "Outpost",    building: "Outpost",   cost: { Gold: 20 } },
      { id: "unlock_church",    name: "Church",     building: "Church",    cost: { Gold: 25 } },
    ],
    Church: [
      { id: "unlock_monastery",    name: "Monastery",     building: "Monastery",    cost: { Gold: 20 } },
      { id: "unlock_garrison",     name: "Garrison",      building: "Garrison",     cost: { Gold: 15 } },
      { id: "unlock_archer_tower", name: "Archer Tower",  building: "ArcherTower",  cost: { Gold: 25 } },
    ],
  },
};

/** Every building kind that needs an unlock before it's placeable, per race. */
export const BUILDINGS_REQUIRING_UNLOCK: Record<string, Set<BuildingKind>> = {
  Human: new Set(Object.values(BUILDING_UNLOCK_RESEARCH.Human).flat().map(o => o.building)),
};
