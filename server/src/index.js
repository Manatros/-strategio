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
import { upsertIdentity, getHighscores, getOwnedRaces, grantRaceEntitlement, getPlayerRecord, registerAccount, verifyAccountLogin, getIsAdmin, setAdmin, setAdminByNameTag, getPlayerAchievements, getKeybindings, setKeybindings } from "./persist/store.js";
import { ACHIEVEMENTS } from "./config/achievements.js";
import { redirectToSteamLogin, handleSteamReturn } from "./auth/steam.js";
import { RACES } from "./world/races.js";
import { kickRandomBot, ensureBotsFilled } from "./rooms/bots.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.join(__dirname, "../public");

const app = express();
app.use(express.json());

app.get("/health", (_, res) => res.send("ok"));
app.get("/version", (_, res) => res.json({ protocol: cfg.protocol, tickRate: cfg.tickRate }));

const rm = new RoomManager(cfg);
app.get("/room-stats", (_, res) => res.json({ rooms: rm.allStats() }));
/**
 * The real ops-monitoring surface — separate from the in-game admin debug
 * panel on purpose (see the design note this responds to): scoped to the
 * whole server process across every room, not to whichever one game a
 * player happens to be connected to, and never sent over the same channel
 * untrusted game clients talk over.
 */
app.get("/admin/stats", (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: "ADMIN_SECRET not configured" });
  if (req.get("x-admin-secret") !== secret) return res.status(401).json({ error: "unauthorized" });

  const mem = process.memoryUsage();
  res.json({
    process: {
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      memoryMB: { heapUsed: Math.round(mem.heapUsed / 1024 / 1024), rss: Math.round(mem.rss / 1024 / 1024) },
      backend: process.env.DATABASE_URL ? "postgres" : "sqlite",
    },
    rooms: rm.allStats(),
  });
});

app.get("/highscores", async (req, res) => {
  const sortBy = req.query.sortBy === "total" ? "total" : "best"; // whitelist -- anything else falls back to "best"
  res.json({ highscores: await getHighscores(50, sortBy) });
});

// Lets the menu check with the server before showing "Resume Game" — a client-only localStorage
// flag can go stale (grace period expired, game ended in another tab/device) and would otherwise
// show a resume option that's actually dead.
app.get("/can-resume/:token", (req, res) => {
  res.json({ canResume: !!rm.findResumableRoom(req.params.token) });
});

// Full achievement definitions (name/description/category) plus which ones this specific player
// has actually unlocked — the client needs both to render "here's everything, here's what you've
// got" rather than only ever seeing achievements once they're already earned.
app.get("/achievements/:token", async (req, res) => {
  const records = await getPlayerAchievements(req.params.token);
  res.json({ achievements: Object.values(ACHIEVEMENTS), unlocked: records.map((r) => r.id) });
});

// Keybindings are keyed by token, same trust model as every other per-token endpoint — the token
// itself is the player's identity proof, no separate auth needed. This is what makes bindings
// naturally follow an account across devices: logging in adopts the account's stable token (see
// /auth/login), so the same row is read/written from wherever that token connects. Without an
// account it's just a random per-browser token, so bindings persist on this browser but don't
// follow anywhere else.
app.get("/keybindings/:token", async (req, res) => {
  const bindings = await getKeybindings(req.params.token);
  res.json({ bindings });
});

app.post("/keybindings/:token", async (req, res) => {
  const { bindings } = req.body || {};
  if (!bindings || typeof bindings !== "object") return res.status(400).json({ error: "bindings object is required" });
  await setKeybindings(req.params.token, bindings);
  res.json({ ok: true });
});

// A player looks this up before showing the race picker (and to see their own Name#tag), so
// locked races and their identity render correctly before they've even connected.
app.get("/races/:token", async (req, res) => {
  const [record, ownedRaces] = await Promise.all([
    getPlayerRecord(req.params.token),
    getOwnedRaces(req.params.token),
  ]);
  res.json({ ownedRaces, name: record?.name || null, tag: record?.tag || null });
});

app.get("/auth/steam", redirectToSteamLogin);
app.get("/auth/steam/return", handleSteamReturn);

