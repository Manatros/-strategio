import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { cfg } from "./config.js";
import { log } from "./utils/logger.js";
import { send, safeJSON } from "./net/wire.js";
import { RoomManager } from "./rooms/RoomManager.js";
import { uid } from "./utils/uid.js";
import { upsertIdentity, getHighscores, getOwnedRaces, grantRaceEntitlement, getPlayerRecord } from "./persist/store.js";
import { redirectToSteamLogin, handleSteamReturn } from "./auth/steam.js";
import { RACES } from "./world/races.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.join(__dirname, "../public");

const app = express();
app.use(express.json());

app.get("/health", (_, res) => res.send("ok"));
app.get("/version", (_, res) => res.json({ protocol: cfg.protocol, tickRate: cfg.tickRate }));

const rm = new RoomManager(cfg);
app.get("/room-stats", (_, res) => res.json({ rooms: rm.allStats() }));
app.get("/highscores", async (_, res) => res.json({ highscores: await getHighscores(50) }));

// A player looks this up before showing the race picker (and to see their own Name#tag), so
// locked races and their identity render correctly before they've even connected.
app.get("/races/:token", async (req, res) => {
  const [record, ownedRaces] = await Promise.all([
    getPlayerRecord(req.params.token),
    getOwnedRaces(req.params.token),
  ]);
  const effectiveOwned = process.env.DEV_UNLOCK_ALL_RACES === "1" ? [...RACES] : ownedRaces;
  res.json({ ownedRaces: effectiveOwned, name: record?.name || null, tag: record?.tag || null });
});

app.get("/auth/steam", redirectToSteamLogin);
app.get("/auth/steam/return", handleSteamReturn);

/**
 * Grants a race entitlement to an identity. This is the one integration
 * point every payment path funnels through — a Steam DLC-ownership check,
 * a Stripe webhook, or a manual grant all just call this the same way.
 * Protected by a shared secret (set ADMIN_SECRET in the environment) since
 * anyone who can hit this endpoint can hand out free races.
 */
app.post("/admin/grant-race", async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: "ADMIN_SECRET not configured" });
  if (req.get("x-admin-secret") !== secret) return res.status(401).json({ error: "unauthorized" });

  const { token, race, source } = req.body || {};
  if (typeof token !== "string" || typeof race !== "string") {
    return res.status(400).json({ error: "token and race are required" });
  }
  const granted = await grantRaceEntitlement(token, race, source || "admin");
  res.json({ granted, ownedRaces: await getOwnedRaces(token) });
});

app.use(express.static(FRONTEND_DIST));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/health") || req.path.startsWith("/version") ||
      req.path.startsWith("/room-stats") || req.path.startsWith("/highscores") ||
      req.path.startsWith("/races/") || req.path.startsWith("/admin/") || req.path.startsWith("/auth/")) return next();
  res.sendFile(path.join(FRONTEND_DIST, "index.html"), (err) => { if (err) next(); });
});

const server = app.listen(cfg.port, () => {
  log(`HTTP on http://localhost:${cfg.port}`);
});

const wss = new WebSocketServer({ server });

/**
 * Handshake: { type:"handshake", name, color, clientToken, mode }
 *  - clientToken: a client-generated, persistent (localStorage) id, or a
 *    stable "steam:<id64>" one after Steam sign-in. Not an account/login
 *    system -- just enough to remember "this is the same player" for score
 *    history and for resuming a still-live game.
 *  - mode: "auto" tries to resume the game this token was last in (if it's
 *    still alive and the player hasn't died there); "new" (or anything
 *    else) always starts a brand-new game on a new map.
 */
async function handleHandshake(ws, msg) {
  const name = typeof msg.name === "string" && msg.name.trim() ? msg.name.trim().slice(0, 24) : "Player";
  const color = Number.isFinite(msg.color) ? Number(msg.color) : undefined;
  const token = typeof msg.clientToken === "string" && msg.clientToken ? msg.clientToken : uid();
  const mode = msg.mode === "auto" ? "auto" : "new";
  const requestedRace = typeof msg.race === "string" ? msg.race : undefined;

  const identity = await upsertIdentity(token, { name, color });

  // Human is always free; every other race must be owned. Set DEV_UNLOCK_ALL_RACES=1
  // locally to skip this check while testing races you haven't "purchased".
  const devUnlockAll = process.env.DEV_UNLOCK_ALL_RACES === "1";
  const ownedRaces = await getOwnedRaces(token);
  const race = devUnlockAll || ownedRaces.includes(requestedRace) ? requestedRace : "Human";

  if (mode === "auto") {
    const resumable = rm.findResumableRoom(token);
    if (resumable) {
      const clientId = resumable.resume(ws, token);
      if (clientId) return { room: resumable, clientId };
    }
  }

  const room = rm.pickRoom();
  const clientId = room.join(ws, { token, name, color, race, tag: identity.tag, ownedRaces: devUnlockAll ? null : ownedRaces });
  rm.registerResumable(token, room.id);
  return { room, clientId };
}

wss.on("connection", (ws) => {
  let joined = false;
  let joining = false;
  let room = null;
  let clientId = null;
  const pending = []; // messages that arrive before the (now-async) handshake finishes resolving

  const finishJoin = (r, id) => {
    room = r; clientId = id; joined = true;
    for (const raw of pending) room.onMessage(clientId, raw);
    pending.length = 0;
  };

  const doJoin = async (msg) => {
    if (joining) return;
    joining = true;
    try {
      const result = await handleHandshake(ws, msg);
      finishJoin(result.room, result.clientId);
    } catch (err) {
      log(`[connection] handshake failed: ${err.message}`);
      ws.close();
    }
  };

  ws.on("message", (raw) => {
    if (joined) return; // Room's own listener (wired up inside join()/resume()) now owns this socket — forwarding here too would process every message twice
    if (!joining) {
      const msg = safeJSON(raw) || {};
      if (msg.type === "handshake") { doJoin(msg); return; }
      // no handshake as the first message -> auto-join a fresh room, forward this message once ready
      pending.push(raw);
      doJoin({});
      return;
    }
    // handshake already in flight -- queue this message, it'll be replayed in order once joined
    pending.push(raw);
  });

  ws.on("close", () => {
    if (joined && room && clientId) room.leave(clientId, "ws_close");
  });

  const t = setTimeout(() => { if (!joining) doJoin({}); }, 500);
  ws.on("message", () => clearTimeout(t));
});

setInterval(() => rm.reapIdle(Date.now()), 30_000);