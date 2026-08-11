// Bot AI: a periodic "think" loop that drives a bot player by calling the
// exact same handlers a real client's messages would trigger. This is a
// reasonable, functional first version — not a deeply optimized strategic
// AI. It follows a simple, sensible priority order (found a town, build
// housing, build a small economy, then either grow military or keep
// expanding depending on personality) rather than any kind of lookahead
// planning. Good enough to feel like "a player who knows what to build and
// when," not good enough to be genuinely hard to beat.
import { key, hexDistance, diskCoords, canEnterTerrain } from "../world/hex.js";
import { raceOf, RACE_UNIT_OVERRIDES, resolveUnitDef } from "../world/races.js";
import { canPlace } from "../world/buildings.js";
import { canAfford } from "../world/economy.js";
import { BUILD_COST, UNIT_DEFS, VISION_RADIUS, ATTACK_RANGE } from "../config/balance.js";
import * as diplomacy from "./diplomacy.js";
import * as units from "./units.js";
import * as combat from "./combat.js";

const THINK_INTERVAL_MS = 1500; // how often each bot re-evaluates and takes at most one action
const EXPANSION_CHECK_RADIUS = 12; // how far out a bot looks for unclaimed, buildable land before concluding it's boxed in
const GATHERING_KINDS = ["Lumberjack", "Farm", "Mine", "FishingBoat"];

// How many Soldiers/Archers each personality tries to maintain, and whether it bothers with a
// Garrison at all — this is what makes "usually doesn't build army units" vs "focuses on army
// units" actually show up in play.
const MILITARY_TARGET = { passive: 0, neutral: 2, aggressive: 6 };

export function advanceBotAI(room) {
  const now = Date.now();
  for (const player of room.players.values()) {
    if (!player.isBot) continue;
    if (!player.botState) continue; // defensive — a bot should always have this, but never crash the room if not
    if (now - player.botState.lastThinkAt < THINK_INTERVAL_MS) continue;
    player.botState.lastThinkAt = now;
    try {
      thinkForBot(room, player);
    } catch (err) {
      // A bot's own decision logic misbehaving should never take down the room for real players.
      console.error(`[bot ${player.name}] think() threw:`, err?.message ?? err);
    }
  }
}

function ownedBuildingsOf(room, player) {
  return player.ownedBuildings.map((bp) => room.buildings.get(key(bp.q, bp.r))).filter(Boolean);
}

function myMilitaryUnits(player) {
  return [...player.units.values()].filter((u) => u.kind === "Soldier" || u.kind === "Archer");
}

/** Same as findBuildSpot for TownHall, but prefers a spot with good resource variety within its own
 *  self/adjacent-gather range (radius 1) — every building costs Wood, most also cost Stone, and a
 *  spot with neither nearby Stone nor nearby Water (for FishingBoat) is a genuine economic dead end:
 *  there's no way to ever afford anything past the TownHall itself. Scores candidates by how many
 *  distinct resource terrain types (Forest/Stone/Water/Fields) are in range and picks the best
 *  within the search radius, rather than just the first technically-legal tile. */
function findTownHallSpot(room, player, center, maxRadius = 15) {
  const rd = raceOf(player.race);
  let best = null, bestScore = -1;
  for (let radius = 0; radius <= maxRadius; radius++) {
    for (const c of diskCoords(center, radius)) {
      const posKey = key(c.q, c.r);
      if (room.buildings.has(posKey)) continue;
      const tile = room.tiles.getAt(c.q, c.r);
      if (!canPlace("TownHall", tile, rd)) continue;

      const nearby = diskCoords(c, 1).map((n) => room.tiles.getAt(n.q, n.r).kind);
      const score = ["Forest", "Stone", "Water", "Fields"].filter((k) => nearby.includes(k)).length;
      if (score > bestScore) { bestScore = score; best = c; }
      if (score >= 2) return c; // good enough (Wood plus at least one of Stone/Water/Fields) — stop searching
    }
    if (best && radius >= 3) break; // don't search forever once something reasonable turned up nearby
  }
  return best;
}

