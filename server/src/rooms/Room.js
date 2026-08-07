// The authoritative room: owns all world/player state and the tick loop.
// Combat, diplomacy, race-specific periodic effects, and unit lifecycle are
// implemented in sibling modules (combat.js / diplomacy.js / raceEffects.js
// / units.js) as functions taking `room` explicitly — this file wires them
// together and owns the state they operate on.
import { uid } from "../utils/uid.js";
import { log } from "../utils/logger.js";
import { send, safeJSON } from "../net/wire.js";
import { TileStore } from "../world/tileStore.js";
import { key, hexDistance, diskCoords, canEnterTerrain } from "../world/hex.js";
import { canAfford, spend } from "../world/economy.js";
import { canPlace, gatherTick } from "../world/buildings.js";
import { RACES, raceOf, RACE_UNIT_OVERRIDES, resolveUnitDef } from "../world/races.js";
import { recordGameEnd } from "../persist/store.js";
import * as achievements from "./achievements.js";
import { checkWinConditions } from "./winConditions.js";
import { RACE_TROPHY_ID } from "../config/achievements.js";
import {
  DEFAULT_TICK_RATE, HEX_SIZE, VISION_RADIUS, BUILDING_VISION_RADIUS, SCOUT_VISION_RADIUS,
  CLAIM_RADIUS, STARTING_BANK, BUILD_COST, CONSTRUCTION_TICKS, BUILDING_HEALTH, UNIT_DEFS,
  WORKER_EXEMPT, ATTACK_COOLDOWN_TICKS, SCORE, PLAYER_MAX_HP, DISCONNECT_GRACE_MS, PLAYER_COLORS, DEMOLISH_REFUND_FRACTION,
  BASE_STORAGE_CAP, TOWNHALL_STORAGE_BONUS, WAREHOUSE_STORAGE_BONUS, UNIT_RACE_RESTRICTION, TILE_REGEN_RATE, TILE_REGEN_CHECK_TICKS,
} from "../config/balance.js";
import * as diplomacy from "./diplomacy.js";
import * as combat from "./combat.js";
import * as raceEffects from "./raceEffects.js";
import * as units from "./units.js";
import * as research from "./research.js";
import { advancePriestActions } from "./priestActions.js";

const WIN_CHECK_TICKS = 10; // domination scans the whole tile cache, so check every 5s (at 2 ticks/sec) rather than every tick
const ADMIN_DEBUG_TICKS = 4; // how often admin clients get a live server-diagnostics push (2s at the default tick rate)

function colorForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PLAYER_COLORS[Math.abs(h) % PLAYER_COLORS.length];
}
function validColor(c) {
  return Number.isFinite(c) && c >= 0 && c <= 0xffffff;
}

/** Picks a color not already in use by anyone currently in the room, preferring the player's own saved choice if it's free. */
function assignColor(room, preferredColor) {
  const used = new Set();
  for (const p of room.players.values()) used.add(p.color);
  if (validColor(preferredColor) && !used.has(preferredColor)) return preferredColor;
  for (const c of PLAYER_COLORS) {
    if (!used.has(c)) return c;
  }
  return colorForId(uid()); // room has more distinct players than palette entries — extremely unlikely at the 32-player cap
}

/**
 * Reconnect model: a disconnected (not dead) player's state is kept for
 * DISCONNECT_GRACE_MS so resume() can reattach a returning client to their
 * exact same game. Dying removes the player entirely, so their next
 * connection can only start a fresh game elsewhere.
 */
export class Room {
  constructor(id, cfg) {
    this.id = id || uid();
    this.cfg = cfg;
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.hexSize = HEX_SIZE;
    this.tiles = new TileStore(this.seed, this.hexSize);
    this.clients = new Map();
    this.players = new Map();
    this.buildings = new Map();
    this.claims = new Map();
    this.usedSpawns = new Set();
    this.relations = new Map();
    this.proposals = new Map();
    this.tickCount = 0;
    this._capCache = new Map();
    this._capCacheTick = -1;
    this.lastActive = Date.now();
    this._interval = null;

    const tickRate = (cfg && cfg.tickRate) || DEFAULT_TICK_RATE;
    this.stepCooldownMs = 1000 / tickRate;
    this.attackCooldownMs = this.stepCooldownMs * ATTACK_COOLDOWN_TICKS;
  }

