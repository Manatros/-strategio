// Combat: attack resolution shared by player-commanded attacks and
// autonomous tower fire, plus the tower's own targeting loop.
import { send } from "../net/wire.js";
import { key, hexDistance } from "../world/hex.js";
import { UNIT_DEFS, ATTACK_DAMAGE, ATTACK_RANGE, LEVEL_MULTIPLIER, SCORE, BASE_STORAGE_CAP, WAREHOUSE_STORAGE_BONUS, CIVILIAN_RESPAWN_DELAY_MS, BERSERKER_MAX_BONUS } from "../config/balance.js";
import { raceOf, RACE_UNIT_OVERRIDES, resolveUnitDef } from "../world/races.js";
import { getRelation } from "./diplomacy.js";
import { applyResearchHpBonus } from "./research.js";
import { releaseCiviliansFrom } from "./civilians.js";
import { recomputeHumanBank, storageCapFor, creditHumanStorage } from "./humanEconomy.js";
import { uid } from "../utils/uid.js";

export function handleAttack(room, player, msg) {
  const unit = player.units.get(msg.unitId);
  if (!unit || !ATTACK_RANGE[unit.kind]) return;

  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;
  if (hexDistance({ q: unit.q, r: unit.r }, { q, r }) > ATTACK_RANGE[unit.kind]) return;

  const now = Date.now();
  if (now - (unit.lastActionAt || 0) < room.attackCooldownMs) return;
  unit.lastActionAt = now;

  let damage = ATTACK_DAMAGE * (LEVEL_MULTIPLIER[unit.level || 1] || 1);
  if (unit.kind === "Brawler" && unit.maxHp > 0) {
    // Berserker: up to +50% damage as this Brawler's own hp drops, scaling linearly down to 0 hp.
    const hpFraction = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
    damage *= 1 + (1 - hpFraction) * BERSERKER_MAX_BONUS;
  }
  resolveAttack(room, player, q, r, unit.kind, damage);
}

/**
 * Shared damage/outcome resolution for player-commanded attacks and
 * autonomous tower fire. attackerUnitKind is null for tower fire (towers
 * never pillage or raise dead — those are unit-specific abilities).
 */
