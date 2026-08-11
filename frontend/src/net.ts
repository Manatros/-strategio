// src/net.ts
import type { Tile, Axial } from "./hex/types";
import type { BuildingKind } from "./buildings/types";
import type { Bank } from "./econ/resources";

export type TrainQueueItem = { id: string; kind: string; ticksRemaining: number; totalTicks: number };
export type RemoteBuilding = {
  id: string; kind: BuildingKind; q: number; r: number; ownerId: string;
  constructed: boolean; ticksRemaining: number; hp: number; maxHp: number;
  workers?: number; // how many civilians/abstract workers are currently staffed here
  level?: number;   // Road: 1=basic/2=stone. Gathering buildings/Warehouse: their tier (1-3, see civilians.js's maxWorkersFor).
  level2?: boolean; // only meaningful for House (Human's Urban Planning upgrade)
  inventory?: Partial<Record<"Wood" | "Stone" | "Bread" | "Fish" | "Gold", number>>; // Human only — resources gathered but not yet delivered/collected
  trainQueue?: TrainQueueItem[]; // up to 4 queued/in-progress units — only the front one's ticksRemaining actually counts down
};
export type RemotePlayer = { id: string; name: string; tag: string; q: number; r: number; color: number; hp: number; maxHp: number; race: string };
export type RemoteUnit = {
  id: string; ownerId: string; kind: string; level: number; guard: boolean; q: number; r: number; color: number; hp: number; maxHp: number;
  homeBuildingId?: string | null; // only meaningful for Civilian — which House/TownHall spawned them
  assignedTo?: string | null;     // only meaningful for Civilian — the building id they're currently working, if any
  moving?: boolean;               // only meaningful for Civilian — true while actively walking (new assignment, delivery, roving, or heading home), false while stationed (idle at home or working in place)
  carrying?: { kind: string; amount: number } | null; // only meaningful for Civilian — what they're physically carrying during a delivery/roving trip, if any
  constructingBuildingId?: string | null; // only meaningful for Builder — the building id they're currently locked to constructing, if any (null/absent = available)
};
export type ClaimedBy = { id: string; color: number; name: string; race: string };
export type RemoteTile = Tile & { claimedBy?: ClaimedBy };

export type RelationStatus = "neutral" | "war" | "open_borders";
export type ProposalType = "trade" | "demand" | "open_borders";
export type ResourceAmounts = Partial<Record<keyof Bank, number>>;

export type ServerMsg =
  | { type: "welcome"; playerId: string; roomId: string; seed: number; hexSize: number; visionRadius: number; spawn: Axial; color: number; race: string; resumed: boolean; hp: number; maxHp: number; stepCooldownMs: number; ownedRaces: string[] | null; tag: string; isAdmin: boolean }
  | { type: "admin_debug"; roomId: string; tickCount: number; playerCount: number; buildingCount: number; claimCount: number; discoveredTiles: number; proposalCount: number; memoryMB: number }
  | { type: "bank"; bank: Bank; popCap: number; workers: number; hp: number; maxHp: number; score: number; research: string[]; storageCap: number; pendingResearch: { optionId: string; ticksRemaining: number; totalTicks: number } | null; buildingUnlocks?: string[] }
  | { type: "config"; buildCost: Record<string, Partial<Bank>>; unitCost: Record<string, { cost: Partial<Bank>; popCost: number; minUsedWorkers: number }>; demolishRefundFraction: number }
  | { type: "tiles_update"; tiles: RemoteTile[] }
  | { type: "state"; self: Axial; players: RemotePlayer[]; buildings: RemoteBuilding[]; removedBuildings: string[]; units: RemoteUnit[] }
  | { type: "player_join"; id: string; name: string; tag: string }
  | { type: "player_leave"; id: string; reason: string }
  | { type: "step_rejected"; q: number; r: number; unitId?: string; reason: string }
  | { type: "build_rejected"; reason: string }
  | { type: "you_died"; finalScore: number; reason: string }
  | { type: "relations_update"; withId: string; status: RelationStatus }
  | { type: "proposal_received"; id: string; proposalType: ProposalType; fromId: string; fromName: string; offer: ResourceAmounts | null; request: ResourceAmounts | null }
  | { type: "proposal_result"; id: string; proposalType: ProposalType; accepted: boolean; withId: string; reason?: string }
  | { type: "research_unlocked"; optionId: string }
  | { type: "achievement_unlocked"; id: string; name: string; description: string; category: string }
  | { type: "game_over"; winnerId: string; winnerName: string; winnerRace: string; reason: string; youWon: boolean; finalScore: number; bonus: number };

/**
 * Called once on page load. If we just landed here from the Steam login
 * redirect (?steamToken=steam:...), adopt that as this browser's identity
 * going forward — overwriting any existing random token, since signing in
 * is meant to take over. Cleans the query param off the URL either way.
 */
