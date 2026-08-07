// Building/unit *logic* only — every tunable number lives in config/balance.js.
import { BUILD_COST, GATHER_RATE, DWARF_MINE_ADJACENT_RATE, RESEARCH_GOLD_RATE } from "../config/balance.js";

export { BUILD_COST };

export function canPlace(kind, t, raceData) {
  if (!t) return false;
  if (t.blocked && kind !== "Bridge") return false; // e.g. a Dwarf Mine's adjacent claim blocks new construction there
  switch (kind) {
    case "TownHall":    return t.kind === (raceData?.townHallTerrain ?? "Grass");
    case "House":       return t.kind === (raceData?.houseTerrain ?? "Grass");
    case "Garrison":    return t.kind === "Grass";
    case "ArcherTower": return t.kind === "Grass";
    case "Research":    return t.kind === "Grass";
    case "Warehouse":   return t.kind === "Grass";
    case "Outpost":     return t.kind === "Grass";
    case "Church":      return t.kind === "Grass";
    case "Lumberjack":  return t.kind === "Forest";
    case "Farm":        return t.kind === "Fields";
    case "Mine":        return t.kind === "Stone" || t.kind === "HighMountain";
    case "FishingBoat": return t.kind === "Water";
    case "Bridge":      return t.kind === "Water";
    default: return false;
  }
}

/** Advance one building's resource gathering by dtSec, crediting `bank` (the owner's). */
export function gatherTick(tiles, building, dtSec, bank, scoreRef, raceData = {}, storageCaps = null) {
  if (!building.constructed) return; // still being built — no output until it's finished

  const mult = (kind) => raceData.rateMultiplier?.[kind] ?? 1;

  /** Adds `amount` of `kind` to the bank, clamped at that resource's storage cap (if any). */
  const credit = (kind, amount) => {
    if (amount <= 0) return;
    const cap = storageCaps ? (storageCaps[kind] ?? Infinity) : Infinity;
    const room = Math.max(0, cap - (bank[kind] ?? 0));
    const got = Math.min(amount, room);
    if (got <= 0) return;
    bank[kind] = (bank[kind] ?? 0) + got;
    if (scoreRef) scoreRef.value += got;
    return got;
  };

  if (building.kind === "Research") {
    credit("Gold", RESEARCH_GOLD_RATE * dtSec);
    return;
  }

  const t = tiles.getAt(building.q, building.r);
  if (!t) return;

  const take = (tile, kind, rate) => {
    if (!tile || tile.resLeft === undefined || tile.resLeft <= 0) return;
    const cap = storageCaps ? (storageCaps[kind] ?? Infinity) : Infinity;
    const room = Math.max(0, cap - (bank[kind] ?? 0));
    const got = Math.min(tile.resLeft, rate * dtSec, room);
    if (got <= 0) return;
    tile.resLeft -= got;
    bank[kind] = (bank[kind] ?? 0) + got;
    if (scoreRef) scoreRef.value += got;
  };

  switch (building.kind) {
    case "Lumberjack":  if (t.kind === "Forest") take(t, "Wood", GATHER_RATE.Lumberjack * (building.workers || 1) * mult("Lumberjack")); break;
    case "Farm": {
      if (t.kind !== "Fields") break;
      if (raceData.farmDepletesInstantly) {
        // Orc "Collect": empties the tile in one action for a flat 10 Bread, instead of gradual gathering.
        if (t.resLeft > 0) {
          credit("Bread", 10);
          t.resLeft = 0;
        }
      } else {
        take(t, "Bread", GATHER_RATE.Farm * (building.workers || 1) * mult("Farm"));
      }
      break;
    }
    case "Mine":        if (t.kind === "Stone")  take(t, "Stone", GATHER_RATE.Mine * (building.workers || 1) * mult("Mine")); break;
    case "FishingBoat": if (t.kind === "Water")  take(t, "Fish",  GATHER_RATE.FishingBoat * (building.workers || 1) * mult("FishingBoat")); break;
    case "Bridge": break;
    case "House": break;        // residential — no resource gathering, this is what grants population instead
    case "Garrison": break;     // no resource gathering — its job is training units
    case "ArcherTower": break;  // no resource gathering — see rooms/combat.js's advanceTowerDefense
    case "Research": break;     // no resource gathering — unlocks research options instead, see rooms/research.js
    case "TownHall": {
      if (t.kind === "Forest") take(t, "Wood", GATHER_RATE.TownHallSelf);
      if (t.kind === "Fields") take(t, "Bread", GATHER_RATE.TownHallSelf);
      if (t.kind === "Stone")  take(t, "Stone", GATHER_RATE.TownHallSelf);
      if (t.kind === "Water")  take(t, "Fish",  GATHER_RATE.TownHallSelf);
      const adj = [
        { q: building.q + 1, r: building.r }, { q: building.q + 1, r: building.r - 1 }, { q: building.q, r: building.r - 1 },
        { q: building.q - 1, r: building.r }, { q: building.q - 1, r: building.r + 1 }, { q: building.q, r: building.r + 1 },
      ];
      for (const a of adj) {
        const nt = tiles.getAt(a.q, a.r);
        if (!nt) continue;
        if (nt.kind === "Forest") take(nt, "Wood", GATHER_RATE.TownHallAdj);
        if (nt.kind === "Fields") take(nt, "Bread", GATHER_RATE.TownHallAdj);
        if (nt.kind === "Stone")  take(nt, "Stone", GATHER_RATE.TownHallAdj);
        if (nt.kind === "Water")  take(nt, "Fish",  GATHER_RATE.TownHallAdj);
      }
      break;
    }
  }
}

export { DWARF_MINE_ADJACENT_RATE };