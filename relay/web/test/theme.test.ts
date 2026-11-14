import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initTheme } from "../src/theme.js";

const store = new Map<string, string>();
const { document } = parseHTML(
  '<!doctype html><html><head><meta name="theme-color" content="#141414"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"></head><body></body></html>',
);
let storageBlocked = false;
Object.assign(globalThis, {
  document,
  localStorage: {
    removeItem: (key: string) => {
      if (storageBlocked) throw new Error("storage unavailable");
      store.delete(key);
    },
  },
});

function assertLight(): void {
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(document.querySelector('meta[name="theme-color"]')!.getAttribute("content"), "#f8fafc");
  assert.equal(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')!.getAttribute("content"), "default");
  const value = (name: string) => document.documentElement.style.getPropertyValue(name);
  assert.equal(value("--button-primary-bg"), "#006bd6");
  assert.equal(value("--button-primary-fg"), "#ffffff");
  assert.equal(value("--button-danger-bg"), "#c93636");
  assert.equal(value("--button-danger-fg"), "#ffffff");
}

test("Relay always initializes Light and removes legacy preferences", () => {
  for (const previous of [undefined, "dark", "light", "auto"]) {
    store.clear();
    store.set("larryRemote.sessionToken", "keep-session");
    if (previous) store.set("larryRemote.theme", previous);
    if (previous) document.documentElement.dataset.theme = previous;
    else delete document.documentElement.dataset.theme;
    initTheme();
    assertLight();
    assert.equal(store.has("larryRemote.theme"), false);
    assert.equal(store.get("larryRemote.sessionToken"), "keep-session");
  }
});

test("blocked storage cannot prevent Light initialization or repeated initialization", () => {
  storageBlocked = true;
  try {
    document.documentElement.dataset.theme = "dark";
    initTheme();
    initTheme();
    assertLight();
  } finally {
    storageBlocked = false;
  }
});

test("first paint and PWA launch use Light without JavaScript or storage", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const launch = parseHTML(html).document;
  assert.equal(launch.documentElement.dataset.theme, "light");
  assert.equal(launch.querySelector('meta[name="theme-color"]')!.getAttribute("content"), "#f8fafc");
  assert.equal(launch.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')!.getAttribute("content"), "default");
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.background_color, "#f8fafc");
  assert.equal(manifest.theme_color, "#f8fafc");
});
