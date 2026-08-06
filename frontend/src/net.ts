// src/net.ts
import type { Tile, Axial } from "./hex/types";
import type { BuildingKind } from "./buildings/types";
import type { Bank } from "./econ/resources";

export type RemoteBuilding = {
  id: string; kind: BuildingKind; q: number; r: number; ownerId: string;
  constructed: boolean; ticksRemaining: number; hp: number; maxHp: number;
};
export type RemotePlayer = { id: string; name: string; tag: string; q: number; r: number; color: number; hp: number; maxHp: number; race: string };
export type RemoteUnit = { id: string; ownerId: string; kind: string; level: number; guard: boolean; q: number; r: number; color: number; hp: number; maxHp: number };
export type ClaimedBy = { id: string; color: number; name: string };
export type RemoteTile = Tile & { claimedBy?: ClaimedBy };

export type RelationStatus = "neutral" | "war" | "open_borders";
export type ProposalType = "trade" | "demand" | "open_borders";
export type ResourceAmounts = Partial<Record<keyof Bank, number>>;

export type ServerMsg =
  | { type: "welcome"; playerId: string; roomId: string; seed: number; hexSize: number; visionRadius: number; spawn: Axial; color: number; race: string; resumed: boolean; hp: number; maxHp: number; stepCooldownMs: number; ownedRaces: string[] | null; tag: string }
  | { type: "bank"; bank: Bank; popCap: number; workers: number; hp: number; maxHp: number; score: number; research: string[]; storageCap: number; pendingResearch: { optionId: string; ticksRemaining: number; totalTicks: number } | null }
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
  | { type: "research_unlocked"; optionId: string };

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
  if (window.location.port === "5173") return "ws://localhost:3000";
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

export function connectWS(opts: ConnectOptions, url = resolveServerUrl()) {
  const ws = new WebSocket(url);
  const listeners = new Set<(msg: ServerMsg) => void>();

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
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
      listeners.forEach(fn => fn(msg));
    } catch { /* ignore malformed frames */ }
  });

  return {
    onMessage(fn: (msg: ServerMsg) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    step(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "step", q, r }));
    },
    placeBuilding(kind: BuildingKind, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "place_building", kind, q, r }));
    },
    /** Demolishes one of our own buildings — refunds part of its cost and frees the population it used. */
    demolishBuilding(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "demolish_building", q, r }));
    },
    trainUnit(kind: "Scout" | "Soldier" | "Archer", q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "train_unit", kind, q, r }));
    },
    stepUnit(unitId: string, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "step_unit", unitId, q, r }));
    },
    /** A Soldier attacks an adjacent tile (enemy building, unit, or player). */
    attack(unitId: string, q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "attack", unitId, q, r }));
    },
    /** Merges 3 same-kind, same-level units standing on (q,r) into one unit a level higher (max level 3). */
    mergeUnits(q: number, r: number) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "merge_units", q, r }));
    },
    /** Unilateral and immediate — no consent needed from the target. */
    declareWar(toId: string) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "declare_war", toId }));
    },
    /** Trade, resource demands, and open-borders all need the other player to accept via respondProposal(). */
    propose(type: ProposalType, toId: string, offer: ResourceAmounts | null, request: ResourceAmounts | null) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "propose", proposalType: type, toId, offer, request }));
    },
    respondProposal(proposalId: string, accept: boolean) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "respond_proposal", proposalId, accept }));
    },
    /** Unlocks a research option at one of our own Research buildings. */
    research(optionId: string) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "research", optionId }));
    },
    /** Guard mode: this unit automatically attacks any enemy that comes within its range. */
    setGuard(unitId: string, guard: boolean) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "set_guard", unitId, guard }));
    },
    close() { ws.close(); },
    socket: ws,
  };
}

export type WS = ReturnType<typeof connectWS>;

export type Highscore = {
  name: string; tag: string | null; color: number; bestScore: number; gamesPlayed: number;
  race: string | null; stats: { gathered: number; built: number; destroyed: number; captured: number; landClaimed: number; kills: number } | null;
};

export async function fetchHighscores(): Promise<Highscore[]> {
  const res = await fetch("/highscores");
  const json = await res.json();
  return json.highscores ?? [];
}