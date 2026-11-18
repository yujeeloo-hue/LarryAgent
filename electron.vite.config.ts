import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ["gpt-tokenizer"] }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve("src/renderer"),
    build: {
      cssCodeSplit: false,
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          changes: resolve("src/renderer/changes.html"),
          reader: resolve("src/renderer/reader.html"),
          subagents: resolve("src/renderer/subagents.html"),
          notifyPopup: resolve("src/renderer/notify-popup.html"),
          usagePopup: resolve("src/renderer/usage-popup.html"),
        },
      },
    },
  },
});
