// src/buildings/rules.ts
import type { BuildingKind } from "./types";
import type { Tile } from "../hex/types";
import { raceDisplay } from "../core/races";
import { isPassable } from "../hex/helpers";

export function canPlace(kind: BuildingKind, t: Tile | undefined, race?: string): boolean {
  if (!t) return false;
  const rd = raceDisplay(race);
  switch (kind) {
    case "TownHall":    return t.kind === rd.townHallTerrain;
    case "House":       return t.kind === rd.houseTerrain;
    case "Garrison":    return t.kind === "Grass";
    case "ArcherTower": return t.kind === "Grass";
    case "Research":    return t.kind === "Grass";
    case "Warehouse":   return t.kind === "Grass";
    case "Outpost":     return t.kind === "Grass";
    case "Church":      return t.kind === "Grass";
    case "Road":        return race === "Human" && isPassable(t);
    case "Monastery":   return race === "Human" && t.kind === "Grass";
    case "Lumberjack":  return t.kind === "Forest";
    case "Farm":        return t.kind === "Fields";
    case "Mine":        return t.kind === "Stone" || t.kind === "HighMountain";
    case "FishingBoat": return t.kind === "Water";
    case "Bridge":      return t.kind === "Water";
    default: return false;
  }
}