/** Finds a valid, currently-unoccupied tile for `kind`, searching outward from `center`. TownHall
 *  ignores territory ownership (same as a real player founding one); everything else must land on
 *  the bot's own claimed land. */
function findBuildSpot(room, player, kind, center, maxRadius = 10) {
  const rd = raceOf(player.race);
  for (let radius = 0; radius <= maxRadius; radius++) {
    for (const c of diskCoords(center, radius)) {
      const posKey = key(c.q, c.r);
      if (room.buildings.has(posKey)) continue;
      const tile = room.tiles.getAt(c.q, c.r);
      if (!canPlace(kind, tile, rd)) continue;
      if (kind !== "TownHall") {
        const claim = room.claims.get(posKey);
        if (!claim || claim.ownerId !== player.id) continue;
      }
      return c;
    }
  }
  return null;
}

/** One step along a real path toward `target` — not just "whichever neighbor looks closest," which
 *  can get stuck forever behind any obstacle in the way. */
function stepToward(room, player, target) {
  if (player.q === target.q && player.r === target.r) return;
  const rd = raceOf(player.race);
  const path = bfsPath(room, rd.scoutCrossesHighMountain, { q: player.q, r: player.r }, target);
  if (!path || path.length < 2) return;
  room.handleStep(player, { q: path[1].q, r: path[1].r });
}

function stepUnitToward(room, player, unit, target) {
  if (unit.q === target.q && unit.r === target.r) return;
  const rd = raceOf(player.race);
  const path = bfsPath(room, rd.scoutCrossesHighMountain, { q: unit.q, r: unit.r }, target);
  if (!path || path.length < 2) return;
  units.handleStepUnit(room, player, { unitId: unit.id, q: path[1].q, r: path[1].r });
}

/** Simple BFS path search (server has no pathfinding elsewhere — the client has its own for player
 *  movement, but bots need their own since they're server-driven). Used instead of a naive greedy
 *  step, which can get permanently stuck behind any obstacle (e.g. a lake) between the bot and its
 *  target — a real problem once the map has any nontrivial terrain in the way. */
function bfsPath(room, allowHighMountain, start, goal, maxNodes = 600) {
  if (start.q === goal.q && start.r === goal.r) return [start];
  const startK = key(start.q, start.r), goalK = key(goal.q, goal.r);
  const seen = new Set([startK]);
  const parent = new Map();
  const queue = [start];
  let head = 0, nodes = 0;

  while (head < queue.length && nodes++ < maxNodes) {
    const cur = queue[head++];
    const neighbors = [
      { q: cur.q + 1, r: cur.r }, { q: cur.q + 1, r: cur.r - 1 }, { q: cur.q, r: cur.r - 1 },
      { q: cur.q - 1, r: cur.r }, { q: cur.q - 1, r: cur.r + 1 }, { q: cur.q, r: cur.r + 1 },
    ];
    for (const n of neighbors) {
      const nk = key(n.q, n.r);
      if (seen.has(nk)) continue;
      if (!canEnterTerrain(room.tiles.getAt(n.q, n.r), allowHighMountain)) continue;
      seen.add(nk);
      parent.set(nk, cur);
      if (nk === goalK) {
        const path = [goal];
        let p = goal;
        while (key(p.q, p.r) !== startK) {
          p = parent.get(key(p.q, p.r));
          path.push(p);
        }
        return path.reverse();
      }
      queue.push(n);
    }
  }
  return null; // unreachable within maxNodes -- caller should fall back to something else
}

function canAffordBuilding(player, kind) {
  return canAfford(player.bank, BUILD_COST[kind] || {});
}

function canAffordUnit(player, kind) {
  const def = resolveUnitDef(player.race, kind, UNIT_DEFS, RACE_UNIT_OVERRIDES);
  if (!def) return false;
  const available = player.popCap - player.usedWorkers;
  return available >= def.popCost && canAfford(player.bank, def.cost);
}

