// src/buildings/costs.ts
import type { Bank } from "../econ/resources";
import type { BuildingKind } from "./types";

export const BUILD_COST: Record<BuildingKind, Partial<Bank>> = {
  TownHall:    { Wood: 30,  Stone: 30 },
  Lumberjack:  { Wood: 15,  Stone: 10 },
  Farm:        { Wood: 10,  Stone: 10 },
  Mine:        { Wood: 10,  Stone: 20 },
  FishingBoat: { Wood: 20 },
  Bridge:      { Wood: 8 },
  House:       { Bread: 15 },
  Garrison:    { Wood: 25, Stone: 15 },
  ArcherTower: { Wood: 20, Stone: 25 },
};