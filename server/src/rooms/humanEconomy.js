// Human's building-based storage economy. Every other race keeps the
// simple flat player.bank pool, completely untouched by anything here.
//
// For Human, player.bank is no longer independently mutable — it's always
// a recomputed SUM of orphanedBank (see below) plus what their storage
// buildings actually hold. recomputeHumanBank() must be called after
// anything that changes either of those, or the aggregate goes stale.
//
// orphanedBank exists to solve a real chicken-and-egg problem: a player
// starts with resources before they own a single building. Without
// tracking that pool explicitly, spending it (e.g. to build their very
// first TownHall) would have nothing to actually draw down, and the next
// recompute would silently wipe it to zero instead of reflecting the
// spend. orphanedBank only ever shrinks (spent, or absorbed into a newly
// built storage building) — nothing ever tops it back up, so there's no
// way to exploit it as unlimited hidden capacity.
import { raceOf } from "../world/races.js";
import { spend as spendBank, add as addBank } from "../world/economy.js";
import { TOWNHALL_STORAGE_BONUS, WAREHOUSE_STORAGE_BONUS, GATHERING_BUILDING_CAP } from "../config/balance.js";
import { neighbors } from "../world/hex.js";

const GATHER_RESOURCE_BY_KIND = { Lumberjack: "Wood", Farm: "Bread", Mine: "Stone", FishingBoat: "Fish" };
const GATHER_TILE_BY_KIND = { Lumberjack: "Forest", Farm: "Fields", Mine: "Stone", FishingBoat: "Water" };
const TILE_KIND_TO_RESOURCE = { Forest: "Wood", Fields: "Bread", Stone: "Stone", Water: "Fish" };
const HUMAN_GATHER_TICKS = 6; // flat: 1 resource every 6 ticks, regardless of building kind, while a worker is present
const TAX_TICKS = 30; // a House generates 1 Gold per working Civilian that calls it home, every 30 ticks

/** True if at least one Civilian assigned to this building is physically standing there right now
 *  (not off on a delivery/roving trip) — gathering only happens while someone's actually present,
 *  matching real workers actually being at their post rather than the abstract "assigned" count. */
function hasPresentWorker(room, building) {
  const owner = room.players.get(building.ownerId);
  if (!owner) return false;
  for (const u of owner.units.values()) {
    if (u.kind === "Civilian" && u.assignedTo === building.id && u.q === building.q && u.r === building.r) return true;
  }
  return false;
}

/**
 * Advances Human gathering for one building — discrete and tick-based (1 resource every
 * HUMAN_GATHER_TICKS ticks, the same flat rate for every gathering building kind), and only while
 * a worker is actually present at the building. A TownHall now requires a present worker too
 * (matching a Warehouse) and gathers from whichever adjacent tile currently has a resource, rather
 * than the old always-on passive trickle.
 */
export function advanceHumanGathering(room, building) {
  if (!building.constructed || !hasPresentWorker(room, building)) return;
  const owner = room.players.get(building.ownerId);
  if (!owner) return;

  building.gatherCounter = (building.gatherCounter || 0) + 1;
  if (building.gatherCounter < HUMAN_GATHER_TICKS) return;
  building.gatherCounter = 0;

  if (building.kind === "TownHall") {
    if (!building.inventory) building.inventory = { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 };
    const cap = storageCapFor("TownHall");
    for (const n of neighbors(building.q, building.r)) {
      const t = room.tiles.getAt(n.q, n.r);
      const resKind = t && TILE_KIND_TO_RESOURCE[t.kind];
      if (!resKind || (t.resLeft ?? 0) <= 0) continue;
      if ((building.inventory[resKind] || 0) >= cap) continue;
      t.resLeft -= 1;
      building.inventory[resKind] = Math.min(cap, (building.inventory[resKind] || 0) + 1);
      owner.score += 1; owner.stats.gathered += 1;
      recomputeHumanBank(room, owner);
      return;
    }
    return;
  }

  const resKind = GATHER_RESOURCE_BY_KIND[building.kind];
  if (!resKind) return;
  const t = room.tiles.getAt(building.q, building.r);
  if (!t || (t.resLeft ?? 0) <= 0) return;
  if (!building.inventory) building.inventory = { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 };
  if ((building.inventory[resKind] || 0) >= GATHERING_BUILDING_CAP) return; // full — the worker should be delivering, not gathering more
  t.resLeft -= 1;
  building.inventory[resKind] = Math.min(GATHERING_BUILDING_CAP, (building.inventory[resKind] || 0) + 1);
  owner.score += 1; owner.stats.gathered += 1;
}

const RESOURCE_KEYS = ["Wood", "Stone", "Bread", "Fish", "Gold"];
const STORAGE_KINDS = new Set(["TownHall", "Warehouse"]);

export function storageCapFor(kind) {
  if (kind === "TownHall") return TOWNHALL_STORAGE_BONUS;
  if (kind === "Warehouse") return WAREHOUSE_STORAGE_BONUS;
  return 0;
}

/** Every constructed storage building this player owns. */
function storageBuildings(room, player) {
  return [...room.buildings.values()].filter(
    (b) => b.ownerId === player.id && b.constructed && STORAGE_KINDS.has(b.kind)
  );
}

/** Recomputes player.bank as orphanedBank + the sum of all storage buildings' own inventories.
 *  Call after any change to either. */
