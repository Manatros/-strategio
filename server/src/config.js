export const cfg = {
  port: Number(process.env.PORT || 3000),
  tickRate: Number(process.env.TICK_RATE || 10),
  protocol: String(process.env.PROTOCOL_VERSION || "0.0.1"),
  maxClientsPerRoom: Number(process.env.MAX_CLIENTS_PER_ROOM || 64),
  roomIdleSeconds: Number(process.env.ROOM_IDLE_SECONDS || 600),
};
