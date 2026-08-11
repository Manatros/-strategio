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
export const UNIT_VISION_BONUS = { Scout: 1 }; // per-kind addition on top of SCOUT_VISION_RADIUS — only Scout gets extra range

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
export const TOWNHALL_STORAGE_BONUS = 60; // each constructed TownHall adds this much, per resource — must exceed the Warehouse's own 50/50 build cost, or a Human player relying on just their TownHall can never save up enough to ever build their first one
export const WAREHOUSE_STORAGE_BONUS = 50; // each constructed Warehouse adds this much, per resource
// Dwarf's Warehouse is flavored as a "Vault" — beyond the uniform WAREHOUSE_STORAGE_BONUS every
// race gets, it holds extra Gold specifically, matching a mining race actually caring about hoarding
// the stuff. Fills a gap the codebase's own races.js header comment used to flag as unimplemented.
export const DWARF_VAULT_GOLD_BONUS = 40;

export const BUILD_COST = {
  TownHall:    { Wood: 10, Stone: 10 },
  Lumberjack:  { Wood: 0, Stone: 10 },
  Farm:        { Wood: 10, Stone: 10 },
  Mine:        { Wood: 10, Stone: 0 },
  FishingBoat: { Wood: 18 },
  Bridge:      { Wood: 8 },
  House:       { Wood: 10, Stone: 10 },
  Garrison:    { Wood: 25, Stone: 20 },
  ArcherTower: { Wood: 20, Stone: 25 },
  Research:    { Wood: 50, Stone: 50 },
  Warehouse:   { Wood: 50, Stone: 50 },
  Outpost:     { Wood: 20, Stone: 10 },        // trains Settlers and Builders
  Church:      { Wood: 30, Stone: 15, Bread: 15 }, // trains Priests
  Monastery:   { Wood: 40, Stone: 20, Gold: 20 },  // Human-only — passively heals nearby own units, see MONASTERY_HEAL_* below
  Road:        { Wood: 5, Stone: 5 },          // Human-only — see ROAD_* constants below
};

// ---- Civilians (Human-only) --------------------------------------------
// See races.js's hasCivilians/civiliansPerHouse. Assignment is a simplified
// "travel timer" rather than full server-side pathfinding — a civilian
// reaches its new workplace after hexDistance * CIVILIAN_TICKS_PER_TILE
// ticks, then snaps there. A real router would be a substantial separate
// project (the server doesn't do pathfinding anywhere else either — the
// client does, and just sends individual validated steps); this captures
// "takes time to walk there" honestly without needing that.
export const CIVILIAN_TICKS_PER_TILE = 4; // matches Human's own unroaded base speed
export const HOUSE_UPGRADE_COST = { Wood: 20, Stone: 20 };
export const GATHERING_BUILDING_CAP = 15; // Human-only: a gathering building's own inventory caps here before civilians deliver it
export const CIVILIAN_RESPAWN_DELAY_MS = 60 * 1000; // how long after a Civilian dies before a replacement spawns at their home

// ---- Tiers (Human-only) --------------------------------------------------
// Gathering buildings: level 1 is the default (see races.js's gatherRadius for the base 1-tile
// rule). Level 2 needs the Advanced Gathering research and 50/50 more Wood/Stone, and only actually
// grants the (currently fixed at 1) radius bonus once MIN_WORKERS_GATHER_L2 civilians are staffed
// there — buying the upgrade alone isn't enough. Level 3 needs Tile Conversion research and costs
// 200/200 more, and unlocks the ability to convert adjacent tiles (the conversion action itself is
// not yet implemented — this only wires up the level-3 upgrade path and its worker requirement).
export const GATHERING_UPGRADE_COST = {
  2: { Wood: 50, Stone: 50 },
  3: { Wood: 200, Stone: 200 },
};
export const GATHERING_MAX_WORKERS = { 1: 2, 2: 3, 3: 5 };
export const GATHERING_MIN_WORKERS_FOR_RADIUS_BONUS = 3; // level 2's radius bonus needs this many actually staffed, not just the upgrade purchased
export const GATHERING_MIN_WORKERS_FOR_CONVERSION = 5;   // level 3's tile conversion needs this many staffed
export const TILE_CONVERSION_GOLD_COST = 10; // per tile
// Which terrain kind each gathering building converts a tile TO — matches what it actually collects from.
export const GATHERING_CONVERSION_TARGET = {
  Lumberjack: "Forest",
  Farm: "Fields",
  Mine: "Stone",
  FishingBoat: "Water",
};

// Warehouse: level 1 needs 1 civilian staffed to be considered "claimed"/active at all. Level 2
// (100 Wood/200 Stone) allows a second worker; level 3 (200 Wood/300 Stone) allows a third and
// raises the storage cap further. The level 2/3 "second/third worker actively roves the map
// collecting from gathering buildings" behavior described in the original spec is a substantial
// separate AI system and is NOT implemented yet — this only wires up the upgrade path and worker caps.
export const WAREHOUSE_UPGRADE_COST = {
  2: { Wood: 100, Stone: 200 },
  3: { Wood: 200, Stone: 300 },
};
export const WAREHOUSE_MAX_WORKERS = { 1: 1, 2: 2, 3: 3 };
export const WAREHOUSE_MIN_WORKERS_TO_CLAIM = 1;

