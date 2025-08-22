// src/buildings/rules.ts
import type { BuildingKind } from "./types";
import type { Tile } from "../hex/types";

export function canPlace(kind: BuildingKind, t: Tile | undefined): boolean {
  if (!t) return false;
  switch (kind) {
    case "TownHall":    return t.kind === "Grass";
    case "Lumberjack":  return t.kind === "Forest";
    case "Farm":        return t.kind === "Fields";
    case "Mine":        return t.kind === "Stone";
    case "FishingBoat": return t.kind === "Water";
    case "Bridge":      return t.kind === "Water";
    default: return false;
  }
}
