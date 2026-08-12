// Civilians (Human-only): population is literally the count of these units,
// not an abstract number (see races.js's hasCivilians). They spawn
// automatically when a House finishes construction, sit idle until the
// player assigns them to a worker building, then actually walk there
// tile-by-tile (real pathfinding, same as any other unit) before starting work.
import { send } from "../net/wire.js";
import { key, hexDistance, bfsPath, canEnterTerrain, neighbors } from "../world/hex.js";
import { raceOf } from "../world/races.js";
import { canAfford } from "../world/economy.js";
import { uid } from "../utils/uid.js";
import { WORKER_EXEMPT, CIVILIAN_TICKS_PER_TILE, HOUSE_UPGRADE_COST, UNIT_DEFS, GATHERING_MAX_WORKERS, WAREHOUSE_MAX_WORKERS, GATHERING_UPGRADE_COST, WAREHOUSE_UPGRADE_COST, GATHERING_MIN_WORKERS_FOR_CONVERSION, TILE_CONVERSION_GOLD_COST, GATHERING_CONVERSION_TARGET, WAREHOUSE_MIN_WORKERS_TO_CLAIM, GATHERING_BUILDING_CAP, ROAD_SPEED_TICKS } from "../config/balance.js";
import { spendResources, creditHumanStorage, storageCapFor } from "./humanEconomy.js";

/** How many workers a building can currently hold, based on its kind and (for gathering
 *  buildings/Warehouse) its tier level. building.level being undefined means "no tier concept
 *  applies here" (every non-Human building, and every other Human building kind) — Human's
 *  gathering buildings and Warehouses are explicitly tagged level:1 at placement (see Room.js's
 *  handlePlaceBuilding) specifically so this can tell that apart from "untiered, use the old flat 2." */
export function maxWorkersFor(building) {
  if (building.level === undefined) return 2;
  const gathering = building.kind === "Lumberjack" || building.kind === "Farm" || building.kind === "Mine" || building.kind === "FishingBoat";
  if (gathering) return GATHERING_MAX_WORKERS[building.level] ?? 2;
  if (building.kind === "Warehouse") return WAREHOUSE_MAX_WORKERS[building.level] ?? 1;
  return 2;
}

/** Ticks for a civilian's next step onto (q,r) — same road-speed logic as the player's own
 *  movement (see Room.js's stepCooldownFor), just expressed in ticks instead of milliseconds.
 *  Roads exist mainly to speed up worker traffic, so civilians benefit from them the same way. */
/** Every worker building (TownHall/Warehouse/gathering building etc.) this player owns that's
 *  currently reachable from actual storage via roads/near-storage — these count as roads
 *  themselves for civilian movement purposes (both passability and speed), not just for other
 *  buildings' auto-connect goal-search (see tryAutoConnectRoad). Recomputed fresh each call, same
 *  cost model as nearStorageTileKeys (iterates all buildings), which callers already pay. */
function connectedBuildingTileKeys(room, playerId) {
  const nearStorage = nearStorageTileKeys(room, playerId);
  const storageBuildings = [...room.buildings.values()].filter(
    (b) => b.ownerId === playerId && b.constructed && (b.kind === "TownHall" || b.kind === "Warehouse")
  );
  const roadPassable = (t, q, r) => {
    const k = key(q, r);
    if (nearStorage.has(k)) return canEnterTerrain(t, false);
    const road = room.buildings.get(k);
    return !!(road && road.kind === "Road" && road.constructed && road.ownerId === playerId);
  };
  const connected = new Set();
  for (const b of room.buildings.values()) {
    if (b.ownerId !== playerId || !b.constructed) continue;
    const k = key(b.q, b.r);
    if (nearStorage.has(k)) { connected.add(k); continue; }
    for (const storage of storageBuildings) {
      if (bfsPath(room.tiles, { q: b.q, r: b.r }, { q: storage.q, r: storage.r }, roadPassable, 300)) { connected.add(k); break; }
    }
  }
  return connected;
}

function civilianStepTicks(room, q, r, connectedBuildings) {
  const road = room.buildings.get(key(q, r));
  if (road && road.kind === "Road" && road.constructed) {
    return ROAD_SPEED_TICKS[road.level ?? 1] ?? CIVILIAN_TICKS_PER_TILE;
  }
  if (connectedBuildings && connectedBuildings.has(key(q, r))) {
    return ROAD_SPEED_TICKS[1] ?? CIVILIAN_TICKS_PER_TILE; // road-connected building — same speed as a basic road
  }
  return CIVILIAN_TICKS_PER_TILE;
}

/** Every tile a civilian can walk WITHOUT a road present: a constructed TownHall/Warehouse's own
 *  tile plus its 6 neighbors — the "last mile" exception, so a worker building placed directly next
 *  to one doesn't need a dedicated road link. */
function nearStorageTileKeys(room, playerId) {
  const keys = new Set();
  for (const b of room.buildings.values()) {
    if (b.ownerId !== playerId || !b.constructed) continue;
    if (b.kind !== "TownHall" && b.kind !== "Warehouse") continue;
    keys.add(key(b.q, b.r));
    for (const n of neighbors(b.q, b.r)) keys.add(key(n.q, n.r));
  }
  return keys;
}

/**
 * Computes a real walkable path and returns step-by-step movement state: one tile advances every
 * civilianStepTicks(...) ticks (faster on roads), matching the pacing of ordinary movement instead
 * of a "wait N ticks then jump to the destination" timer. This is what makes Civilians visibly walk
 * instead of teleporting once a trip completes.
 *
 * Movement is road-restricted: civilians can only walk along constructed Roads, except for the
 * "last mile" right around a TownHall/Warehouse (no dedicated road needed if a building sits
 * directly next to one) and the final step onto the actual destination itself. A building that
 * isn't reachable this way (no road, not near storage) simply can't be staffed or delivered to
 * yet — connect it with a Road first.
 *
 * Returns null if genuinely no path exists this way — callers should treat that the same as
 * "can't get there right now."
 */
