export type ServerMsg =
  | { type: "welcome"; playerId: string; roomId: string }
  | { type: "player_join"; id: string; name: string }
  | { type: "player_leave"; id: string; reason: string }
  | { type: "state"; state: { roomId: string; now: number; players: {id:string;name:string;x:number;y:number}[] } };

export function connectWS(url = "ws://localhost:3000") {
  const ws = new WebSocket(url);
  const listeners = new Set<(msg: ServerMsg) => void>();

  ws.addEventListener("open", () => {
    const name = localStorage.getItem("playerName") || "Player";
    ws.send(JSON.stringify({ type: "handshake", name }));
  });

  ws.addEventListener("message", (ev) => {
    try { const msg = JSON.parse(String(ev.data)); listeners.forEach(fn=>fn(msg)); } catch {}
  });

  return {
    onMessage(fn: (msg: ServerMsg)=>void){ listeners.add(fn); return ()=>listeners.delete(fn); },
    move(dx:number,dy:number){ ws.readyState===WebSocket.OPEN && ws.send(JSON.stringify({type:"move",dx,dy})); },
    socket: ws
  };
}
