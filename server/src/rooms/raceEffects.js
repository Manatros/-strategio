// Per-tick effects that only apply to specific races. Each is a no-op for
// every player it doesn't concern, so it's safe to call unconditionally
// every tick — the race checks inside are the actual gate.
import { key, diskCoords } from "../world/hex.js";
import { raceOf } from "../world/races.js";
import { DWARF_MINE_ADJACENT_RATE } from "../config/balance.js";

/** Dwarf Mines also slowly draw Stone+Gold from adjacent Stone/HighMountain tiles, and permanently block building on them. */
export function advanceDwarfMines(room, dtSec) {
  for (const building of room.buildings.values()) {
    if (building.kind !== "Mine" || !building.constructed) continue;
    const owner = room.players.get(building.ownerId);
    if (!owner || raceOf(owner.race).mineWorksAdjacent !== true) continue;

    const cap = room.storageCap(owner);
    for (const c of diskCoords({ q: building.q, r: building.r }, 1)) {
      if (c.q === building.q && c.r === building.r) continue;
      const t = room.tiles.getAt(c.q, c.r);
      if (!t || (t.kind !== "Stone" && t.kind !== "HighMountain")) continue;
      t.blocked = true;
      if (t.resLeft === undefined || t.resLeft <= 0) continue;

      const stoneRoom = Math.max(0, (cap.Stone ?? Infinity) - owner.bank.Stone);
      const got = Math.min(t.resLeft, DWARF_MINE_ADJACENT_RATE * dtSec, stoneRoom);
      if (got <= 0) continue;
      t.resLeft -= got;
      owner.bank.Stone += got;
      owner.score += got;
      owner.stats.gathered += got;

      if (t.kind === "HighMountain") {
        const goldRoom = Math.max(0, (cap.Gold ?? Infinity) - owner.bank.Gold);
        const gold = Math.min(got * 0.5, goldRoom);
        owner.bank.Gold += gold;
      }
    }
  }
}

/** Undead territory is scorched earth: anyone but the owner standing on it takes damage. Call this on the "every 3rd tick" cadence, not every tick. */
export function advanceScorchedEarth(room) {
  for (const [id, player] of room.players) {
    const claim = room.claims.get(key(player.q, player.r));
    if (!claim || claim.ownerId === id) continue;
    const owner = room.players.get(claim.ownerId);
    if (!owner || !raceOf(owner.race).scorchedEarth) continue;
    player.hp -= 1;
    if (player.hp <= 0) room.killPlayer(player, "scorched_earth");
  }
  for (const player of room.players.values()) {
    for (const [unitId, unit] of player.units) {
      const claim = room.claims.get(key(unit.q, unit.r));
      if (!claim || claim.ownerId === player.id) continue;
      const owner = room.players.get(claim.ownerId);
      if (!owner || !raceOf(owner.race).scorchedEarth) continue;
      unit.hp -= 1;
      if (unit.hp <= 0) {
        player.units.delete(unitId);
        player.usedWorkers = Math.max(0, player.usedWorkers - (unit.popCost || 0));
      }
    }
  }
}

/** Elf units standing on Forest heal 1 hp. Call this on the "every 3rd tick" cadence, not every tick. */
export function advanceElfHealing(room) {
  for (const player of room.players.values()) {
    if (!raceOf(player.race).forestHeal) continue;
    for (const unit of player.units.values()) {
      if (unit.hp >= unit.maxHp) continue;
      const t = room.tiles.getAt(unit.q, unit.r);
      if (t && t.kind === "Forest") unit.hp = Math.min(unit.maxHp, unit.hp + 1);
    }
  }
}