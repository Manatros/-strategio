# Strategio — Developer Guide

## 1. Stack

| Layer | Technology |
|---|---|
| Frontend | TypeScript, Vite, Pixi.js (WebGL rendering) |
| Backend | Node.js, `ws` (WebSocket), Express (HTTP) |
| Persistence | SQLite (`better-sqlite3`) by default, PostgreSQL (`pg`) when `DATABASE_URL` is set — same interface either way |
| Auth | Username/password (Node's built-in `scrypt`), Steam OpenID, or anonymous localStorage token |

---

## 2. Repo Structure

```
server/
  src/
    index.js            — HTTP + WebSocket entry point, handshake, all HTTP routes
    config.js            — env-driven server config (port, tick rate, room limits)
    config/
      balance.js          — every gameplay-tunable number lives here
      achievements.js      — achievement registry (data-driven)
    world/
      hex.js, rng.js, noise.js   — coordinate math, seeded RNG, procedural terrain
      races.js              — per-race data (names, terrain, mechanics, unit overrides)
      buildings.js           — building placement rules + resource gathering logic
      economy.js              — bank helpers (afford/spend/add)
      tileStore.js             — lazy, cached, authoritative world tile generator
    rooms/
      Room.js               — the authoritative per-game-room state + tick loop
      RoomManager.js          — creates/reuses rooms, handles idle reaping
      combat.js                — attack resolution, tower defense, guard mode
      diplomacy.js               — relations, trade/demand/open-borders proposals
      units.js                    — training, movement, merging
      research.js                  — research queue + unlock effects
      raceEffects.js                — per-tick race-specific effects (Dwarf mines, scorched earth, Elf healing)
      achievements.js                — achievement checking/granting
      winConditions.js                — pluggable win-condition system (Domination Victory)
    persist/
      store.js               — dispatcher: picks SQLite or Postgres based on DATABASE_URL
      store.sqlite.js          — SQLite backend
      store.postgres.js         — Postgres backend
    auth/
      steam.js                — Steam OpenID login flow
    net/wire.js              — WebSocket send/parse helpers
    utils/                   — uid generator, timestamped logger

frontend/
  src/
    main.ts                 — entry point
    net.ts                    — WebSocket client, message types, HTTP helpers
    scene/                     — MenuScene, GameScene, GameOverScene, OptionsScene, LeaderboardScene
    hex/                        — coordinate math, pathfinding, tile rendering
    entities/Player.ts             — the visual/movement representation of a character or unit
    buildings/                      — building rendering + client-side placement rules
    ui/                               — every HUD panel (build menu, units, diplomacy, debug/admin, toasts, minimap)
    core/                             — client-side mirrors of race/balance data (for instant UI feedback only — server is authoritative)
    fow/Fog.ts                        — fog-of-war state tracking
  vite.config.ts             — build config + dev-server API proxy
```

---

## 3. Setup

### Prerequisites
Node.js 18+ (native `crypto.scrypt`, ES modules throughout — no transpilation step on the server).

### Install
```bash
cd server && npm install
cd ../frontend && npm install
```

### Running in development
Two options:

**A. Separate dev servers (hot-reload frontend)**
```bash
# Terminal 1 — backend
cd server && npm run dev        # node --watch src/index.js, port 3000

# Terminal 2 — frontend
cd frontend && npm run dev      # vite, port 5173
```
Open `http://localhost:5173`. The Vite dev server proxies all API calls (`/auth`, `/races`, `/admin`, `/highscores`, `/room-stats`, `/health`, `/version`) to `localhost:3000` automatically — see `vite.config.ts`. The WebSocket connection also auto-detects dev mode and targets the backend on port 3000, using whatever hostname the page was actually loaded from (so this also works correctly when testing from another device on your LAN via your machine's IP address, not just `localhost`).

**B. Production-style single origin**
```bash
cd frontend && npm run build    # outputs straight into ../server/public
cd ../server && node src/index.js
```
Open `http://localhost:3000` — everything (game + API) is served from one origin, no proxy needed. This is what a real deployment looks like.

---

## 4. Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP/WS listen port | `3000` |
| `TICK_RATE` | Server ticks per second | `2` |
| `MAX_CLIENTS_PER_ROOM` | Room capacity before a new room is created | `128` |
| `ROOM_IDLE_SECONDS` | How long an empty room lingers before cleanup | `600` |
| `DATABASE_URL` | Postgres connection string. Absent → SQLite | — |
| `DATABASE_POOL_MAX` | Postgres connection pool size | `20` |
| `PGSSL` | Set to `require` to force SSL for Postgres | — |
| `ADMIN_SECRET` | Required for every `/admin/*` endpoint | — |
| `DEV_ALL_ADMIN` | Set to `1` to make every connecting player an admin | — |
| `DEV_UNLOCK_ALL_RACES` | Set to `1` to bypass race entitlement checks | — |
| `STEAM_WEB_API_KEY` | Enables fetching the player's Steam persona name on login | — |

---

## 5. Persistence

Two interchangeable backends behind one dispatcher (`persist/store.js`). Nothing else in the codebase needs to know which is active.

- **SQLite** (no `DATABASE_URL`): single file at `server/data/players.db`, WAL mode. Auto-migrates schema for columns added after a database was first created (checked via `PRAGMA table_info` at boot). Good for local dev and small self-hosted deployments.
- **Postgres** (`DATABASE_URL` set): any number of server processes can share one database — this is the actual path to horizontal scale for *identity and progress* (see the Architecture doc for the important caveat about live game state).

What's stored: player identity (name, tag, color), best score + games played, lifetime stats, owned race entitlements, unlocked achievements, admin flag, and (for account-based logins) username + password hash in a separate `accounts` table.

---

## 6. Balance & Config

Every gameplay-tunable number lives in `server/src/config/balance.js` — building costs, gather rates, unit stats, research options, combat numbers, storage caps, etc. The client never hardcodes these for anything that matters: on connect, the server sends a `config` message with the real costs, and the client's own copies (`frontend/src/buildings/costs.ts`, `frontend/src/core/balance.ts`) are only ever used as a *pre-connection fallback* for instant UI feedback. Change a number in `balance.js` and every client picks it up on their next connection — no client code changes needed.

### Re-enabling the race paywall
Currently every race is free (`FREE_RACES` in both `store.sqlite.js` and `store.postgres.js` includes all five races). To restore the entitlement gate, change that array back to `["Human"]` in both files — the rest of the monetization plumbing (`/admin/grant-race`, the menu's lock icons, `DEV_UNLOCK_ALL_RACES`) already works and doesn't need touching.

---

## 7. Extending the Game

Two systems were built explicitly to make future additions cheap:

### Adding an achievement
Add one entry to `server/src/config/achievements.js`. Stat-based achievements (most of them) need zero new code — just an `id`, `statKey`, and `threshold`; the generic checker in `rooms/achievements.js` picks it up automatically. Event-driven ones (like race trophies) call `achievements.grant(room, player, id)` from wherever that event is handled.

### Adding a win condition
Write one function `(room) => { winnerId, reason } | null` in `server/src/rooms/winConditions.js` and add it to the `WIN_CONDITIONS` array. `checkWinConditions()` and everything that calls it doesn't need to change.

---

## 8. Testing

**There is currently no automated test suite.** Every verification in this codebase's history has been ad-hoc: writing a one-off script that exercises real server code (via `import { Room } from "./src/rooms/Room.js"` and calling `room.tick()` directly, or spinning up a real server process and connecting a real WebSocket client to it), checking the output, then deleting the script. This has been effective at catching real bugs, but it's not repeatable — nothing prevents a regression from slipping back in.

**Recommendation**: the highest-value next step for reliability is standing up a real test suite (Vitest or Node's built-in test runner would both work well given the existing ES module structure) covering at minimum: gathering/storage-cap clamping, construction timing, win-condition triggering, and achievement granting — these are exactly the areas where subtle bugs have been found and fixed by hand this project's history.

---

## 9. Deployment Notes

- `frontend/npm run build` outputs directly into `server/public` — a single `node src/index.js` then serves everything.
- No containerization/CI is currently set up.
- **Restarting the server destroys every in-progress game.** Room/game state (buildings, units, territory, tick loop) is entirely in-memory with no persistence — only identity/progress survives a restart (since that's in the database). This is the single biggest architectural gap standing between this codebase and something you'd trust to deploy without disrupting active players. See the Architecture doc for more on this.
