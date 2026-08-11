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
import { canAfford } from "../world/economy.js";
import { canPlace, gatherTick } from "../world/buildings.js";
import { RACES, raceOf, RACE_UNIT_OVERRIDES, resolveUnitDef } from "../world/races.js";
import { recordGameEnd } from "../persist/store.js";
import * as achievements from "./achievements.js";
import { checkWinConditions } from "./winConditions.js";
import { RACE_TROPHY_ID } from "../config/achievements.js";
import {
  DEFAULT_TICK_RATE, HEX_SIZE, VISION_RADIUS, BUILDING_VISION_RADIUS, SCOUT_VISION_RADIUS, UNIT_VISION_BONUS,
  CLAIM_RADIUS, STARTING_BANK, BUILD_COST, CONSTRUCTION_TICKS, BUILDING_HEALTH, UNIT_DEFS,
  WORKER_EXEMPT, ATTACK_COOLDOWN_TICKS, SCORE, PLAYER_MAX_HP, DISCONNECT_GRACE_MS, PLAYER_COLORS, DEMOLISH_REFUND_FRACTION,
  BASE_STORAGE_CAP, TOWNHALL_STORAGE_BONUS, WAREHOUSE_STORAGE_BONUS, UNIT_RACE_RESTRICTION, TILE_REGEN_RATE, TILE_REGEN_CHECK_TICKS,
  ROAD_CLAIM_RADIUS, ROAD_UPGRADE_COST, ROAD_SPEED_TICKS, GATHERING_BUILDING_CAP, BUILDING_UNLOCK_RESEARCH, DWARF_VAULT_GOLD_BONUS, HERO_ITEM_SLOTS,
} from "../config/balance.js";
import * as diplomacy from "./diplomacy.js";
import * as combat from "./combat.js";
import * as raceEffects from "./raceEffects.js";
import * as units from "./units.js";
import * as heroItems from "./heroItems.js";
import * as research from "./research.js";
import { advancePriestActions } from "./priestActions.js";
import { advanceBuilderRepair } from "./builderActions.js";
import { advanceMonasteryHealing } from "./monasteryActions.js";
import { spawnCivilians, handleAssignCivilian, advanceCivilianTravel, advanceCivilianDelivery, advanceCivilianReturnHome, advanceCivilianRespawns, advanceWarehouseRoving, releaseCiviliansFrom, handleUpgradeHouse, handleCollectResources, handleUpgradeGatheringBuilding, handleUpgradeWarehouseTier, handleConvertTile, tryAutoAssignWorker, handleAssignNearestWorker, handleUnassignWorker, tryAutoConnectRoad } from "./civilians.js";
import { ensureBotsFilled } from "./bots.js";
import { advanceBotAI } from "./botAI.js";
import { spendResources, creditResources, initStorageInventory, humanStorageCap, storageCapFor, recomputeHumanBank, advanceHumanGathering, advanceHouseTax } from "./humanEconomy.js";

