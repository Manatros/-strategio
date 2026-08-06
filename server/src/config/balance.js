// Every number in this file affects gameplay balance, not correctness.
// Change values here to tune the game — nothing else should hardcode a
// balance number; other modules import from this file instead.

// ---- World / tick ----------------------------------------------------
export const DEFAULT_TICK_RATE = 2;      // ticks per second. Also defines "how long is 1 tile of movement".
export const HEX_SIZE = 22;              // must match the client's rendering hexSize.

// ---- Vision ------------------------------------------------------------
export const VISION_RADIUS = 5;          // around the player themself
export const BUILDING_VISION_RADIUS = 3; // around each owned building
export const SCOUT_VISION_RADIUS = 5;    // around each owned unit (Scouts etc.)

// ---- Territory -----------------------------------------------------
export const CLAIM_RADIUS = 2;           // how far a building's territory claim extends

// ---- Economy ------------------------------------------------------
export const STARTING_BANK = { Wood: 30, Stone: 30, Bread: 30, Fish: 30, Gold: 0 };

// ---- Storage --------------------------------------------------------
// A player's total capacity per resource is the sum of what every one of
// their constructed storage-granting buildings contributes. This is an
// aggregate model, not literal per-building inventories with nearest-
// building routing — that would need a much larger rework (every place
// that reads/writes a bank would need to become building-aware). The
// gameplay effect is the same either way: build more storage to hold more.
export const BASE_STORAGE_CAP = 30;      // every player has this much capacity even with zero buildings
export const TOWNHALL_STORAGE_BONUS = 20; // each constructed TownHall adds this much, per resource
export const WAREHOUSE_STORAGE_BONUS = 50; // each constructed Warehouse adds this much, per resource

export const BUILD_COST = {
  TownHall:    { Wood: 15, Stone: 15 },
  Lumberjack:  { Wood: 15, Stone: 10 },
  Farm:        { Wood: 10, Stone: 10 },
  Mine:        { Wood: 10, Stone: 20 },
  FishingBoat: { Wood: 18 },
  Bridge:      { Wood: 8 },
  House:       { Bread: 15 },
  Garrison:    { Wood: 25, Stone: 20 },
  ArcherTower: { Wood: 20, Stone: 25 },
  Research:    { Wood: 25, Stone: 15, Bread: 10 },
  Warehouse:   { Wood: 30, Stone: 20 },
};

// Tiered by how gated/valuable the resource is downstream — Wood is needed
// everywhere and stays fastest; Stone gates military, storage, and research
// and is deliberately the slowest to accumulate.
export const GATHER_RATE = {
  Lumberjack: 0.9,   // Wood — abundant, used by nearly everything
  FishingBoat: 0.75, // Fish — mid-tier, mainly gates Scouts
  Farm: 0.7,         // Bread — gates population growth and Settlers
  Mine: 0.55,        // Stone — gates military buildings, Warehouse, Research
  TownHallSelf: 0.15,
  TownHallAdj: 0.08,
};

export const DWARF_MINE_ADJACENT_RATE = 0.3; // Stone(+Gold) per second, per adjacent Stone/HighMountain tile

// A depleted (or partially-gathered) resource tile slowly regenerates back toward its original
// endowment over time — resources aren't a strictly finite one-time thing, they just take a while
// to recover once drained. 1 unit per 30 seconds, checked every few ticks rather than every single
// tick (30s of imprecision from a coarser check cadence doesn't matter for a 30s-per-unit rate).
export const TILE_REGEN_RATE = 1 / 30; // per second
export const TILE_REGEN_CHECK_TICKS = 4; // how often (in ticks) the regen pass runs

// ---- Population ---------------------------------------------------
// Per-race pop bonuses live in races.js (RACE_DATA) since they vary by race;
// this is only the shared, race-independent piece.

// ---- Construction ---------------------------------------------------
// Construction time scales with how "big" a building is — sum its resource
// cost and scale that into ticks, clamped to a sane range. A Bridge (cost 8)
// goes up fast; a TownHall (cost 60) takes meaningfully longer than a House.
function totalCost(cost) {
  return Object.values(cost).reduce((sum, v) => sum + v, 0);
}
export const CONSTRUCTION_TICKS = Object.fromEntries(
  Object.entries(BUILD_COST).map(([kind, cost]) => [kind, Math.min(24, Math.max(4, Math.round(totalCost(cost) * 0.3)))])
);

