import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

// RELAY_BASE_PATH builds the console for serving under a path prefix
// (e.g. "/relay" on jellybot.cloud). Vite rewrites asset URLs to ${base}…
const base = process.env.RELAY_BASE_PATH
  ? `${process.env.RELAY_BASE_PATH.replace(/\/+$/, "")}/`
  : "/";

export default defineConfig({
  base,
  build: {
    outDir: "../public",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    fs: { allow: [path.resolve(webRoot, "../..")] },
    port: 5174,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8788", ws: true },
      "/api": { target: "http://127.0.0.1:8788" },
    },
  },
});
