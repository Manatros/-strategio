// src/buildings/costs.ts
import type { Bank } from "../econ/resources";
import type { BuildingKind } from "./types";

// Initial balance pass (tweak freely).
export const BUILD_COST: Record<BuildingKind, Partial<Bank>> = {
  TownHall:    { Wood: 30,  Stone: 30 },
  Lumberjack:  { Wood: 15,  Stone: 10 },
  Farm:        { Wood: 10,  Stone: 10 },
  Mine:        { Wood: 10,  Stone: 20 },
  FishingBoat: { Wood: 20 },
  Bridge:      { Wood: 8 },
};
