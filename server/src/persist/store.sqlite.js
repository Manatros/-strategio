// SQLite backend for player persistence — used automatically whenever
// DATABASE_URL isn't set, so small/local deployments need zero setup at
// all. Every function is async even though better-sqlite3 itself is
// synchronous under the hood, so callers don't care which backend is
// active (see store.js, the dispatcher) — same interface either way.
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
    games_played INTEGER NOT NULL DEFAULT 0,
    race TEXT,
    stats_json TEXT,
    owned_races_json TEXT NOT NULL DEFAULT '[]',
    purchase_log_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
  CREATE INDEX IF NOT EXISTS idx_players_best_score ON players(best_score DESC);
`);

migrateFromJsonIfNeeded();

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
    bestScore: row.best_score, gamesPlayed: row.games_played,
    race: row.race, stats: row.stats_json ? JSON.parse(row.stats_json) : null,
    ownedRaces: JSON.parse(row.owned_races_json),
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

export async function recordGameEnd(token, finalScore, race, stats) {
  const existing = db.prepare("SELECT best_score, games_played FROM players WHERE token = ?").get(token);
  const gamesPlayed = (existing ? existing.games_played : 0) + 1;
  const shouldUpdateBest = !existing || finalScore >= existing.best_score;

  db.prepare(`
    INSERT INTO players (token, name, best_score, games_played, race, stats_json)
    VALUES (@token, 'Player', @score, @gamesPlayed, @race, @statsJson)
    ON CONFLICT(token) DO UPDATE SET
      games_played = @gamesPlayed,
      best_score = CASE WHEN @shouldUpdateBest THEN @score ELSE best_score END,
      race        = CASE WHEN @shouldUpdateBest THEN @race ELSE race END,
      stats_json  = CASE WHEN @shouldUpdateBest THEN @statsJson ELSE stats_json END
  `).run({
    token, score: finalScore, gamesPlayed, race,
    statsJson: stats ? JSON.stringify(stats) : null,
    shouldUpdateBest: shouldUpdateBest ? 1 : 0,
  });
}

const FREE_RACES = ["Human", "Orc", "Elf", "Dwarf", "Undead"]; // TEMPORARY: everyone can play every race for now.
// To re-enable monetization later, change this back to just ["Human"] — nothing else changes;
// grantRaceEntitlement, /admin/grant-race, and the menu's lock icons all still work unchanged.

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

export async function getHighscores(limit = 50) {
  const rows = db.prepare("SELECT * FROM players ORDER BY best_score DESC LIMIT ?").all(limit);
  return rows.map((row) => ({
    name: row.name, tag: row.tag || null, color: row.color, bestScore: row.best_score, gamesPlayed: row.games_played,
    race: row.race || null, stats: row.stats_json ? JSON.parse(row.stats_json) : null,
  }));
}

export async function flush() {} // SQLite commits durably per-statement already — kept for interface parity

process.on("exit", () => db.close());