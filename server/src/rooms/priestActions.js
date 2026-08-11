// Priest abilities are passive — no click needed, just standing on the
// right tile. Runs every tick so capture/cleanse react immediately to a
// priest moving on/off a tile, rather than needing a separate toggle.
import { key } from "../world/hex.js";
import { raceOf } from "../world/races.js";
import { getRelation } from "./diplomacy.js";
import { PRIEST_CAPTURE_TICKS } from "../config/balance.js";
import { releaseCiviliansFrom } from "./civilians.js";
import { recomputeHumanBank } from "./humanEconomy.js";

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
            const oldRd = oldOwner ? raceOf(oldOwner.race) : null;
            if (oldOwner && (building.kind === "House" || building.kind === "TownHall") && !oldRd.hasCivilians) {
              // Non-Human: the old instant abstract-worker model. Human civilians already spawned
              // don't vanish just because the building that spawned them changed hands.
              const bonus = building.kind === "House" ? oldRd.popPerHouse : oldRd.popPerTownHall;
              oldOwner.popCap = Math.max(0, oldOwner.popCap - bonus);
            }
            if (oldOwner) releaseCiviliansFrom(room, building); // frees anyone working here, regardless of building kind (no-op for races without civilians)

            building.ownerId = playerId;
            building.hp = building.maxHp;
            building.priestCapture = null;
            room.transferClaimsAround(building, playerId, player.color);

            const newRd = raceOf(player.race);
            if (building.kind === "House" && !newRd.hasCivilians) player.popCap += newRd.popPerHouse;
            else if (building.kind === "TownHall" && !newRd.hasCivilians) player.popCap += newRd.popPerTownHall;

            // TownHall holds real per-building inventory for races on the Human economy model — its
            // contents move with it just by changing ownerId, but both sides' cached aggregate bank
            // needs an explicit recompute or they'd show stale totals until some unrelated event
            // happened to trigger one.
            if (building.kind === "TownHall") {
              if (oldOwner && oldRd.hasCivilians) recomputeHumanBank(room, oldOwner);
              if (newRd.hasCivilians) recomputeHumanBank(room, player);
            }

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