export function consumeSteamLoginFromUrl(): { signedIn: boolean; error: boolean; name: string | null } {
  const params = new URLSearchParams(window.location.search);
  const steamToken = params.get("steamToken");
  const steamName = params.get("steamName");
  const steamError = params.get("steamError");
  if (!steamToken && !steamError) return { signedIn: false, error: false, name: null };

  if (steamToken) {
    localStorage.setItem("strategio_clientToken", steamToken);
    localStorage.removeItem("strategio_inGame"); // that flag pointed at a session under the old (now-abandoned) token
  }
  if (steamName) localStorage.setItem("playerName", steamName);

  params.delete("steamToken");
  params.delete("steamName");
  params.delete("steamError");
  const clean = window.location.pathname + (params.toString() ? `?${params}` : "");
  window.history.replaceState({}, "", clean);

  return { signedIn: !!steamToken, error: !!steamError, name: steamName };
}

/** A persistent (localStorage) identity token — not a login, just enough to track score history and resume a still-live game. */
export function getClientToken(): string {
  const KEY = "strategio_clientToken";
  let token = localStorage.getItem(KEY);
  if (!token) {
    token = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(KEY, token);
  }
  return token;
}

function resolveServerUrl(): string {
  const override = new URLSearchParams(window.location.search).get("server");
  if (override) return override;
  // Dev mode (Vite on 5173, backend on 3000) — use whatever host the page was actually loaded
  // from, not a hardcoded "localhost". That literal only means "this device" from the browser's
  // perspective; testing from another machine on the LAN via e.g. http://192.168.x.x:5173 needs
  // the WebSocket to target that same address on port 3000, not the visiting device's own loopback.
  if (window.location.port === "5173") return `ws://${window.location.hostname}:3000`;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

export type ConnectOptions = {
  name: string;
  color: number;
  race: string;
  /** "new" always starts a fresh game on a fresh map; "auto" tries to resume the game this browser was last in. */
  mode: "new" | "auto";
};

export type DebugLogEntry = { dir: "in" | "out"; type: string; at: number; raw: unknown };

export function connectWS(opts: ConnectOptions, url = resolveServerUrl()) {
  const ws = new WebSocket(url);
  const listeners = new Set<(msg: ServerMsg) => void>();

  // Captures every message in both directions, for the admin debug HUD — entirely inert (just an
  // array + a Set of subscribers) when nothing is listening, so this costs nothing for normal players.
  const debugLog: DebugLogEntry[] = [];
  const debugListeners = new Set<(entry: DebugLogEntry) => void>();
  const MAX_DEBUG_LOG = 200;
  function pushDebugLog(entry: DebugLogEntry) {
    debugLog.push(entry);
    if (debugLog.length > MAX_DEBUG_LOG) debugLog.shift();
    debugListeners.forEach(fn => fn(entry));
  }
  const rawSend = ws.send.bind(ws);
  const loggedSend = (data: string) => {
    try { const parsed = JSON.parse(data); pushDebugLog({ dir: "out", type: parsed.type, at: Date.now(), raw: parsed }); } catch { /* ignore */ }
    rawSend(data);
  };

  ws.addEventListener("open", () => {
    loggedSend(JSON.stringify({
      type: "handshake",
      name: opts.name,
      color: opts.color,
      race: opts.race,
      clientToken: getClientToken(),
      mode: opts.mode,
    }));
  });

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      pushDebugLog({ dir: "in", type: msg.type, at: Date.now(), raw: msg });
      listeners.forEach(fn => fn(msg));
    } catch { /* ignore malformed frames */ }
  });

  return {
    onMessage(fn: (msg: ServerMsg) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Admin debug HUD hook — fires for every message sent or received, doesn't affect normal gameplay. */
    onDebugLog(fn: (entry: DebugLogEntry) => void) { debugListeners.add(fn); return () => debugListeners.delete(fn); },
    getDebugLog() { return debugLog; },
    step(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "step", q, r }));
    },
    placeBuilding(kind: BuildingKind, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "place_building", kind, q, r }));
    },
    /** Demolishes one of our own buildings — refunds part of its cost and frees the population it used. */
    demolishBuilding(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "demolish_building", q, r }));
    },
    trainUnit(kind: string, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "train_unit", kind, q, r }));
    },
    /** Cancels a queued/in-progress unit at a specific queue slot, refunding its full cost. */
    cancelTraining(q: number, r: number, index: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "cancel_training", q, r, index }));
    },
    /** Voluntarily ends the current game — same accounting as dying (score saved), player-initiated. */
    surrender() {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "surrender" }));
    },
    stepUnit(unitId: string, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "step_unit", unitId, q, r }));
    },
    /** A Soldier attacks an adjacent tile (enemy building, unit, or player). */
    attack(unitId: string, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "attack", unitId, q, r }));
    },
    /** Merges 3 same-kind, same-level units standing on (q,r) into one unit a level higher (max level 3). */
    mergeUnits(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "merge_units", q, r }));
    },
    /** Unilateral and immediate — no consent needed from the target. */
    declareWar(toId: string) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "declare_war", toId }));
    },
    /** Trade, resource demands, and open-borders all need the other player to accept via respondProposal(). */
    propose(type: ProposalType, toId: string, offer: ResourceAmounts | null, request: ResourceAmounts | null) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "propose", proposalType: type, toId, offer, request }));
    },
    respondProposal(proposalId: string, accept: boolean) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "respond_proposal", proposalId, accept }));
    },
    /** Unlocks a research option at one of our own Research buildings. */
    research(optionId: string) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "research", optionId }));
    },
    /** Unlocks a building-unlock research option at a specific TownHall/Church — separate from the
     *  abstract-bonus research above, this permanently unlocks another building kind for placement. */
    researchBuilding(q: number, r: number, optionId: string) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "research_building", q, r, optionId }));
    },
    /** Guard mode: this unit automatically attacks any enemy that comes within its range. */
    setGuard(unitId: string, guard: boolean) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "set_guard", unitId, guard }));
    },
    /** Elf's Forager (a renamed Scout) ability — instantly gathers from the tile it's standing on. */
    forage(unitId: string) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "forage", unitId }));
    },
    /** Admin-only: server ignores this from non-admins. Bypasses the storage cap on purpose, for testing. */
    adminCheatResources(amounts: ResourceAmounts) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "admin_cheat_resources", amounts }));
    },
    /** Admin-only: server ignores this from non-admins. Shows everything anyone in the room has discovered. */
    adminToggleReveal(reveal: boolean) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "admin_toggle_reveal", reveal }));
    },
    /** Upgrades a basic road to a stone road (Human-only) — faster still, no further level beyond that. */
    upgradeRoad(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "upgrade_road", q, r }));
    },
    /** Sends an idle Civilian (Human-only) walking toward a worker building to start working there. */
    assignCivilian(civilianId: string, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "assign_civilian", civilianId, q, r }));
    },
    /** Same idea, but for the Building HUD's "Assign Worker" button — the server picks the best
     *  idle Civilian itself (closest available house), no need to separately select one first. */
    assignNearestWorker(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "assign_nearest_worker", q, r }));
    },
    /** Releases one worker (the most recently assigned) from a building back to idle, so they can
     *  be reassigned somewhere else. */
    unassignWorker(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "unassign_worker", q, r }));
    },
    /** Upgrades a House to level 2 (Human-only, needs the Urban Planning research) — spawns 2 more Civilians. */
    upgradeHouse(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "upgrade_house", q, r }));
    },
    /** Any unit (or the player character, if unitId is omitted) grabs a gathering building's current
     *  stock instantly if adjacent — Human-only, an alternative to waiting for Civilian delivery. */
    collectResources(unitId: string | null, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "collect_resources", unitId: unitId ?? undefined, q, r }));
    },
    /** Upgrades a gathering building's tier (Human-only, needs research for level 2/3). */
    upgradeGatheringBuilding(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "upgrade_gathering_building", q, r }));
    },
    /** Upgrades a Warehouse's tier (Human-only, cost only, no research gate). */
    upgradeWarehouse(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "upgrade_warehouse", q, r }));
    },
    /** Converts a nearby tile to whatever terrain a level-3 gathering building collects from — costs Gold. */
    convertTile(buildingQ: number, buildingR: number, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) loggedSend(JSON.stringify({ type: "convert_tile", buildingQ, buildingR, q, r }));
    },
    close() { ws.close(); },
    socket: ws,
  };
}

export type WS = ReturnType<typeof connectWS>;

export type Highscore = {
  name: string; tag: string | null; color: number; bestScore: number; totalScore: number; gamesPlayed: number;
  race: string | null; stats: { gathered: number; built: number; destroyed: number; captured: number; landClaimed: number; kills: number } | null;
};

/** sortBy: "best" (highest score in a single game) or "total" (cumulative score across every game). */
export async function fetchHighscores(sortBy: "best" | "total" = "best"): Promise<Highscore[]> {
  const res = await fetch(`/highscores?sortBy=${sortBy}`);
  const json = await res.json();
  return json.highscores ?? [];
}

export type Achievement = {
  id: string; name: string; description: string; category: string; kind: "stat" | "special";
  statKey?: string; threshold?: number; race?: string;
};
export async function fetchAchievements(token: string): Promise<{ achievements: Achievement[]; unlocked: string[] }> {
  const res = await fetch(`/achievements/${token}`);
  const json = await res.json();
  return { achievements: json.achievements ?? [], unlocked: json.unlocked ?? [] };
}
