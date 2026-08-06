import { uid } from "../utils/uid.js";
import { Room } from "./Room.js";

export class RoomManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.rooms = new Map();       // id -> Room
    this.defaultRoomId = null;
    this.tokenToRoom = new Map(); // clientToken -> roomId, for reconnect-to-same-game
  }

  ensureDefault() {
    if (this.defaultRoomId && this.rooms.has(this.defaultRoomId)) {
      return this.rooms.get(this.defaultRoomId);
    }
    const id = uid();
    const r = new Room(id, this.cfg);
    r.attach(1000 / this.cfg.tickRate);
    this.rooms.set(id, r);
    this.defaultRoomId = id;
    return r;
  }

  /** Always a fresh room pick — used for "New Game" and for anyone who can't resume. */
  pickRoom() {
    const r = this.ensureDefault();
    if (r.clients.size < this.cfg.maxClientsPerRoom) return r;
    const n = new Room(uid(), this.cfg);
    n.attach(1000 / this.cfg.tickRate);
    this.rooms.set(n.id, n);
    return n;
  }

  get(id) { return this.rooms.get(id); }

  registerResumable(token, roomId) {
    this.tokenToRoom.set(token, roomId);
  }

  /** The room a returning client should try to resume into, if any. */
  findResumableRoom(token) {
    const roomId = this.tokenToRoom.get(token);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) { this.tokenToRoom.delete(token); return null; }
    return room;
  }

  allStats() {
    return [...this.rooms.values()].map(r => r.stats);
  }

  reapIdle(now = Date.now()) {
    const idleMs = this.cfg.roomIdleSeconds * 1000;
    for (const [id, r] of this.rooms) {
      r.reapDisconnected(now);
      if (r.clients.size === 0 && now - r.lastActive > idleMs) {
        r.detach();
        this.rooms.delete(id);
        for (const [token, roomId] of this.tokenToRoom) {
          if (roomId === id) this.tokenToRoom.delete(token);
        }
      }
    }
  }
}