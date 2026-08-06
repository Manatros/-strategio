import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Output straight into the server's static folder, so `npm run build`
    // here is all it takes for the Node server to serve the whole game.
    outDir: "../server/public",
    emptyOutDir: true,
  },
});