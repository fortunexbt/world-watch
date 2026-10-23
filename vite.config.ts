import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { DEFAULT_FEED, feedPath } from "./src/shared/feeds";
// `--mode public` builds the anonymous read-only demo: relative asset paths for
// any static host, and a compile-time flag that drops the owner-only UI. Only the
// owner app gets the Web Push service worker; the demo announces its default feed.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    {
      name: "public-feed-discovery",
      apply: () => mode === "public",
      transformIndexHtml: () => [
        {
          tag: "link",
          attrs: {
            rel: "alternate",
            type: "application/atom+xml",
            title: "World Watch: world, significant impact or higher",
            href: "data/" + feedPath(DEFAULT_FEED, "atom"),
          },
          injectTo: "head",
        },
      ],
    },
  ],
  base: mode === "public" ? "./" : "/",
  define: { __PUBLIC_DEMO__: JSON.stringify(mode === "public") },
  build: {
    outDir: mode === "public" ? "dist-public" : "dist",
    ...(mode === "public"
      ? {}
      : {
          rolldownOptions: {
            input: { main: "index.html", sw: "src/client/sw.ts" },
            output: {
              entryFileNames: (chunk: { name: string }) =>
                chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
            },
          },
        }),
  },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
}));