export const BUILDING_HEALTH = {
  TownHall: 50,
  Lumberjack: 10,
  Farm: 10,
  Mine: 10,
  FishingBoat: 10,
  Bridge: 10,
  House: 10,
  Garrison: 10,
  ArcherTower: 30,
  Research: 20,
  Warehouse: 40,
};

// ---- Units ----------------------------------------------------------
export const UNIT_DEFS = {
  Scout:      { cost: { Fish: 12 }, popCost: 1, minUsedWorkers: 0, hp: 8 },
  Soldier:    { cost: { Wood: 10, Stone: 10 }, popCost: 1, minUsedWorkers: 2, hp: 20 },
  Archer:     { cost: { Wood: 12, Fish: 6 }, popCost: 1, minUsedWorkers: 2, hp: 10 }, // 3x Soldier's range, so priced/gated to match rather than undercut it
  Settler:    { cost: { Wood: 20, Bread: 20 }, popCost: 2, minUsedWorkers: 0, hp: 10 }, // consumed founding a new TownHall
  Necromancer:{ cost: { Bread: 20, Stone: 10 }, popCost: 2, minUsedWorkers: 2, hp: 20 }, // Undead only; base hp set high since Undead's -80% multiplier hits this hard (see races.js)
};

/** Units restricted to a single race, beyond the shared roster every race can train. */
export const UNIT_RACE_RESTRICTION = { Necromancer: "Undead", Brawler: "Orc" };

// Training now takes real time instead of completing the instant you can
// afford it — roughly scaled to how strategically significant the unit is.
export const TRAINING_TICKS = {
  Scout: 4,        // 2s — cheap, meant to be fielded quickly
  Soldier: 6,       // 3s
  Archer: 6,        // 3s — matches Soldier now that it's priced/gated the same
  Settler: 8,       // 4s — founds a whole new town, worth the wait
  Necromancer: 10,  // 5s — Undead's elite unit
  Brawler: 10,      // 5s — Orc's elite unit
};

/** Buildings that don't need an assigned worker — TownHall anchors territory, House is what creates population in the first place. */
export const WORKER_EXEMPT = new Set(["TownHall", "House"]);

// ---- Leveling ---------------------------------------------------------
export const MAX_UNIT_LEVEL = 3;
export const UNITS_TO_MERGE = 3;         // this many same-kind, same-level units merge into 1 of the next level
export const LEVEL_MULTIPLIER = { 1: 1, 2: 1.5, 3: 2 }; // scales both hp and attack damage

// ---- Combat -----------------------------------------------------------
export const ATTACK_DAMAGE = 1;          // per attack action, before level scaling
export const ATTACK_COOLDOWN_TICKS = 2;  // ticks between one attack and the next, for any attacker

export const ATTACK_RANGE = {
  Soldier: 1,
  Archer: 3,
  ArcherTower: 5,
  Necromancer: 1,
  Brawler: 1,
};

export const PLAYER_MAX_HP = 100;

// ---- Scoring ----------------------------------------------------------
export const SCORE = {
  gatherPerUnit: 1,      // per unit of resource gathered
  claimPerTile: 1,       // per newly-claimed tile of territory
  captureBuilding: 20,   // reducing a non-TownHall enemy building to 0 hp transfers it to you
  destroyTownHall: 50,   // reducing an enemy TownHall to 0 hp destroys it outright
  killPlayer: 30,        // reducing an enemy player's own health to 0
};

export const DEMOLISH_REFUND_FRACTION = 0.5; // fraction of original build cost returned when demolishing

// ---- Research ----------------------------------------------------------
// A deliberately-scoped starting version of a fuller tech tree: each race
// has exactly 3 independent (not mutually exclusive) unlocks, each a flat
// bonus. Real strategic choice comes from which to afford/build first, not
// from branching prerequisites — that's the honest scope of this pass.

