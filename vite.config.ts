import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// `--mode public` builds the anonymous read-only demo: relative asset paths for
// any static host, and a compile-time flag that drops the owner-only UI.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "public" ? "./" : "/",
  define: { __PUBLIC_DEMO__: JSON.stringify(mode === "public") },
  build: { outDir: mode === "public" ? "dist-public" : "dist" },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
}));