export function resolveAttack(room, attackerPlayer, q, r, attackerUnitKind = null, damage = ATTACK_DAMAGE) {
  const posKey = key(q, r);
  const rd = raceOf(attackerPlayer.race);

  const building = room.buildings.get(posKey);
  if (building && building.ownerId !== attackerPlayer.id) {
    if (getRelation(room, attackerPlayer.id, building.ownerId) !== "war") return false;

    if (building.kind === "Warehouse") {
      // Can't be destroyed and can't be captured just by attacking it — damage only
      // weakens it down to a 1 hp floor. Actually taking it over requires a unit to
      // physically stand on it once it's at that floor (see tryCaptureWarehouse).
      building.hp = Math.max(1, building.hp - damage);
      return true;
    }

    building.hp -= damage;

    // Orc pillage: a non-TownHall building at half hp or below is captured immediately, plus a resource bonus.
    if (building.kind !== "TownHall" && rd.canPillage && building.hp > 0 && building.hp <= building.maxHp / 2) {
      const oldOwner = room.players.get(building.ownerId);
      if (oldOwner && building.kind === "House" && !raceOf(oldOwner.race).hasCivilians) oldOwner.popCap = Math.max(0, oldOwner.popCap - raceOf(oldOwner.race).popPerHouse);
      if (oldOwner) releaseCiviliansFrom(room, building);
      building.ownerId = attackerPlayer.id;
      building.hp = building.maxHp;
      room.transferClaimsAround(building, attackerPlayer.id, attackerPlayer.color);
      attackerPlayer.bank.Fish = (attackerPlayer.bank.Fish || 0) + 20;
      attackerPlayer.score += SCORE.captureBuilding;
      attackerPlayer.stats.captured += 1;
      return true;
    }

    if (building.hp <= 0) {
      const oldOwner = room.players.get(building.ownerId);
      if (building.kind === "TownHall") {
        room.releaseClaimsAround(building);
        if (oldOwner) releaseCiviliansFrom(room, building);
        room.buildings.delete(posKey);
        attackerPlayer.score += SCORE.destroyTownHall;
        attackerPlayer.stats.destroyed += 1;
        if (oldOwner && !raceOf(oldOwner.race).hasCivilians) oldOwner.popCap = Math.max(0, oldOwner.popCap - raceOf(oldOwner.race).popPerTownHall);
        // Losing your last TownHall means losing the game — this check runs AFTER removing the
        // destroyed one, so "zero remaining" genuinely means zero, not one-still-standing. Skipped
        // for a player who's already abandoned (surrendered/died earlier) — their game already
        // ended once; this is just decay or another player finishing off what's left, not a second
        // game-ending event to process.
        if (oldOwner && !oldOwner.abandoned) {
          const remainingTownHalls = [...room.buildings.values()].some(b => b.ownerId === oldOwner.id && b.kind === "TownHall");
          if (!remainingTownHalls) room.killPlayer(oldOwner, "no_townhalls_remaining");
        }
      } else {
        if (oldOwner && building.kind === "House" && !raceOf(oldOwner.race).hasCivilians) oldOwner.popCap = Math.max(0, oldOwner.popCap - raceOf(oldOwner.race).popPerHouse);
        if (oldOwner) releaseCiviliansFrom(room, building);
        building.ownerId = attackerPlayer.id;
        building.hp = building.maxHp;
        room.transferClaimsAround(building, attackerPlayer.id, attackerPlayer.color);
        attackerPlayer.score += SCORE.captureBuilding;
        attackerPlayer.stats.captured += 1;
      }
    }
    return true;
  }

  for (const [otherId, other] of room.players) {
    if (otherId === attackerPlayer.id) continue;
    if (getRelation(room, attackerPlayer.id, otherId) !== "war") continue;

    for (const [otherUnitId, otherUnit] of other.units) {
      if (otherUnit.q === q && otherUnit.r === r) {
        otherUnit.hp -= damage;
        if (otherUnit.hp <= 0) {
          other.units.delete(otherUnitId);
          other.usedWorkers = Math.max(0, other.usedWorkers - (otherUnit.popCost || 0));
          // A dead Civilian IS a lost unit of population (unlike other units, which never counted
          // toward popCap directly) — queue a replacement to spawn at their home after the cooldown.
          if (otherUnit.kind === "Civilian") {
            other.popCap = Math.max(0, other.popCap - 1);
            if (otherUnit.homeBuildingId) {
              other.pendingCivilianRespawns.push({ homeBuildingId: otherUnit.homeBuildingId, readyAt: Date.now() + CIVILIAN_RESPAWN_DELAY_MS });
            }
          }
          // Necromancer: raise the fallen enemy as your own undead unit, same kind, at level 1, half hp.
          if (attackerUnitKind === "Necromancer") {
            const baseDef = resolveUnitDef(attackerPlayer.race, otherUnit.kind, UNIT_DEFS, RACE_UNIT_OVERRIDES) || { hp: 10 };
            const def = applyResearchHpBonus(attackerPlayer, otherUnit.kind, baseDef);
            const raised = {
              id: uid(), kind: otherUnit.kind, level: 1, guard: false, q, r,
              lastStepAt: 0, lastActionAt: 0,
              hp: Math.max(1, Math.round(def.hp * 0.5)), maxHp: def.hp, popCost: 0,
            };
            attackerPlayer.units.set(raised.id, raised);
          }
        }
        return true;
      }
    }

    if (other.q === q && other.r === r) {
      other.hp -= damage;
      if (other.hp <= 0) {
        attackerPlayer.score += SCORE.killPlayer;
        attackerPlayer.stats.kills += 1;
        room.killPlayer(other, "killed");
      }
      return true;
    }
  }
  return false;
}

/**
 * Every constructed ArcherTower automatically fires at the nearest enemy
 * (unit or player) within its range, once per attack cooldown — no player
 * input needed. This is what makes it a defensive structure.
 */
export function advanceTowerDefense(room, now) {
  const range = ATTACK_RANGE.ArcherTower;
  for (const building of room.buildings.values()) {
    if (building.kind !== "ArcherTower" || !building.constructed) continue;
    if (now - (building.lastAttackAt || 0) < room.attackCooldownMs) continue;

    const owner = room.players.get(building.ownerId);
    if (!owner) continue;
    const center = { q: building.q, r: building.r };

    let bestDist = Infinity;
    let bestTarget = null;

    for (const [otherId, other] of room.players) {
      if (otherId === building.ownerId) continue;
      if (getRelation(room, building.ownerId, otherId) !== "war") continue;

      for (const u of other.units.values()) {
        const d = hexDistance(center, { q: u.q, r: u.r });
        if (d <= range && d < bestDist) { bestDist = d; bestTarget = { q: u.q, r: u.r }; }
      }
      const dPlayer = hexDistance(center, { q: other.q, r: other.r });
      if (dPlayer <= range && dPlayer < bestDist) { bestDist = dPlayer; bestTarget = { q: other.q, r: other.r }; }
    }

    if (!bestTarget) continue;
    building.lastAttackAt = now;
    resolveAttack(room, owner, bestTarget.q, bestTarget.r, null);
  }
}

/**
 * Guard mode: any unit with `guard: true` automatically attacks the nearest
 * enemy (unit or player) that comes within its own attack range — no click
 * needed. Same cooldown, same war-only rule as a manually-commanded attack.
 */
