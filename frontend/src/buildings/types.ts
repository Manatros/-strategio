// src/buildings/types.ts
export type BuildingKind = "TownHall" | "Lumberjack" | "Farm" | "Mine" | "FishingBoat" | "Bridge" | "House" | "Garrison" | "ArcherTower" | "Warehouse" | "Research";

export type Building = {
  kind: BuildingKind;
  q: number;
  r: number;
  owner?: string;
  constructed?: boolean;
  ticksRemaining?: number;
  hp?: number;
  maxHp?: number;
};