import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single-file build so the prototype can be shared as one HTML page.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  test: { globals: true, environment: "node", testTimeout: 30_000, hookTimeout: 30_000 },
});
