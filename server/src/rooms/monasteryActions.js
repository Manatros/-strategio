// Monastery healing is passive — no click needed, just being within radius
// of a constructed Monastery you own. Mirrors builderActions.js's pattern
// (a simple per-tick distance check, not a stateful "healing session").
import { hexDistance } from "../world/hex.js";
import { MONASTERY_HEAL_RADIUS, MONASTERY_HEAL_RATE } from "../config/balance.js";

export function advanceMonasteryHealing(room, dtSec) {
  for (const [playerId, player] of room.players) {
    for (const building of room.buildings.values()) {
      if (building.kind !== "Monastery" || building.ownerId !== playerId || !building.constructed) continue;
      const center = { q: building.q, r: building.r };

      if (player.hp < player.maxHp && hexDistance({ q: player.q, r: player.r }, center) <= MONASTERY_HEAL_RADIUS) {
        player.hp = Math.min(player.maxHp, player.hp + MONASTERY_HEAL_RATE * dtSec);
      }

      for (const unit of player.units.values()) {
        if (unit.hp >= unit.maxHp) continue;
        if (hexDistance({ q: unit.q, r: unit.r }, center) > MONASTERY_HEAL_RADIUS) continue;
        unit.hp = Math.min(unit.maxHp, unit.hp + MONASTERY_HEAL_RATE * dtSec);
      }
    }
  }
}