// Monastery (Human-only): passively heals every one of the owner's own units within radius, no
// worker or click needed — same "just standing nearby" convention as Builder repair / Priest capture.
export const MONASTERY_HEAL_RADIUS = 2;
export const MONASTERY_HEAL_RATE = 1.5; // hp per second, per unit within radius

// ---- Roads (Human-only) ----------------------------------------------
// A road is a building like any other (placed, owned, has hp), but claims
// only a 1-tile radius (not the usual CLAIM_RADIUS) and exists purely to
// speed up movement — see baseTicksPerTile in races.js and ROAD_SPEED_TICKS
// below. "Connected" (for rendering, and for which tiles count as road for
// pathing) is computed on the fly from adjacency, not stored separately.
export const ROAD_CLAIM_RADIUS = 1;
export const ROAD_UPGRADE_COST = { Stone: 10 }; // basic -> stone road
// ticks-per-tile when the STEP DESTINATION is a road of this level (lower = faster).
// Human's un-roaded baseTicksPerTile is 4; a basic road roughly halves that, a
// stone road matches every other race's normal (unroaded) speed.
export const ROAD_SPEED_TICKS = { 1: 2, 2: 1 };

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
  Outpost: 15,
  Church: 20,
  Monastery: 20,
  Road: 5,
};

// ---- Units ----------------------------------------------------------
export const UNIT_DEFS = {
  Scout:      { cost: { Fish: 12 }, popCost: 1, minUsedWorkers: 0, hp: 8 },
  Soldier:    { cost: { Wood: 10, Stone: 10 }, popCost: 1, minUsedWorkers: 2, hp: 20 },
  Archer:     { cost: { Wood: 12, Fish: 6 }, popCost: 1, minUsedWorkers: 2, hp: 10 }, // 3x Soldier's range, so priced/gated to match rather than undercut it
  Settler:    { cost: { Wood: 20, Bread: 20 }, popCost: 2, minUsedWorkers: 0, hp: 10 }, // consumed founding a new TownHall
  Necromancer:{ cost: { Bread: 20, Stone: 10 }, popCost: 2, minUsedWorkers: 2, hp: 20 }, // Undead only; base hp set high since Undead's -80% multiplier hits this hard (see races.js)
  Priest:     { cost: { Bread: 15, Gold: 10 }, popCost: 1, minUsedWorkers: 0, hp: 12 }, // trained at Church -- cleanses scorched earth, captures buildings by standing on them
  Builder:    { cost: { Wood: 15 }, popCost: 1, minUsedWorkers: 0, hp: 8 }, // trained at Outpost -- can place buildings like the player character can
  // Civilians are never "trained" through the normal flow — they spawn automatically when a House
  // finishes construction (Human only, see races.js's hasCivilians). popCost:0 because they don't
  // consume population, they ARE the population; cost is empty for the same reason.
  Civilian:   { cost: {}, popCost: 0, minUsedWorkers: 0, hp: 5 },
};

/** Which building trains which unit — training used to be Garrison-only; Settler/Builder/Priest have their own. */
export const TRAINING_BUILDING = {
  Scout: "Garrison", Soldier: "Garrison", Archer: "Garrison", Necromancer: "Garrison", Brawler: "Garrison",
  Settler: "Outpost", Builder: "Outpost",
  Priest: "Church",
};

/** How long a Priest must stand still on an enemy building to capture it. */
export const PRIEST_CAPTURE_TICKS = 10;

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
  Priest: 8,        // 4s
  Builder: 6,       // 3s
};

/** Buildings that don't need an assigned worker — TownHall anchors territory, House is what creates population in the first place. */
export const WORKER_EXEMPT = new Set(["TownHall", "House", "Road", "Monastery"]);

// ---- Leveling ---------------------------------------------------------
export const MAX_UNIT_LEVEL = 3;
export const UNITS_TO_MERGE = 3;         // this many same-kind, same-level units merge into 1 of the next level
export const LEVEL_MULTIPLIER = { 1: 1, 2: 1.5, 3: 2 }; // scales both hp and attack damage

// ---- Combat -----------------------------------------------------------
export const ATTACK_DAMAGE = 1;          // per attack action, before level scaling

// Orc's Brawler ("elite unit") has no unique mechanic beyond base stats otherwise — Berserker
// gives it up to this much bonus damage (as a fraction) as its own hp drops, scaling linearly from
// 0% bonus at full hp to BERSERKER_MAX_BONUS at 0 hp. A wounded Brawler becomes more dangerous
// rather than just weaker, matching Orc's aggressive, don't-retreat flavor.
export const BERSERKER_MAX_BONUS = 0.5; // +50% damage at the very edge of death