/**
 * Once a bot's current town has at least one of every gathering building, trains a Settler (via
 * Outpost — every race can build one, not just Human) and sends it off to found another TownHall.
 * Without this, a bot's build cycle has nowhere left to go once it hits its economy caps — it just
 * stalls out after a handful of buildings instead of ever really expanding.
 */
function tryExpandTownHall(room, player) {
  const ownBuildings = ownedBuildingsOf(room, player);
  const townHalls = ownBuildings.filter((b) => b.kind === "TownHall");
  if (townHalls.length === 0) return false; // tryFoundTownHall handles the very first one
  if (townHalls.length >= 3) return false; // a reasonable cap, not infinite expansion

  const gatheringCount = GATHERING_KINDS.reduce((sum, k) => sum + ownBuildings.filter((b) => b.kind === k).length, 0);

  const outpost = ownBuildings.find((b) => b.kind === "Outpost" && b.constructed);
  if (!outpost) {
    if (!canAffordBuilding(player, "Outpost")) return false;
    const result = tryBuildNear(room, player, "Outpost", { q: townHalls[0].q, r: townHalls[0].r });
    return result;
  }

  const settler = [...player.units.values()].find((u) => u.kind === "Settler");
  if (settler) {
    if (!player.botState.expansionTarget) {
      const spot = findTownHallSpot(room, player, { q: settler.q, r: settler.r }, 20);
      if (!spot) return false; // nothing found this cycle -- try again later
      player.botState.expansionTarget = spot;
    }
    const spot = player.botState.expansionTarget;
    if (room.buildings.has(key(spot.q, spot.r))) { player.botState.expansionTarget = null; return true; }
    if (hexDistance({ q: settler.q, r: settler.r }, spot) > 1) { stepUnitToward(room, player, settler, spot); return true; }
    room.handlePlaceBuilding(player, { kind: "TownHall", q: spot.q, r: spot.r });
    player.botState.expansionTarget = null;
    return true;
  }

  if ((outpost.trainQueue?.length || 0) > 0) return false; // already training something there
  if (!canAffordUnit(player, "Settler")) return false;
  units.handleTrainUnit(room, player, { kind: "Settler", q: outpost.q, r: outpost.r });
  return true;
}

/** Founds a TownHall via the starting Settler — walks it into range first if needed. Every bot's
 *  very first priority, same as a real player would (nothing else is buildable without one).
 *  The chosen spot is cached on botState once found — searching fresh from the settler's current
 *  position on every think cycle would have it chase a shifting target and never converge. */
function tryFoundTownHall(room, player) {
  const ownBuildings = ownedBuildingsOf(room, player);
  if (ownBuildings.some((b) => b.kind === "TownHall")) { player.botState.townHallTarget = null; return false; }

  const settler = [...player.units.values()].find((u) => u.kind === "Settler");
  if (!settler) return false;

  if (!player.botState.townHallTarget) {
    const spot = findTownHallSpot(room, player, { q: settler.q, r: settler.r }, 15);
    if (!spot) return false; // nothing found even at this range -- very unusual terrain, just wait
    player.botState.townHallTarget = spot;
  }

  const spot = player.botState.townHallTarget;
  if (room.buildings.has(key(spot.q, spot.r))) {
    // Someone else took it while we were en route -- drop it and re-search next think cycle.
    player.botState.townHallTarget = null;
    return true;
  }

  if (hexDistance({ q: settler.q, r: settler.r }, spot) > 1) {
    stepUnitToward(room, player, settler, spot);
    return true;
  }
  room.handlePlaceBuilding(player, { kind: "TownHall", q: spot.q, r: spot.r });
  const succeeded = room.buildings.get(key(spot.q, spot.r))?.ownerId === player.id;
  player.botState.townHallTarget = null; // either way, re-search fresh next time rather than keep chasing this exact spot
  return succeeded; // if placement was rejected (e.g. contested by another bot), fall through to other behavior this cycle instead of getting stuck retrying forever
}