export function recomputeHumanBank(room, player) {
  const totals = { ...(player.orphanedBank || { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 }) };
  for (const b of storageBuildings(room, player)) {
    if (!b.inventory) continue;
    for (const k of RESOURCE_KEYS) totals[k] = (totals[k] || 0) + (b.inventory[k] || 0);
  }
  player.bank = totals;
}

/** Human-only, total capacity across every constructed storage building — no base amount, unlike
 *  every other race's storageCap(). Zero buildings really does mean zero building capacity (though
 *  any still-orphaned starting resources remain spendable regardless — see orphanedBank above). */
export function humanStorageCap(room, player) {
  let total = 0;
  for (const b of storageBuildings(room, player)) total += storageCapFor(b.kind);
  return { Wood: total, Stone: total, Bread: total, Fish: total, Gold: total };
}

/** Called when a Human TownHall/Warehouse finishes construction: gives it an empty inventory, then
 *  tops it up from orphanedBank (in practice: their starting resources, the first time this runs). */
export function initStorageInventory(room, player, building) {
  building.inventory = { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 };
  if (!player.orphanedBank) player.orphanedBank = { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 };
  const cap = storageCapFor(building.kind);
  for (const k of RESOURCE_KEYS) {
    const transfer = Math.min(cap, player.orphanedBank[k] || 0);
    building.inventory[k] = transfer;
    player.orphanedBank[k] -= transfer;
  }
  recomputeHumanBank(room, player);
}

/**
 * Drains `cost` from storage buildings first (TownHall, then Warehouses), then from orphanedBank
 * for whatever's left. Caller must have already confirmed canAfford(player.bank, cost) — that
 * check still works unchanged, since player.bank is always kept in sync with what's really spendable.
 */
export function drainHumanStorage(room, player, cost) {
  if (!player.orphanedBank) player.orphanedBank = { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 };
  const buildings = storageBuildings(room, player).sort((a) => (a.kind === "TownHall" ? -1 : 1));

  for (const k of RESOURCE_KEYS) {
    let remaining = cost[k] || 0;
    if (remaining <= 0) continue;
    for (const b of buildings) {
      if (remaining <= 0) break;
      const take = Math.min(b.inventory?.[k] || 0, remaining);
      b.inventory[k] -= take;
      remaining -= take;
    }
    if (remaining > 0) {
      const take = Math.min(player.orphanedBank[k] || 0, remaining);
      player.orphanedBank[k] -= take;
      remaining -= take;
    }
    // If canAfford() was correctly checked beforehand, remaining should be 0 here. If it somehow
    // isn't (a caller skipped that check), we just don't manufacture negative resources — the
    // player ends up having paid what they actually had, not more.
  }
  recomputeHumanBank(room, player);
}

/** Unified spend: Human drains real building storage (+ orphanedBank), everyone else keeps the plain bank pool. */
export function spendResources(room, player, cost) {
  if (raceOf(player.race).hasCivilians) drainHumanStorage(room, player, cost);
  else spendBank(player.bank, cost);
}

/** Credits `amounts` into storage buildings (TownHall first, then Warehouses), clamped to each
 *  building's own remaining capacity. Any amount that doesn't fit anywhere is lost — matches
 *  spend/drain's honest building-based-capacity spirit rather than silently overflowing into
 *  orphanedBank (which would otherwise become an exploitable unlimited-capacity loophole). */
export function creditHumanStorage(room, player, amounts) {
  const buildings = storageBuildings(room, player).sort((a) => (a.kind === "TownHall" ? -1 : 1));
  for (const k of RESOURCE_KEYS) {
    let remaining = amounts[k] || 0;
    if (remaining <= 0) continue;
    for (const b of buildings) {
      if (remaining <= 0) break;
      const cap = storageCapFor(b.kind);
      const capRemaining = Math.max(0, cap - (b.inventory?.[k] || 0));
      const give = Math.min(capRemaining, remaining);
      b.inventory[k] += give;
      remaining -= give;
    }
  }
  recomputeHumanBank(room, player);
}

/** Unified credit: Human deposits into real building storage, everyone else keeps the plain bank pool. */
export function creditResources(room, player, amounts) {
  if (raceOf(player.race).hasCivilians) creditHumanStorage(room, player, amounts);
  else addBank(player.bank, amounts);
}

/**
 * Advances one House's tax generation for one tick — 1 Gold every TAX_TICKS ticks for each
 * working Civilian (assignedTo set) who calls this House home, accumulating in house.taxGold until
 * a TownHall/Warehouse worker physically collects it (see civilians.js's roving collection, which
 * treats a House's tax gold the same way it treats a gathering building's stock). Runs
 * independently of whether a collector is present — taxes pile up on their own; only picking them
 * up requires a worker.
 */
export function advanceHouseTax(room, house) {
  if (!house.constructed) return;
  const owner = room.players.get(house.ownerId);
  if (!owner) return;

  let workingResidents = 0;
  for (const u of owner.units.values()) {
    if (u.kind === "Civilian" && u.homeBuildingId === house.id && u.assignedTo) workingResidents++;
  }
  if (workingResidents === 0) return;

  house.taxCounter = (house.taxCounter || 0) + 1;
  if (house.taxCounter < TAX_TICKS) return;
  house.taxCounter = 0;
  house.taxGold = (house.taxGold || 0) + workingResidents;
}