  attach(serverTickMs) {
    if (!this._interval) {
      this._interval = setInterval(() => this.tick(serverTickMs / 1000), serverTickMs);
    }
  }
  detach() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }

  // ---- Diplomacy: thin delegates so call sites can just say `room.getRelation(...)` ----
  getRelation(a, b) { return diplomacy.getRelation(this, a, b); }
  setRelation(a, b, status) { return diplomacy.setRelation(this, a, b, status); }

  /** Fresh join: new spawn, new bank, new everything. `{ token, name, color, race, tag, ownedRaces, isAdmin }`. */
  join(ws, { token, name = "Player", color, race, tag, ownedRaces, isAdmin = false } = {}) {
    const id = uid();
    this.clients.set(id, ws);
    const chosenRace = RACES.includes(race) ? race : "Human";
    const rd = raceOf(chosenRace);
    const spawn = this.findSpawn(this.randomSpawnSeed(), rd.scoutCrossesHighMountain);
    this.usedSpawns.add(key(spawn.q, spawn.r));
    const player = {
      id, name, tag: tag || "0000", token, race: chosenRace, isAdmin: !!isAdmin,
      q: spawn.q, r: spawn.r,
      bank: { ...STARTING_BANK },
      color: assignColor(this, color),
      popCap: 0,
      usedWorkers: 0,
      ownedBuildings: [],
      units: new Map(),
      spawnKey: key(spawn.q, spawn.r),
      lastStepAt: 0,
      knownTiles: new Map(),
      knownBuildings: new Set(),
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      score: 0,
      stats: { gathered: 0, built: 0, destroyed: 0, captured: 0, landClaimed: 0, kills: 0 },
      research: new Set(),
      pendingResearch: null,
      revealMap: false,
      disconnectedAt: null,
    };
    this.players.set(id, player);
    achievements.loadAchievements(player)
      .catch((err) => log(`[room ${this.id}] loadAchievements failed for ${id}: ${err.message}`));

    // Some races start with units already in the field (e.g. Orc).
    for (const startKind of rd.startingUnits) {
      const spot = this.findAdjacentPassable(spawn, rd.scoutCrossesHighMountain) || spawn;
      const baseDef = resolveUnitDef(chosenRace, startKind, UNIT_DEFS, RACE_UNIT_OVERRIDES) || { hp: 10 };
      const unitDef = research.applyResearchHpBonus(player, startKind, baseDef);
      const unit = { id: uid(), kind: startKind, level: 1, guard: false, q: spot.q, r: spot.r, lastStepAt: 0, lastActionAt: 0, hp: unitDef.hp, maxHp: unitDef.hp, popCost: 0 }; // starting units are free -- never charged, so nothing to refund on death either
      player.units.set(unit.id, unit);
    }

    this.lastActive = Date.now();
    this._wireSocket(ws, id);

    send(ws, "welcome", {
      playerId: id, roomId: this.id, seed: this.seed, hexSize: this.hexSize,
      visionRadius: VISION_RADIUS, spawn: { q: player.q, r: player.r },
      color: player.color, race: chosenRace, resumed: false, hp: player.hp, maxHp: player.maxHp,
      stepCooldownMs: this.stepCooldownMs, ownedRaces: ownedRaces ?? null, tag: player.tag, isAdmin: player.isAdmin,
    });
    this._sendConfig(ws, player);
    this._sendBank(ws, player);

    this.broadcast("player_join", { id, name, tag: player.tag });
    log(`[room ${this.id}] join: ${id} (${name}, ${chosenRace})`);
    return id;
  }

  resume(ws, token) {
    for (const player of this.players.values()) {
      if (player.token === token && player.disconnectedAt !== null) {
        player.disconnectedAt = null;
        this.clients.set(player.id, ws);
        this._wireSocket(ws, player.id);
        this.lastActive = Date.now();

        // The returning client is a fresh page load with empty local caches, but the server's
        // knownTiles/knownBuildings still reflect the OLD session. Without clearing these, the
        // diff-based sendWorldSlice() thinks "nothing changed" and never resends anything the
        // player already "knew" before disconnecting — leaving the new client blind to its own
        // units/buildings/terrain. This was the resume bug.
        player.knownTiles.clear();
        player.knownBuildings.clear();

        send(ws, "welcome", {
          playerId: player.id, roomId: this.id, seed: this.seed, hexSize: this.hexSize,
          visionRadius: VISION_RADIUS, spawn: { q: player.q, r: player.r },
          color: player.color, race: player.race, resumed: true, hp: player.hp, maxHp: player.maxHp,
          stepCooldownMs: this.stepCooldownMs, tag: player.tag, isAdmin: player.isAdmin,
        });
        this._sendConfig(ws, player);
        this._sendBank(ws, player);
        this.sendWorldSlice(player, ws); // don't make them wait for the next tick to see anything
        log(`[room ${this.id}] resume: ${player.id} (${player.name})`);
        return player.id;
      }
    }
    return null;
  }

  _wireSocket(ws, id) {
    ws.on("message", (raw) => this.onMessage(id, raw));
    ws.on("close", () => this.leave(id, "close"));
    ws.on("error", () => this.leave(id, "error"));
  }

  _sendBank(ws, player) {
    send(ws, "bank", {
      bank: player.bank, popCap: player.popCap, workers: player.usedWorkers,
      hp: player.hp, maxHp: player.maxHp, score: player.score,
      research: [...player.research], storageCap: this.storageCap(player).Wood,
      pendingResearch: player.pendingResearch,
    });
  }

  leave(id, reason = "leave") {
    if (!this.clients.has(id)) return;
    this.clients.delete(id);
    const player = this.players.get(id);
    if (player) player.disconnectedAt = Date.now();
    this.broadcast("player_leave", { id, reason });
    this.lastActive = Date.now();
    log(`[room ${this.id}] disconnect: ${id} (${reason})`);
  }

  reapDisconnected(now = Date.now()) {
    for (const [id, player] of this.players) {
      if (player.disconnectedAt && now - player.disconnectedAt > DISCONNECT_GRACE_MS) {
        this.usedSpawns.delete(player.spawnKey);
        this.players.delete(id);
      }
    }
  }

  /** Ends a player's game permanently: persists their score+stats, tells their client, removes them. */
  killPlayer(player, reason = "died") {
    recordGameEnd(player.token, Math.round(player.score), player.race, player.stats)
      .catch((err) => log(`[room ${this.id}] recordGameEnd failed for ${player.id}: ${err.message}`));
    const ws = this.clients.get(player.id);
    if (ws) send(ws, "you_died", { finalScore: Math.round(player.score), reason });
    this.clients.delete(player.id);
    this.usedSpawns.delete(player.spawnKey);
    this.players.delete(player.id);
    this.broadcast("player_leave", { id: player.id, reason });
  }

  randomSpawnSeed() {
    const SPREAD = 40 + this.players.size * 3;
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * SPREAD;
    return { q: Math.round(Math.cos(angle) * dist), r: Math.round(Math.sin(angle) * dist) };
  }

  findSpawn(start, allowHighMountain = false) {
    const MAX_RADIUS = 50;
    const free = (c) => canEnterTerrain(this.tiles.getAt(c.q, c.r), allowHighMountain) && !this.usedSpawns.has(key(c.q, c.r));
    if (free(start)) return start;
    for (let radius = 1; radius < MAX_RADIUS; radius++) {
      for (const c of diskCoords(start, radius)) {
        if (free(c)) return c;
      }
    }
    return start;
  }

  findAdjacentPassable(center, allowHighMountain = false) {
    for (const c of diskCoords(center, 1)) {
      if (c.q === center.q && c.r === center.r) continue;
      if (canEnterTerrain(this.tiles.getAt(c.q, c.r), allowHighMountain)) return c;
    }
    return null;
  }

  onMessage(id, raw) {
    const msg = safeJSON(raw);
    if (!msg || typeof msg.type !== "string") return;
    const player = this.players.get(id);
    if (!player) return;
    this.lastActive = Date.now();

    switch (msg.type) {
      case "step": this.handleStep(player, msg); break;
      case "place_building": this.handlePlaceBuilding(player, msg); break;
      case "demolish_building": this.handleDemolishBuilding(player, msg); break;
      case "train_unit": units.handleTrainUnit(this, player, msg); break;
      case "step_unit": units.handleStepUnit(this, player, msg); break;
      case "merge_units": units.handleMergeUnits(this, player, msg); break;
      case "set_guard": units.handleSetGuard(this, player, msg); break;
      case "attack": combat.handleAttack(this, player, msg); break;
      case "declare_war": diplomacy.handleDeclareWar(this, player, msg); break;
      case "propose": diplomacy.handlePropose(this, player, msg); break;
      case "respond_proposal": diplomacy.handleRespondProposal(this, player, msg); break;
      case "research": research.handleResearch(this, player, msg); break;
      case "admin_cheat_resources": this.handleAdminCheatResources(player, msg); break;
      case "admin_toggle_reveal": this.handleAdminToggleReveal(player, msg); break;
      default: break;
    }
  }

  handleStep(player, msg) {
    const ws = this.clients.get(player.id);
    const q = Number(msg.q), r = Number(msg.r);
    if (!Number.isFinite(q) || !Number.isFinite(r)) return;

    const now = Date.now();
    if (now - player.lastStepAt < this.stepCooldownMs) {
      return send(ws, "step_rejected", { q, r, reason: "too_soon" });
    }
    if (hexDistance({ q: player.q, r: player.r }, { q, r }) !== 1) {
      return send(ws, "step_rejected", { q, r, reason: "not_adjacent" });
    }
    const rd = raceOf(player.race);
    if (!canEnterTerrain(this.tiles.getAt(q, r), rd.scoutCrossesHighMountain)) {
      return send(ws, "step_rejected", { q, r, reason: "impassable" });
    }
    const claim = this.claims.get(key(q, r));
    if (claim && claim.ownerId !== player.id) {
      const rel = this.getRelation(player.id, claim.ownerId);
      if (rel !== "war" && rel !== "open_borders") {
        return send(ws, "step_rejected", { q, r, reason: "territory_blocked" });
      }
    }

    player.q = q; player.r = r; player.lastStepAt = now;
    combat.tryCaptureWarehouse(this, player, q, r);
  }

  handlePlaceBuilding(player, msg) {
    const ws = this.clients.get(player.id);
    const kind = msg.kind;
    const q = Number(msg.q), r = Number(msg.r);
    if (!BUILD_COST[kind] || !Number.isFinite(q) || !Number.isFinite(r)) return;

    // Every building except TownHall must be near the player OR one of their own Builder units; TownHall
    // only needs a Settler nearby (see below) — this is what lets a Settler found a new town far away,
    // and a Builder construct things without the player character needing to be right there.
    if (kind !== "TownHall") {
      const nearPlayer = hexDistance({ q: player.q, r: player.r }, { q, r }) <= 1;
      const nearBuilder = [...player.units.values()].some(u => u.kind === "Builder" && hexDistance({ q: u.q, r: u.r }, { q, r }) <= 1);
      if (!nearPlayer && !nearBuilder) return send(ws, "build_rejected", { reason: "too_far" });
    }

    const posKey = key(q, r);
    if (this.buildings.has(posKey)) return send(ws, "build_rejected", { reason: "occupied" });

    const rd = raceOf(player.race);
    const tile = this.tiles.getAt(q, r);
    if (!canPlace(kind, tile, rd)) return send(ws, "build_rejected", { reason: "invalid_tile" });

    if (kind !== "TownHall") {
      const claim = this.claims.get(posKey);
      if (!claim || claim.ownerId !== player.id) {
        return send(ws, "build_rejected", { reason: "not_your_territory" });
      }
    }

    // Founding a new TownHall consumes a Settler standing on or next to it.
    let settlerId = null;
    if (kind === "TownHall") {
      const found = [...player.units].find(([, u]) => u.kind === "Settler" && hexDistance({ q: u.q, r: u.r }, { q, r }) <= 1);
      if (!found) return send(ws, "build_rejected", { reason: "need_settler" });
      settlerId = found[0];
    }

    const cost = BUILD_COST[kind] || {};
    if (!canAfford(player.bank, cost)) return send(ws, "build_rejected", { reason: "cannot_afford" });

    let workers = 0;
    if (!WORKER_EXEMPT.has(kind)) {
      workers = msg.workers === 2 ? 2 : 1;
      const available = player.popCap - player.usedWorkers;
      if (available < workers) return send(ws, "build_rejected", { reason: "not_enough_population" });
    }

    spend(player.bank, cost);
    if (kind === "Bridge" && tile.kind === "Water") tile.kind = "Bridge";
    if (kind === "House") player.popCap += rd.popPerHouse;
    if (kind === "TownHall") {
      player.popCap += rd.popPerTownHall;
      player.units.delete(settlerId);
    }

    const maxHp = BUILDING_HEALTH[kind] ?? 10;
    const ticksNeeded = CONSTRUCTION_TICKS[kind] ?? 10;
    const building = {
      id: uid(), kind, q, r, ownerId: player.id, workers,
      constructed: false, ticksRemaining: ticksNeeded, constructionTicks: ticksNeeded,
      hp: 1, maxHp, lastAttackAt: 0, pendingTrain: null,
    };
    this.buildings.set(posKey, building);

    // Living Tree / Great Mines convert what they claim (simplified single-kind overwrite — see races.js note).
    const convertTo = kind === "TownHall" && rd.claimConvertsToForest ? "Forest" : null;
    this.claimAround({ q, r }, player.id, player.color, player, convertTo);

    player.usedWorkers += workers;
    player.ownedBuildings.push({ q, r });
    player.stats.built += 1;
    this._capCache.delete(player.id);

    this._sendBank(ws, player);
  }

  /** Total per-resource storage capacity: a base amount plus a bonus per constructed TownHall/Warehouse. Memoized per tick. */
  storageCap(player) {
    if (this._capCacheTick !== this.tickCount) {
      this._capCache = new Map();
      this._capCacheTick = this.tickCount;
    }
    let cap = this._capCache.get(player.id);
    if (!cap) {
      let bonus = 0;
      for (const b of this.buildings.values()) {
        if (b.ownerId !== player.id || !b.constructed) continue;
        if (b.kind === "TownHall") bonus += TOWNHALL_STORAGE_BONUS;
        else if (b.kind === "Warehouse") bonus += WAREHOUSE_STORAGE_BONUS;
      }
      const total = BASE_STORAGE_CAP + bonus;
      cap = { Wood: total, Stone: total, Bread: total, Fish: total, Gold: total };
      this._capCache.set(player.id, cap);
    }
    return cap;
  }

  /**
   * Sends every cost the client needs to render its HUD correctly, resolved
   * for this specific player's race — once, right after welcome. This is
   * what the client uses instead of hardcoding its own copy of balance.js;
   * change a cost on the server and every connected client picks it up on
   * their next connection with zero client-side changes needed.
   */
  _sendConfig(ws, player) {
    const trainableKinds = ["Scout", "Soldier", "Archer", "Settler", "Builder", "Priest"];
    const restricted = Object.entries(UNIT_RACE_RESTRICTION).filter(([, race]) => race === player.race).map(([kind]) => kind);
    const unitCost = {};
    for (const kind of [...trainableKinds, ...restricted]) {
      const def = resolveUnitDef(player.race, kind, UNIT_DEFS, RACE_UNIT_OVERRIDES);
      if (def) unitCost[kind] = { cost: def.cost, popCost: def.popCost, minUsedWorkers: def.minUsedWorkers || 0 };
    }
    send(ws, "config", { buildCost: BUILD_COST, unitCost, demolishRefundFraction: DEMOLISH_REFUND_FRACTION });
  }

  /**
   * Admin-only: adds (or subtracts, for negative amounts) resources directly to a player's bank,
   * for testing. Deliberately bypasses the normal storage cap — testing often needs to push past
   * it on purpose — but still clamps to a sane range so a typo can't produce an absurd value.
   */
  handleAdminCheatResources(player, msg) {
    if (!player.isAdmin) return; // silently ignore for non-admins -- no reason to even hint this exists
    const ws = this.clients.get(player.id);
    const amounts = msg.amounts;
    if (!amounts || typeof amounts !== "object") return;

    for (const k of ["Wood", "Stone", "Bread", "Fish", "Gold"]) {
      const v = Number(amounts[k]);
      if (!Number.isFinite(v) || v === 0) continue;
      player.bank[k] = Math.max(0, Math.min(999999, (player.bank[k] || 0) + v));
    }
    this._sendBank(ws, player);
  }

  /** Admin-only: toggles seeing everything anyone in the room has ever discovered, ignoring normal vision entirely. */
  handleAdminToggleReveal(player, msg) {
    if (!player.isAdmin) return;
    player.revealMap = !!msg.reveal;
    // Visibility just changed dramatically in one direction or the other -- force a full resync
    // rather than waiting for the normal diff logic to notice, in either direction.
    player.knownTiles.clear();
    player.knownBuildings.clear();
    const ws = this.clients.get(player.id);
    if (ws) this.sendWorldSlice(player, ws);
  }

  claimAround(center, ownerId, color, player, convertTo = null) {
    let newClaims = 0;
    for (const c of diskCoords(center, CLAIM_RADIUS)) {
      const k = key(c.q, c.r);
      if (!this.claims.has(k)) {
        this.claims.set(k, { ownerId, color });
        newClaims++;
        if (convertTo) {
          const t = this.tiles.getAt(c.q, c.r);
          if (t && (t.kind === "Grass" || t.kind === "Fields")) t.kind = convertTo;
        }
      }
    }
    if (player) {
      player.score += newClaims * SCORE.claimPerTile;
      player.stats.landClaimed += newClaims;
    }
  }

  /** Demolishes one of the player's own buildings: refunds a fraction of its cost and frees the population it used. */
  handleDemolishBuilding(player, msg) {
    const ws = this.clients.get(player.id);
    const q = Number(msg.q), r = Number(msg.r);
    if (!Number.isFinite(q) || !Number.isFinite(r)) return;

    const posKey = key(q, r);
    const building = this.buildings.get(posKey);
    if (!building || building.ownerId !== player.id) return send(ws, "build_rejected", { reason: "not_your_building" });

    const rd = raceOf(player.race);
    let popFreed = 0;
    if (building.kind === "House") popFreed = rd.popPerHouse;
    else if (building.kind === "TownHall") popFreed = rd.popPerTownHall;

    // Don't let freeing population from a House/TownHall drop capacity below what's currently in use elsewhere.
    if (popFreed > 0 && player.popCap - popFreed < player.usedWorkers) {
      return send(ws, "build_rejected", { reason: "population_in_use" });
    }

    const cost = BUILD_COST[building.kind] || {};
    const cap = this.storageCap(player);
    for (const k of Object.keys(cost)) {
      const refund = Math.round((cost[k] || 0) * DEMOLISH_REFUND_FRACTION);
      player.bank[k] = Math.min(cap[k] ?? Infinity, (player.bank[k] || 0) + refund);
    }

    player.popCap -= popFreed;
    player.usedWorkers -= building.workers || 0;
    player.ownedBuildings = player.ownedBuildings.filter(b => !(b.q === q && b.r === r));
    this.buildings.delete(posKey);
    this._capCache.delete(player.id);

    this._sendBank(ws, player);
  }

  advanceConstruction() {
    for (const b of this.buildings.values()) {
      if (b.constructed) continue;
      b.ticksRemaining -= 1;
      if (b.ticksRemaining <= 0) {
        b.ticksRemaining = 0;
        b.constructed = true;
        b.hp = b.maxHp;
        if (b.kind === "TownHall" || b.kind === "Warehouse") this._capCache.delete(b.ownerId); // its storage bonus just started counting
      } else {
        const progress = (b.constructionTicks - b.ticksRemaining) / b.constructionTicks;
        b.hp = Math.max(1, Math.round(1 + (b.maxHp - 1) * progress));
      }
    }
  }

  /** Depleted/partially-gathered resource tiles slowly recover toward their original endowment over time. */
  advanceTileRegen(dtSec) {
    for (const t of this.tiles.cache.values()) {
      if (t.resLeft === undefined || t.maxResLeft === undefined || t.resLeft >= t.maxResLeft) continue;
      t.resLeft = Math.min(t.maxResLeft, t.resLeft + TILE_REGEN_RATE * dtSec);
    }
  }

  /**
   * Ends the game for every player in the room at once (a win condition is a
   * whole-room event, not a personal one — see winConditions.js). The winner
   * gets their final score plus a 10% bonus and the race-specific trophy
   * achievement; everyone's actual final score is persisted either way.
   */
  endGameByWin(winnerId, reason) {
    const winner = this.players.get(winnerId);
    if (!winner) return;

    const bonus = Math.round(winner.score * 0.1);
    const winnerFinalScore = Math.round(winner.score) + bonus;

    const trophyId = RACE_TROPHY_ID[winner.race];
    if (trophyId) achievements.grant(this, winner, trophyId);

    for (const [id, player] of this.players) {
      const isWinner = id === winnerId;
      const finalScore = isWinner ? winnerFinalScore : Math.round(player.score);
      recordGameEnd(player.token, finalScore, player.race, player.stats)
        .catch((err) => log(`[room ${this.id}] recordGameEnd (win) failed for ${id}: ${err.message}`));

      const ws = this.clients.get(id);
      if (ws) {
        send(ws, "game_over", {
          winnerId, winnerName: winner.name, winnerRace: winner.race, reason,
          youWon: isWinner, finalScore, bonus: isWinner ? bonus : 0,
        });
      }
    }

    log(`[room ${this.id}] game ended: ${winner.name} (${winner.race}) won by ${reason}, score ${winnerFinalScore}`);
    this.clients.clear();
    this.players.clear();
    this.detach();
  }

  tick(dtSec) {
    if (this.clients.size === 0) return;
    this.tickCount++;

    this.advanceConstruction();
    combat.advanceTowerDefense(this, Date.now());
    combat.advanceGuardUnits(this, Date.now());
    raceEffects.advanceDwarfMines(this, dtSec);
    diplomacy.reapStaleProposals(this);
    units.advanceTraining(this);
    research.advanceResearch(this);
    advancePriestActions(this);

    if (this.tickCount % ATTACK_COOLDOWN_TICKS === 0) { // reusing this cadence for "every few ticks" race effects too
      raceEffects.advanceScorchedEarth(this);
      raceEffects.advanceElfHealing(this);
    }

    if (this.tickCount % TILE_REGEN_CHECK_TICKS === 0) {
      this.advanceTileRegen(dtSec * TILE_REGEN_CHECK_TICKS);
    }

    for (const player of this.players.values()) {
      achievements.checkStatAchievements(this, player);
    }

    if (this.tickCount % WIN_CHECK_TICKS === 0) {
      const winResult = checkWinConditions(this);
      if (winResult) { this.endGameByWin(winResult.winnerId, winResult.reason); return; }
    }

    for (const b of this.buildings.values()) {
      const owner = this.players.get(b.ownerId);
      if (owner) {
        const scoreRef = { value: 0 };
        gatherTick(this.tiles, b, dtSec, owner.bank, scoreRef, research.effectiveRaceData(owner), this.storageCap(owner));
        owner.score += scoreRef.value * SCORE.gatherPerUnit;
        owner.stats.gathered += scoreRef.value;
      }
    }

    for (const [id, ws] of this.clients) {
      const player = this.players.get(id);
      if (!player) continue;
      this.sendWorldSlice(player, ws);
      this._sendBank(ws, player);
    }

    if (this.tickCount % ADMIN_DEBUG_TICKS === 0) {
      for (const [id, ws] of this.clients) {
        const player = this.players.get(id);
        if (!player?.isAdmin) continue;
        send(ws, "admin_debug", {
          roomId: this.id, tickCount: this.tickCount,
          playerCount: this.players.size, buildingCount: this.buildings.size,
          claimCount: this.claims.size, discoveredTiles: this.tiles.cache.size,
          proposalCount: this.proposals.size,
          memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        });
      }
    }
  }

  sendWorldSlice(player, ws) {
    const center = { q: player.q, r: player.r };
    const visible = new Map();
    if (player.revealMap) {
      // Admin reveal: show every tile anyone in the room has ever discovered, not just this player's own vision.
      for (const t of this.tiles.cache.values()) visible.set(key(t.q, t.r), { q: t.q, r: t.r });
    } else {
      for (const c of diskCoords(center, VISION_RADIUS)) visible.set(key(c.q, c.r), c);
      for (const bp of player.ownedBuildings) {
        for (const c of diskCoords(bp, BUILDING_VISION_RADIUS)) {
          const k = key(c.q, c.r);
          if (!visible.has(k)) visible.set(k, c);
        }
      }
      for (const u of player.units.values()) {
        for (const c of diskCoords({ q: u.q, r: u.r }, SCOUT_VISION_RADIUS)) {
          const k = key(c.q, c.r);
          if (!visible.has(k)) visible.set(k, c);
        }
      }
    }
    const visibleKeys = new Set(visible.keys());
    const changedTiles = [];

    for (const c of visible.values()) {
      const k = key(c.q, c.r);
      const t = this.tiles.getAt(c.q, c.r);
      const claim = this.claims.get(k);
      const prev = player.knownTiles.get(k);
      if (!prev || prev.kind !== t.kind || prev.resLeft !== t.resLeft || prev.claimedBy !== (claim?.ownerId) || prev.blocked !== !!t.blocked) {
        changedTiles.push(claim ? { ...t, claimedBy: { id: claim.ownerId, color: claim.color, name: this.players.get(claim.ownerId)?.name ?? "" } } : t);
        player.knownTiles.set(k, { kind: t.kind, resLeft: t.resLeft, claimedBy: claim?.ownerId, blocked: !!t.blocked });
      }
    }
    if (changedTiles.length) send(ws, "tiles_update", { tiles: changedTiles });

    const players = [];
    for (const [otherId, other] of this.players) {
      if (otherId === player.id) continue;
      if (visibleKeys.has(key(other.q, other.r))) {
        players.push({ id: otherId, name: other.name, tag: other.tag, q: other.q, r: other.r, color: other.color, hp: other.hp, maxHp: other.maxHp, race: other.race });
      }
    }

    const buildings = [];
    const removedBuildings = [];
    for (const k of visibleKeys) {
      const b = this.buildings.get(k);
      if (b) {
        buildings.push(b);
        player.knownBuildings.add(k);
      } else if (player.knownBuildings.has(k)) {
        removedBuildings.push(k);
        player.knownBuildings.delete(k);
      }
    }

    const unitsOut = [];
    for (const [otherId, other] of this.players) {
      for (const u of other.units.values()) {
        if (visibleKeys.has(key(u.q, u.r))) {
          unitsOut.push({ id: u.id, ownerId: otherId, kind: u.kind, level: u.level || 1, guard: !!u.guard, q: u.q, r: u.r, color: other.color, hp: u.hp, maxHp: u.maxHp });
        }
      }
    }

    send(ws, "state", { self: { q: player.q, r: player.r }, players, buildings, removedBuildings, units: unitsOut });
  }

  broadcast(type, payload = {}) {
    for (const ws of this.clients.values()) send(ws, type, payload);
  }

  get stats() {
    return {
      id: this.id,
      clients: this.clients.size,
      players: this.players.size,
      buildings: this.buildings.size,
      seed: this.seed,
      tickCount: this.tickCount,
      claims: this.claims.size,
      discoveredTiles: this.tiles.cache.size,
      lastActive: this.lastActive,
    };
  }
}