function startTrip(room, player, civilian, goal) {
  // Some worker buildings sit on terrain that's genuinely impassable to normal movement (a
  // FishingBoat on Water, most notably) — a civilian can never path directly onto that tile, so
  // redirect to the nearest passable tile next to it instead. Civilian position is only ever a
  // visual stand-in for "assigned here" anyway (the actual gathering mechanic just checks
  // building.workers), so ending up adjacent instead of exactly on top works identically.
  const goalTile = room.tiles.getAt(goal.q, goal.r);
  const actualGoal = canEnterTerrain(goalTile, false) ? goal : room.findAdjacentPassable(goal);
  if (!actualGoal) return null; // nowhere reachable near the goal at all

  if (civilian.q === actualGoal.q && civilian.r === actualGoal.r) return { path: [], stepTicksRemaining: 0 };

  const nearStorage = nearStorageTileKeys(room, player.id);
  const connectedBuildings = cachedConnectedBuildingTileKeys(room, player.id);
  const goalKey = key(actualGoal.q, actualGoal.r);
  const isPassable = (t, q, r) => {
    const k = key(q, r);
    if (k === goalKey) return canEnterTerrain(t, false); // always allowed to actually arrive
    if (nearStorage.has(k)) return canEnterTerrain(t, false); // last-mile exception near storage
    const building = room.buildings.get(k);
    if (building && building.kind === "Road" && building.constructed && building.ownerId === player.id) return true;
    if (connectedBuildings.has(k)) return true; // a road-connected building counts as a road itself
    return false;
  };

  const found = bfsPath(room.tiles, { q: civilian.q, r: civilian.r }, actualGoal, isPassable, 300);
  if (!found || found.length < 2) return null;
  const path = found.slice(1);
  return { path, stepTicksRemaining: civilianStepTicks(room, path[0].q, path[0].r, connectedBuildings) };
}

/** Same as connectedBuildingTileKeys, but cached per room per tick — every civilian's movement
 *  step within the same tick reuses one computation instead of each redoing this BFS-based scan
 *  independently, which would otherwise scale with (civilians moving this tick) × (buildings ×
 *  storage buildings), a real cost with many civilians active at once. */
function cachedConnectedBuildingTileKeys(room, playerId) {
  if (!room._connectedBuildingsCache || room._connectedBuildingsCacheTick !== room.tickCount) {
    room._connectedBuildingsCache = new Map();
    room._connectedBuildingsCacheTick = room.tickCount;
  }
  if (!room._connectedBuildingsCache.has(playerId)) {
    room._connectedBuildingsCache.set(playerId, connectedBuildingTileKeys(room, playerId));
  }
  return room._connectedBuildingsCache.get(playerId);
}

/** Advances one leg of an in-progress trip by a single tick. Returns true once the civilian has
 *  actually arrived (path fully walked) — false means still en route, try again next tick. */
function advanceTripStep(room, player, civilian, trip) {
  if (trip.path.length === 0) return true;
  trip.stepTicksRemaining -= 1;
  if (trip.stepTicksRemaining > 0) return false;
  const next = trip.path.shift();
  civilian.q = next.q; civilian.r = next.r;
  if (trip.path.length === 0) return true;
  trip.stepTicksRemaining = civilianStepTicks(room, trip.path[0].q, trip.path[0].r, cachedConnectedBuildingTileKeys(room, player.id));
  return false;
}

const AUTO_ASSIGN_KINDS = new Set(["TownHall", "Lumberjack", "Farm", "Mine", "FishingBoat", "Warehouse"]);
// TownHall now takes an assigned Civilian worker too (works like a Warehouse) — unlike the shared
// WORKER_EXEMPT (which still correctly exempts TownHall from the OLD placement-time worker check
// other races use), civilian assignment specifically excludes only House/Road/Monastery.
const CIVILIAN_ASSIGN_EXEMPT = new Set(["House", "Road", "Monastery"]);

/** Finds the best idle Civilian to send to `target` — one from the CLOSEST House/TownHall that
 *  still has an idle Civilian at home, not just any idle Civilian regardless of which home they
 *  belong to. Matches "civilians stay in their house until assigned, and a newly staffed building
 *  draws its worker from the nearest house that still has one available." */
function findNearestIdleCivilian(room, player, target) {
  const idleByHome = new Map(); // homeBuildingId -> [civilian, ...], in the order encountered
  for (const u of player.units.values()) {
    if (u.kind !== "Civilian" || u.assignedTo || u.travel || u.delivery || u.roving || u.returningHome) continue;
    const list = idleByHome.get(u.homeBuildingId);
    if (list) list.push(u); else idleByHome.set(u.homeBuildingId, [u]);
  }
  if (idleByHome.size === 0) return null;

  let bestHomeId = null, bestDist = Infinity;
  for (const [homeId, civilians] of idleByHome) {
    const home = [...room.buildings.values()].find((b) => b.id === homeId);
    // If the home building is gone, fall back to that civilian's own current position — still a
    // reasonable distance estimate, and better than skipping them entirely.
    const pos = home ? { q: home.q, r: home.r } : { q: civilians[0].q, r: civilians[0].r };
    const d = hexDistance(pos, target);
    if (d < bestDist) { bestDist = d; bestHomeId = homeId; }
  }
  return idleByHome.get(bestHomeId)[0];
}