export function advanceGuardUnits(room, now) {
  for (const player of room.players.values()) {
    for (const unit of player.units.values()) {
      if (!unit.guard || !ATTACK_RANGE[unit.kind]) continue;
      if (now - (unit.lastActionAt || 0) < room.attackCooldownMs) continue;

      const range = ATTACK_RANGE[unit.kind];
      const center = { q: unit.q, r: unit.r };
      let bestDist = Infinity;
      let bestTarget = null;

      for (const [otherId, other] of room.players) {
        if (otherId === player.id) continue;
        if (getRelation(room, player.id, otherId) !== "war") continue;

        for (const u of other.units.values()) {
          const d = hexDistance(center, { q: u.q, r: u.r });
          if (d <= range && d < bestDist) { bestDist = d; bestTarget = { q: u.q, r: u.r }; }
        }
        const dPlayer = hexDistance(center, { q: other.q, r: other.r });
        if (dPlayer <= range && dPlayer < bestDist) { bestDist = dPlayer; bestTarget = { q: other.q, r: other.r }; }
      }

      if (!bestTarget) continue;
      unit.lastActionAt = now;
      const damage = ATTACK_DAMAGE * (LEVEL_MULTIPLIER[unit.level || 1] || 1);
      resolveAttack(room, player, bestTarget.q, bestTarget.r, unit.kind, damage);
    }
  }
}

const RESOURCE_KEYS = ["Wood", "Stone", "Bread", "Fish", "Gold"];

/**
 * Captures a Warehouse a player is standing on, once it's been battered
 * down to its 1 hp floor and they're at war with its owner. Warehouses
 * can never be destroyed — this is the only way to take one over.
 *
 * The Warehouse keeps whatever's actually inside it and simply changes
 * hands — for a race using real per-building storage (currently Human,
 * per the "all warehouses should eventually work like this" direction),
 * that's a genuine, literal theft of building.inventory, not an
 * approximation. If either side doesn't use that model yet, this falls
 * back to crediting/debiting their flat aggregate bank instead — the
 * old owner's cut is still approximated the same way it always was
 * (a proportional share of their total stockpile) when THEY don't have
 * real per-building inventory to read from directly.
 */
export function tryCaptureWarehouse(room, player, q, r) {
  const building = room.buildings.get(key(q, r));
  if (!building || building.kind !== "Warehouse") return;
  if (building.ownerId === player.id) return;
  if (building.hp > 1) return;

  const oldOwner = room.players.get(building.ownerId);
  if (!oldOwner) return;
  if (getRelation(room, player.id, oldOwner.id) !== "war") return;

  const oldHasRealStorage = raceOf(oldOwner.race).hasCivilians;
  const newHasRealStorage = raceOf(player.race).hasCivilians;

  let moved;
  if (oldHasRealStorage) {
    // Real theft: exactly what's sitting in THIS warehouse, not an approximation.
    moved = { ...(building.inventory ?? { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 }) };
  } else {
    // Old owner is still on the aggregate model — approximate this warehouse's proportional share.
    const oldCap = room.storageCap(oldOwner);
    const oldBonus = oldCap.Wood - BASE_STORAGE_CAP; // same bonus number for every resource kind in this model
    const share = oldBonus > 0 ? WAREHOUSE_STORAGE_BONUS / oldBonus : 0;
    moved = {};
    for (const k of RESOURCE_KEYS) {
      const amt = Math.round((oldOwner.bank[k] || 0) * share);
      if (amt > 0) { moved[k] = amt; oldOwner.bank[k] -= amt; }
    }
  }

  building.ownerId = player.id;
  building.hp = building.maxHp;
  room.transferClaimsAround(building, player.id, player.color);
  room._capCache.delete(oldOwner.id);
  room._capCache.delete(player.id);

  if (newHasRealStorage && oldHasRealStorage) {
    // Both sides use real storage: this warehouse's literal contents transfer with it, capped at
    // what a Warehouse can hold — same as it always could, just under new ownership now.
    const cap = storageCapFor("Warehouse");
    const inv = { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 };
    for (const k of RESOURCE_KEYS) inv[k] = Math.min(cap, moved[k] || 0);
    building.inventory = inv;
    recomputeHumanBank(room, player);
  } else if (newHasRealStorage) {
    // Old owner's contribution was only ever an approximation (they don't have a real per-building
    // amount to hand over) — spread it across the capturer's whole storage network, same as any
    // other credit, rather than force it all into just this one warehouse where it could overflow
    // and be lost even though the capturer has plenty of room elsewhere.
    building.inventory = { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 };
    creditHumanStorage(room, player, moved);
  } else {
    // Capturer uses the flat pool — credit directly, and the building's inventory field (if any)
    // becomes meaningless to them, so clear it rather than leave stale data sitting unused.
    building.inventory = { Wood: 0, Stone: 0, Bread: 0, Fish: 0, Gold: 0 };
    const newCap = room.storageCap(player);
    for (const k of Object.keys(moved)) {
      player.bank[k] = Math.min(newCap[k] ?? Infinity, (player.bank[k] || 0) + (moved[k] || 0));
    }
  }
  if (oldHasRealStorage) recomputeHumanBank(room, oldOwner); // reflect the loss in their aggregate too

  player.score += SCORE.captureBuilding;
  player.stats.captured += 1;
}
