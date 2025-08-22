import { uid } from "../utils/uid.js";
import { log } from "../utils/logger.js";
import { send, safeJSON } from "../net/wire.js";

/**
 * A very small room with:
 * - players: {id, name, x, y}
 * - tick loop broadcasting state at cfg.tickRate
 * - basic 'move' messages (dx,dy), clamped
 * - join/leave notifications
 */
export class Room {
  constructor(id, cfg) {
    this.id = id || uid();
    this.cfg = cfg;
    this.clients = new Map();     // id -> { ws, name }
    this.players = new Map();     // id -> { id, name, x, y }
    this.lastActive = Date.now();
    this._interval = null;
  }

  attach(serverTickMs) {
    if (!this._interval) {
      this._interval = setInterval(() => this.tick(), serverTickMs);
    }
  }
  detach() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }

  join(ws, name = "Player") {
    const id = uid();
    this.clients.set(id, { ws, name });
    this.players.set(id, { id, name, x: 0, y: 0 });
    this.lastActive = Date.now();

    // wire events
    ws.on("message", (raw) => this.onMessage(id, raw));
    ws.on("close", () => this.leave(id, "close"));
    ws.on("error", () => this.leave(id, "error"));

    // greet
    send(ws, "welcome", { playerId: id, roomId: this.id });
    this.broadcast("player_join", { id, name });
    log(`[room ${this.id}] join: ${id} (${name})`);
    return id;
  }

  leave(id, reason = "leave") {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    this.players.delete(id);
    this.broadcast("player_leave", { id, reason });
    this.lastActive = Date.now();
    log(`[room ${this.id}] leave: ${id} (${reason})`);
  }

  onMessage(id, raw) {
    const msg = safeJSON(raw);
    if (!msg || typeof msg.type !== "string") return;

    this.lastActive = Date.now();
    switch (msg.type) {
      case "move": {
        const p = this.players.get(id);
        if (!p) return;
        const dx = Number(msg.dx || 0);
        const dy = Number(msg.dy || 0);
        // clamp step size to avoid teleporting
        const maxStep = 1;
        p.x += Math.max(-maxStep, Math.min(maxStep, dx));
        p.y += Math.max(-maxStep, Math.min(maxStep, dy));
        break;
      }
      default:
        // ignore unknowns for now
        break;
    }
  }

  broadcast(type, payload = {}) {
    for (const { ws } of this.clients.values()) {
      send(ws, type, payload);
    }
  }

  get state() {
    return {
      roomId: this.id,
      now: Date.now(),
      players: [...this.players.values()],
    };
  }

  tick() {
    // simple broadcast of current state
    if (this.clients.size === 0) return;
    this.broadcast("state", { state: this.state });
  }

  get stats() {
    return {
      id: this.id,
      clients: this.clients.size,
      players: this.players.size,
      lastActive: this.lastActive,
    };
  }
}
