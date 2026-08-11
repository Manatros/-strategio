// Everything about a player's units besides combat: training them at a
// Garrison-equivalent, moving them, and merging 3 into a stronger one.
import { send } from "../net/wire.js";
import { key, hexDistance, canEnterTerrain } from "../world/hex.js";
import { UNIT_DEFS, UNIT_RACE_RESTRICTION, MAX_UNIT_LEVEL, UNITS_TO_MERGE, LEVEL_MULTIPLIER, TRAINING_TICKS, TRAINING_BUILDING, FORAGE_AMOUNT, FORAGE_COOLDOWN_MS, FORAGE_TILE_RESOURCE } from "../config/balance.js";
import { raceOf, RACE_UNIT_OVERRIDES, resolveUnitDef } from "../world/races.js";
import { applyResearchHpBonus } from "./research.js";
import { tryCaptureWarehouse } from "./combat.js";
import { canAfford } from "../world/economy.js";
import { uid } from "../utils/uid.js";
import { spendResources, creditResources } from "./humanEconomy.js";

const MAX_TRAIN_QUEUE = 4;

export function handleTrainUnit(room, player, msg) {
  const ws = room.clients.get(player.id);
  const kind = msg.kind;
  const restriction = UNIT_RACE_RESTRICTION[kind];
  if (restriction && player.race !== restriction) return send(ws, "build_rejected", { reason: "wrong_race" });

  const def = resolveUnitDef(player.race, kind, UNIT_DEFS, RACE_UNIT_OVERRIDES);
  if (!def) return;
  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;

  const building = room.buildings.get(key(q, r));
  const requiredBuildingKind = TRAINING_BUILDING[kind] || "Garrison";
  if (!building || building.kind !== requiredBuildingKind || building.ownerId !== player.id) {
    return send(ws, "build_rejected", { reason: `not_your_${requiredBuildingKind.toLowerCase()}` });
  }
  if (!building.constructed) return send(ws, "build_rejected", { reason: "still_constructing" });
  if (!building.trainQueue) building.trainQueue = [];
  if (building.trainQueue.length >= MAX_TRAIN_QUEUE) return send(ws, "build_rejected", { reason: "queue_full" });
  if (hexDistance({ q: player.q, r: player.r }, { q, r }) > 1) {
    return send(ws, "build_rejected", { reason: "too_far" });
  }
  if (player.usedWorkers < (def.minUsedWorkers || 0)) return send(ws, "build_rejected", { reason: "unit_locked" });
  if (player.popCap - player.usedWorkers < def.popCost) {
    return send(ws, "build_rejected", { reason: "not_enough_population" });
  }
  if (!canAfford(player.bank, def.cost)) return send(ws, "build_rejected", { reason: "cannot_afford" });

  // Resources and population are committed the moment something is queued, not when it starts
  // training or completes — matches "consumed when queueing them up," and makes the refund on
  // cancellation exact (see handleCancelTraining) rather than needing to track partial progress.
  spendResources(room, player, def.cost);
  player.usedWorkers += def.popCost;

  const ticksNeeded = TRAINING_TICKS[kind] ?? 6;
  building.trainQueue.push({ id: uid(), kind, ticksRemaining: ticksNeeded, totalTicks: ticksNeeded, playerId: player.id, cost: def.cost, popCost: def.popCost });

  room._sendBank(ws, player);
}

/** Cancels one queued (or in-progress) unit at a specific queue slot, refunding its full resource
 *  cost and population reservation — matches "when you remove a unit from queue they give all
 *  resources back," including one that's already partway through training (no partial refund;
 *  the whole point is undoing the commitment cleanly). */
export function handleCancelTraining(room, player, msg) {
  const ws = room.clients.get(player.id);
  const q = Number(msg.q), r = Number(msg.r);
  const index = Number(msg.index);
  if (!Number.isFinite(q) || !Number.isFinite(r) || !Number.isFinite(index)) return;

  const building = room.buildings.get(key(q, r));
  if (!building || building.ownerId !== player.id) return send(ws, "build_rejected", { reason: "not_your_building" });
  if (!building.trainQueue || index < 0 || index >= building.trainQueue.length) return;

  const [removed] = building.trainQueue.splice(index, 1);
  if (removed.playerId === player.id) {
    creditResources(room, player, removed.cost);
    player.usedWorkers = Math.max(0, player.usedWorkers - removed.popCost);
  }
  room._sendBank(ws, player);
}

/** Advances every building's training queue by one tick — only the FRONT item's countdown actually
 *  runs; everything behind it waits its turn. Spawns the unit and shifts the queue once it
 *  completes, so the next queued item (if any) starts counting down immediately. */
export function advanceTraining(room) {
  for (const building of room.buildings.values()) {
    if (!building.trainQueue || building.trainQueue.length === 0) continue;
    const front = building.trainQueue[0];
    front.ticksRemaining -= 1;
    if (front.ticksRemaining > 0) continue;

    building.trainQueue.shift();
    const { kind, playerId } = front;
    const player = room.players.get(playerId);
    if (!player) continue; // they left/died mid-training — cost already spent, nothing more to do

    const rd = raceOf(player.race);
    const spawn = room.findAdjacentPassable({ q: building.q, r: building.r }, rd.scoutCrossesHighMountain) || { q: building.q, r: building.r };
    const def = resolveUnitDef(player.race, kind, UNIT_DEFS, RACE_UNIT_OVERRIDES);
    if (!def) continue;
    const boostedDef = applyResearchHpBonus(player, kind, def);
    const unit = { id: uid(), kind, level: 1, guard: false, q: spawn.q, r: spawn.r, lastStepAt: 0, lastActionAt: 0, hp: boostedDef.hp, maxHp: boostedDef.hp, popCost: def.popCost || 1 };
    player.units.set(unit.id, unit);

    const ws = room.clients.get(playerId);
    if (ws) room._sendBank(ws, player);
  }
}