export const RESEARCH_OPTIONS = {
  Human: [
    { id: "trade_routes", name: "Trade Routes", cost: { Gold: 25 }, effect: { kind: "gatherBonus", buildings: ["Lumberjack", "Farm", "Mine", "FishingBoat"], mult: 1.2 } },
    { id: "masonry",      name: "Masonry",      cost: { Gold: 25 }, effect: { kind: "unitHpBonus", units: ["Soldier", "Archer"], mult: 1.2 } },
    { id: "census",       name: "Census",       cost: { Gold: 35 }, effect: { kind: "popBonus", amount: 5 } },
  ],
  Orc: [
    { id: "blood_rage", name: "Blood Rage", cost: { Gold: 25 }, effect: { kind: "unitHpBonus", units: ["Soldier"], mult: 1.3 } },
    { id: "raiding",    name: "Raiding",     cost: { Gold: 25 }, effect: { kind: "gatherBonus", buildings: ["Lumberjack", "Mine", "FishingBoat"], mult: 1.2 } },
    { id: "warband",    name: "Warband",     cost: { Gold: 35 }, effect: { kind: "popBonus", amount: 5 } },
  ],
  Elf: [
    { id: "elder_wisdom", name: "Elder Wisdom", cost: { Gold: 25 }, effect: { kind: "gatherBonus", buildings: ["Lumberjack", "Farm", "Mine", "FishingBoat"], mult: 1.2 } },
    { id: "woodcraft",    name: "Woodcraft",     cost: { Gold: 25 }, effect: { kind: "unitHpBonus", units: ["Scout"], mult: 1.3 } },
    { id: "grove_growth", name: "Grove Growth",  cost: { Gold: 35 }, effect: { kind: "popBonus", amount: 5 } },
  ],
  Dwarf: [
    { id: "deep_mining",   name: "Deep Mining",   cost: { Gold: 20 }, effect: { kind: "gatherBonus", buildings: ["Mine"], mult: 1.3 } }, // cheaper -- Dwarves have a second Gold source
    { id: "runesmithing",  name: "Runesmithing",  cost: { Gold: 20 }, effect: { kind: "unitHpBonus", units: ["Soldier", "Archer"], mult: 1.2 } },
    { id: "mountain_halls",name: "Mountain Halls",cost: { Gold: 30 }, effect: { kind: "popBonus", amount: 5 } },
  ],
  Undead: [
    { id: "necrotic_might", name: "Necrotic Might", cost: { Gold: 25 }, effect: { kind: "unitHpBonus", units: ["Soldier", "Archer", "Scout", "Necromancer"], mult: 1.3 } },
    { id: "soul_harvest",   name: "Soul Harvest",   cost: { Gold: 25 }, effect: { kind: "gatherBonus", buildings: ["Lumberjack", "Farm", "Mine", "FishingBoat"], mult: 1.2 } },
    { id: "crypt_expansion",name: "Crypt Expansion",cost: { Gold: 35 }, effect: { kind: "popBonus", amount: 5 } },
  ],
};

// Research now takes real time too, scaled to its Gold cost — same 0.6
// ticks-per-Gold formula applied uniformly across every race's options.
function researchTicks(goldCost) {
  return Math.max(6, Math.round(goldCost * 0.6));
}
for (const options of Object.values(RESEARCH_OPTIONS)) {
  for (const opt of options) opt.ticks = researchTicks(opt.cost.Gold || 0);
}

// Research buildings passively generate a small Gold trickle for every race — otherwise only
// Dwarves (who can mine HighMountain) would ever be able to afford Gold-priced research at all.
export const RESEARCH_GOLD_RATE = 0.15; // Gold per second, per constructed Research building

// ---- Guard (auto-attack) -----------------------------------------------
export const GUARD_CHECK_TICKS = 1; // how often (in ticks) a guarding unit scans for a target in range

// ---- Session ----------------------------------------------------------
export const DISCONNECT_GRACE_MS = 5 * 60 * 1000; // how long a disconnected (not dead) player's state is kept for resume
export const PROPOSAL_MAX_AGE_MS = 2 * 60 * 1000; // how long an unanswered trade/demand/open-borders proposal lingers

export const PLAYER_COLORS = [
  0xff5555, 0x55c7ff, 0x7bd88f, 0xffb85c, 0xd88cff, 0xffe45c, 0x6bffe0, 0xff8ac2,
  0xe63946, 0x2196f3, 0x4caf50, 0xff9800, 0x9c27b0, 0xffeb3b, 0x009688, 0xe91e63,
  0x8b0000, 0x006994, 0x2e7d32, 0xf4511e, 0x6a1b9a, 0xc0ca33, 0x00796b, 0xad1457,
  0xff6f61, 0x03a9f4, 0x8bc34a, 0xffa726, 0x7e57c2, 0xfff176, 0x26a69a, 0xf06292,
]; // 32 distinct colors — one per max-player slot