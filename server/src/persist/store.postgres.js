// PostgreSQL backend for player persistence — used automatically whenever
// DATABASE_URL is set. This is the path to real horizontal scale: unlike
// the SQLite backend, any number of game-server processes can point at the
// same Postgres instance and share one consistent view of every player's
// identity, entitlements, and leaderboard standing. Point it at a managed
// Postgres (RDS, Supabase, Neon, Render, etc.) and it scales with however
// much you provision there — this code doesn't need to change either way.
//
// Security notes:
//  - Every query is parameterized ($1, $2, ...) — no string-built SQL
//    anywhere, so there's no SQL-injection surface from player-controlled
//    input (names, tokens, etc).
//  - DATABASE_URL (which can contain a password) is read only from the
//    environment and is NEVER logged, anywhere, including on connection
//    errors — only the fact that a connection failed is logged, not the
//    connection string itself.
//  - This game has no username/password login at all (identity is an
//    opaque token or a Steam-verified id) — there is no password to store
//    or leak in the first place. The only personal-ish data kept is a
//    display name the player chose themselves.
import pg from "pg";
import crypto from "crypto";
const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  max: Number(process.env.DATABASE_POOL_MAX) || 20, // cap concurrent connections so a traffic spike can't exhaust the DB
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Managed Postgres providers typically require SSL but use certs that
  // don't chain to a standard root store; this is the common pragmatic
  // setting for that. Self-hosted Postgres without SSL configured is
  // unaffected (ssl stays undefined) unless PGSSL=require is set.
  ssl: /sslmode=require/.test(connectionString || "") || process.env.PGSSL === "require"
    ? { rejectUnauthorized: false }
    : undefined,
});