// Elf's Scout is renamed "Forager" but had no unique mechanic to match — no other race gets a
// resource-gathering unit at all, so this gives Elf's exploration unit real economic utility
// instead of being purely a scouting tool, fitting the name. An active ability, not passive
// income: stand on a matching resource tile and use it, on a cooldown, capped by storage like any
// other resource gain.
export const FORAGE_AMOUNT = 8;          // per use
export const FORAGE_COOLDOWN_MS = 8000;  // 8s between uses, same unit or not
export const FORAGE_TILE_RESOURCE = { Forest: "Wood", Fields: "Bread", Stone: "Stone", Water: "Fish" };
export const ATTACK_COOLDOWN_TICKS = 2;  // ticks between one attack and the next, for any attacker

export const ATTACK_RANGE = {
  Soldier: 1,
  Archer: 3,
  ArcherTower: 5,
  Necromancer: 1,
  Brawler: 1,
};

export const PLAYER_MAX_HP = 100;

/**
 * Hero items — each player's own character has HERO_ITEM_SLOTS equipment slots. An item grants a
 * flat stat bonus while equipped; unequipping refunds its full Gold cost (items aren't consumed,
 * just worn or not). Kept deliberately small and flat (no rarity tiers, no random drops) as a
 * foundation — more depth (race-specific items, crafting, drops) can layer on top of this later
 * without changing the wire protocol.
 */
export const HERO_ITEM_SLOTS = 3;
export const HERO_ITEMS = {
  vitality_charm:  { id: "vitality_charm",  name: "Vitality Charm",  cost: { Gold: 30 }, statBonus: { maxHp: 30 } },
  greater_vitality: { id: "greater_vitality", name: "Greater Vitality Charm", cost: { Gold: 70 }, statBonus: { maxHp: 75 } },
  swift_boots:     { id: "swift_boots",     name: "Swift Boots",     cost: { Gold: 30 }, statBonus: { moveSpeedBonus: 1 } }, // -1 tick per step, floored at 1
  greater_boots:   { id: "greater_boots",   name: "Winged Boots",    cost: { Gold: 70 }, statBonus: { moveSpeedBonus: 2 } },
  war_talisman:    { id: "war_talisman",    name: "War Talisman",    cost: { Gold: 40 }, statBonus: { damageBonus: 2 } },
  greater_talisman:{ id: "greater_talisman",name: "Greater War Talisman", cost: { Gold: 90 }, statBonus: { damageBonus: 5 } },
};

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
    // Human-only 4th option: gates handleUpgradeHouse (rooms/civilians.js), checked directly by id
    // rather than through the generic effect-application system, since "unlock a capability" isn't
    // one of the numeric-bonus effect kinds research.js already knows how to apply.
    { id: "urban_planning", name: "Urban Planning", cost: { Gold: 30 }, effect: { kind: "unlockHouseUpgrade" } },
    { id: "advanced_gathering", name: "Advanced Gathering", cost: { Gold: 35 }, effect: { kind: "unlockGatheringUpgrade", level: 2 } },
    { id: "tile_conversion_tech", name: "Tile Conversion", cost: { Gold: 45 }, effect: { kind: "unlockGatheringUpgrade", level: 3 } },
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

/**
 * Building-unlock research — a separate mechanic from RESEARCH_OPTIONS above (which grants numeric
 * bonuses). This gates which OTHER buildings even show up as buildable at all: a building listed
 * here can't be placed until its unlock has been researched, and the research itself is done AT a
 * specific building (a TownHall or a Church), not the generic Research building.
 *
 * Only Human currently has entries — every other race's full build menu stays unlocked from the
 * start, matching how those races' economies already work without this system.
 */
export const BUILDING_UNLOCK_RESEARCH = {
  Human: {
    TownHall: [
      { id: "unlock_garrison",  name: "Garrison",  building: "Garrison",  cost: { Gold: 15 } },
      { id: "unlock_bridge",    name: "Bridge",     building: "Bridge",    cost: { Gold: 10 } },
      { id: "unlock_warehouse", name: "Warehouse",  building: "Warehouse", cost: { Gold: 20 } },
      { id: "unlock_outpost",   name: "Outpost",    building: "Outpost",   cost: { Gold: 20 } },
      { id: "unlock_church",    name: "Church",     building: "Church",    cost: { Gold: 25 } },
    ],
    Church: [
      { id: "unlock_monastery",    name: "Monastery",     building: "Monastery",    cost: { Gold: 20 } },
      { id: "unlock_garrison",     name: "Garrison",      building: "Garrison",     cost: { Gold: 15 } },
      { id: "unlock_archer_tower", name: "Archer Tower",  building: "ArcherTower",  cost: { Gold: 25 } },
    ],
  },
};

// Every building that appears anywhere in BUILDING_UNLOCK_RESEARCH above needs an unlock before
// it's buildable. Anything NOT in this set (TownHall, House, Lumberjack, Farm, Mine, FishingBoat,
// Road, and every non-Human race's whole roster) stays available from the start, same as today.
export const BUILDINGS_REQUIRING_UNLOCK = {
  Human: new Set(Object.values(BUILDING_UNLOCK_RESEARCH.Human).flat().map((opt) => opt.building)),
};

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