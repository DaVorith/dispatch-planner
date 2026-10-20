import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single-file build so the prototype can be shared as one HTML page.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  // `npm run dev` talks to the API server from `npm run dev:server`.
  server: { proxy: { "/api": "http://localhost:8080" } },
  test: { globals: true, environment: "node", testTimeout: 30_000, hookTimeout: 30_000 },
});
