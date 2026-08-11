export function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify({ type, ...payload })); } catch {}
}
export function safeJSON(raw) {
  try { return JSON.parse(String(raw)); } catch { return null; }
}
