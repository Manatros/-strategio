// Builder repair is passive — no click needed, just standing on or next to
// a damaged building you own. Mirrors priestActions.js's pattern: a simple
// per-tick position check, not a stateful "repair session" to track.
import { hexDistance } from "../world/hex.js";

export const BUILDER_REPAIR_RATE = 2; // hp per second, per Builder actively repairing

export function advanceBuilderRepair(room, dtSec) {
  for (const [playerId, player] of room.players) {
    for (const unit of player.units.values()) {
      if (unit.kind !== "Builder") continue;

      for (const building of room.buildings.values()) {
        if (building.ownerId !== playerId) continue;
        if (!building.constructed) continue; // under-construction buildings heal via advanceConstruction() instead
        if (building.hp >= building.maxHp) continue;
        if (hexDistance({ q: unit.q, r: unit.r }, { q: building.q, r: building.r }) > 1) continue;

        building.hp = Math.min(building.maxHp, building.hp + BUILDER_REPAIR_RATE * dtSec);
      }
    }
  }
}
