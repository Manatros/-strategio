// Research: each race has 3 independent unlocks (see RESEARCH_OPTIONS in
// config/balance.js), bought at the player's own Research building.
// Deliberately scoped: no prerequisites/branching, just "can you afford it
// and do you have the building" — real depth (tiers, exclusivity) can be
// layered on top of this later without changing the wire protocol.
import { send } from "../net/wire.js";
import { key } from "../world/hex.js";
import { canAfford } from "../world/economy.js";
import { raceOf } from "../world/races.js";
import { RESEARCH_OPTIONS, BUILDING_UNLOCK_RESEARCH } from "../config/balance.js";
import { spendResources } from "./humanEconomy.js";

/**
 * Instantly unlocks one building at the TownHall/Church where it's researched — a one-time
 * purchase rather than a progressive multi-tick project like the abstract-bonus research above,
 * which keeps a second research system tractable without duplicating all of advanceResearch's
 * ticking machinery for what's fundamentally a simpler "pay once, permanently unlocked" purchase.
 */
export function handleResearchBuilding(room, player, msg) {
  const ws = room.clients.get(player.id);
  const optionId = msg.optionId;
  const q = Number(msg.q), r = Number(msg.r);
  if (!optionId || !Number.isFinite(q) || !Number.isFinite(r)) return;

  const building = room.buildings.get(key(q, r));
  if (!building || building.ownerId !== player.id) return send(ws, "build_rejected", { reason: "not_your_building" });
  if (!building.constructed) return send(ws, "build_rejected", { reason: "still_constructing" });

  const options = BUILDING_UNLOCK_RESEARCH[player.race]?.[building.kind];
  const option = options?.find((o) => o.id === optionId);
  if (!option) return send(ws, "build_rejected", { reason: "invalid_option" });

  if (!player.buildingUnlocks) player.buildingUnlocks = new Set();
  if (player.buildingUnlocks.has(option.id)) return send(ws, "build_rejected", { reason: "already_unlocked" });
  if (!canAfford(player.bank, option.cost)) return send(ws, "build_rejected", { reason: "cannot_afford" });

  spendResources(room, player, option.cost);
  player.buildingUnlocks.add(option.id);
  room._sendBank(ws, player);
}

export function handleResearch(room, player, msg) {
  const ws = room.clients.get(player.id);
  const optionId = msg.optionId;
  const options = RESEARCH_OPTIONS[player.race] || [];
  const option = options.find(o => o.id === optionId);
  if (!option) return;

  if (player.research.has(optionId)) return send(ws, "build_rejected", { reason: "already_researched" });
  if (player.pendingResearch) return send(ws, "build_rejected", { reason: "already_researching" });

  let hasLab = false;
  for (const b of room.buildings.values()) {
    if (b.kind === "Research" && b.ownerId === player.id && b.constructed) { hasLab = true; break; }
  }
  if (!hasLab) return send(ws, "build_rejected", { reason: "need_research_building" });

  if (!canAfford(player.bank, option.cost)) return send(ws, "build_rejected", { reason: "cannot_afford" });

  spendResources(room, player, option.cost);
  player.pendingResearch = { optionId, ticksRemaining: option.ticks, totalTicks: option.ticks };

  room._sendBank(ws, player);
}

/** Advances every player's in-progress research by one tick, applying the unlock once it completes. */
export function advanceResearch(room) {
  for (const player of room.players.values()) {
    if (!player.pendingResearch) continue;
    player.pendingResearch.ticksRemaining -= 1;
    if (player.pendingResearch.ticksRemaining > 0) continue;

    const { optionId } = player.pendingResearch;
    player.pendingResearch = null;

    const options = RESEARCH_OPTIONS[player.race] || [];
    const option = options.find(o => o.id === optionId);
    if (option) {
      player.research.add(optionId);
      if (option.effect.kind === "popBonus") player.popCap += option.effect.amount;
    }

    const ws = room.clients.get(player.id);
    if (ws) {
      room._sendBank(ws, player);
      send(ws, "research_unlocked", { optionId });
    }
  }
}

/** Merges a player's race gather-rate multipliers with any unlocked research gather bonuses, for gatherTick(). */
export function effectiveRaceData(player) {
  const rd = raceOf(player.race);
  if (!player.research || player.research.size === 0) return rd;

  const options = RESEARCH_OPTIONS[player.race] || [];
  const rateMultiplier = { ...(rd.rateMultiplier || {}) };
  for (const optionId of player.research) {
    const option = options.find(o => o.id === optionId);
    if (!option || option.effect.kind !== "gatherBonus") continue;
    for (const kind of option.effect.buildings) {
      rateMultiplier[kind] = (rateMultiplier[kind] ?? 1) * option.effect.mult;
    }
  }
  return { ...rd, rateMultiplier };
}

/** Applies any unlocked unit-hp research bonus for this player+kind on top of an already-resolved unit def. */
export function applyResearchHpBonus(player, kind, def) {
  if (!def || !player.research || player.research.size === 0) return def;
  const options = RESEARCH_OPTIONS[player.race] || [];
  let mult = 1;
  for (const optionId of player.research) {
    const option = options.find(o => o.id === optionId);
    if (option?.effect.kind === "unitHpBonus" && option.effect.units.includes(kind)) mult *= option.effect.mult;
  }
  if (mult === 1) return def;
  return { ...def, hp: Math.max(1, Math.round(def.hp * mult)) };
}