/**
 * Automatically assigns one idle Civilian to a worker building the instant it finishes
 * construction, so there's always at least one worker present without the player needing to
 * manually click — same real tile-by-tile travel as a manual assignment, just started by the
 * server instead of a player message. Only applies to buildings a Civilian actually does anything
 * for (gathering buildings, Warehouse — see the .workers usage audit these are drawn from); a
 * silent no-op if there's no idle Civilian available right now.
 */
/**
 * When a worker building finishes construction, automatically lays a full Road connection from it
 * to the nearest TownHall/Warehouse, if it isn't already reachable (not next to one, no road
 * already touching it) — "buildings generate the first connection to a road." This is the whole
 * initial link, built once; any additional/redundant roads beyond it are left for the player to
 * build manually. Silently does nothing if no reasonably short connection exists (e.g. blocked by
 * water) — a manual road is still possible, this is just the free head start.
 */
export function tryAutoConnectRoad(room, player, building) {
  if (!AUTO_ASSIGN_KINDS.has(building.kind)) return; // only buildings that actually need worker traffic
  if (!raceOf(player.race).hasRoads) return;
  const nearStorage = nearStorageTileKeys(room, player.id);
  if (nearStorage.has(key(building.q, building.r))) return; // already reachable, no road needed

  for (const n of neighbors(building.q, building.r)) {
    const existing = room.buildings.get(key(n.q, n.r));
    if (existing && existing.kind === "Road" && existing.ownerId === player.id) return; // already connected
  }

  const isPassable = (t, q, r) => {
    const k = key(q, r);
    if (nearStorage.has(k)) return canEnterTerrain(t, false);
    const road = room.buildings.get(k);
    return !!(road && road.kind === "Road" && road.constructed && road.ownerId === player.id);
  };

  const storageKeys = new Set();
  for (const b of room.buildings.values()) {
    if (b.ownerId !== player.id || !b.constructed) continue;
    if (b.kind !== "TownHall" && b.kind !== "Warehouse") continue;
    storageKeys.add(key(b.q, b.r));
  }
  if (storageKeys.size === 0) return;

  // A building connected to a road counts as a road itself: any other worker building that's
  // already reachable from storage is an equally valid connection point for this new one, not just
  // TownHall/Warehouse directly. Lets a cluster of buildings share one trunk road organically
  // instead of every single one needing its own separate path all the way back to storage.
  for (const b of room.buildings.values()) {
    if (b.ownerId !== player.id || !b.constructed || b.id === building.id) continue;
    if (!AUTO_ASSIGN_KINDS.has(b.kind)) continue;
    const bKey = key(b.q, b.r);
    if (storageKeys.has(bKey)) continue;
    const reachable = [...storageKeys].some((goalKey) => {
      const [gq, gr] = goalKey.split(",").map(Number);
      return bfsPath(room.tiles, { q: b.q, r: b.r }, { q: gq, r: gr }, isPassable, 300);
    });
    if (reachable) storageKeys.add(bKey);
  }

  const path = cheapestRoadPath(room, player.id, { q: building.q, r: building.r }, storageKeys, 600);
  if (!path || path.length < 2) return; // no reasonable connection found -- player can still hand-build one

  // Lay road on every tile of the path except the two endpoints (the building itself and the
  // storage building's own tile) — those are already occupied by real buildings. Tiles that are
  // already an existing road cost nothing to "use" and don't need to be re-laid.
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i];
    const k = key(p.q, p.r);
    if (room.buildings.has(k)) continue; // already a road (or something else) — nothing to add here
    const tile = room.tiles.getAt(p.q, p.r);
    if (!canEnterTerrain(tile, false)) continue;
    room.buildings.set(k, {
      id: uid(), kind: "Road", q: p.q, r: p.r, ownerId: player.id, workers: 0,
      constructed: true, ticksRemaining: 0, constructionTicks: 1, hp: 5, maxHp: 5,
      lastAttackAt: 0, trainQueue: [], level: 1,
    });
  }
}

/**
 * Weighted pathfinding for laying new road connections, from `start` to whichever tile in
 * `goalKeys` ends up cheapest to reach: stepping onto an ALREADY-EXISTING road (this player's own)
 * costs nothing — reusing it is free — while stepping onto any other passable tile costs 1 (a new
 * road segment would need to be built there). The result naturally routes through existing road
 * networks whenever that means fewer new tiles overall, and can even prefer a farther storage
 * building over a closer one if it's already better-connected. Small Dijkstra with a sorted-array
 * frontier rather than a real heap — fine at this scale (runs once per building, not per tick).
 */
function cheapestRoadPath(room, playerId, start, goalKeys, maxNodes = 600) {
  const connectedBuildings = cachedConnectedBuildingTileKeys(room, playerId);
  const startK = key(start.q, start.r);
  if (goalKeys.has(startK)) return [start];
  const dist = new Map([[startK, 0]]);
  const parent = new Map();
  const posOf = new Map([[startK, start]]);
  const frontier = [{ k: startK, d: 0 }];
  let nodes = 0;

  while (frontier.length && nodes++ < maxNodes) {
    frontier.sort((a, b) => a.d - b.d);
    const cur = frontier.shift();
    if (cur.d > (dist.get(cur.k) ?? Infinity)) continue; // stale entry, a cheaper one already won
    if (goalKeys.has(cur.k)) {
      const path = [posOf.get(cur.k)];
      let k = cur.k;
      while (k !== startK) { const p = parent.get(k); path.push(posOf.get(p)); k = p; }
      return path.reverse();
    }
    const curPos = posOf.get(cur.k);
    for (const n of neighbors(curPos.q, curPos.r)) {
      const nk = key(n.q, n.r);
      const isGoal = goalKeys.has(nk);
      const tile = room.tiles.getAt(n.q, n.r);
      if (!isGoal && !canEnterTerrain(tile, false)) continue;
      const claim = room.claims.get(nk);
      if (!isGoal && (!claim || claim.ownerId !== playerId)) continue; // roads can only be laid on your own claimed land
      const occupant = room.buildings.get(nk);
      const isExistingRoad = !!(occupant && occupant.kind === "Road" && occupant.ownerId === playerId);
      const isConnectedBuilding = connectedBuildings.has(nk);
      if (occupant && !isExistingRoad && !isConnectedBuilding && !isGoal) continue; // some other building in the way, can't route through it
      const stepCost = (isExistingRoad || isConnectedBuilding) ? 0 : 1;
      const nd = cur.d + stepCost;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        parent.set(nk, cur.k);
        posOf.set(nk, n);
        frontier.push({ k: nk, d: nd });
      }
    }
  }
  return null;
}

