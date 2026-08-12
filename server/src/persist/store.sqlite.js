// SQLite backend for player persistence — used automatically whenever
// DATABASE_URL isn't set, so small/local deployments need zero setup at
// all. Every function is async even though better-sqlite3 itself is
// synchronous under the hood, so callers don't care which backend is
// active (see store.js, the dispatcher) — same interface either way.
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { log } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../../data");
const DB_FILE = path.join(DATA_DIR, "players.db");
const OLD_JSON_FILE = path.join(DATA_DIR, "players.json"); // only read once, for migration

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL"); // lets reads (leaderboard queries) proceed without blocking on writes

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    token TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'Player',
    tag TEXT,
    color INTEGER NOT NULL DEFAULT 3830271,
    best_score REAL NOT NULL DEFAULT 0,
    total_score REAL NOT NULL DEFAULT 0,
    games_played INTEGER NOT NULL DEFAULT 0,
    race TEXT,
    stats_json TEXT,
    owned_races_json TEXT NOT NULL DEFAULT '[]',
    purchase_log_json TEXT NOT NULL DEFAULT '[]',
    achievements_json TEXT NOT NULL DEFAULT '[]',
    is_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
  CREATE INDEX IF NOT EXISTS idx_players_best_score ON players(best_score DESC);

  CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY,
    username_lower TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username_lower ON accounts(username_lower);
