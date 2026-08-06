// src/buildings/rules.ts
import type { BuildingKind } from "./types";
import type { Tile } from "../hex/types";
import { raceDisplay } from "../core/races";

export function canPlace(kind: BuildingKind, t: Tile | undefined, race?: string): boolean {
  if (!t) return false;
  const rd = raceDisplay(race);
  switch (kind) {
    case "TownHall":    return t.kind === rd.townHallTerrain;
    case "House":       return t.kind === rd.houseTerrain;
    case "Garrison":    return t.kind === "Grass";
    case "ArcherTower": return t.kind === "Grass";
    case "Lumberjack":  return t.kind === "Forest";
    case "Farm":        return t.kind === "Fields";
    case "Mine":        return t.kind === "Stone" || t.kind === "HighMountain";
    case "FishingBoat": return t.kind === "Water";
    case "Bridge":      return t.kind === "Water";
    default: return false;
  }
}