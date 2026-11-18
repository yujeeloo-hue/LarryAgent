import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { extname, join, resolve } from "node:path";
import { parse } from "@babel/parser";

const root = resolve(import.meta.dirname);
const verbose = process.argv.includes("--verbose");

const TARGETS = [
  { name: "app", dirs: ["src"], pkg: "package.json" },
  { name: "relay server", dirs: ["relay/src", "relay/test"], pkg: "relay/package.json" },
  { name: "relay web", dirs: ["relay/web/src", "relay/web/test"], pkg: "relay/web/package.json" },
];

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

function bareSpecifiers(file) {
  const source = parse(readFileSync(file, "utf8"), {
    sourceFilename: file,
    sourceType: "unambiguous",
    plugins: /\.[cm]?tsx?$/.test(file) ? ["typescript", ...(file.endsWith(".tsx") ? ["jsx"] : [])] : ["jsx"],
    createImportExpressions: true,
  });
  const specs = new Set();

  function add(specifier) {
    const name = specifier?.type === "StringLiteral" ? specifier.value
      : specifier?.type === "TemplateLiteral" && !specifier.expressions.length ? specifier.quasis[0].value.cooked
      : null;
    if (!name || name.startsWith(".") || name.startsWith("/") || name.startsWith("#")) return;
    const parts = name.split("/");
    if (name.startsWith("node:") || builtins.has(parts[0])) return;
    specs.add(name.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  }

  function visit(node) {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
      case "ImportExpression":
        add(node.source);
        break;
      case "CallExpression":
        if (node.callee.type !== "Identifier" || node.callee.name !== "require") break;
        add(node.arguments[0]);
        break;
      case "TSImportType":
        add(node.argument);
        break;
      case "TSExternalModuleReference":
        add(node.expression);
        break;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (typeof child?.type === "string") visit(child);
      } else if (typeof value?.type === "string") {
        visit(value);
      }
    }
  }

  visit(source);
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
