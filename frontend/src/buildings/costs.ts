// src/buildings/costs.ts
import type { Bank } from "../econ/resources";
import type { BuildingKind } from "./types";

export const BUILD_COST: Record<BuildingKind, Partial<Bank>> = {
  TownHall:    { Wood: 10, Stone: 10 },
  Lumberjack:  { Wood: 0,  Stone: 10 },
  Farm:        { Wood: 10, Stone: 10 },
  Mine:        { Wood: 10, Stone: 0 },
  FishingBoat: { Wood: 18 },
  Bridge:      { Wood: 8 },
  House:       { Wood: 10, Stone: 10 },
  Garrison:    { Wood: 25, Stone: 20 },
  ArcherTower: { Wood: 20, Stone: 25 },
  Research:    { Wood: 50, Stone: 50 },
  Warehouse:   { Wood: 50, Stone: 50 },
  Outpost:     { Wood: 20, Stone: 10 },
  Church:      { Wood: 30, Stone: 15, Bread: 15 },
  Road:        { Wood: 5, Stone: 5 },
  Monastery:   { Wood: 40, Stone: 20, Gold: 20 },
};
