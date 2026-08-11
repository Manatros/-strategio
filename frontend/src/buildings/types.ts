// src/buildings/types.ts
export type BuildingKind = "TownHall" | "Lumberjack" | "Farm" | "Mine" | "FishingBoat" | "Bridge" | "House" | "Garrison" | "ArcherTower" | "Research" | "Warehouse" | "Outpost" | "Church" | "Road" | "Monastery";

export type Building = {
  kind: BuildingKind;
  q: number;
  r: number;
  owner?: string;
  constructed?: boolean;
  ticksRemaining?: number;
  hp?: number;
  maxHp?: number;
  workers?: number;
  level?: number;
  inventory?: Partial<Record<"Wood" | "Stone" | "Bread" | "Fish" | "Gold", number>>;
};