export function tryAutoAssignWorker(room, player, building) {
  if (!AUTO_ASSIGN_KINDS.has(building.kind)) return;
  if ((building.workers || 0) >= maxWorkersFor(building)) return;
  const idle = findNearestIdleCivilian(room, player, { q: building.q, r: building.r });
  if (!idle) return;

  const trip = startTrip(room, player, idle, { q: building.q, r: building.r });
  if (!trip) return; // no walkable path there right now -- leave them idle rather than get stuck
  idle.travel = { toKey: key(building.q, building.r), toBuildingId: building.id, ...trip };
}

/**
 * Player-triggered equivalent of the above, for the Building HUD's "Assign Worker" button — the
 * player doesn't need to separately select a specific idle Civilian first; this finds the best one
 * itself (closest available house), exactly like tryAutoAssignWorker does on construction.
 */
export function handleAssignNearestWorker(room, player, msg) {
  const ws = room.clients.get(player.id);
  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;
  const building = room.buildings.get(key(q, r));
  if (!building || building.ownerId !== player.id) return send(ws, "build_rejected", { reason: "not_your_building" });
  if (CIVILIAN_ASSIGN_EXEMPT.has(building.kind)) return send(ws, "build_rejected", { reason: "building_needs_no_worker" });
  if ((building.workers || 0) >= maxWorkersFor(building)) return send(ws, "build_rejected", { reason: "building_fully_staffed" });

  const idle = findNearestIdleCivilian(room, player, { q, r });
  if (!idle) return send(ws, "build_rejected", { reason: "no_idle_civilian" });

  const trip = startTrip(room, player, idle, { q, r });
  if (!trip) return send(ws, "build_rejected", { reason: "no_path" });
  idle.travel = { toKey: key(q, r), toBuildingId: building.id, ...trip };
  room._sendBank(ws, player);
}

/**
 * Player-triggered: releases one Civilian from a building back to idle (heading home), freeing
 * them up to be reassigned somewhere else. Releases whichever one was assigned most recently — the
 * dedicated runner, if the building has one — keeping the "first stays and works, others run
 * deliveries" convention intact rather than arbitrarily disrupting the one actually working in place.
 */
export function handleUnassignWorker(room, player, msg) {
  const ws = room.clients.get(player.id);
  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;
  const building = room.buildings.get(key(q, r));
  if (!building || building.ownerId !== player.id) return send(ws, "build_rejected", { reason: "not_your_building" });

  const assigned = assignedOrder(player, building);
  const civilian = assigned[assigned.length - 1];
  if (!civilian) return send(ws, "build_rejected", { reason: "no_worker_to_release" });

  civilian.assignedTo = null;
  civilian.delivery = null;
  civilian.roving = null;
  building.workers = Math.max(0, (building.workers || 0) - 1);
  player.usedWorkers = Math.max(0, player.usedWorkers - 1);
  sendCivilianHome(room, player, civilian);
  room._sendBank(ws, player);
}

/** Spawns `count` idle Civilians at/around a House. Called once when the house finishes construction,
 *  and again (for the delta) when it's upgraded to level 2. */
export function spawnCivilians(room, player, house, count) {
  for (let i = 0; i < count; i++) {
    const civilian = {
      id: uid(), kind: "Civilian", level: 1, guard: false, q: house.q, r: house.r,
      lastStepAt: 0, lastActionAt: 0, hp: UNIT_DEFS.Civilian.hp, maxHp: UNIT_DEFS.Civilian.hp, popCost: 0,
      assignedTo: null,     // building id once working, else null (idle, sitting inside their house)
      travel: null,         // { toKey, toBuildingId, path, stepTicksRemaining } while walking to a new assignment
      homeBuildingId: house.id, // the House/TownHall this civilian was spawned from — see sendCivilianHome
      returningHome: null,  // { toKey, path, stepTicksRemaining } while walking back home after losing a job
    };
    player.units.set(civilian.id, civilian);
  }
  player.popCap += count;
}

/**
 * Assigns an idle Civilian to a worker building — starts it actually walking there tile-by-tile.
 * Population accounting (building.workers / player.usedWorkers) only actually updates once it arrives.
 */
export function handleAssignCivilian(room, player, msg) {
  const ws = room.clients.get(player.id);
  const civilian = player.units.get(msg.civilianId);
  if (!civilian || civilian.kind !== "Civilian") return;
  if (civilian.assignedTo || civilian.travel) return send(ws, "build_rejected", { reason: "civilian_busy" });

  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;
  const posKey = key(q, r);
  const building = room.buildings.get(posKey);
  if (!building || building.ownerId !== player.id) return send(ws, "build_rejected", { reason: "not_your_building" });
  if (CIVILIAN_ASSIGN_EXEMPT.has(building.kind)) return send(ws, "build_rejected", { reason: "building_needs_no_worker" });
  if ((building.workers || 0) >= maxWorkersFor(building)) return send(ws, "build_rejected", { reason: "building_fully_staffed" });

  const trip = startTrip(room, player, civilian, { q, r });
  if (!trip) return send(ws, "build_rejected", { reason: "no_path" });
  civilian.travel = { toKey: posKey, toBuildingId: building.id, ...trip };
  room._sendBank(ws, player);
}

