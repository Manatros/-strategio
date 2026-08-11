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
    blurb: "Moves slower than everyone else by default — build roads to catch up, or exceed it.",
    buildingNames: { TownHall: "Town Hall", House: "House", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fishing Boat", Garrison: "Garrison", ArcherTower: "Archer Tower", Research: "Library", Warehouse: "Warehouse", Outpost: "Outpost", Church: "Church", Road: "Road", Monastery: "Monastery" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Scout", Settler: "Settler", Builder: "Builder", Priest: "Priest" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
  },
  Orc: {
    label: "Orc",
    blurb: "Starts with 2 units and permanent war with everyone — no trade, no diplomacy, ever.",
    buildingNames: { TownHall: "Broodcave", House: "Tent", Lumberjack: "Wood Grunt", Mine: "Mine", Farm: "Collect", FishingBoat: "Fishing Boat", Garrison: "Garrison", ArcherTower: "Archer Tower", Research: "War Camp", Warehouse: "Stockpile", Outpost: "Raiding Post", Church: "Shaman Hut" },
    unitNames: { Soldier: "Grunt", Archer: "Stonethrower", Scout: "Scout", Settler: "Settler", Brawler: "Brawler", Builder: "Digger", Priest: "Shaman" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
  },
  Elf: {
    label: "Elf",
    blurb: "Open borders with everyone by default. Forests heal your units over time.",
    buildingNames: { TownHall: "Living Tree", House: "Treehouse", Lumberjack: "Forester", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "Training Course", ArcherTower: "Archer Tower", Research: "Grove of Wisdom", Warehouse: "Hollow Store", Outpost: "Ranger Post", Church: "Sacred Grove" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Forager", Settler: "Settler", Builder: "Craftsman", Priest: "Druid" },
    townHallTerrain: "Forest",
    houseTerrain: "Forest",
  },
  Dwarf: {
    label: "Dwarf",
    blurb: "Town Hall only on high mountain peaks. Mines also drain — and lock — adjacent mountain tiles.",
    buildingNames: { TownHall: "Great Mines", House: "Cave", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "The Great Forge", ArcherTower: "Archer Tower", Research: "Deep Archive", Warehouse: "Vault", Outpost: "Mining Camp", Church: "Shrine" },
    unitNames: { Soldier: "Warrior", Archer: "Boomstick", Scout: "Scout", Settler: "Great Digger", Builder: "Mason", Priest: "Cleric" },
    townHallTerrain: "HighMountain",
    houseTerrain: "Stone",
  },
  Undead: {
    label: "Undead",
    blurb: "Your territory becomes scorched earth, damaging anyone who isn't you.",
    buildingNames: { TownHall: "Crypt", House: "Grave", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "Altar", ArcherTower: "Archer Tower", Research: "Sepulcher", Warehouse: "Ossuary", Outpost: "Bone Camp", Church: "Unholy Shrine" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Scout", Settler: "Cryptkeeper", Necromancer: "Necromancer", Builder: "Ghoul", Priest: "Cultist" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
  },
};

export function raceDisplay(race: string | undefined): RaceDisplay {
  return RACE_DISPLAY[(race as Race) in RACE_DISPLAY ? (race as Race) : "Human"];
}
