// src/core/races.ts
export const RACES = ["Human", "Orc", "Elf", "Dwarf", "Undead", "Hive"] as const;
export type Race = (typeof RACES)[number];

export type RaceDisplay = {
  label: string;
  blurb: string;
  buildingNames: Record<string, string>;
  unitNames: Record<string, string>;
  townHallTerrain: string;
  houseTerrain: string;
  /** The player's own hero-unit title and weapon/archetype flavor — shown in the UI, no mechanical effect on its own. */
  heroTitle: string;
  heroWeapon: string;
};

export const RACE_DISPLAY: Record<Race, RaceDisplay> = {
  Human: {
    label: "Human",
    blurb: "Moves slower than everyone else by default — build roads to catch up, or exceed it.",
    buildingNames: { TownHall: "Town Hall", House: "House", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fishing Boat", Garrison: "Garrison", ArcherTower: "Archer Tower", Research: "Library", Warehouse: "Warehouse", Outpost: "Outpost", Church: "Church", Road: "Road", Monastery: "Monastery" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Scout", Settler: "Settler", Builder: "Builder", Priest: "Priest" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
    heroTitle: "The King",
    heroWeapon: "sword and shield",
  },
  Orc: {
    label: "Orc",
    blurb: "Starts with 2 units and permanent war with everyone — no trade, no diplomacy, ever.",
    buildingNames: { TownHall: "Broodcave", House: "Tent", Lumberjack: "Wood Grunt", Mine: "Mine", Farm: "Collect", FishingBoat: "Fishing Boat", Garrison: "Garrison", ArcherTower: "Archer Tower", Research: "War Camp", Warehouse: "Stockpile", Outpost: "Raiding Post", Church: "Shaman Hut" },
    unitNames: { Soldier: "Grunt", Archer: "Stonethrower", Scout: "Scout", Settler: "Settler", Brawler: "Brawler", Builder: "Digger", Priest: "Shaman" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
    heroTitle: "The Warchief",
    heroWeapon: "a massive battle axe",
  },
  Elf: {
    label: "Elf",
    blurb: "Open borders with everyone by default. Forests heal your units over time.",
    buildingNames: { TownHall: "Living Tree", House: "Treehouse", Lumberjack: "Forester", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "Training Course", ArcherTower: "Archer Tower", Research: "Grove of Wisdom", Warehouse: "Hollow Store", Outpost: "Ranger Post", Church: "Sacred Grove" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Forager", Settler: "Settler", Builder: "Craftsman", Priest: "Druid" },
    townHallTerrain: "Forest",
    houseTerrain: "Forest",
    heroTitle: "The Ranger-General",
    heroWeapon: "a longbow",
  },
  Dwarf: {
    label: "Dwarf",
    blurb: "Town Hall only on high mountain peaks. Mines also drain — and lock — adjacent mountain tiles.",
    buildingNames: { TownHall: "Great Mines", House: "Cave", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "The Great Forge", ArcherTower: "Archer Tower", Research: "Deep Archive", Warehouse: "Vault", Outpost: "Mining Camp", Church: "Shrine" },
    unitNames: { Soldier: "Warrior", Archer: "Boomstick", Scout: "Scout", Settler: "Great Digger", Builder: "Mason", Priest: "Cleric" },
    townHallTerrain: "HighMountain",
    houseTerrain: "Stone",
    heroTitle: "The Thane",
    heroWeapon: "a heavy war mace",
  },
  Undead: {
    label: "Undead",
    blurb: "Your territory becomes scorched earth, damaging anyone who isn't you.",
    buildingNames: { TownHall: "Crypt", House: "Grave", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "Altar", ArcherTower: "Archer Tower", Research: "Sepulcher", Warehouse: "Ossuary", Outpost: "Bone Camp", Church: "Unholy Shrine" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Scout", Settler: "Cryptkeeper", Necromancer: "Necromancer", Builder: "Ghoul", Priest: "Cultist" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
    heroTitle: "The Dark Sorcerer",
    heroWeapon: "forbidden necromantic magic",
  },
  // Hive is a skeleton entry only — basics laid out (name, blurb, hero flavor) so the race exists
  // and can be selected/extended, but none of its actual gameplay mechanics (corruption, swarm
  // units, the counter-relationship with Elf's forests) are implemented yet. It currently plays
  // identically to Human under the hood until that work happens.
  Hive: {
    label: "Hive",
    blurb: "(In development) A swarm race — many low-health units, land corruption, countered by Elf's forests and cleansed by Priests.",
    buildingNames: { TownHall: "Hive Cluster", House: "Brood Nest", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fishing Boat", Garrison: "Spawning Pit", ArcherTower: "Archer Tower", Research: "Consciousness", Warehouse: "Larder", Outpost: "Outpost", Church: "Church" },
    unitNames: { Soldier: "Drone", Archer: "Spitter", Scout: "Scout", Settler: "Settler", Builder: "Builder", Priest: "Priest" },
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
    heroTitle: "The Hive Leader",
    heroWeapon: "claws and swarm instinct",
  },
};

export function raceDisplay(race: string | undefined): RaceDisplay {
  return RACE_DISPLAY[(race as Race) in RACE_DISPLAY ? (race as Race) : "Human"];
}
