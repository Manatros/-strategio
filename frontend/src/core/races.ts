// src/core/races.ts
export const RACES = ["Human", "Orc", "Elf", "Dwarf", "Undead"] as const;
export type Race = (typeof RACES)[number];

export type RaceDisplay = {
  label: string;
  blurb: string;
  buildingNames: Record<string, string>;
  unitNames: Record<string, string>;
  townHallTerrain: string;
  houseTerrain: string;
};

export const RACE_DISPLAY: Record<Race, RaceDisplay> = {
  Human: {
    label: "Human",
    blurb: "Balanced and straightforward — no restrictions, no surprises.",
    buildingNames: { TownHall: "Town Hall", House: "House", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fishing Boat", Garrison: "Garrison", ArcherTower: "Archer Tower", Research: "Library", Warehouse: "Warehouse" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Scout", Settler: "Settler" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
  },
  Orc: {
    label: "Orc",
    blurb: "Starts with 2 units and permanent war with everyone — no trade, no diplomacy, ever.",
    buildingNames: { TownHall: "Broodcave", House: "Tent", Lumberjack: "Wood Grunt", Mine: "Mine", Farm: "Collect", FishingBoat: "Fishing Boat", Garrison: "Garrison", ArcherTower: "Archer Tower", Research: "War Camp", Warehouse: "Stockpile" },
    unitNames: { Soldier: "Grunt", Archer: "Stonethrower", Scout: "Scout", Settler: "Settler", Brawler: "Brawler" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
  },
  Elf: {
    label: "Elf",
    blurb: "Open borders with everyone by default. Forests heal your units over time.",
    buildingNames: { TownHall: "Living Tree", House: "Treehouse", Lumberjack: "Forester", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "Training Course", ArcherTower: "Archer Tower", Research: "Grove of Wisdom", Warehouse: "Hollow Store" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Forager", Settler: "Settler" },
    townHallTerrain: "Forest",
    houseTerrain: "Forest",
  },
  Dwarf: {
    label: "Dwarf",
    blurb: "Town Hall only on high mountain peaks. Mines also drain — and lock — adjacent mountain tiles.",
    buildingNames: { TownHall: "Great Mines", House: "Cave", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "The Great Forge", ArcherTower: "Archer Tower", Research: "Deep Archive", Warehouse: "Vault" },
    unitNames: { Soldier: "Warrior", Archer: "Boomstick", Scout: "Scout", Settler: "Great Digger" },
    townHallTerrain: "HighMountain",
    houseTerrain: "Stone",
  },
  Undead: {
    label: "Undead",
    blurb: "Your territory becomes scorched earth, damaging anyone who isn't you.",
    buildingNames: { TownHall: "Crypt", House: "Grave", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "Altar", ArcherTower: "Archer Tower", Research: "Sepulcher", Warehouse: "Ossuary" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Scout", Settler: "Cryptkeeper", Necromancer: "Necromancer" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
  },
};

export function raceDisplay(race: string | undefined): RaceDisplay {
  return RACE_DISPLAY[(race as Race) in RACE_DISPLAY ? (race as Race) : "Human"];
}