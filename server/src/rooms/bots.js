// Bot players: fill empty lobby slots so games always feel populated. A bot
// is a completely normal `player` entry in room.players/room.clients — it
// just has isBot:true and a stub WebSocket that silently no-ops on send(),
// so every existing handler (handlePlaceBuilding, handleTrainUnit, etc.)
// works on it unmodified. The AI itself (botAI.js) drives it by calling
// those same handlers the way a real client's messages would.
import { uid } from "../utils/uid.js";
import { RACES } from "../world/races.js";

export const BOT_PERSONALITIES = ["passive", "neutral", "aggressive"];

const BOT_NAME_POOL = [
  "Aldric", "Brennan", "Cassia", "Doran", "Elowen", "Fenris", "Garrick", "Hilda",
  "Ivar", "Joslyn", "Kestrel", "Lyra", "Magnus", "Nissa", "Osric", "Petra",
  "Quill", "Rowan", "Sable", "Torvin", "Ulric", "Vesna", "Wren", "Yara",
];

function pickBotName(room) {
  const used = new Set([...room.players.values()].map((p) => p.name));
  const pool = BOT_NAME_POOL.filter((n) => !used.has(n));
  const base = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : BOT_NAME_POOL[Math.floor(Math.random() * BOT_NAME_POOL.length)];
  return used.has(base) ? `${base}${Math.floor(Math.random() * 900 + 100)}` : base;
}

/** A stub WebSocket a bot "sends" over — every message the server would normally push to a real
 *  client just gets silently dropped, since nothing is listening on the other end. */
function makeStubSocket() {
  return { readyState: 1, OPEN: 1, on: () => {}, send: () => {}, close: () => {} };
}

/** Creates one bot, joins it into the room exactly like a real player, and tags it with a
 *  personality that botAI.js reads to decide how it builds, expands, and handles diplomacy. */
export function createBot(room) {
  const personality = BOT_PERSONALITIES[Math.floor(Math.random() * BOT_PERSONALITIES.length)];
  const race = RACES[Math.floor(Math.random() * RACES.length)];
  const name = pickBotName(room);
  const token = `bot:${uid()}`; // never used for persistence lookups (recordGameEnd skips bots entirely), just needs to be unique

  const id = room.join(makeStubSocket(), { token, name, race });
  const player = room.players.get(id);
  player.isBot = true;
  player.botPersonality = personality;
  player.botState = {
    lastThinkAt: 0,
    warDecisions: new Set(), // playerIds already evaluated for a war decision, so "neutral" only coinflips once per enemy
    lastExpansionCheckAt: 0,
    blockedBy: null, // playerId identified as the reason expansion stalled, once war is declared over it
    townHallTarget: null, // { q, r } once chosen, so the settler walks toward a fixed spot instead of a shifting one
    buildTarget: null, // { kind, q, r } for the current economy building the player character is walking toward
    wanderTarget: null, // { q, r } for idle expansion movement, anchored back to home each time it's re-picked
  };
  return player;
}

/** Removes a bot from the room the same way a disconnect would, but immediately (no reconnect
 *  grace period — there's nothing to reconnect). Used both to make room for a joining real player
 *  and any other time a bot needs to be dropped outright. */
export function removeBot(room, player) {
  room.clients.delete(player.id);
  room.usedSpawns.delete(player.spawnKey);
  room.players.delete(player.id);
  room.broadcast("player_leave", { id: player.id, reason: "bot_removed" });
}

/** True if at least one non-bot player is currently part of this room (connected or within their
 *  disconnect grace period) — the condition that justifies the room existing/staying populated at
 *  all, both for gating whether bots should start filling a room (ensureBotsFilled) and for the
 *  reaping decision in RoomManager (a disconnected player still counts as "real" here until
 *  reapDisconnected actually removes them once DISCONNECT_GRACE_MS elapses — see RoomManager.js). */
export function hasAnyRealPlayer(room) {
  for (const player of room.players.values()) {
    if (!player.isBot) return true;
  }
  return false;
}

/** Picks and removes one random bot to free a slot — used when a real player is about to join a
 *  room that's already at its target size. */
export function kickRandomBot(room) {
  const bots = [...room.players.values()].filter((p) => p.isBot);
  if (bots.length === 0) return false;
  const victim = bots[Math.floor(Math.random() * bots.length)];
  removeBot(room, victim);
  return true;
}

/** Tops the room up to its target lobby size with bots — but only if there's at least one real
 *  player in it. A room with zero real players should never accumulate bots (see the "no bot-only
 *  lobbies" rule enforced in RoomManager's reaping) — this is the other half of that: don't even
 *  let a bot-only room start filling up in the first place. */
export function ensureBotsFilled(room, targetSize) {
  if (!hasAnyRealPlayer(room)) return;
  while (room.players.size < targetSize) {
    createBot(room);
  }
}