/** Advances every in-progress civilian assignment by one tick, completing it (and starting the actual
 *  work) once the walk there is done. */
export function advanceCivilianTravel(room) {
  for (const [playerId, player] of room.players) {
    for (const civilian of player.units.values()) {
      if (civilian.kind !== "Civilian" || !civilian.travel) continue;
      if (!advanceTripStep(room, player, civilian, civilian.travel)) continue;

      const building = room.buildings.get(civilian.travel.toKey);
      // The building might have been demolished/destroyed/captured away while the civilian was en route.
      if (!building || building.ownerId !== playerId || (building.workers || 0) >= maxWorkersFor(building)) {
        civilian.travel = null;
        continue;
      }

      civilian.assignedTo = building.id;
      civilian.travel = null;
      building.workers = (building.workers || 0) + 1;
      player.usedWorkers += 1;

      const ws = room.clients.get(playerId);
      if (ws) room._sendBank(ws, player);
    }
  }
}

const GATHERING_KINDS = new Set(["Lumberjack", "Farm", "Mine", "FishingBoat"]);
const RESOURCE_KEYS = ["Wood", "Stone", "Bread", "Fish", "Gold"];

/**
 * Converts a nearby tile to whatever terrain kind this level-3 gathering building collects from
 * (e.g. a Lumberjack converts to Forest) — the ability level 3's upgrade unlocks, gated behind
 * actually having GATHERING_MIN_WORKERS_FOR_CONVERSION staffed there, not just owning the upgrade.
 * Costs Gold per tile. The target must be within the same 2-tile radius the level-2+ gather bonus
 * uses, must not already be occupied by a building, and must not already be that terrain kind.
 */
export function handleConvertTile(room, player, msg) {
  const ws = room.clients.get(player.id);
  const rd = raceOf(player.race);
  if (!rd.hasCivilians) return send(ws, "build_rejected", { reason: "not_available" });

  const bq = Number(msg.buildingQ), br = Number(msg.buildingR);
  const tq = Number(msg.q), tr = Number(msg.r);
  if (!Number.isFinite(bq) || !Number.isFinite(br) || !Number.isFinite(tq) || !Number.isFinite(tr)) return;

  const building = room.buildings.get(key(bq, br));
  if (!building || !GATHERING_KINDS.has(building.kind) || building.ownerId !== player.id) {
    return send(ws, "build_rejected", { reason: "not_your_building" });
  }
  if (!building.constructed) return send(ws, "build_rejected", { reason: "still_constructing" });
  if ((building.level ?? 1) < 3) return send(ws, "build_rejected", { reason: "requires_level_3" });
  if ((building.workers || 0) < GATHERING_MIN_WORKERS_FOR_CONVERSION) return send(ws, "build_rejected", { reason: "not_enough_workers" });

  if (hexDistance({ q: bq, r: br }, { q: tq, r: tr }) > 2) return send(ws, "build_rejected", { reason: "tile_out_of_range" });

  const targetKind = GATHERING_CONVERSION_TARGET[building.kind];
  const tile = room.tiles.getAt(tq, tr);
  if (!tile) return send(ws, "build_rejected", { reason: "invalid_tile" });
  if (tile.kind === targetKind) return send(ws, "build_rejected", { reason: "already_that_kind" });
  if (room.buildings.has(key(tq, tr))) return send(ws, "build_rejected", { reason: "occupied" });

  const cost = { Gold: TILE_CONVERSION_GOLD_COST };
  if (!canAfford(player.bank, cost)) return send(ws, "build_rejected", { reason: "cannot_afford" });

  spendResources(room, player, cost);
  tile.kind = targetKind;
  tile.resLeft = 60; // a reasonable fixed endowment, same ballpark as a naturally-generated tile's 20-100 range
  tile.maxResLeft = 60;
  room._sendBank(ws, player);
}

/** The nearest constructed storage building (TownHall/Warehouse) this player owns that still has
 *  room for more of resourceKind — "shortest way, or the next storage building if the nearest is full." */
