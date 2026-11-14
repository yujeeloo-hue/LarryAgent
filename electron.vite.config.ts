import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [
      // gpt-tokenizer ships all encoders (~55MB); bundling tree-shakes down to
      // the single o200k_base vocab (~3MB) actually imported by estimateTokens.
      externalizeDepsPlugin({ exclude: ["gpt-tokenizer"] }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve("src/renderer"),
    build: {
      /*
       * No CSS code splitting. With multiple entries (index / changes /
       * reader) sharing stylesheets, Rollup extracts shared CSS into chunks
       * whose load order can flip the cascade: the entry css keeps a partial
       * duplicate (e.g. `.content-card` 3% tint) that then loads AFTER the
       * shared chunk and beats same-specificity rules (e.g. the near-opaque
       * `.content-card-plan` background) — plan cards turned see-through in
       * packaged builds. Inlining one deterministic css per entry avoids the
       * whole class of bugs; the size cost is irrelevant for a desktop app.
       */
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
