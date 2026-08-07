// Priest abilities are passive — no click needed, just standing on the
// right tile. Runs every tick so capture/cleanse react immediately to a
// priest moving on/off a tile, rather than needing a separate toggle.
import { key } from "../world/hex.js";
import { raceOf } from "../world/races.js";
import { getRelation } from "./diplomacy.js";
import { PRIEST_CAPTURE_TICKS } from "../config/balance.js";

export function advancePriestActions(room) {
  // Track which building each priest is currently progressing, so leaving (or a different priest
  // taking over) resets/redirects capture progress correctly.
  const activeCaptures = new Set(); // "buildingKey|unitId" pairs seen this tick

  for (const [playerId, player] of room.players) {
    for (const unit of player.units.values()) {
      if (unit.kind !== "Priest") continue;
      const tileKey = key(unit.q, unit.r);

      // Cleanse: standing on a tile claimed by an Undead player removes that claim outright.
      const claim = room.claims.get(tileKey);
      if (claim && claim.ownerId !== playerId) {
        const owner = room.players.get(claim.ownerId);
        if (owner && raceOf(owner.race).scorchedEarth) {
          room.claims.delete(tileKey);
        }
      }

      // Capture: standing on an enemy building at war slowly takes it over.
      const building = room.buildings.get(tileKey);
      if (building && building.ownerId !== playerId && getRelation(room, playerId, building.ownerId) === "war") {
        const captureKey = `${tileKey}|${unit.id}`;
        activeCaptures.add(captureKey);
        if (!building.priestCapture || building.priestCapture.unitId !== unit.id || building.priestCapture.byPlayerId !== playerId) {
          building.priestCapture = { unitId: unit.id, byPlayerId: playerId, ticksRemaining: PRIEST_CAPTURE_TICKS };
        } else {
          building.priestCapture.ticksRemaining -= 1;
          if (building.priestCapture.ticksRemaining <= 0) {
            const oldOwner = room.players.get(building.ownerId);
            if (oldOwner && (building.kind === "House" || building.kind === "TownHall")) {
              const bonus = building.kind === "House" ? raceOf(oldOwner.race).popPerHouse : raceOf(oldOwner.race).popPerTownHall;
              oldOwner.popCap = Math.max(0, oldOwner.popCap - bonus);
            }
            building.ownerId = playerId;
            building.hp = building.maxHp;
            building.priestCapture = null;
            if (building.kind === "House") player.popCap += raceOf(player.race).popPerHouse;
            else if (building.kind === "TownHall") player.popCap += raceOf(player.race).popPerTownHall;
            player.stats.captured += 1;
          }
        }
      }
    }
  }

  // Any building whose capture wasn't touched this tick (priest left, died, or building changed hands another way) resets.
  for (const building of room.buildings.values()) {
    if (!building.priestCapture) continue;
    const captureKey = `${key(building.q, building.r)}|${building.priestCapture.unitId}`;
    if (!activeCaptures.has(captureKey)) building.priestCapture = null;
  }
}