/** Houses, then a couple of each gathering building on matching nearby terrain — the same basic
 *  economic backbone any race benefits from, regardless of personality. Searches near the bot's own
 *  TownHall (where its claimed territory actually is), not the player character's current position —
 *  the player and its territory can easily be far apart, and handlePlaceBuilding requires the player
 *  to actually be adjacent to build anyway, so this also walks the player there first if needed. */
function tryEconomyAction(room, player) {
  const ownBuildings = ownedBuildingsOf(room, player);
  const townHall = ownBuildings.find((b) => b.kind === "TownHall");
  if (!townHall) return false; // shouldn't happen (tryFoundTownHall runs first), but be defensive
  const center = { q: townHall.q, r: townHall.r };

  // Gathering infrastructure comes first: a Human bot in particular can otherwise spend its entire
  // starting bank on population buildings before ever attempting the one thing that population
  // actually needs a job at, leaving every civilian permanently idle with nowhere to work.
  for (const kind of GATHERING_KINDS) {
    const count = ownBuildings.filter((b) => b.kind === kind).length;
    if (count >= 2) continue;
    if (!canAffordBuilding(player, kind)) continue;
    if (tryBuildNear(room, player, kind, center)) return true;
  }

  const popAvailable = player.popCap - player.usedWorkers;
  if (popAvailable < 3 && canAffordBuilding(player, "House")) {
    if (tryBuildNear(room, player, "House", center)) return true;
  }

  return false;
}

/** Finds a spot for `kind` near `center`, walks the player character there if it isn't already
 *  adjacent (placement requires that), and places once in range. Caches the chosen spot on botState
 *  so it doesn't re-search relative to the player's shifting position each think cycle. */
function tryBuildNear(room, player, kind, center) {
  if (!player.botState.buildTarget || player.botState.buildTarget.kind !== kind) {
    const spot = findBuildSpot(room, player, kind, center, 20);
    if (!spot) return false;
    player.botState.buildTarget = { kind, q: spot.q, r: spot.r };
  }
  const target = player.botState.buildTarget;
  if (room.buildings.has(key(target.q, target.r))) {
    player.botState.buildTarget = null;
    return true; // contested/gone -- re-search next cycle, but this cycle still counts as "did something"
  }

  // Non-TownHall placement requires an available Builder (not already locked to another
  // construction) within 1 tile — walk the closest one there instead of the player character.
  const builder = closestAvailableBuilder(player, target);
  if (!builder) return false; // nothing free to build with right now — try again next cycle
  if (hexDistance({ q: builder.q, r: builder.r }, target) > 1) {
    // The build spot itself can be on impassable terrain (Water for FishingBoat, HighMountain for
    // a Dwarf spot) — pathing the builder AT the spot directly would never find a route, since
    // bfsPath requires the goal tile to be enterable. Path to an adjacent passable tile instead,
    // which is all "within 1 tile" actually requires.
    const rd = raceOf(player.race);
    const spotTile = room.tiles.getAt(target.q, target.r);
    const approach = canEnterTerrain(spotTile, rd.scoutCrossesHighMountain)
      ? target
      : room.findAdjacentPassable(target, rd.scoutCrossesHighMountain);
    if (!approach || !bfsPath(room, rd.scoutCrossesHighMountain, { q: builder.q, r: builder.r }, approach)) {
      // Genuinely unreachable (e.g. across water with no land route) — drop this spot and
      // re-search next cycle instead of looping on it forever.
      player.botState.buildTarget = null;
      return false;
    }
    stepUnitToward(room, player, builder, approach);
    return true;
  }
  room.handlePlaceBuilding(player, { kind, q: target.q, r: target.r });
  player.botState.buildTarget = null;
  return true;
}

/** The closest of this bot's own Builder units not already locked to constructing something else. */
function closestAvailableBuilder(player, target) {
  let best = null, bestDist = Infinity;
  for (const u of player.units.values()) {
    if (u.kind !== "Builder" || u.constructingBuildingId) continue;
    const d = hexDistance({ q: u.q, r: u.r }, target);
    if (d < bestDist) { bestDist = d; best = u; }
  }
  return best;
}