export function handleStepUnit(room, player, msg) {
  const ws = room.clients.get(player.id);
  const unit = player.units.get(msg.unitId);
  if (!unit) return;
  if (unit.kind === "Civilian") {
    return send(ws, "step_rejected", { unitId: unit.id, q: Number(msg.q), r: Number(msg.r), reason: "civilian_auto_controlled" });
  }

  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;

  if (hexDistance({ q: unit.q, r: unit.r }, { q, r }) !== 1) {
    return send(ws, "step_rejected", { unitId: unit.id, q, r, reason: "not_adjacent" });
  }
  const now = Date.now();
  if (now - unit.lastStepAt < room.stepCooldownFor(player, q, r)) {
    return send(ws, "step_rejected", { unitId: unit.id, q, r, reason: "too_soon" });
  }
  // Simplification: "can cross HighMountain" applies race-wide here, not just the Scout kind — see races.js note.
  const rd = raceOf(player.race);
  if (!canEnterTerrain(room.tiles.getAt(q, r), rd.scoutCrossesHighMountain)) {
    return send(ws, "step_rejected", { unitId: unit.id, q, r, reason: "impassable" });
  }
  const claim = room.claims.get(key(q, r));
  if (claim && claim.ownerId !== player.id) {
    const rel = room.getRelation(player.id, claim.ownerId);
    if (rel !== "war" && rel !== "open_borders") {
      return send(ws, "step_rejected", { unitId: unit.id, q, r, reason: "territory_blocked" });
    }
  }

  unit.q = q; unit.r = r; unit.lastStepAt = now;
  tryCaptureWarehouse(room, player, q, r);
}

/**
 * Merges 3 of the player's own same-kind, same-level units standing on one
 * tile into a single unit one level higher (max level MAX_UNIT_LEVEL). Any
 * other eligible group on that same tile merges too, in the same action.
 */
export function handleMergeUnits(room, player, msg) {
  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;

  const groups = new Map(); // "kind|level" -> [unitId, ...]
  for (const [id, u] of player.units) {
    if (u.q !== q || u.r !== r) continue;
    const level = u.level || 1;
    if (level >= MAX_UNIT_LEVEL) continue;
    const gk = `${u.kind}|${level}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(id);
  }

  let mergedAny = false;
  for (const [gk, ids] of groups) {
    if (ids.length < UNITS_TO_MERGE) continue;
    const [kind, levelStr] = gk.split("|");
    const newLevel = Number(levelStr) + 1;

    const baseDef = resolveUnitDef(player.race, kind, UNIT_DEFS, RACE_UNIT_OVERRIDES);
    if (!baseDef) continue;
    const newMaxHp = Math.max(1, Math.round(baseDef.hp * (LEVEL_MULTIPLIER[newLevel] || 1)));

    const consumedIds = ids.slice(0, UNITS_TO_MERGE);
    const reservedPop = consumedIds.reduce((sum, id) => sum + (player.units.get(id)?.popCost || 0), 0);
    for (const id of consumedIds) player.units.delete(id);
    const merged = { id: uid(), kind, level: newLevel, guard: false, q, r, lastStepAt: 0, lastActionAt: 0, hp: newMaxHp, maxHp: newMaxHp, popCost: reservedPop };
    player.units.set(merged.id, merged);
    mergedAny = true;
  }

  if (mergedAny) room._sendBank(room.clients.get(player.id), player); // no bank change, but nudges the client to refresh its unit panel
}

/** Toggles Guard mode: a guarding Soldier/Archer automatically attacks any enemy that comes within its range, no click needed. */
export function handleSetGuard(room, player, msg) {
  const unit = player.units.get(msg.unitId);
  if (!unit) return;
  unit.guard = !!msg.guard;
}

/**
 * Elf's Forager (a renamed Scout) ability: instantly gather FORAGE_AMOUNT of whatever resource
 * matches the tile it's standing on, straight into the player's bank (capped by storage, same as
 * any other resource gain). On a per-unit cooldown, not tied to any building — this is what makes
 * a "Forager" meaningfully different from every other race's plain exploration Scout.
 */
export function handleForage(room, player, msg) {
  const ws = room.clients.get(player.id);
  const unit = player.units.get(msg.unitId);
  if (!unit || unit.kind !== "Scout" || player.race !== "Elf") return;

  const now = Date.now();
  if (now - (unit.lastForageAt || 0) < FORAGE_COOLDOWN_MS) return send(ws, "build_rejected", { reason: "forage_on_cooldown" });

  const tile = room.tiles.getAt(unit.q, unit.r);
  const resourceKind = tile && FORAGE_TILE_RESOURCE[tile.kind];
  if (!resourceKind || (tile.resLeft ?? 0) <= 0) return send(ws, "build_rejected", { reason: "nothing_to_forage_here" });

  const amount = Math.min(FORAGE_AMOUNT, tile.resLeft);
  tile.resLeft -= amount;
  unit.lastForageAt = now;
  creditResources(room, player, { [resourceKind]: amount });
  room._sendBank(ws, player);
}
