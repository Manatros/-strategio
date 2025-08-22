import { uid } from "../utils/uid.js";
import { Room } from "./Room.js";

export class RoomManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.rooms = new Map(); // id -> Room
    this.defaultRoomId = null;
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

  pickRoom() {
    // simple: put everyone into the default room unless full
    const r = this.ensureDefault();
    if (r.clients.size < this.cfg.maxClientsPerRoom) return r;
    // create a new room if full
    const n = new Room(uid(), this.cfg);
    n.attach(1000 / this.cfg.tickRate);
    this.rooms.set(n.id, n);
    return n;
  }

  get(id) { return this.rooms.get(id); }

  allStats() {
    return [...this.rooms.values()].map(r => r.stats);
  }

  reapIdle(now = Date.now()) {
    const idleMs = this.cfg.roomIdleSeconds * 1000;
    for (const [id, r] of this.rooms) {
      if (r.clients.size === 0 && now - r.lastActive > idleMs) {
        r.detach();
        this.rooms.delete(id);
      }
    }
  }
}
