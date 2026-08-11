// Diplomacy: relations between players (war / open_borders / neutral) and
// the propose -> accept/refuse flow for trade, demands, and open borders.
// Every function takes `room` explicitly instead of using `this`, so this
// stays a plain, testable module rather than being tangled into Room.
import { send } from "../net/wire.js";
import { canAfford } from "../world/economy.js";
import { raceOf } from "../world/races.js";
import { uid } from "../utils/uid.js";
import { PROPOSAL_MAX_AGE_MS } from "../config/balance.js";
import { spendResources, creditResources } from "./humanEconomy.js";

const RESOURCE_KEYS = ["Wood", "Stone", "Bread", "Fish", "Gold"];

function clampToCap(room, player) {
  const cap = room.storageCap(player);
  for (const k of RESOURCE_KEYS) {
    if (player.bank[k] > cap[k]) player.bank[k] = cap[k];
  }
}

/** Validates a client-supplied {Wood,Stone,...} amounts object for a trade/demand proposal. Returns null if invalid/empty. */
function sanitizeResourceAmounts(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  let any = false;
  for (const k of RESOURCE_KEYS) {
    const v = Number(input[k]);
    if (Number.isFinite(v) && v > 0) { out[k] = v; any = true; }
  }
  return any ? out : null;
}

export function relationKey(a, b) { return [a, b].sort().join("|"); }

/**
 * Orcs are always at war, with everyone, permanently — that's a floor no
 * stored relation can override. Elves always have at least open borders —
 * a floor too, but war (from either side) still wins over it.
 */
export function getRelation(room, a, b) {
  const pa = room.players.get(a), pb = room.players.get(b);
  const ra = pa ? raceOf(pa.race) : null, rb = pb ? raceOf(pb.race) : null;
  if (ra?.startingRelation === "war" || rb?.startingRelation === "war") return "war";
  const stored = room.relations.get(relationKey(a, b));
  if (stored) return stored;
  if (ra?.alwaysOpenBorders || rb?.alwaysOpenBorders) return "open_borders";
  return "neutral";
}

export function setRelation(room, a, b, status) {
  room.relations.set(relationKey(a, b), status);
  for (const id of [a, b]) {
    const ws = room.clients.get(id);
    if (ws) send(ws, "relations_update", { withId: id === a ? b : a, status });
  }
}

/** Declaring war needs no consent from the target — it's unilateral and immediate. */
export function handleDeclareWar(room, player, msg) {
  const target = room.players.get(msg.toId);
  if (!target || target.id === player.id) return;
  setRelation(room, player.id, target.id, "war");
}

/** Orcs "don't know the common tongue" — they can neither send nor receive trade/demand/open-borders proposals. */
export function handlePropose(room, player, msg) {
  const ws = room.clients.get(player.id);
  if (!raceOf(player.race).canTrade) return;
  const type = msg.proposalType;
  if (!["trade", "demand", "open_borders"].includes(type)) return;
  const target = room.players.get(msg.toId);
  if (!target || target.id === player.id) return;
  if (!raceOf(target.race).canTrade) return; // they wouldn't understand the offer

  const offer = sanitizeResourceAmounts(msg.offer);
  const request = sanitizeResourceAmounts(msg.request);
  if (type === "trade" && (!offer || !request)) return;
  if (type === "demand" && !request) return;

  const proposal = { id: uid(), type, fromId: player.id, toId: target.id, offer, request, createdAt: Date.now() };
  room.proposals.set(proposal.id, proposal);

  const targetWs = room.clients.get(target.id);
  if (targetWs) {
    send(targetWs, "proposal_received", {
      id: proposal.id, proposalType: type, fromId: player.id, fromName: player.name, offer, request,
    });
  } else {
    room.proposals.delete(proposal.id); // not connected right now — don't let it linger forever
  }
}

export function handleRespondProposal(room, player, msg) {
  if (!raceOf(player.race).canTrade) return;
  const proposal = room.proposals.get(msg.proposalId);
  if (!proposal || proposal.toId !== player.id) return;
  room.proposals.delete(proposal.id);

  const fromPlayer = room.players.get(proposal.fromId);
  const fromWs = room.clients.get(proposal.fromId);
  const toWs = room.clients.get(player.id);

  if (!msg.accept || !fromPlayer) {
    if (fromWs) send(fromWs, "proposal_result", { id: proposal.id, proposalType: proposal.type, accepted: false, withId: player.id });
    return;
  }

  if (proposal.type === "open_borders") {
    setRelation(room, proposal.fromId, player.id, "open_borders");
  } else if (proposal.type === "trade") {
    if (!canAfford(fromPlayer.bank, proposal.offer) || !canAfford(player.bank, proposal.request)) {
      if (fromWs) send(fromWs, "proposal_result", { id: proposal.id, proposalType: proposal.type, accepted: false, withId: player.id, reason: "cannot_afford" });
      if (toWs) send(toWs, "proposal_result", { id: proposal.id, proposalType: proposal.type, accepted: false, withId: proposal.fromId, reason: "cannot_afford" });
      return;
    }
    spendResources(room, fromPlayer, proposal.offer);
    creditResources(room, fromPlayer, proposal.request);
    if (!raceOf(fromPlayer.race).hasCivilians) clampToCap(room, fromPlayer);
    spendResources(room, player, proposal.request);
    creditResources(room, player, proposal.offer);
    if (!raceOf(player.race).hasCivilians) clampToCap(room, player);
    if (fromWs) room._sendBank(fromWs, fromPlayer);
    room._sendBank(toWs, player);
  } else if (proposal.type === "demand") {
    if (!canAfford(player.bank, proposal.request)) {
      if (fromWs) send(fromWs, "proposal_result", { id: proposal.id, proposalType: proposal.type, accepted: false, withId: player.id, reason: "cannot_afford" });
      return;
    }
    spendResources(room, player, proposal.request);
    creditResources(room, fromPlayer, proposal.request);
    if (!raceOf(fromPlayer.race).hasCivilians) clampToCap(room, fromPlayer);
    room._sendBank(toWs, player);
    if (fromWs) room._sendBank(fromWs, fromPlayer);
  }

  if (fromWs) send(fromWs, "proposal_result", { id: proposal.id, proposalType: proposal.type, accepted: true, withId: player.id });
}

/** Clears out proposals nobody responded to, so they don't linger forever. */
export function reapStaleProposals(room, now = Date.now(), maxAgeMs = PROPOSAL_MAX_AGE_MS) {
  for (const [id, p] of room.proposals) {
    if (now - p.createdAt > maxAgeMs) room.proposals.delete(id);
  }
}