`);

// Migration: add achievements_json to any players.db created before this column existed.
const existingCols = db.prepare("PRAGMA table_info(players)").all().map(c => c.name);
if (!existingCols.includes("achievements_json")) {
  db.exec("ALTER TABLE players ADD COLUMN achievements_json TEXT NOT NULL DEFAULT '[]'");
  log("[store:sqlite] migrated schema: added achievements_json column");
}
if (!existingCols.includes("is_admin")) {
  db.exec("ALTER TABLE players ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  log("[store:sqlite] migrated schema: added is_admin column");
}
if (!existingCols.includes("keybindings_json")) {
  db.exec("ALTER TABLE players ADD COLUMN keybindings_json TEXT");
  log("[store:sqlite] migrated schema: added keybindings_json column");
}
if (!existingCols.includes("total_score")) {
  // Backfill: for anyone who already has games recorded, we only ever kept their best score, not a
  // running total — seed total_score with best_score as a reasonable starting point rather than 0
  // (0 would make an established player's cumulative total look artificially like a brand-new player's).
  db.exec("ALTER TABLE players ADD COLUMN total_score REAL NOT NULL DEFAULT 0");
  db.exec("UPDATE players SET total_score = best_score");
  log("[store:sqlite] migrated schema: added total_score column (backfilled from best_score)");
}
// Safe to run unconditionally either way: a fresh database already has the column (from CREATE
// TABLE above, so the migration branch just above was skipped) but still needs this index; an
// existing database just had the column added by that branch. CREATE INDEX IF NOT EXISTS is a
// no-op if it's already there from a previous run.
db.exec("CREATE INDEX IF NOT EXISTS idx_players_total_score ON players(total_score DESC)");

migrateFromJsonIfNeeded();

/** scrypt with a random salt per password — Node's built-in, no extra dependency, well-regarded for this. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex"), b = Buffer.from(check, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b); // constant-time, avoids leaking hash-match info via timing
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

/**
 * Creates a username/password account and returns the stable token it maps
 * to going forward — "account:<username>", same pattern as Steam's
 * "steam:<id64>". This is deliberately just another way to obtain a stable
 * token; every other system (progress, achievements, entitlements) already
 * only cares about the token string, so nothing else needed to change.
 */
export async function registerAccount(username, password) {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return { ok: false, error: "invalid_username" }; // 3-24 chars, letters/numbers/underscore only
  }
  if (typeof password !== "string" || password.length < 8) {
    return { ok: false, error: "password_too_short" };
  }
  const usernameLower = username.toLowerCase();
  const existing = db.prepare("SELECT username FROM accounts WHERE username_lower = ?").get(usernameLower);
  if (existing) return { ok: false, error: "username_taken" };

  const passwordHash = hashPassword(password);
  db.prepare("INSERT INTO accounts (username, username_lower, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(username, usernameLower, passwordHash, Date.now());

  return { ok: true, token: `account:${usernameLower}` };
}

export async function verifyAccountLogin(username, password) {
  if (typeof username !== "string" || typeof password !== "string") return { ok: false, error: "invalid_credentials" };
  const row = db.prepare("SELECT username_lower, password_hash FROM accounts WHERE username_lower = ?").get(username.toLowerCase());
  if (!row || !verifyPassword(password, row.password_hash)) return { ok: false, error: "invalid_credentials" };
  return { ok: true, token: `account:${row.username_lower}` };
}

/** One-time import from the old players.json, if the DB is still empty and that file exists. */
function migrateFromJsonIfNeeded() {
  const { c } = db.prepare("SELECT COUNT(*) as c FROM players").get();
  if (c > 0 || !fs.existsSync(OLD_JSON_FILE)) return;
  try {
    const old = JSON.parse(fs.readFileSync(OLD_JSON_FILE, "utf8"));
    const insert = db.prepare(`
      INSERT OR IGNORE INTO players (token, name, tag, color, best_score, games_played, race, stats_json, owned_races_json, purchase_log_json)
      VALUES (@token, @name, @tag, @color, @bestScore, @gamesPlayed, @race, @statsJson, @ownedRacesJson, @purchaseLogJson)
    `);
    const importAll = db.transaction((entries) => {
      for (const [token, rec] of entries) {
        insert.run({
          token, name: rec.name || "Player", tag: rec.tag || null, color: rec.color ?? 0x3a86ff,
          bestScore: rec.bestScore || 0, gamesPlayed: rec.gamesPlayed || 0, race: rec.race || null,
          statsJson: rec.stats ? JSON.stringify(rec.stats) : null,
          ownedRacesJson: JSON.stringify(rec.ownedRaces || []),
          purchaseLogJson: JSON.stringify(rec.purchaseLog || []),
        });
      }
    });
    importAll(Object.entries(old));
    log(`[store:sqlite] migrated ${Object.keys(old).length} player record(s) from players.json`);
  } catch (err) {
    log(`[store:sqlite] migration from players.json failed: ${err.message}`);
  }
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    name: row.name, tag: row.tag, color: row.color,
    bestScore: row.best_score, totalScore: row.total_score, gamesPlayed: row.games_played,
    race: row.race, stats: row.stats_json ? JSON.parse(row.stats_json) : null,
    ownedRaces: JSON.parse(row.owned_races_json),
    achievements: JSON.parse(row.achievements_json || "[]"),
    isAdmin: !!row.is_admin,
  };
}

/** Picks a 4-digit discriminator that doesn't collide with another identity currently using the same name. */
function generateTag(name) {
  const existingTags = new Set(
    db.prepare("SELECT tag FROM players WHERE name = ? COLLATE NOCASE AND tag IS NOT NULL").all(name).map(r => r.tag)
  );
  let tag, attempts = 0;
  do {
    tag = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
  } while (existingTags.has(tag) && attempts < 50);
  return tag;
}

export async function getPlayerRecord(token) {
  return rowToRecord(db.prepare("SELECT * FROM players WHERE token = ?").get(token));
}

export async function upsertIdentity(token, { name, color }) {
  const existing = db.prepare("SELECT name, color, tag FROM players WHERE token = ?").get(token);
  const finalName = name ?? existing?.name ?? "Player";
  const finalColor = color ?? existing?.color ?? 0x3a86ff;
  const tag = existing?.tag || generateTag(finalName);

  db.prepare(`
    INSERT INTO players (token, name, tag, color) VALUES (@token, @name, @tag, @color)
    ON CONFLICT(token) DO UPDATE SET name = @name, tag = @tag, color = @color
  `).run({ token, name: finalName, tag, color: finalColor });

  return getPlayerRecord(token);
}

export async function recordGameEnd(token, finalScore, race, stats, isBot = false) {
  if (isBot) return; // bot games are never persisted — no identity worth tracking across sessions
  const existing = db.prepare("SELECT best_score, total_score, games_played FROM players WHERE token = ?").get(token);
  const gamesPlayed = (existing ? existing.games_played : 0) + 1;
  const shouldUpdateBest = !existing || finalScore >= existing.best_score;
  const newTotalScore = (existing ? existing.total_score : 0) + finalScore;

  db.prepare(`
    INSERT INTO players (token, name, best_score, total_score, games_played, race, stats_json)
    VALUES (@token, 'Player', @score, @newTotalScore, @gamesPlayed, @race, @statsJson)
    ON CONFLICT(token) DO UPDATE SET
      games_played = @gamesPlayed,
      total_score  = @newTotalScore,
      best_score   = CASE WHEN @shouldUpdateBest THEN @score ELSE best_score END,
      race         = CASE WHEN @shouldUpdateBest THEN @race ELSE race END,
      stats_json   = CASE WHEN @shouldUpdateBest THEN @statsJson ELSE stats_json END
  `).run({
    token, score: finalScore, newTotalScore, gamesPlayed, race,
    statsJson: stats ? JSON.stringify(stats) : null,
    shouldUpdateBest: shouldUpdateBest ? 1 : 0,
  });
}

// Every race is free, permanently — the game is funded by donations, not race unlocks. The
// entitlement machinery below (grantRaceEntitlement, /admin/grant-race) is left in place since
// it's harmless and could still be useful for something else later (e.g. a donation-linked
// cosmetic), but nothing currently gates access behind it.
const FREE_RACES = ["Human", "Orc", "Elf", "Dwarf", "Undead", "Hive"];

export async function getOwnedRaces(token) {
  const row = db.prepare("SELECT owned_races_json FROM players WHERE token = ?").get(token);
  const purchased = row ? JSON.parse(row.owned_races_json) : [];
  return [...new Set([...FREE_RACES, ...purchased])];
}

export async function grantRaceEntitlement(token, race, source = "unknown") {
  const existing = db.prepare("SELECT owned_races_json, purchase_log_json FROM players WHERE token = ?").get(token);
  const owned = new Set(existing ? JSON.parse(existing.owned_races_json) : []);
  if (owned.has(race)) return false;
  owned.add(race);
  const purchaseLog = existing ? JSON.parse(existing.purchase_log_json) : [];
  purchaseLog.push({ race, source, at: Date.now() });

  db.prepare(`
    INSERT INTO players (token, name, owned_races_json, purchase_log_json) VALUES (@token, 'Player', @owned, @log)
    ON CONFLICT(token) DO UPDATE SET owned_races_json = @owned, purchase_log_json = @log
  `).run({ token, owned: JSON.stringify([...owned]), log: JSON.stringify(purchaseLog) });

  return true;
}

export async function getPlayerAchievements(token) {
  const row = db.prepare("SELECT achievements_json FROM players WHERE token = ?").get(token);
  return row ? JSON.parse(row.achievements_json || "[]") : [];
}

/** { id, unlockedAt }[] — idempotent: granting an already-held achievement is a safe no-op. */
export async function grantAchievement(token, achievementId) {
  const existing = db.prepare("SELECT achievements_json FROM players WHERE token = ?").get(token);
  const list = existing ? JSON.parse(existing.achievements_json || "[]") : [];
  if (list.some(a => a.id === achievementId)) return false;
  list.push({ id: achievementId, unlockedAt: Date.now() });

  db.prepare(`
    INSERT INTO players (token, name, achievements_json) VALUES (@token, 'Player', @achievements)
    ON CONFLICT(token) DO UPDATE SET achievements_json = @achievements
  `).run({ token, achievements: JSON.stringify(list) });

  return true;
}

export async function getIsAdmin(token) {
  const row = db.prepare("SELECT is_admin FROM players WHERE token = ?").get(token);
  return !!row?.is_admin;
}

/** Grants or revokes admin status for a real identity — the actual (non-dev-override) mechanism. */
export async function setAdmin(token, isAdmin) {
  db.prepare(`
    INSERT INTO players (token, name, is_admin) VALUES (@token, 'Player', @isAdmin)
    ON CONFLICT(token) DO UPDATE SET is_admin = @isAdmin
  `).run({ token, isAdmin: isAdmin ? 1 : 0 });
}

/** Same as setAdmin, but looks the player up by name#tag instead of requiring the raw token —
 *  more convenient for granting admin to a specific known player. Returns false if no player with
 *  that exact name#tag has ever connected (nothing to grant admin to). */
export async function setAdminByNameTag(name, tag, isAdmin) {
  const row = db.prepare("SELECT token FROM players WHERE name = ? AND tag = ?").get(name, tag);
  if (!row) return false;
  db.prepare("UPDATE players SET is_admin = ? WHERE token = ?").run(isAdmin ? 1 : 0, row.token);
  return true;
}

/** Keybindings are keyed by token, same as everything else — this is what makes them naturally
 *  follow an account across devices: logging in adopts the account's stable token (see
 *  /auth/login), so from that point on the same row is read/written regardless of which device
 *  connects. Without an account, the token is just a random per-browser one, so bindings persist
 *  locally but don't follow you anywhere else — "saved as good as they can without an account." */
export async function getKeybindings(token) {
  const row = db.prepare("SELECT keybindings_json FROM players WHERE token = ?").get(token);
  return row?.keybindings_json ? JSON.parse(row.keybindings_json) : null;
}

export async function setKeybindings(token, bindings) {
  db.prepare(`
    INSERT INTO players (token, name, keybindings_json) VALUES (@token, 'Player', @bindings)
    ON CONFLICT(token) DO UPDATE SET keybindings_json = @bindings
  `).run({ token, bindings: JSON.stringify(bindings) });
}

/** sortBy: "best" (highest single-game score, the original leaderboard) or "total" (cumulative score across every game). */
export async function getHighscores(limit = 50, sortBy = "best") {
  const column = sortBy === "total" ? "total_score" : "best_score";
  const rows = db.prepare(`SELECT * FROM players ORDER BY ${column} DESC LIMIT ?`).all(limit);
  return rows.map((row) => ({
    name: row.name, tag: row.tag || null, color: row.color, bestScore: row.best_score, totalScore: row.total_score, gamesPlayed: row.games_played,
    race: row.race || null, stats: row.stats_json ? JSON.parse(row.stats_json) : null,
  }));
}

export async function flush() {} // SQLite commits durably per-statement already — kept for interface parity

process.on("exit", () => db.close());