function findNearestNonFullStorage(room, player, from, resourceKind) {
  let best = null, bestDist = Infinity;
  for (const b of room.buildings.values()) {
    if (b.ownerId !== player.id || !b.constructed) continue;
    if (b.kind !== "TownHall" && b.kind !== "Warehouse") continue;
    if (b.kind === "Warehouse" && (b.workers || 0) < WAREHOUSE_MIN_WORKERS_TO_CLAIM) continue; // unstaffed Warehouse isn't "claimed" yet
    const cap = storageCapFor(b.kind);
    if ((b.inventory?.[resourceKind] || 0) >= cap) continue; // full -- skip to the next candidate
    const d = hexDistance(from, { q: b.q, r: b.r });
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return best;
}

/** Among civilians assigned to a given building, the "first" (lowest id, a stable deterministic
 *  order) is the dedicated worker: they stay put and just work the building, never carrying
 *  anything anywhere themselves. Any others are dedicated runners — see isRunnerWorker below,
 *  which this powers for both gathering buildings and Warehouses. */
function assignedOrder(player, building) {
  return [...player.units.values()]
    .filter((u) => u.kind === "Civilian" && u.assignedTo === building.id)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** True for every civilian assigned to this building except the first — the ones whose whole job
 *  is carrying the building's output to storage, never the gathering itself. */
function isRunnerWorker(player, civilian, building) {
  return assignedOrder(player, building).findIndex((u) => u.id === civilian.id) > 0;
}

/**
 * Advances every Human civilian's delivery run by one tick. Only a gathering building's SECOND (and
 * beyond) assigned civilian ever makes a delivery run — the first stays put and just works the
 * building, letting its output accumulate in the building's own inventory until a runner (or a
 * player's manual collect) carries it off. A gathering building with only one worker simply
 * accumulates until manually collected — matches "the first always just collects the resources and
 * stores them in the building, the second one brings them to storage."
 */
export function advanceCivilianDelivery(room) {
  for (const [playerId, player] of room.players) {
    if (!raceOf(player.race).hasCivilians) continue;

    for (const civilian of player.units.values()) {
      if (civilian.kind !== "Civilian") continue;

      if (civilian.delivery) {
        if (!advanceTripStep(room, player, civilian, civilian.delivery)) continue;

        if (civilian.delivery.phase === "toStorage") {
          const storage = room.buildings.get(civilian.delivery.targetKey);
          if (storage && storage.ownerId === playerId && storage.constructed) {
            creditHumanStorage(room, player, { [civilian.delivery.resourceKind]: civilian.delivery.amount });
          }
          const gathering = room.buildings.get(civilian.delivery.gatheringKey);
          if (gathering) {
            const trip = startTrip(room, player, civilian, { q: gathering.q, r: gathering.r });
            civilian.delivery = trip ? { phase: "returning", targetKey: civilian.delivery.gatheringKey, gatheringKey: civilian.delivery.gatheringKey, resourceKind: null, amount: 0, ...trip } : null;
          } else {
            civilian.delivery = null; // the gathering building it was working is gone -- just ends the trip here
          }
        } else {
          civilian.delivery = null; // arrived back at the gathering building
        }
        continue;
      }

      if (!civilian.assignedTo) continue;
      const building = [...room.buildings.values()].find((b) => b.id === civilian.assignedTo);
      if (!building || !GATHERING_KINDS.has(building.kind) || !building.inventory) continue;

      const workerCount = assignedOrder(player, building).length;
      const isFull = RESOURCE_KEYS.some((k) => (building.inventory[k] || 0) >= GATHERING_BUILDING_CAP);
      // With 2+ workers, only the runner(s) ever deliver — the first stays and gathers continuously,
      // which is more efficient. With just 1 worker, they have no choice but to interrupt gathering
      // and deliver themselves once the building is actually full — otherwise a solo-staffed building
      // would accumulate forever and never contribute anything to the player's usable resources.
      if (!isRunnerWorker(player, civilian, building) && !(workerCount === 1 && isFull)) continue;

      const resourceKind = RESOURCE_KEYS.find((k) => (building.inventory[k] || 0) > 0);
      if (!resourceKind) continue; // nothing to deliver yet

      const target = findNearestNonFullStorage(room, player, { q: building.q, r: building.r }, resourceKind);
      if (!target) {
        // Every storage building is full for this resource — nothing productive for this worker to
        // do right now. Walk them home to idle rather than leaving them stuck standing at the
        // building, but stay assigned — the resource is still safely sitting in the building's own
        // inventory, and this same check runs every tick, so they'll automatically pick the
        // delivery back up (from wherever they currently are) the moment space frees up, with no
        // need to manually reassign them.
        sendCivilianHome(room, player, civilian);
        continue;
      }

      const trip = startTrip(room, player, civilian, { q: target.q, r: target.r });
      if (!trip) continue; // can't actually path there right now -- try again next tick

      const amount = building.inventory[resourceKind];
      building.inventory[resourceKind] = 0; // carried away — gathering can start refilling immediately, ready for the next trip
      civilian.delivery = {
        phase: "toStorage",
        targetKey: key(target.q, target.r),
        gatheringKey: key(building.q, building.r),
        resourceKind, amount,
        ...trip,
      };
    }
  }
}

/**
 * Manual collection: any of the player's own units, OR the player character themselves, can grab
 * a gathering building's current stock directly if standing on or next to it — an instant, player-
 * initiated alternative to waiting for a Civilian's automatic delivery run. msg.unitId is omitted
 * (or null) to collect with the player character itself.
 */
export function handleCollectResources(room, player, msg) {
  const ws = room.clients.get(player.id);
  if (!raceOf(player.race).hasCivilians) return; // nothing to manually collect for races without building-based storage

  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;
  const building = room.buildings.get(key(q, r));
  if (!building || building.ownerId !== player.id) return send(ws, "build_rejected", { reason: "not_your_building" });
  if (!GATHERING_KINDS.has(building.kind) || !building.inventory) return send(ws, "build_rejected", { reason: "nothing_to_collect" });

  const moverPos = msg.unitId
    ? player.units.get(msg.unitId)
    : { q: player.q, r: player.r };
  if (!moverPos) return;
  const dist = hexDistance(moverPos, { q, r });
  if (dist > 1) return send(ws, "build_rejected", { reason: "too_far" });

  const resourceKind = RESOURCE_KEYS.find((k) => (building.inventory[k] || 0) > 0);
  if (!resourceKind) return send(ws, "build_rejected", { reason: "nothing_to_collect" });

  const amount = building.inventory[resourceKind];
  building.inventory[resourceKind] = 0;
  creditHumanStorage(room, player, { [resourceKind]: amount });
  room._sendBank(ws, player);
}

/** Advances every pending Civilian respawn — once its cooldown elapses, spawns exactly one
 *  replacement at the home building it's tied to, same as a freshly-completed House/TownHall would.
 *  If that home no longer exists by the time the cooldown finishes (demolished/destroyed/captured
 *  since), the respawn is simply dropped — there's nowhere left to spawn it. */
export function advanceCivilianRespawns(room) {
  const now = Date.now();
  for (const player of room.players.values()) {
    if (!player.pendingCivilianRespawns || player.pendingCivilianRespawns.length === 0) continue;
    const stillPending = [];
    for (const pending of player.pendingCivilianRespawns) {
      if (now < pending.readyAt) { stillPending.push(pending); continue; }
      const home = [...room.buildings.values()].find((b) => b.id === pending.homeBuildingId && b.ownerId === player.id);
      if (home) spawnCivilians(room, player, home, 1);
      // else: home is gone — drop the pending respawn rather than spawn it somewhere unrelated.
    }
    player.pendingCivilianRespawns = stillPending;
  }
}

/** Starts a Civilian walking back toward the House/TownHall it was originally spawned from — same
 *  real tile-by-tile pathing as assignment/delivery. A no-op if their home no longer exists
 *  (demolished/destroyed since), in which case they just stay idle wherever they lost their job. */
export function sendCivilianHome(room, player, civilian) {
  if (!civilian.homeBuildingId || civilian.returningHome) return;
  const home = [...room.buildings.values()].find((b) => b.id === civilian.homeBuildingId);
  if (!home) return;
  const trip = startTrip(room, player, civilian, { q: home.q, r: home.r });
  if (!trip) return; // nowhere to go right now -- stays put, harmless
  civilian.returningHome = { toKey: key(home.q, home.r), ...trip };
}

/** Advances every Civilian's walk-home trip by one tick. Deliberately separate from the
 *  assignment/delivery travel machinery — arriving home should just leave them idle there, not
 *  accidentally "assign" them to the house (which is WORKER_EXEMPT and shouldn't hold a job anyway). */
export function advanceCivilianReturnHome(room) {
  for (const player of room.players.values()) {
    for (const civilian of player.units.values()) {
      if (civilian.kind !== "Civilian" || !civilian.returningHome) continue;
      if (!advanceTripStep(room, player, civilian, civilian.returningHome)) continue;
      civilian.returningHome = null;
    }
  }
}

/** The nearest of the player's own gathering buildings that currently has any stock at all. */
/** The nearest of the player's own gathering buildings with stock, OR House with accumulated tax
 *  gold waiting to be collected — whichever is closer. A roving worker doesn't distinguish between
 *  "bringing in gathered resources" and "collecting taxes," it's the same trip either way. */
function findNearestStockedGatheringBuilding(room, player, from) {
  let best = null, bestDist = Infinity;
  for (const b of room.buildings.values()) {
    if (b.ownerId !== player.id) continue;
    const isStockedGathering = GATHERING_KINDS.has(b.kind) && b.inventory && RESOURCE_KEYS.some((k) => (b.inventory[k] || 0) > 0);
    const isTaxedHouse = b.kind === "House" && b.constructed && (b.taxGold || 0) > 0;
    if (!isStockedGathering && !isTaxedHouse) continue;
    const d = hexDistance(from, { q: b.q, r: b.r });
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return best;
}

/**
 * Advances the Warehouse level 2/3 "extra workers actively rove the map collecting from gathering
 * buildings" behavior. A Warehouse's first assigned Civilian stays put (the level-1 "claiming"
 * worker); any beyond that continuously round-trip to whichever of the player's own gathering
 * buildings currently has stock, collect all of it (same instant-grab as manual collection), and
 * bring it back to deposit at the Warehouse. If nothing anywhere has stock, they just wait and
 * check again next tick — this is deliberately continuous rather than needing a player click.
 */
export function advanceWarehouseRoving(room) {
  for (const player of room.players.values()) {
    if (!raceOf(player.race).hasCivilians) continue;

    for (const civilian of player.units.values()) {
      if (civilian.kind !== "Civilian") continue;

      if (civilian.roving) {
        if (!advanceTripStep(room, player, civilian, civilian.roving)) continue;

        if (civilian.roving.phase === "toTarget") {
          const target = [...room.buildings.values()].find((b) => b.id === civilian.roving.targetBuildingId);

          let collected = null;
          if (target && target.ownerId === player.id) {
            if (target.kind === "House" && (target.taxGold || 0) > 0) {
              collected = { kind: "Gold", amount: target.taxGold };
              target.taxGold = 0;
            } else if (target.inventory) {
              const rk = RESOURCE_KEYS.find((k) => (target.inventory[k] || 0) > 0);
              if (rk) { collected = { kind: rk, amount: target.inventory[rk] }; target.inventory[rk] = 0; }
            }
          }

          const warehouse = [...room.buildings.values()].find((b) => b.id === civilian.roving.warehouseId);
          const trip = warehouse && collected ? startTrip(room, player, civilian, { q: warehouse.q, r: warehouse.r }) : null;
          if (warehouse && collected && trip) {
            civilian.roving = { phase: "returning", targetBuildingId: null, warehouseId: warehouse.id, resourceKind: collected.kind, amount: collected.amount, ...trip };
          } else {
            civilian.roving = null; // nothing there to collect (someone else got it first, or it's gone) — try again next idle tick
          }
        } else {
          const warehouse = [...room.buildings.values()].find((b) => b.id === civilian.roving.warehouseId);
          if (warehouse && civilian.roving.resourceKind) {
            creditHumanStorage(room, player, { [civilian.roving.resourceKind]: civilian.roving.amount });
          }
          civilian.roving = null;
        }
        continue;
      }

      if (!civilian.assignedTo) continue;
      const warehouse = [...room.buildings.values()].find((b) => b.id === civilian.assignedTo && (b.kind === "Warehouse" || b.kind === "TownHall"));
      if (!warehouse || (warehouse.workers || 0) < 2) continue;
      if (!isRunnerWorker(player, civilian, warehouse)) continue;

      const target = findNearestStockedGatheringBuilding(room, player, { q: civilian.q, r: civilian.r });
      if (!target) continue; // nothing anywhere has stock right now — wait, check again next tick

      const trip = startTrip(room, player, civilian, { q: target.q, r: target.r });
      if (!trip) continue; // can't path there right now -- try again next tick
      civilian.roving = { phase: "toTarget", targetBuildingId: target.id, warehouseId: warehouse.id, resourceKind: null, amount: 0, ...trip };
    }
  }
}

/** Frees any civilian(s) working a building that's gone (demolished, destroyed, or captured away) —
 *  called from the same places that already remove a building, so a lost building doesn't leave its
 *  former workers permanently "stuck" assigned to nothing. They head back to whichever House/TownHall
 *  they were originally spawned from. */
export function releaseCiviliansFrom(room, building) {
  const owner = room.players.get(building.ownerId);
  if (!owner) return;
  for (const civilian of owner.units.values()) {
    if (civilian.kind === "Civilian" && civilian.assignedTo === building.id) {
      civilian.assignedTo = null;
      owner.usedWorkers = Math.max(0, owner.usedWorkers - 1);
      sendCivilianHome(room, owner, civilian);
    }
  }
}

/** Upgrades a gathering building's tier (Human-only). Level 2 needs Advanced Gathering research and
 *  raises the max staffable workers to 3 (its radius bonus only actually applies once that many are
 *  staffed — see world/buildings.js). Level 3 needs Tile Conversion research and raises the cap to 5;
 *  the tile-conversion action itself isn't implemented yet, only this upgrade path and worker cap. */
export function handleUpgradeGatheringBuilding(room, player, msg) {
  const ws = room.clients.get(player.id);
  const rd = raceOf(player.race);
  if (!rd.hasCivilians) return send(ws, "build_rejected", { reason: "not_available" });

  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;
  const building = room.buildings.get(key(q, r));
  if (!building || !GATHERING_KINDS.has(building.kind) || building.ownerId !== player.id) {
    return send(ws, "build_rejected", { reason: "not_your_building" });
  }
  if (!building.constructed) return send(ws, "build_rejected", { reason: "still_constructing" });

  const nextLevel = (building.level ?? 1) + 1;
  if (nextLevel > 3) return send(ws, "build_rejected", { reason: "already_max_level" });

  const requiredResearch = nextLevel === 2 ? "advanced_gathering" : "tile_conversion_tech";
  if (!player.research.has(requiredResearch)) return send(ws, "build_rejected", { reason: "research_required" });

  const cost = GATHERING_UPGRADE_COST[nextLevel];
  if (!canAfford(player.bank, cost)) return send(ws, "build_rejected", { reason: "cannot_afford" });

  spendResources(room, player, cost);
  building.level = nextLevel;
  room._sendBank(ws, player);
}

/** Upgrades a Warehouse's tier (Human-only) — costs only, no research gate (unlike gathering
 *  buildings). Raises the max staffable workers; the level 2/3 "extra workers actively rove the map
 *  collecting from gathering buildings" behavior is implemented in advanceWarehouseRoving above. */
export function handleUpgradeWarehouseTier(room, player, msg) {
  const ws = room.clients.get(player.id);
  const rd = raceOf(player.race);
  if (!rd.hasCivilians) return send(ws, "build_rejected", { reason: "not_available" });

  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;
  const building = room.buildings.get(key(q, r));
  if (!building || building.kind !== "Warehouse" || building.ownerId !== player.id) {
    return send(ws, "build_rejected", { reason: "not_your_warehouse" });
  }
  if (!building.constructed) return send(ws, "build_rejected", { reason: "still_constructing" });

  const nextLevel = (building.level ?? 1) + 1;
  if (nextLevel > 3) return send(ws, "build_rejected", { reason: "already_max_level" });

  const cost = WAREHOUSE_UPGRADE_COST[nextLevel];
  if (!canAfford(player.bank, cost)) return send(ws, "build_rejected", { reason: "cannot_afford" });

  spendResources(room, player, cost);
  building.level = nextLevel;
  room._sendBank(ws, player);
}

/** Upgrades a House to level 2 (Human-only, requires the Urban Planning research) — spawns the extra civiliansPerHouseUpgrade Civilians immediately. */
export function handleUpgradeHouse(room, player, msg) {
  const ws = room.clients.get(player.id);
  const rd = raceOf(player.race);
  if (!rd.hasCivilians) return send(ws, "build_rejected", { reason: "not_available" });
  if (!player.research.has("urban_planning")) return send(ws, "build_rejected", { reason: "research_required" });

  const q = Number(msg.q), r = Number(msg.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return;
  const house = room.buildings.get(key(q, r));
  if (!house || house.kind !== "House" || house.ownerId !== player.id) return send(ws, "build_rejected", { reason: "not_your_house" });
  if (!house.constructed) return send(ws, "build_rejected", { reason: "still_constructing" });
  if (house.level2) return send(ws, "build_rejected", { reason: "already_upgraded" });
  if (!canAfford(player.bank, HOUSE_UPGRADE_COST)) return send(ws, "build_rejected", { reason: "cannot_afford" });

  spendResources(room, player, HOUSE_UPGRADE_COST);
  house.level2 = true;
  spawnCivilians(room, player, house, rd.civiliansPerHouseUpgrade ?? 2);
  room._sendBank(ws, player);
}
