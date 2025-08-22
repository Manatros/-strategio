// src/buildings/types.ts
export type BuildingKind = "TownHall" | "Lumberjack" | "Farm" | "Mine" | "FishingBoat" | "Bridge";

export type Building = {
  kind: BuildingKind;
  q: number;
  r: number;
  owner?: string;
};
