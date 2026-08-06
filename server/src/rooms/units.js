// Everything about a player's units besides combat: training them at a
// Garrison-equivalent, moving them, and merging 3 into a stronger one.
import { send } from "../net/wire.js";
import { key, hexDistance, canEnterTerrain } from "../world/hex.js";
import { UNIT_DEFS, UNIT_RACE_RESTRICTION, MAX_UNIT_LEVEL, UNITS_TO_MERGE, LEVEL_MULTIPLIER, TRAINING_TICKS } from "../config/balance.js";
import { raceOf, RACE_UNIT_OVERRIDES, resolveUnitDef } from "../world/races.js";
import { applyResearchHpBonus } from "./research.js";
import { tryCaptureWarehouse } from "./combat.js";
import { canAfford, spend } from "../world/economy.js";
import { uid } from "../utils/uid.js";

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
  if (!building || building.kind !== "Garrison" || building.ownerId !== player.id) {
    return send(ws, "build_rejected", { reason: "not_your_garrison" });
  }
  if (!building.constructed) return send(ws, "build_rejected", { reason: "still_constructing" });
  if (building.pendingTrain) return send(ws, "build_rejected", { reason: "already_training" });
  if (hexDistance({ q: player.q, r: player.r }, { q, r }) > 1) {
    return send(ws, "build_rejected", { reason: "too_far" });
  }
  if (player.usedWorkers < (def.minUsedWorkers || 0)) return send(ws, "build_rejected", { reason: "unit_locked" });
  if (player.popCap - player.usedWorkers < def.popCost) {
    return send(ws, "build_rejected", { reason: "not_enough_population" });
  }
  if (!canAfford(player.bank, def.cost)) return send(ws, "build_rejected", { reason: "cannot_afford" });

  spend(player.bank, def.cost);
  player.usedWorkers += def.popCost;

  const ticksNeeded = TRAINING_TICKS[kind] ?? 6;
  building.pendingTrain = { kind, ticksRemaining: ticksNeeded, totalTicks: ticksNeeded, playerId: player.id };

  room._sendBank(ws, player);
}

/** Advances every Garrison's in-progress training queue by one tick, spawning the unit once it completes. */
export function advanceTraining(room) {
  for (const building of room.buildings.values()) {
    if (building.kind !== "Garrison" || !building.pendingTrain) continue;
    building.pendingTrain.ticksRemaining -= 1;
    if (building.pendingTrain.ticksRemaining > 0) continue;

    const { kind, playerId } = building.pendingTrain;
    building.pendingTrain = null;
    const player = room.players.get(playerId);
    if (!player) continue; // they left/died mid-training — cost already spent, nothing more to do

    const rd = raceOf(player.race);
    const spawn = room.findAdjacentPassable({ q: building.q, r: building.r }, rd.scoutCrossesHighMountain) || { q: building.q, r: building.r };
    const def = resolveUnitDef(player.race, kind, UNIT_DEFS, RACE_UNIT_OVERRIDES);
    if (!def) continue;
    const boostedDef = applyResearchHpBonus(player, kind, def);
    const unit = { id: uid(), kind, level: 1, guard: false, q: spawn.q, r: spawn.r, lastStepAt: 0, lastActionAt: 0, hp: boostedDef.hp, maxHp: boostedDef.hp };
    player.units.set(unit.id, unit);

    const ws = room.clients.get(playerId);
    if (ws) room._sendBank(ws, player);
  }
}

export function handleStepUnit(room, player, msg) {
  const ws = room.clients.get(player.id);
  const unit = player.units.get(msg.unitId);
  if (!unit) return;

  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;

  const now = Date.now();
  if (now - unit.lastStepAt < room.stepCooldownMs) {
    return send(ws, "step_rejected", { unitId: unit.id, q, r, reason: "too_soon" });
  }
  if (hexDistance({ q: unit.q, r: unit.r }, { q, r }) !== 1) {
    return send(ws, "step_rejected", { unitId: unit.id, q, r, reason: "not_adjacent" });
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

    for (const id of ids.slice(0, UNITS_TO_MERGE)) player.units.delete(id);
    const merged = { id: uid(), kind, level: newLevel, guard: false, q, r, lastStepAt: 0, lastActionAt: 0, hp: newMaxHp, maxHp: newMaxHp };
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