const WIN_CHECK_TICKS = 10; // domination scans the whole tile cache, so check every 5s (at 2 ticks/sec) rather than every tick
const ADMIN_DEBUG_TICKS = 4; // how often admin clients get a live server-diagnostics push (2s at the default tick rate)
const BOT_BACKFILL_CHECK_TICKS = 20; // how often to check whether a freed slot (e.g. a real player's disconnect grace period expired) needs a new bot

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
      orphanedBank: { ...STARTING_BANK }, // Human only (see rooms/humanEconomy.js) — inert for every other race
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
      heroItems: new Array(HERO_ITEM_SLOTS).fill(null), // this player's own hero-unit equipment — see heroItems.js
      score: 0,
      stats: { gathered: 0, built: 0, destroyed: 0, captured: 0, landClaimed: 0, kills: 0 },
      research: new Set(),
      buildingUnlocks: new Set(), // separate from research above — see BUILDING_UNLOCK_RESEARCH in balance.js
      pendingResearch: null,
      revealMap: false,
      pendingCivilianRespawns: [], // Human only — [{ homeBuildingId, readyAt }], see civilians.js's advanceCivilianRespawns
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
        // units/buildings/terrain. This was the resume bug. Snapshot what they knew BEFORE
        // clearing, though — sendWorldSlice only covers currently-visible tiles, so anything they'd
        // explored before that's now outside their vision radius needs a separate resend below, or
        // it's silently lost (their exploration/claims history disappearing on resume).
        const previouslyKnownTileKeys = [...player.knownTiles.keys()];
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

        // Resend whatever they'd explored before that ISN'T already covered by the currently-visible
        // slice just sent above — the previously-out-of-vision remainder of their exploration history.
        const alreadyCovered = new Set(player.knownTiles.keys()); // sendWorldSlice just populated this with the currently-visible set
        const staleTiles = [];
        for (const k of previouslyKnownTileKeys) {
          if (alreadyCovered.has(k)) continue;
          const [tq, tr] = k.split(",").map(Number);
          const t = this.tiles.getAt(tq, tr);
          const claim = this.claims.get(k);
          staleTiles.push(claim
            ? { ...t, claimedBy: { id: claim.ownerId, color: claim.color, name: this.players.get(claim.ownerId)?.name ?? "", race: this.players.get(claim.ownerId)?.race ?? "Human" } }
            : t);
          player.knownTiles.set(k, { kind: t.kind, resLeft: t.resLeft, claimedBy: claim?.ownerId, blocked: !!t.blocked });
        }
        if (staleTiles.length) send(ws, "tiles_update", { tiles: staleTiles });

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
      buildingUnlocks: [...(player.buildingUnlocks ?? [])],
      heroItems: player.heroItems ?? [],
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
        this._endAbandonedDisconnect(player, "grace_period_expired");
      }
    }
  }

  /** Shared "this player's game is over, persist their score" logic — used by every path a
   *  player's game can end through, so none of them can silently skip saving it. */
  _persistGameEnd(player, reason) {
    recordGameEnd(player.token, Math.round(player.score), player.race, player.stats, !!player.isBot)
      .catch((err) => log(`[room ${this.id}] recordGameEnd failed for ${player.id}: ${err.message}`));
    const ws = this.clients.get(player.id);
    if (ws) send(ws, "you_died", { finalScore: Math.round(player.score), reason });
    this.clients.delete(player.id);
  }

  /** Grace-period expiry (a disconnected player who never came back) — they already had their full
   *  wait as a disconnected-but-intact player, so this is a full, immediate removal: buildings and
   *  claims are cleaned up right away rather than starting a second wait on top of the first. */
  _endAbandonedDisconnect(player, reason) {
    this._persistGameEnd(player, reason);
    this._removePlayerAndCleanup(player);
  }

  /** Death (combat, TownHall elimination) or voluntary surrender — genuinely starts the decay
   *  window now (see advanceAbandonedDecay): buildings and units drain HP over DISCONNECT_GRACE_MS
   *  instead of lingering forever ownerless or vanishing instantly, so other players still have a
   *  window to attack and get credit for finishing them off rather than the game just erasing
   *  everything for free. */
  _endPlayerGame(player, reason) {
    this._persistGameEnd(player, reason);
    this.usedSpawns.delete(player.spawnKey);
    player.abandoned = true;
    player.abandonedAt = Date.now();
    player.disconnectedAt = null; // no longer meaningful once abandoned — decay has its own timer

    // Snapshot each building/unit's decay rate based on its hp right now, so it drains toward
    // exactly 0 by the deadline at a constant rate — independent of whatever damage (or none) it
    // takes from other players along the way, rather than a percentage-based decay that would
    // asymptotically approach 0 without ever quite reaching it.
    const graceSec = DISCONNECT_GRACE_MS / 1000;
    for (const b of this.buildings.values()) {
      if (b.ownerId === player.id) b.decayHpPerSec = b.hp / graceSec;
    }
    for (const u of player.units.values()) {
      u.decayHpPerSec = u.hp / graceSec;
    }

    this.broadcast("player_leave", { id: player.id, reason });
    ensureBotsFilled(this, this.cfg.targetLobbySize);
  }

  /** Fully removes a player and everything they own — buildings, claims, units — right now. Used
   *  once decay finishes (see advanceAbandonedDecay) and for grace-period expiry. */
  _removePlayerAndCleanup(player) {
    for (const [k, b] of [...this.buildings]) {
      if (b.ownerId !== player.id) continue;
      this.buildings.delete(k);
    }
    for (const k of [...this.claims.keys()]) {
      if (this.claims.get(k).ownerId === player.id) this.claims.delete(k);
    }
    this.usedSpawns.delete(player.spawnKey);
    this.players.delete(player.id);
  }

  /** Advances decay for every abandoned player's buildings and units — drains hp at each one's
   *  snapshotted constant rate (see _endPlayerGame), destroying it (and releasing just its own
   *  claim radius, same as normal combat destruction) once hp hits 0. Other players can still
   *  attack and finish these off for the usual combat credit during the window — decay doesn't
   *  prevent that, it's just what happens if nobody bothers. Once the full grace window has
   *  elapsed, whatever's left gets fully cleaned up regardless. */
  advanceAbandonedDecay(dtSec) {
    const now = Date.now();
    for (const player of [...this.players.values()]) {
      if (!player.abandoned) continue;
      if (now - player.abandonedAt > DISCONNECT_GRACE_MS) {
        this._removePlayerAndCleanup(player);
        continue;
      }
      for (const [k, b] of [...this.buildings]) {
        if (b.ownerId !== player.id) continue;
        b.hp -= (b.decayHpPerSec || 0) * dtSec;
        if (b.hp <= 0) {
          this.releaseClaimsAround(b);
          this.buildings.delete(k);
        }
      }
      for (const [uid, u] of [...player.units]) {
        u.hp -= (u.decayHpPerSec || 0) * dtSec;
        if (u.hp <= 0) player.units.delete(uid);
      }
    }
  }

  /** Ends a player's game permanently: persists their score+stats, tells their client, removes them.
   *  No-ops if they're already abandoned (surrendered/died earlier) — their game already ended once;
   *  a further "kill" during their decay window (their last building falling, etc.) isn't a second
   *  game-ending event. */
  killPlayer(player, reason = "died") {
    if (player.abandoned) return;
    this._endPlayerGame(player, reason);
  }

  /** A player voluntarily ending their own current game — same accounting as dying (score saved,
   *  removed, bots backfilled), just player-initiated instead of combat-initiated. Also reused for
   *  the automatic "started a new game elsewhere, this old disconnected instance is abandoned" case. */
  handleSurrender(player, reason = "surrendered") {
    if (player.abandoned) return;
    this._endPlayerGame(player, reason);
  }

  randomSpawnSeed() {
    const SPREAD = 40 + this.players.size * 3;
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * SPREAD;
    return { q: Math.round(Math.cos(angle) * dist), r: Math.round(Math.sin(angle) * dist) };
  }

  /** Is every tile within `radius` of `c` free of any claimed territory? Used so a new spawn always
   *  has genuine room to move and claim land of its own, rather than landing inside or right next to
   *  someone else's territory (where they might not even be able to step off their own spawn tile). */
  _farEnoughFromClaims(c, radius) {
    if (this.claims.size === 0) return true; // nothing claimed yet anywhere -- trivially fine
    for (const nc of diskCoords(c, radius)) {
      if (this.claims.has(key(nc.q, nc.r))) return false;
    }
    return true;
  }

  findSpawn(start, allowHighMountain = false) {
    const MAX_RADIUS = 80; // wider search than before -- the territory-distance requirement needs more room
    const MIN_DISTANCE_FROM_CLAIM = 10;
    const free = (c) =>
      canEnterTerrain(this.tiles.getAt(c.q, c.r), allowHighMountain) &&
      !this.usedSpawns.has(key(c.q, c.r)) &&
      this._farEnoughFromClaims(c, MIN_DISTANCE_FROM_CLAIM);

    if (free(start)) return start;
    for (let radius = 1; radius < MAX_RADIUS; radius++) {
      for (const c of diskCoords(start, radius)) {
        if (free(c)) return c;
      }
    }

    // Every candidate within MAX_RADIUS was too close to someone's territory (a very crowded/claimed
    // map) — fall back to the old terrain-only requirement rather than fail to spawn the player at all.
    const freeIgnoringClaims = (c) => canEnterTerrain(this.tiles.getAt(c.q, c.r), allowHighMountain) && !this.usedSpawns.has(key(c.q, c.r));
    if (freeIgnoringClaims(start)) return start;
    for (let radius = 1; radius < MAX_RADIUS; radius++) {
      for (const c of diskCoords(start, radius)) {
        if (freeIgnoringClaims(c)) return c;
      }
    }
    return start;
  }

  /** Whether `kind` is actually placeable right now for this player — true immediately for
   *  anything not listed in BUILDING_UNLOCK_RESEARCH for their race (the vast majority of
   *  buildings, and every non-Human race's whole roster), otherwise only once the specific unlock
   *  research covering it has been purchased at whichever building offers it. */
  isBuildingUnlocked(player, kind) {
    const raceOptions = BUILDING_UNLOCK_RESEARCH[player.race];
    if (!raceOptions) return true;
    const relevant = Object.values(raceOptions).flat().find((o) => o.building === kind);
    if (!relevant) return true; // not gated at all
    return !!player.buildingUnlocks?.has(relevant.id);
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
      case "cancel_training": units.handleCancelTraining(this, player, msg); break;
      case "step_unit": units.handleStepUnit(this, player, msg); break;
      case "merge_units": units.handleMergeUnits(this, player, msg); break;
      case "set_guard": units.handleSetGuard(this, player, msg); break;
      case "surrender": this.handleSurrender(player); break;
      case "equip_hero_item": heroItems.handleEquipHeroItem(this, player, msg); break;
      case "unequip_hero_item": heroItems.handleUnequipHeroItem(this, player, msg); break;
      case "forage": units.handleForage(this, player, msg); break;
      case "attack": combat.handleAttack(this, player, msg); break;
      case "declare_war": diplomacy.handleDeclareWar(this, player, msg); break;
      case "propose": diplomacy.handlePropose(this, player, msg); break;
      case "respond_proposal": diplomacy.handleRespondProposal(this, player, msg); break;
      case "research": research.handleResearch(this, player, msg); break;
      case "research_building": research.handleResearchBuilding(this, player, msg); break;
      case "admin_cheat_resources": this.handleAdminCheatResources(player, msg); break;
      case "admin_toggle_reveal": this.handleAdminToggleReveal(player, msg); break;
      case "upgrade_road": this.handleUpgradeRoad(player, msg); break;
      case "assign_civilian": handleAssignCivilian(this, player, msg); break;
      case "assign_nearest_worker": handleAssignNearestWorker(this, player, msg); break;
      case "unassign_worker": handleUnassignWorker(this, player, msg); break;
      case "upgrade_house": handleUpgradeHouse(this, player, msg); break;
      case "collect_resources": handleCollectResources(this, player, msg); break;
      case "upgrade_gathering_building": handleUpgradeGatheringBuilding(this, player, msg); break;
      case "upgrade_warehouse": handleUpgradeWarehouseTier(this, player, msg); break;
      case "convert_tile": handleConvertTile(this, player, msg); break;
      default: break;
    }
  }

  handleStep(player, msg) {
    const ws = this.clients.get(player.id);
    const q = Number(msg.q), r = Number(msg.r);
    if (!Number.isFinite(q) || !Number.isFinite(r)) return;

    if (hexDistance({ q: player.q, r: player.r }, { q, r }) !== 1) {
      return send(ws, "step_rejected", { q, r, reason: "not_adjacent" });
    }
    const now = Date.now();
    if (now - player.lastStepAt < this.stepCooldownFor(player, q, r)) {
      return send(ws, "step_rejected", { q, r, reason: "too_soon" });
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

    // TownHall placement still requires a nearby Settler (see below) — the actual founding
    // mechanism for expanding to new territory. Every other building requires an available Builder
    // within 1 tile — not already locked to another construction — which gets locked to this one
    // for the duration; the client is responsible for auto-walking the closest available Builder
    // into range before sending this message (see GameScene's placement flow).
    let builderId = null;
    if (kind !== "TownHall") {
      const found = [...player.units].find(([, u]) => u.kind === "Builder" && !u.constructingBuildingId && hexDistance({ q: u.q, r: u.r }, { q, r }) <= 1);
      if (!found) return send(ws, "build_rejected", { reason: "need_builder" });
      builderId = found[0];
    }

    const posKey = key(q, r);
    if (this.buildings.has(posKey)) return send(ws, "build_rejected", { reason: "occupied" });

    const rd = raceOf(player.race);
    const tile = this.tiles.getAt(q, r);
    if (!canPlace(kind, tile, rd)) return send(ws, "build_rejected", { reason: "invalid_tile" });

    if (!this.isBuildingUnlocked(player, kind)) {
      return send(ws, "build_rejected", { reason: "not_researched" });
    }

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
    if (!WORKER_EXEMPT.has(kind) && !rd.hasCivilians) {
      // Non-Human: the old instant abstract-worker model. Human buildings start unstaffed —
      // the player assigns idle Civilians afterward (see civilians.js), which is what actually
      // increments building.workers/player.usedWorkers once they arrive.
      workers = msg.workers === 2 ? 2 : 1;
      const available = player.popCap - player.usedWorkers;
      if (available < workers) return send(ws, "build_rejected", { reason: "not_enough_population" });
    }

    spendResources(this, player, cost);
    if (kind === "Bridge" && tile.kind === "Water") tile.kind = "Bridge";
    if (kind === "House" && !rd.hasCivilians) player.popCap += rd.popPerHouse; // Human: civilians spawn on completion instead, see advanceConstruction()
    if (kind === "TownHall") {
      if (!rd.hasCivilians) player.popCap += rd.popPerTownHall; // Human: civilians spawn on completion instead, see advanceConstruction()
      player.units.delete(settlerId);
    }

    const maxHp = BUILDING_HEALTH[kind] ?? 10;
    const ticksNeeded = CONSTRUCTION_TICKS[kind] ?? 10;
    const building = {
      id: uid(), kind, q, r, ownerId: player.id, workers,
      constructed: false, ticksRemaining: ticksNeeded, constructionTicks: ticksNeeded,
      hp: 1, maxHp, lastAttackAt: 0, trainQueue: [], builderId,
    };
    if (builderId) {
      const builder = player.units.get(builderId);
      if (builder) builder.constructingBuildingId = building.id;
    }
    if (kind === "Road") building.level = 1;
    // Explicitly tag Human's other tiered buildings at level 1 too — this is what lets
    // maxWorkersFor() (civilians.js) tell "a Human building genuinely at tier 1" apart from "a
    // non-Human building that has no tier concept at all and should keep the old flat worker cap,"
    // since both would otherwise read as building.level === undefined.
    const GATHERING_AND_WAREHOUSE = new Set(["Lumberjack", "Farm", "Mine", "FishingBoat", "Warehouse"]);
    if (rd.hasCivilians && GATHERING_AND_WAREHOUSE.has(kind)) building.level = 1;
    this.buildings.set(posKey, building);

    // Living Tree / Great Mines convert what they claim (simplified single-kind overwrite — see races.js note).
    const convertTo = kind === "TownHall" && rd.claimConvertsToForest ? "Forest" : null;
    const claimRadius = kind === "Road" ? ROAD_CLAIM_RADIUS : CLAIM_RADIUS;
    this.claimAround({ q, r }, player.id, player.color, player, convertTo, claimRadius);

    player.usedWorkers += workers;
    player.ownedBuildings.push({ q, r });
    player.stats.built += 1;
    this._capCache.delete(player.id);

    this._sendBank(ws, player);
  }

  /** Upgrades a basic (level 1) road to a stone (level 2) road — faster still, no further upgrade beyond that. */
  handleUpgradeRoad(player, msg) {
    const ws = this.clients.get(player.id);
    const q = Number(msg.q), r = Number(msg.r);
    if (!Number.isFinite(q) || !Number.isFinite(r)) return;

    const building = this.buildings.get(key(q, r));
    if (!building || building.kind !== "Road" || building.ownerId !== player.id) {
      return send(ws, "build_rejected", { reason: "not_your_road" });
    }
    if (!building.constructed) return send(ws, "build_rejected", { reason: "still_constructing" });
    if ((building.level ?? 1) >= 2) return send(ws, "build_rejected", { reason: "already_max_level" });
    if (!canAfford(player.bank, ROAD_UPGRADE_COST)) return send(ws, "build_rejected", { reason: "cannot_afford" });

    spendResources(this, player, ROAD_UPGRADE_COST);
    building.level = 2;
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
      if (raceOf(player.race).hasCivilians) {
        cap = humanStorageCap(this, player);
      } else {
        let bonus = 0, goldBonus = 0;
        for (const b of this.buildings.values()) {
          if (b.ownerId !== player.id || !b.constructed) continue;
          if (b.kind === "TownHall") bonus += TOWNHALL_STORAGE_BONUS;
          else if (b.kind === "Warehouse") {
            bonus += WAREHOUSE_STORAGE_BONUS;
            if (player.race === "Dwarf") goldBonus += DWARF_VAULT_GOLD_BONUS;
          }
        }
        const total = BASE_STORAGE_CAP + bonus;
        cap = { Wood: total, Stone: total, Bread: total, Fish: total, Gold: total + goldBonus };
      }
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

  /** Does any OTHER building this owner has (besides the one at excludeQ,excludeR) still justify a claim on this tile? */
  _tileCoveredByOtherBuilding(q, r, ownerId, excludeQ, excludeR) {
    for (const b of this.buildings.values()) {
      if (b.ownerId !== ownerId) continue;
      if (b.q === excludeQ && b.r === excludeR) continue;
      if (hexDistance({ q, r }, { q: b.q, r: b.r }) <= CLAIM_RADIUS) return true;
    }
    return false;
  }

  /** A building changing hands (captured) takes the territory immediately around it with it. */
  transferClaimsAround(building, newOwnerId, newColor) {
    for (const c of diskCoords({ q: building.q, r: building.r }, CLAIM_RADIUS)) {
      const k = key(c.q, c.r);
      const claim = this.claims.get(k);
      if (claim && claim.ownerId !== newOwnerId) {
        this.claims.set(k, { ownerId: newOwnerId, color: newColor });
        // A Road sitting on this tile belonged to whoever held the territory — when the territory
        // changes hands (captured, stolen from an enemy), the road goes with it, matching how a
        // road only ever benefits its owner's race in the first place.
        const road = this.buildings.get(k);
        if (road && road.kind === "Road" && road.ownerId !== newOwnerId) road.ownerId = newOwnerId;
      }
    }
  }

  /** A building being destroyed outright releases the territory it alone was justifying — unless
   *  another of the same owner's surviving buildings also covers that ground, in which case it stays claimed. */
  releaseClaimsAround(building) {
    const ownerId = building.ownerId;
    for (const c of diskCoords({ q: building.q, r: building.r }, CLAIM_RADIUS)) {
      const k = key(c.q, c.r);
      const claim = this.claims.get(k);
      if (!claim || claim.ownerId !== ownerId) continue;
      if (this._tileCoveredByOtherBuilding(c.q, c.r, ownerId, building.q, building.r)) continue;
      this.claims.delete(k);
    }
  }

  /** How long (ms) a single step to (q,r) takes for this player — their race's base speed, sped up if
   *  the destination tile has one of their own roads on it. Roads only benefit their owner's race
   *  having roads at all (currently just Human) — a non-Human standing on a Human road isn't sped up,
   *  since baseTicksPerTile for every other race is already the same as a stone road's speed anyway. */
  stepCooldownFor(player, q, r) {
    const rd = raceOf(player.race);
    let ticks = rd.baseTicksPerTile ?? 1;
    if (rd.hasRoads) {
      const road = this.buildings.get(key(q, r));
      if (road && road.kind === "Road" && road.constructed) {
        ticks = ROAD_SPEED_TICKS[road.level ?? 1] ?? ticks;
      }
    }
    ticks = Math.max(1, ticks - heroItems.heroMoveSpeedBonus(player));
    return ticks * this.stepCooldownMs;
  }

  claimAround(center, ownerId, color, player, convertTo = null, radius = CLAIM_RADIUS) {
    let newClaims = 0;
    for (const c of diskCoords(center, radius)) {
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

    if (!building.constructed && building.builderId) {
      const builder = player.units.get(building.builderId);
      if (builder) builder.constructingBuildingId = null;
    }

    const rd = raceOf(player.race);
    let popFreed = 0;
    if (building.kind === "House" && !rd.hasCivilians) popFreed = rd.popPerHouse; // Human: civilians already spawned don't vanish with the house
    else if (building.kind === "TownHall" && !rd.hasCivilians) popFreed = rd.popPerTownHall;

    // Don't let freeing population from a House/TownHall drop capacity below what's currently in use elsewhere.
    if (popFreed > 0 && player.popCap - popFreed < player.usedWorkers) {
      return send(ws, "build_rejected", { reason: "population_in_use" });
    }
    releaseCiviliansFrom(this, building); // free whoever was working here, regardless of race (no-op for races without civilians)

    // Storage buildings hold real inventory for Human — pull out whatever's actually stored before
    // the building is gone, same "resources tied to a specific building" logic as Warehouse capture.
    const rdHasCivilians = raceOf(player.race).hasCivilians;
    let stored = null;
    if (rdHasCivilians && building.inventory && (building.kind === "TownHall" || building.kind === "Warehouse")) {
      stored = { ...building.inventory };
    }

    // Remove the building from the room BEFORE crediting any refund — otherwise, if this was the
    // player's only storage building, the refund would credit right back into the very building
    // about to disappear, leaving player.bank in a stale state the moment it's actually deleted
    // (correct only until some unrelated event forces a recompute, which would silently wipe it).
    player.popCap -= popFreed;
    player.usedWorkers -= building.workers || 0;
    player.ownedBuildings = player.ownedBuildings.filter(b => !(b.q === q && b.r === r));
    this.releaseClaimsAround(building);
    this.buildings.delete(posKey);
    this._capCache.delete(player.id);

    const cost = BUILD_COST[building.kind] || {};
    const refundAmounts = {};
    for (const k of Object.keys(cost)) {
      refundAmounts[k] = Math.round((cost[k] || 0) * DEMOLISH_REFUND_FRACTION);
    }
    if (stored) for (const k of Object.keys(stored)) refundAmounts[k] = (refundAmounts[k] || 0) + stored[k];
    creditResources(this, player, refundAmounts);

    // creditResources' non-Human path (a plain bank add) doesn't cap against storage capacity the
    // way the Human building-based path naturally does — clamp explicitly here so a refund can't
    // push a non-Human player's bank above what their buildings can actually hold (matches the old
    // behavior this replaced, and the same pattern diplomacy.js already uses for trade credits).
    if (!rdHasCivilians) {
      const cap = this.storageCap(player);
      for (const k of Object.keys(cap)) {
        if (player.bank[k] > cap[k]) player.bank[k] = cap[k];
      }
    }

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
        if (b.builderId) {
          const owner = this.players.get(b.ownerId);
          const builder = owner?.units.get(b.builderId);
          if (builder) builder.constructingBuildingId = null;
        }
        if (b.kind === "TownHall" || b.kind === "Warehouse") this._capCache.delete(b.ownerId); // its storage bonus just started counting
        if (b.kind === "TownHall" || b.kind === "Warehouse") {
          const owner = this.players.get(b.ownerId);
          if (owner && raceOf(owner.race).hasCivilians) initStorageInventory(this, owner, b);
        }
        if (b.kind === "House" || b.kind === "TownHall") {
          const owner = this.players.get(b.ownerId);
          const rd = owner && raceOf(owner.race);
          if (owner && rd?.hasCivilians) {
            if (b.kind === "TownHall") {
              // 1 Builder (a real unit, distinct from the Civilian worker economy) + one fewer
              // Civilian than before, so every player starts with a Builder to actually construct
              // things with. Free of popCost like a Civilian, with a matching +1 popCap, so this
              // doesn't quietly eat into population capacity compared to the old all-Civilian spawn.
              const civCount = Math.max(0, (rd.civiliansPerTownHall ?? 2) - 1);
              spawnCivilians(this, owner, b, civCount);
              const builderDef = UNIT_DEFS.Builder;
              const builderUnit = {
                id: uid(), kind: "Builder", level: 1, guard: false, q: b.q, r: b.r,
                lastStepAt: 0, lastActionAt: 0, hp: builderDef.hp, maxHp: builderDef.hp, popCost: 0,
              };
              owner.units.set(builderUnit.id, builderUnit);
              owner.popCap += 1;
            } else {
              spawnCivilians(this, owner, b, rd.civiliansPerHouse ?? 4);
            }
          }
        }
        {
          const owner = this.players.get(b.ownerId);
          if (owner && raceOf(owner.race).hasCivilians) { tryAutoConnectRoad(this, owner, b); tryAutoAssignWorker(this, owner, b); }
        }
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
      recordGameEnd(player.token, finalScore, player.race, player.stats, !!player.isBot)
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
    advanceBuilderRepair(this, dtSec);
    this.advanceAbandonedDecay(dtSec);
    advanceMonasteryHealing(this, dtSec);
    advanceCivilianTravel(this);
    advanceCivilianDelivery(this);
    advanceCivilianReturnHome(this);
    advanceCivilianRespawns(this);
    advanceWarehouseRoving(this);
    advanceBotAI(this);

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

    if (this.tickCount % BOT_BACKFILL_CHECK_TICKS === 0) {
      ensureBotsFilled(this, this.cfg.targetLobbySize);
    }

    for (const b of this.buildings.values()) {
      const owner = this.players.get(b.ownerId);
      if (owner) {
        const rd = raceOf(owner.race);
        if (rd.hasCivilians) {
          // Human: discrete, presence-gated gathering (see humanEconomy.js's advanceHumanGathering) —
          // a flat 1 resource every 6 ticks, only while an assigned Civilian is physically standing
          // at the building right now (not off on a delivery run). Handles its own score/stats.
          advanceHumanGathering(this, b);
          if (b.kind === "House") advanceHouseTax(this, b);
        } else {
          const scoreRef = { value: 0 };
          gatherTick(this.tiles, b, dtSec, owner.bank, scoreRef, research.effectiveRaceData(owner), this.storageCap(owner));
          owner.score += scoreRef.value * SCORE.gatherPerUnit;
          owner.stats.gathered += scoreRef.value;
        }
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
        const radius = SCOUT_VISION_RADIUS + (UNIT_VISION_BONUS[u.kind] || 0);
        for (const c of diskCoords({ q: u.q, r: u.r }, radius)) {
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
        changedTiles.push(claim ? { ...t, claimedBy: { id: claim.ownerId, color: claim.color, name: this.players.get(claim.ownerId)?.name ?? "", race: this.players.get(claim.ownerId)?.race ?? "Human" } } : t);
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
          unitsOut.push({
            id: u.id, ownerId: otherId, kind: u.kind, level: u.level || 1, guard: !!u.guard, q: u.q, r: u.r, color: other.color, hp: u.hp, maxHp: u.maxHp,
            homeBuildingId: u.kind === "Civilian" ? u.homeBuildingId ?? null : undefined,
            assignedTo: u.kind === "Civilian" ? u.assignedTo ?? null : undefined,
            moving: u.kind === "Civilian" ? !!(u.travel || u.delivery || u.roving || u.returningHome) : undefined,
            carrying: u.kind === "Civilian"
              ? (u.delivery?.resourceKind ? { kind: u.delivery.resourceKind, amount: u.delivery.amount } : u.roving?.resourceKind ? { kind: u.roving.resourceKind, amount: u.roving.amount } : null)
              : undefined,
            constructingBuildingId: u.kind === "Builder" ? u.constructingBuildingId ?? null : undefined,
          });
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