/** Garrison + Soldiers/Archers, up to this bot's personality-based target. Aggressive bots build
 *  this early and keep training continuously; neutral bots keep a small standing force; passive
 *  bots essentially skip this (target of 0). */
function tryMilitaryAction(room, player) {
  const target = MILITARY_TARGET[player.botPersonality] ?? 0;
  if (target === 0) return false;

  // Defer military spending until expansion is underway — otherwise Garrison/unit training keeps
  // consuming the same Wood/Stone pool the Outpost needs, and since this runs every think cycle
  // where expansion couldn't yet afford it, military spending wins the race across successive
  // cycles even though expansion is checked first within any single one.
  const townHallCount = ownedBuildingsOf(room, player).filter((b) => b.kind === "TownHall").length;
  if (townHallCount < 2) return false;

  const ownBuildings = ownedBuildingsOf(room, player);
  const hasGarrison = ownBuildings.some((b) => b.kind === "Garrison");
  if (!hasGarrison) {
    if (!canAffordBuilding(player, "Garrison")) return false;
    const spot = findBuildSpot(room, player, "Garrison", { q: player.q, r: player.r });
    if (spot) { room.handlePlaceBuilding(player, { kind: "Garrison", q: spot.q, r: spot.r }); return true; }
    return false;
  }

  const militaryCount = myMilitaryUnits(player).length;
  if (militaryCount >= target) return false;
  const kind = Math.random() < 0.5 ? "Soldier" : "Archer";
  if (!canAffordUnit(player, kind)) return false;
  units.handleTrainUnit(room, player, { kind });
  return true;
}

/** Is there still any unclaimed, enterable land within range? If not, who owns the closest
 *  claimed tile blocking further growth — that's who's "preventing them from expanding further." */
function findExpansionBlocker(room, player) {
  const center = { q: player.q, r: player.r };
  let sawUnclaimed = false;
  let blocker = null, blockerDist = Infinity;

  for (const c of diskCoords(center, EXPANSION_CHECK_RADIUS)) {
    const posKey = key(c.q, c.r);
    const claim = room.claims.get(posKey);
    if (!claim) {
      if (canEnterTerrain(room.tiles.getAt(c.q, c.r))) sawUnclaimed = true;
    } else if (claim.ownerId !== player.id) {
      const d = hexDistance(center, c);
      if (d < blockerDist) { blockerDist = d; blocker = claim.ownerId; }
    }
  }
  return sawUnclaimed ? null : blocker;
}

/** "Finding" another player = any of their buildings, units, or their own character is currently
 *  within this bot's vision. A simple, honest approximation of "encountered them" without needing
 *  to track full fog-of-war state per bot. */
function hasEncountered(room, player, other) {
  if (hexDistance({ q: player.q, r: player.r }, { q: other.q, r: other.r }) <= VISION_RADIUS) return true;
  for (const b of other.ownedBuildings) {
    if (hexDistance({ q: player.q, r: player.r }, b) <= VISION_RADIUS) return true;
  }
  for (const u of other.units.values()) {
    if (hexDistance({ q: player.q, r: player.r }, { q: u.q, r: u.r }) <= VISION_RADIUS) return true;
  }
  return false;
}

/** The personality-driven war decision, made exactly once per (bot, other player) pair regardless
 *  of which trigger (encounter vs. expansion-blocked) fires it first. */
function decideWar(room, player, otherId) {
  if (player.botState.warDecisions.has(otherId)) return;
  player.botState.warDecisions.add(otherId);

  if (diplomacy.getRelation(room, player.id, otherId) === "war") return;

  if (player.botPersonality === "aggressive") {
    diplomacy.handleDeclareWar(room, player, { toId: otherId });
  } else if (player.botPersonality === "neutral") {
    if (Math.random() < 0.5) diplomacy.handleDeclareWar(room, player, { toId: otherId });
  }
  // passive: never initiates war — tries to just keep growing elsewhere instead.
}

