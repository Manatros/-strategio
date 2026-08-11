export const cfg = {
  port: Number(process.env.PORT || 3000),
  tickRate: Number(process.env.TICK_RATE || 2),
  protocol: String(process.env.PROTOCOL_VERSION || "0.0.1"),
  maxClientsPerRoom: Number(process.env.MAX_CLIENTS_PER_ROOM || 128),
  roomIdleSeconds: Number(process.env.ROOM_IDLE_SECONDS || 600),
  // How many players (real + bot) a game room aims to have at once — distinct from
  // maxClientsPerRoom, which is a raw connection safety cap, not a gameplay-tuned lobby size.
  targetLobbySize: Number(process.env.TARGET_LOBBY_SIZE || 8),
};