// In-memory, per-process rate limiting on login attempts — a real mitigation for a single server,
// but (like the room/game state itself) doesn't share state across multiple processes. A multi-instance
// deployment would want this backed by something shared (Redis, or the same database) instead.
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 8;
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) { loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS }); return true; }
  if (entry.count >= LOGIN_RATE_MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

/**
 * Username/password accounts — an alternative to Steam login for players
 * without Steam. Deliberately produces the exact same shape of result as
 * Steam login: a stable token the client adopts as its identity. Every
 * downstream system (progress, achievements, entitlements) only ever cares
 * about that token string, so nothing else needed to change to support this.
 */
app.post("/auth/register", async (req, res) => {
  const { username, password } = req.body || {};
  const result = await registerAccount(username, password);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const identity = await upsertIdentity(result.token, { name: username });
  res.json({ token: result.token, name: identity.name, tag: identity.tag });
});

app.post("/auth/login", async (req, res) => {
  if (!checkLoginRateLimit(req.ip)) return res.status(429).json({ error: "too_many_attempts" });
  const { username, password } = req.body || {};
  const result = await verifyAccountLogin(username, password);
  if (!result.ok) return res.status(401).json({ error: result.error });
  const identity = await upsertIdentity(result.token, {});
  res.json({ token: result.token, name: identity.name, tag: identity.tag });
});

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

/** Grants or revokes admin status for an identity. This is now the only way to become admin — protected by ADMIN_SECRET. */
app.post("/admin/set-admin", async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: "ADMIN_SECRET not configured" });
  if (req.get("x-admin-secret") !== secret) return res.status(401).json({ error: "unauthorized" });

  const { token, isAdmin } = req.body || {};
  if (typeof token !== "string") return res.status(400).json({ error: "token is required" });
  await setAdmin(token, !!isAdmin);
  res.json({ token, isAdmin: !!isAdmin });
});

// Same as above but looks the player up by name#tag — more convenient when you know who you want
// to grant admin to but not their raw token. Requires that player to have connected at least once
// already (there's no token to attach admin status to otherwise).
app.post("/admin/set-admin-by-name", async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: "ADMIN_SECRET not configured" });
  if (req.get("x-admin-secret") !== secret) return res.status(401).json({ error: "unauthorized" });

  const { name, tag, isAdmin } = req.body || {};
  if (typeof name !== "string" || typeof tag !== "string") return res.status(400).json({ error: "name and tag are required" });
  const found = await setAdminByNameTag(name, tag, !!isAdmin);
  if (!found) return res.status(404).json({ error: `no player found with name "${name}" and tag "${tag}" — they need to have connected at least once` });
  res.json({ name, tag, isAdmin: !!isAdmin });
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

  // Every race is free — see persist/store.js's FREE_RACES. requestedRace just needs to be a real race.
  const race = RACES.includes(requestedRace) ? requestedRace : "Human";
  const ownedRaces = await getOwnedRaces(token);

  if (mode === "auto") {
    const resumable = rm.findResumableRoom(token);
    if (resumable) {
      const clientId = resumable.resume(ws, token);
      if (clientId) {
        ensureBotsFilled(resumable, cfg.targetLobbySize); // in case a bot died while this player was disconnected
        return { room: resumable, clientId };
      }
    }
  }

  // Starting fresh (mode="new", or "auto" whose resume attempt above didn't pan out) — if this same
  // token still has a disconnected-but-not-yet-reaped instance sitting in some other room, that old
  // game is now genuinely abandoned. Surrender it explicitly (saves its score) rather than leaving
  // it to linger until the grace period naturally expires.
  const staleRoom = rm.findResumableRoom(token);
  if (staleRoom) {
    const stalePlayer = [...staleRoom.players.values()].find((p) => p.token === token && p.disconnectedAt !== null);
    if (stalePlayer) staleRoom.handleSurrender(stalePlayer, "started_new_game_elsewhere");
  }

  const room = rm.pickRoom();
  const isAdmin = await getIsAdmin(token);
  // Make room for the incoming real player if the lobby's already at its target size with bots
  // filling it out — a bot-filled room isn't actually full for a real player's purposes.
  if (room.players.size >= cfg.targetLobbySize) kickRandomBot(room);
  const clientId = room.join(ws, { token, name, color, race, tag: identity.tag, ownedRaces, isAdmin });
  ensureBotsFilled(room, cfg.targetLobbySize);
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