function tryDiplomacyAndExpansionChecks(room, player) {
  for (const [otherId, other] of room.players) {
    if (otherId === player.id) continue;
    if (player.botState.warDecisions.has(otherId)) continue;
    if (hasEncountered(room, player, other)) {
      decideWar(room, player, otherId);
      return true;
    }
  }

  if (Date.now() - player.botState.lastExpansionCheckAt < 15000) return false;
  player.botState.lastExpansionCheckAt = Date.now();

  const blocker = findExpansionBlocker(room, player);
  if (!blocker) return false;
  decideWar(room, player, blocker);
  return true;
}

/** Once at war with someone, move military units toward their nearest visible building/unit and
 *  attack when in range. A simple "walk toward the nearest known target" — no formations, no
 *  target prioritization beyond proximity. */
function tryCombatAction(room, player) {
  const atWarWith = [...room.players.keys()].filter(
    (id) => id !== player.id && diplomacy.getRelation(room, player.id, id) === "war"
  );
  if (atWarWith.length === 0) return false;

  const militaryUnits = myMilitaryUnits(player);
  if (militaryUnits.length === 0) return false;

  let acted = false;
  for (const unit of militaryUnits) {
    const range = ATTACK_RANGE[unit.kind];
    let bestTarget = null, bestDist = Infinity;

    for (const enemyId of atWarWith) {
      const enemy = room.players.get(enemyId);
      if (!enemy) continue;
      for (const eb of enemy.ownedBuildings) {
        const d = hexDistance({ q: unit.q, r: unit.r }, eb);
        if (d < bestDist) { bestDist = d; bestTarget = eb; }
      }
      for (const eu of enemy.units.values()) {
        const d = hexDistance({ q: unit.q, r: unit.r }, { q: eu.q, r: eu.r });
        if (d < bestDist) { bestDist = d; bestTarget = { q: eu.q, r: eu.r }; }
      }
    }
    if (!bestTarget) continue;

    if (bestDist <= range) {
      combat.handleAttack(room, player, { unitId: unit.id, q: bestTarget.q, r: bestTarget.r });
    } else {
      stepUnitToward(room, player, unit, bestTarget);
    }
    acted = true;
  }
  return acted;
}

/** With nothing more urgent to do, wander the player character toward unclaimed land near its own
 *  territory. Anchored to the bot's TownHall, not the player's current position — searching from
 *  wherever the player currently is would let it drift arbitrarily far from home, since there's
 *  always more unclaimed land a bit further out no matter how far it's already wandered. Caches the
 *  chosen tile for the same reason findBuildSpot-based targets do: a fresh search every cycle chases
 *  a shifting target instead of ever arriving anywhere. */
function tryIdleExpansionMove(room, player) {
  const ownBuildings = ownedBuildingsOf(room, player);
  const townHall = ownBuildings.find((b) => b.kind === "TownHall");
  const home = townHall ? { q: townHall.q, r: townHall.r } : { q: player.q, r: player.r };

  if (!player.botState.wanderTarget) {
    for (const c of diskCoords(home, EXPANSION_CHECK_RADIUS)) {
      if (room.claims.has(key(c.q, c.r))) continue;
      if (!canEnterTerrain(room.tiles.getAt(c.q, c.r))) continue;
      player.botState.wanderTarget = c;
      break;
    }
    if (!player.botState.wanderTarget) return false; // no unclaimed land within range at all
  }

  const target = player.botState.wanderTarget;
  if (player.q === target.q && player.r === target.r) {
    player.botState.wanderTarget = null; // arrived -- pick a fresh target next time this runs
    return true;
  }
  stepToward(room, player, target);
  return true;
}

function thinkForBot(room, player) {
  if (tryFoundTownHall(room, player)) return;
  if (tryDiplomacyAndExpansionChecks(room, player)) return;
  if (tryEconomyAction(room, player)) return;
  if (tryExpandTownHall(room, player)) return;
  if (tryCombatAction(room, player)) return;
  if (tryMilitaryAction(room, player)) return;
  tryIdleExpansionMove(room, player);
}
