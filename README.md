# Strategio Project Overview

Welcome to **Strategio**!.

---

## 🔹 Project at a Glance
- **Strategio** is a browser-based RTS with infinite matches, inspired by Slither.io and classic RTS games.
- **Tech stack**: TypeScript + Vite + Pixi.js (frontend), Node.js + WebSocket (backend), Redis + Postgres (infra).
- **Goal**: Fun, casual, drop-in/drop-out multiplayer RTS.

---

## 📂 File Structure & Purpose

### 1. Root
- **README.md** – General project info, setup instructions.
- **package.json / package-lock.json** – Dependencies & scripts.
- **infra/** – Docker + Nginx configs for running in dev/production.
- **data/** – Placeholder for persistent data (replays, highscores).

### 2. Frontend (`/frontend`)
The **game client** (browser, TypeScript, Pixi.js).

- **index.html** – Entry HTML.
- **main.ts** – Bootstraps the game (loads map, HUD, scenes).

#### 2.1 Core (`/core`)
- **rng.ts** – Random number generator (seeded).
- **valueNoise.ts** – Terrain noise for maps.

#### 2.2 Hex System (`/hex`)
- **HexMath.ts** – Hex grid math.
- **Input.ts** – Camera & input handling.
- **MapData.ts** – Procedural map generation.
- **MapView.ts** – Renders the map.
- **TileRenderer.ts** – Draws tiles on screen.
- **types.ts** – Shared type definitions.

#### 2.3 Scenes (`/scene`)
- **BaseScene.ts** – Base scene class.
- **MenuScene.ts** – Main menu (Play, Options, Leaderboard).
- **GameScene.ts** – Core gameplay.
- **LeaderboardScene.ts** – Global scores view.
- **OptionsScene.ts** – Settings (volume, player colors).
- **SceneManager.ts** – Switch scenes.

#### 2.4 UI (`/ui`)
- **Button.ts** – Reusable buttons.
- **DebugHUD.ts** – HUD overlay (FPS/resources/debug).
- **fitToScreen.ts** – Utility to adapt UI to screen.

### 3. Backend (`/server`)
The **authoritative game server** (Node.js + WebSockets).

- **src/hex/HexMath.ts** – Shared hex math for consistency.
- **index.js** – WebSocket server, tick loop, player sync.
- **.env.example** – Config (protocol version, tick rate).

### 4. Infrastructure (`/infra`)
- **docker-compose.yml** – Spins up server + Postgres + Redis + Nginx.
- **nginx.conf** – Reverse proxy config.
- **Cloudflare Tunnel** – Optional for remote team testing.

---

## 🔹 How It All Fits Together
- **Frontend**: Renders the map, handles UI, sends actions to server.
- **Backend**: Validates/simulates world state, syncs players.
- **Infra**: Ensures multiplayer works across machines (local + remote).

---

## 🚀 Getting Started (Dev Quickstart)
1. Clone repo: `git clone https://github.com/Manatros/-strategio.git`
2. Install dependencies:  
   ```bash
   cd frontend && npm install
   cd ../server && npm install
   ```
3. Run frontend:  
   ```bash
   cd frontend
   npm run dev
   ```  
   → Opens on [http://localhost:5173](http://localhost:5173)
4. Run backend:  
   ```bash
   cd server
   npm run dev
   ```  
   → Runs on [http://localhost:3000](http://localhost:3000)
5. Start playing!

---

## 📌 Notes for New Devs
- Map generation uses **value noise** for elevation + moisture.
- HUD/UI currently basic → planned layout (resources top-left, minimap bottom-right, etc).
- Infinite game loop → no hard match end, leaderboard-based dominance.
- Code style: **TypeScript + Pixi.js for rendering, Node.js for server logic**.

---