pool.on("error", (err) => {
  // A background/idle client error — never log `err` wholesale if it might echo the connection string back.
  console.error("[store:postgres] unexpected pool error:", err.message);
});

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        token TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Player',
        tag TEXT,
        color BIGINT NOT NULL DEFAULT 3830271,
        best_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        games_played INTEGER NOT NULL DEFAULT 0,
        race TEXT,
        stats_json JSONB,
        owned_races_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        purchase_log_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        achievements_json JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
      CREATE INDEX IF NOT EXISTS idx_players_best_score ON players(best_score DESC);
      ALTER TABLE players ADD COLUMN IF NOT EXISTS achievements_json JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS total_score DOUBLE PRECISION NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_players_total_score ON players(total_score DESC);
      ALTER TABLE players ADD COLUMN IF NOT EXISTS keybindings_json JSONB;
      UPDATE players SET total_score = best_score WHERE total_score = 0 AND best_score > 0;

      CREATE TABLE IF NOT EXISTS accounts (
        username_lower TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
    `);
  }
  return schemaReady;
}

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
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

export async function registerAccount(username, password) {
  await ensureSchema();
  if (typeof username !== "string" || !USERNAME_RE.test(username)) return { ok: false, error: "invalid_username" };
  if (typeof password !== "string" || password.length < 8) return { ok: false, error: "password_too_short" };

  const usernameLower = username.toLowerCase();
  const { rows } = await pool.query("SELECT username_lower FROM accounts WHERE username_lower = $1", [usernameLower]);
  if (rows.length) return { ok: false, error: "username_taken" };

  const passwordHash = hashPassword(password);
  await pool.query(
    "INSERT INTO accounts (username_lower, username, password_hash, created_at) VALUES ($1, $2, $3, $4)",
    [usernameLower, username, passwordHash, Date.now()]
  );
  return { ok: true, token: `account:${usernameLower}` };
}

export async function verifyAccountLogin(username, password) {
  await ensureSchema();
  if (typeof username !== "string" || typeof password !== "string") return { ok: false, error: "invalid_credentials" };
  const { rows } = await pool.query("SELECT username_lower, password_hash FROM accounts WHERE username_lower = $1", [username.toLowerCase()]);
  if (!rows.length || !verifyPassword(password, rows[0].password_hash)) return { ok: false, error: "invalid_credentials" };
  return { ok: true, token: `account:${rows[0].username_lower}` };
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    name: row.name, tag: row.tag, color: Number(row.color),
    bestScore: row.best_score, totalScore: row.total_score, gamesPlayed: row.games_played,
    race: row.race, stats: row.stats_json ?? null,
    ownedRaces: row.owned_races_json ?? [],
    achievements: row.achievements_json ?? [],
    isAdmin: !!row.is_admin,
  };
}

/** Picks a 4-digit discriminator that doesn't collide with another identity currently using the same name. */
async function generateTag(name) {
  const { rows } = await pool.query(
    "SELECT tag FROM players WHERE lower(name) = lower($1) AND tag IS NOT NULL",
    [name]
  );
  const existingTags = new Set(rows.map(r => r.tag));
  let tag, attempts = 0;
  do {
    tag = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
  } while (existingTags.has(tag) && attempts < 50);
  return tag;
}

export async function getPlayerRecord(token) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT * FROM players WHERE token = $1", [token]);
  return rowToRecord(rows[0]);
}

export async function upsertIdentity(token, { name, color }) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT name, color, tag FROM players WHERE token = $1", [token]);
  const existing = rows[0];
  const finalName = name ?? existing?.name ?? "Player";
  const finalColor = color ?? (existing ? Number(existing.color) : 0x3a86ff);
  const tag = existing?.tag || await generateTag(finalName);

  await pool.query(
    `INSERT INTO players (token, name, tag, color) VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET name = $2, tag = $3, color = $4`,
    [token, finalName, tag, finalColor]
  );
  return getPlayerRecord(token);
}

export async function recordGameEnd(token, finalScore, race, stats, isBot = false) {
  if (isBot) return; // bot games are never persisted — no identity worth tracking across sessions
  await ensureSchema();
  const { rows } = await pool.query("SELECT best_score, total_score, games_played FROM players WHERE token = $1", [token]);
  const existing = rows[0];
  const gamesPlayed = (existing ? existing.games_played : 0) + 1;
  const shouldUpdateBest = !existing || finalScore >= existing.best_score;
  const newTotalScore = (existing ? Number(existing.total_score) : 0) + finalScore;

  await pool.query(
    `INSERT INTO players (token, name, best_score, total_score, games_played, race, stats_json)
     VALUES ($1, 'Player', $2, $7, $3, $4, $5)
     ON CONFLICT (token) DO UPDATE SET
       games_played = $3,
       total_score = $7,
       best_score  = CASE WHEN $6 THEN $2 ELSE players.best_score END,
       race        = CASE WHEN $6 THEN $4 ELSE players.race END,
       stats_json  = CASE WHEN $6 THEN $5::jsonb ELSE players.stats_json END`,
    [token, finalScore, gamesPlayed, race, stats ? JSON.stringify(stats) : null, shouldUpdateBest, newTotalScore]
  );
}

// Every race is free, permanently — the game is funded by donations, not race unlocks. The
// entitlement machinery below (grantRaceEntitlement, /admin/grant-race) is left in place since
// it's harmless and could still be useful for something else later (e.g. a donation-linked
// cosmetic), but nothing currently gates access behind it.
const FREE_RACES = ["Human", "Orc", "Elf", "Dwarf", "Undead", "Hive"];

export async function getOwnedRaces(token) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT owned_races_json FROM players WHERE token = $1", [token]);
  const purchased = rows[0]?.owned_races_json ?? [];
  return [...new Set([...FREE_RACES, ...purchased])];
}

export async function grantRaceEntitlement(token, race, source = "unknown") {
  await ensureSchema();
  const { rows } = await pool.query("SELECT owned_races_json, purchase_log_json FROM players WHERE token = $1", [token]);
  const existing = rows[0];
  const owned = new Set(existing?.owned_races_json ?? []);
  if (owned.has(race)) return false;
  owned.add(race);
  const purchaseLog = existing?.purchase_log_json ?? [];
  purchaseLog.push({ race, source, at: Date.now() });

  await pool.query(
    `INSERT INTO players (token, name, owned_races_json, purchase_log_json) VALUES ($1, 'Player', $2::jsonb, $3::jsonb)
     ON CONFLICT (token) DO UPDATE SET owned_races_json = $2::jsonb, purchase_log_json = $3::jsonb`,
    [token, JSON.stringify([...owned]), JSON.stringify(purchaseLog)]
  );
  return true;
}

export async function getPlayerAchievements(token) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT achievements_json FROM players WHERE token = $1", [token]);
  return rows[0]?.achievements_json ?? [];
}

/** { id, unlockedAt }[] — idempotent: granting an already-held achievement is a safe no-op. */
export async function grantAchievement(token, achievementId) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT achievements_json FROM players WHERE token = $1", [token]);
  const list = rows[0]?.achievements_json ?? [];
  if (list.some(a => a.id === achievementId)) return false;
  list.push({ id: achievementId, unlockedAt: Date.now() });

  await pool.query(
    `INSERT INTO players (token, name, achievements_json) VALUES ($1, 'Player', $2::jsonb)
     ON CONFLICT (token) DO UPDATE SET achievements_json = $2::jsonb`,
    [token, JSON.stringify(list)]
  );
  return true;
}

export async function getIsAdmin(token) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT is_admin FROM players WHERE token = $1", [token]);
  return !!rows[0]?.is_admin;
}

/** Grants or revokes admin status for a real identity — the actual (non-dev-override) mechanism. */
export async function setAdmin(token, isAdmin) {
  await ensureSchema();
  await pool.query(
    `INSERT INTO players (token, name, is_admin) VALUES ($1, 'Player', $2)
     ON CONFLICT (token) DO UPDATE SET is_admin = $2`,
    [token, !!isAdmin]
  );
}

export async function setAdminByNameTag(name, tag, isAdmin) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT token FROM players WHERE name = $1 AND tag = $2", [name, tag]);
  if (!rows[0]) return false;
  await pool.query("UPDATE players SET is_admin = $1 WHERE token = $2", [!!isAdmin, rows[0].token]);
  return true;
}

export async function getKeybindings(token) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT keybindings_json FROM players WHERE token = $1", [token]);
  return rows[0]?.keybindings_json ?? null;
}

export async function setKeybindings(token, bindings) {
  await ensureSchema();
  await pool.query(
    `INSERT INTO players (token, name, keybindings_json) VALUES ($1, 'Player', $2::jsonb)
     ON CONFLICT (token) DO UPDATE SET keybindings_json = $2::jsonb`,
    [token, JSON.stringify(bindings)]
  );
}

/** sortBy: "best" (highest single-game score, the original leaderboard) or "total" (cumulative score across every game). */
export async function getHighscores(limit = 50, sortBy = "best") {
  await ensureSchema();
  const column = sortBy === "total" ? "total_score" : "best_score";
  const { rows } = await pool.query(`SELECT * FROM players ORDER BY ${column} DESC LIMIT $1`, [limit]);
  return rows.map((row) => ({
    name: row.name, tag: row.tag || null, color: Number(row.color), bestScore: row.best_score, totalScore: row.total_score, gamesPlayed: row.games_played,
    race: row.race || null, stats: row.stats_json ?? null,
  }));
}

export async function flush() {} // Postgres commits durably per-statement already — kept for interface parity

process.on("exit", () => { pool.end().catch(() => {}); });
