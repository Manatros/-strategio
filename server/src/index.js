import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { cfg } from "./config.js";
import { log } from "./utils/logger.js";
import { send, safeJSON } from "./net/wire.js";
import { RoomManager } from "./rooms/RoomManager.js";

dotenv.config();

const app = express();
app.use(express.json());

// basic health + version
app.get("/health", (_, res) => res.send("ok"));
app.get("/version", (_, res) => res.json({ protocol: cfg.protocol, tickRate: cfg.tickRate }));

// room stats
const rm = new RoomManager(cfg);
app.get("/room-stats", (_, res) => res.json({ rooms: rm.allStats() }));

const server = app.listen(cfg.port, () => {
  log(`HTTP on http://localhost:${cfg.port}`);
});

const wss = new WebSocketServer({ server });

// very light "handshake optional" flow:
// - if client sends {type:"handshake", name?, roomId?}, we use that
// - otherwise we auto-join default room with "Player" name
wss.on("connection", (ws) => {
  let joined = false;
  let room = null;
  let clientId = null;

  // if first message is handshake, use it
  ws.once("message", (raw) => {
    const msg = safeJSON(raw) || {};
    if (msg.type === "handshake") {
      const name = typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : "Player";
      const target = typeof msg.roomId === "string" ? rm.get(msg.roomId) : null;
      room = target || rm.pickRoom();
      clientId = room.join(ws, name);
      joined = true;
      return;
    }
    // no handshake -> auto join default room and forward the first message into room handler
    room = rm.pickRoom();
    clientId = room.join(ws, "Player");
    joined = true;
    room.onMessage(clientId, raw); // process that first message
    // now pipe further messages normally
    ws.on("message", (r) => room.onMessage(clientId, r));
  });

  ws.on("close", () => {
    if (joined && room && clientId) {
      room.leave(clientId, "ws_close");
    }
  });

  // safety: if client never sends anything, auto-join after short delay
  const t = setTimeout(() => {
    if (!joined) {
      room = rm.pickRoom();
      clientId = room.join(ws, "Player");
      joined = true;
      ws.on("message", (r) => room.onMessage(clientId, r));
    }
  }, 500);
  ws.on("message", () => clearTimeout(t));
});

// housekeeping (reap idle rooms)
setInterval(() => rm.reapIdle(Date.now()), 30_000);
