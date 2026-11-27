import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LUA_SEMANTIC_TOKEN_TYPES } from "../../shared/luaSemanticLegend.js";
import { findLuaServer } from "./locate.js";
import { LuaLanguageService } from "./service.js";
import type { LanguageServerProgressEvent } from "../lsp/progressTypes.js";

const binary = findLuaServer();

const HERO = [
  "---@class BP_Hero_C",
  "",
  "---@type BP_Hero_C|BP_Hero_BP",
  "local BP_Hero_C = UnrealClass(\"BP_Hero_C\")",
  "",
  "function BP_Hero_C:Cache()",
  "end",
  "",
  "function BP_Hero_C:Construct()",
  "    self:Cache()",
  "end",
  "",
  "return BP_Hero_C",
  "",
].join("\n");

async function put(root: string, rel: string, text: string): Promise<string> {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

function withLine(text: string, afterLine: number, line: string): string {
  const lines = text.split("\n");
  lines.splice(afterLine, 0, line);
  return lines.join("\n");
}

test("exported UnLua annotations drive UE and self completion, hover and definition", {
  skip: !binary && "bundled emmylua_ls is not extracted (node prepare-emmylua.mjs)",
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "jb-lua-ls-"));
  const progress: LanguageServerProgressEvent[] = [];
  const service = new LuaLanguageService(undefined, undefined, event => progress.push(event));
  try {
    const scripts = join(root, "Content", "Script");
    await put(scripts, "IntelliSense/UE/UE_1.lua", "UE = {}\n---@type AActor\nUE.AActor = nil\n");
    await put(scripts, "IntelliSense/Engine/Actor.lua", [
      "---@class AActor",
      "---@field public RootComponent USceneComponent",
      "local AActor = {}",
      "function AActor:K2_GetActorLocation() end",
      "",
    ].join("\n"));
    await put(scripts, "IntelliSense/Game/BP_Hero_BP.lua", [
      "---@class BP_Hero_BP : AActor",
      "---@field public BtnHide UButton",
      "local BP_Hero_C = {}",
      "",
    ].join("\n"));
    const hero = await put(scripts, "Hero.lua", HERO);

    await service.docChanged(root, hero, HERO);

    const ueText = withLine(HERO, 10, "    local a = UE.");
    let labels: string[] = [];
    for (let i = 0; i < 60 && !labels.includes("AActor"); i++) {
      const res = await service.completion(root, { path: hero, line: 11, column: 18, text: ueText, triggerCharacter: "." });
      assert.ok(res.ok, res.ok ? "" : res.message);
      labels = res.items.map((item) => item.label);
      if (!labels.includes("AActor")) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(labels.includes("AActor"), `UE. completion: ${labels.slice(0, 20).join(", ")}`);

    const selfText = withLine(HERO, 10, "    self.");
    const self = await service.completion(root, { path: hero, line: 11, column: 10, text: selfText, triggerCharacter: "." });
    assert.ok(self.ok);
    const selfLabels = self.items.map((item) => item.label);
    for (const name of ["BtnHide", "RootComponent"]) {
      assert.ok(selfLabels.includes(name), `self. missing ${name}: ${selfLabels.join(", ")}`);
    }

    const colonText = withLine(HERO, 10, "    self:");
    const colon = await service.completion(root, { path: hero, line: 11, column: 10, text: colonText, triggerCharacter: ":" });
    assert.ok(colon.ok);
    const colonLabels = colon.items.map((item) => item.label);
    assert.ok(colonLabels.includes("K2_GetActorLocation"), `self: missing inherited method: ${colonLabels.join(", ")}`);

    const classOnLocal = HERO.replace(
      "---@class BP_Hero_C\n\n---@type BP_Hero_C|BP_Hero_BP\n",
      "---@class BP_Hero_C : BP_Hero_BP\n",
    );
    const hero2 = await put(scripts, "Hero2.lua", classOnLocal.replace(/BP_Hero_C/g, "BP_Hero2_C"));
    const ownText = withLine(classOnLocal.replace(/BP_Hero_C/g, "BP_Hero2_C"), 8, "    self:");
    let ownLabels: string[] = [];
    for (let i = 0; i < 20 && !ownLabels.includes("Cache"); i++) {
      const own = await service.completion(root, { path: hero2, line: 9, column: 10, text: ownText, triggerCharacter: ":" });
      assert.ok(own.ok);
      ownLabels = own.items.map((item) => item.label);
      if (!ownLabels.includes("Cache")) await new Promise((r) => setTimeout(r, 500));
    }
    for (const name of ["Cache", "K2_GetActorLocation"]) {
      assert.ok(ownLabels.includes(name), `class-on-local self: missing ${name}: ${ownLabels.join(", ")}`);
    }

    const def = await service.definition(root, { path: hero, line: 6, column: 10, text: HERO });
    assert.ok(def.ok);
    assert.equal(def.definitions[0]?.line, 4);

    const hero2Text = classOnLocal.replace(/BP_Hero_C/g, "BP_Hero2_C");
    const ownDef = await service.definition(root, { path: hero2, line: 8, column: 11, text: hero2Text });
    assert.ok(ownDef.ok);
    assert.deepEqual(
      ownDef.definitions.map((d) => [d.path.toLowerCase(), d.line]),
      [[hero2.toLowerCase(), 4]],
    );

    const hover = await service.hover(root, { path: hero2, line: 8, column: 11, text: hero2Text });
    assert.ok(hover.ok);
    assert.ok(hover.markdown?.includes("Cache"), String(hover.markdown));

    const semantic = await service.semanticTokens(root, { path: hero2, text: hero2Text });
    assert.ok(semantic.ok);
    const lines = hero2Text.split("\n");
    const tokens: Array<[string, string]> = [];
    let line = 0;
    let start = 0;
    for (let i = 0; i < semantic.data.length; i += 5) {
      const [dl, ds, len, type] = semantic.data.slice(i, i + 4) as [number, number, number, number];
      line += dl;
      start = dl === 0 ? start + ds : ds;
      tokens.push([lines[line]!.slice(start, start + len), LUA_SEMANTIC_TOKEN_TYPES[type]!]);
    }
    assert.ok(tokens.some(([text, type]) => text === "Cache" && (type === "method" || type === "function")), JSON.stringify(tokens));
    assert.ok(tokens.some(([text, type]) => text === "BP_Hero_BP" && (type === "class" || type === "type")), JSON.stringify(tokens));
    assert.ok(tokens.every(([, type]) => type !== undefined));

    service.docClosed(root, hero);
    service.docClosed(root, hero2);

    const phases = progress.map(event => event.phase);
    assert.equal(phases[0], "starting");
    assert.ok(phases.includes("loading"), phases.join(", "));
    assert.ok(progress.every(event => event.server === "lua" && event.rootPath === root));
    service.stop();
    assert.equal(progress.at(-1)?.phase, "idle");
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("a missing server is reported as not_found", async () => {
  const service = new LuaLanguageService(() => null);
  const res = await service.completion("/ws", { path: "/ws/a.lua", line: 1, column: 1, text: "" });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.reason, "not_found");
});
