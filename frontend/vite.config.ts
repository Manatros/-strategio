import { defineConfig } from "vite";

const BACKEND = "http://localhost:3000";

export default defineConfig({
  server: {
    // Listen on all network interfaces (0.0.0.0), not just localhost — lets other devices on your
    // LAN reach the dev server at http://<your-ip>:5173 without needing to pass --host manually
    // every time. The backend (server/src/index.js) already listens on all interfaces by default
    // (Node's http.Server.listen(port) with no host argument does this automatically).
    host: true,
    // Without this, every plain fetch() (account register/login, race lookup, highscores) hits
    // Vite's own dev server instead of the real backend — it has no matching routes, so it falls
    // back to serving index.html, and parsing that as JSON throws. WebSocket connections already
    // had their own special-case redirect for dev mode (see net.ts's resolveServerUrl) — this is
    // the same fix, just for the plain HTTP calls. Not needed in production: there, everything is
    // served from the same origin (the Node server itself), so this gap doesn't exist at all.
    proxy: {
      "/auth": BACKEND,
      "/races": BACKEND,
      "/admin": BACKEND,
      "/highscores": BACKEND,
      "/room-stats": BACKEND,
      "/health": BACKEND,
      "/version": BACKEND,
    },
  },
  build: {
    // Output straight into the server's static folder, so `npm run build`
    // here is all it takes for the Node server to serve the whole game.
    outDir: "../server/public",
    emptyOutDir: true,
  },
});