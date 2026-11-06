// Build guard: every bare import must be declared in the owning package.json,
// and every root runtime dependency must actually be installed.
//
// Why: main-process imports are kept external by electron-vite
// (externalizeDepsPlugin), so they are resolved at runtime from the node_modules
// electron-builder copies into the asar. A dependency that is declared but never
// installed produces a build that only fails on launch ("Cannot find module").
//
// Runs from prebuild; pass --verbose to also list declared-but-unused packages.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname);
const verbose = process.argv.includes("--verbose");

const TARGETS = [
  { name: "app", dirs: ["src"], pkg: "package.json" },
  { name: "relay server", dirs: ["relay/src", "relay/test"], pkg: "relay/package.json" },
  { name: "relay web", dirs: ["relay/web/src", "relay/web/test"], pkg: "relay/web/package.json" },
];

// Imported by main/preload yet intentionally devDependencies: electron is
// supplied by the runtime, gpt-tokenizer is bundled (externalize exclude).
const DEV_DEP_ALLOWLIST = new Set(["electron", "gpt-tokenizer"]);

const EXT = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);
const builtins = new Set(builtinModules);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.has(extname(p))) out.push(p);
  }
  return out;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Package names (scope-aware) imported by one file. */
function bareSpecifiers(file) {
  const text = stripComments(readFileSync(file, "utf8"));
  const specs = new Set();
  // `[^;]` keeps the multi-line named-import form from swallowing whole files
  // and matching an unrelated quoted string further down.
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s[^;]*?from\s*["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const s = m[1];
      if (s.startsWith(".") || s.startsWith("/") || s.startsWith("#")) continue;
      if (s.startsWith("node:") || builtins.has(s.split("/")[0])) continue;
      specs.add(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);
    }
  }
  return specs;
}

const failures = [];

for (const target of TARGETS) {
  const pkg = JSON.parse(readFileSync(join(root, target.pkg), "utf8"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const used = new Set();
  for (const dir of target.dirs) {
    for (const file of walk(join(root, dir))) {
      for (const spec of bareSpecifiers(file)) used.add(spec);
    }
  }

  const missing = [...used].filter((s) => !declared.has(s)).sort();
  if (missing.length) {
    failures.push(`${target.pkg}: imported but not declared — ${missing.join(", ")}`);
  }
  if (verbose) {
    const unused = [...declared].filter((s) => !used.has(s) && !s.startsWith("@types/")).sort();
    console.log(`[check-deps] ${target.name}: ${used.size} imported, unused: ${unused.join(", ") || "none"}`);
  }
}

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const prod = Object.keys(rootPkg.dependencies ?? {});
const dev = new Set(Object.keys(rootPkg.devDependencies ?? {}));

const notInstalled = prod.filter((name) => !existsSync(join(root, "node_modules", name))).sort();
if (notInstalled.length) {
  failures.push(
    `node_modules is out of sync with package.json — run npm install (missing: ${notInstalled.join(", ")})`,
  );
}

const rendererDir = join("src", "renderer");
const mainUsed = new Set();
for (const file of walk(join(root, "src"))) {
  if (file.includes(rendererDir)) continue;
  // Tests are scanned above for declared dependencies, but are not shipped
  // in the main/preload bundles and may use development-only test libraries.
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
  for (const spec of bareSpecifiers(file)) mainUsed.add(spec);
}
const devOnly = [...mainUsed]
  .filter((s) => dev.has(s) && !prod.includes(s) && !DEV_DEP_ALLOWLIST.has(s))
  .sort();
if (devOnly.length) {
  failures.push(
    `imported outside the renderer but only in devDependencies (would be absent from the asar) — ${devOnly.join(", ")}`,
  );
}

if (failures.length) {
  console.error("[check-deps] FAILED");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[check-deps] ok");
