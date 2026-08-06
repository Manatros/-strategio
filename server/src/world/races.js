// Central race definitions. Every race-specific number/rule lives here so
// Room.js and buildings.js stay generic and just look things up by race.
//
// Deliberately simplified vs. the full spec, flagged here rather than
// silently: tiles have exactly one `kind` at a time in this engine, so
// "claim converts tiles to forest/mountain IN ADDITION to their other type"
// is implemented as an outright kind overwrite, not true dual-typing.
// Dwarf "vaults increasing gold storage" isn't implemented — there's no
// storage-cap system in the game at all yet, for any resource.

export const RACES = ["Human", "Orc", "Elf", "Dwarf", "Undead"];

export const RACE_DATA = {
  Human: {
    buildingNames: { TownHall: "Town Hall", House: "House", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fishing Boat", Garrison: "Garrison", ArcherTower: "Archer Tower" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Scout", Settler: "Settler" },
    popPerTownHall: 2,
    popPerHouse: 4,
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
    startingRelation: "neutral",
    canTrade: true,
    startingUnits: ["Settler"],
    rateMultiplier: {},
  },
  Orc: {
    buildingNames: { TownHall: "Broodcave", House: "Tent", Lumberjack: "Wood Grunt", Mine: "Mine", Farm: "Collect", FishingBoat: "Fishing Boat", Garrison: "Garrison", ArcherTower: "Archer Tower" },
    unitNames: { Soldier: "Grunt", Archer: "Stonethrower", Scout: "Scout", Settler: "Settler", Brawler: "Brawler" },
    popPerTownHall: 4,
    popPerHouse: 3,
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
    startingRelation: "war",     // at war with everyone, always — including players who join later
    canTrade: false,             // no trade, no proposals, no accepting them either
    startingUnits: ["Soldier", "Soldier", "Settler"], // 2 playable units at game start, plus the shared starting Settler
    rateMultiplier: {},
    farmDepletesInstantly: true, // "Collect": one gather empties the whole tile for a flat 10 Bread
    canPillage: true,            // captures at 50% hp instead of 0%, plus a 20 Fish bonus
  },
  Elf: {
    buildingNames: { TownHall: "Living Tree", House: "Treehouse", Lumberjack: "Forester", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "Training Course", ArcherTower: "Archer Tower" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Forager", Settler: "Settler" },
    popPerTownHall: 2,
    popPerHouse: 4,
    townHallTerrain: "Forest",
    houseTerrain: "Forest",
    startingRelation: "open_borders", // open borders with everyone, always
    canTrade: true,
    startingUnits: ["Settler"],
    rateMultiplier: { Lumberjack: 0.6, Mine: 0.6, FishingBoat: 0.6 }, // "slowly collects"
    forestHeal: true,        // elf units on Forest heal 1 hp every 3 ticks
    claimConvertsToForest: true, // Living Tree's claim turns claimed Grass into Forest
    alwaysOpenBorders: true, // can cross ANY border, regardless of relation
  },
  Dwarf: {
    buildingNames: { TownHall: "Great Mines", House: "Cave", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "The Great Forge", ArcherTower: "Archer Tower" },
    unitNames: { Soldier: "Warrior", Archer: "Boomstick", Scout: "Scout", Settler: "Great Digger" },
    popPerTownHall: 4,
    popPerHouse: 3,
    townHallTerrain: "HighMountain",
    houseTerrain: "Stone",
    startingRelation: "neutral",
    canTrade: true,
    startingUnits: ["Settler"],
    rateMultiplier: {},
    mineWorksAdjacent: true,   // Mine also draws Stone+Gold from adjacent Stone/HighMountain, and blocks building on them
    scoutCrossesHighMountain: true,
  },
  Undead: {
    buildingNames: { TownHall: "Crypt", House: "Grave", Lumberjack: "Lumberjack", Mine: "Mine", Farm: "Farm", FishingBoat: "Fisherboat", Garrison: "Altar", ArcherTower: "Archer Tower" },
    unitNames: { Soldier: "Soldier", Archer: "Archer", Scout: "Scout", Settler: "Cryptkeeper", Necromancer: "Necromancer" },
    popPerTownHall: 10,
    popPerHouse: 1,
    townHallTerrain: "Grass",
    houseTerrain: "Grass",
    startingRelation: "neutral",
    canTrade: true,
    startingUnits: ["Settler"],
    rateMultiplier: {},
    scorchedEarth: true, // claimed tiles deal 1 dmg every 3 ticks to anyone standing on them who isn't the owner
    hpMultiplier: 0.2,   // -80% max health on every Undead unit, trained or raised
  },
};

export function raceOf(playerRace) {
  return RACE_DATA[playerRace] || RACE_DATA.Human;
}

/**
 * Resolves a unit's real stats for a given race: base UNIT_DEFS, layered
 * with any per-race override (cost/hp/etc.), then the race's overall hp
 * multiplier if it has one (e.g. Undead's -80%). Always use this instead of
 * reading UNIT_DEFS/RACE_UNIT_OVERRIDES directly when a unit is created.
 */
export function resolveUnitDef(race, kind, base, overrides) {
  const def = { ...(base[kind] || {}), ...(overrides[race]?.[kind] || {}) };
  if (!def.hp) return null;
  const mult = raceOf(race).hpMultiplier ?? 1;
  return { ...def, hp: Math.max(1, Math.round(def.hp * mult)) };
}

/** Per-race, per-unit-kind stat overrides layered on top of the base UNIT_DEFS. */
export const RACE_UNIT_OVERRIDES = {
  Orc: {
    Soldier: { hp: 25 },     // Grunt — no diplomacy, no mercy, extra hp
    Brawler: { cost: { Wood: 25, Stone: 15 }, popCost: 2, minUsedWorkers: 3, hp: 40, attackRange: 1 }, // more hp, more expensive
  },
  Dwarf: {
    Soldier: { hp: 25 },     // Warrior
  },
};