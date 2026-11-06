import assert from "node:assert/strict";
import { test } from "node:test";

import { ClangdIndexCompletion, type IndexSymbol } from "./indexCompletion.js";

const FILES: Record<string, string[]> = {
  "NFCharacter.h": [
    "UCLASS()",
    "class NFGAME_API ANFCharacter : public ACharacter, public IAbilityHost",
    "{",
    "    UPROPERTY(EditAnywhere) TObjectPtr<UWeaponComponent> Weapon;",
    "    UAudioConfig* AudioTriggerCfg;",
  ],
  "Audio.h": ["class UAudioConfig", "{", "    void Play();"],
  "DataTable.h": ["class UDataTable", "{", "    void GetAllRows();"],
  "NFCharacter.gen.cpp": [
    'const FObjectPropertyParams NewProp_AudioTriggerCfg = { "AudioTriggerCfg" };',
  ],
  "Character.h": ["class ENGINE_API ACharacter : public APawn", "{"],
  "Pawn.h": ["class ENGINE_API APawn : public AActor", "{"],
  "Actor.h": ["class ENGINE_API AActor : public UObject", "{"],
  "Weapon.h": ["class UWeaponComponent : public UActorComponent", "{"],
};

/** Minimal clangd `workspace/symbol` emulation over a fixed symbol table. */
function fakeIndex(symbols: IndexSymbol[]) {
  const queries: string[] = [];
  return {
    queries,
    query: async (q: string) => {
      queries.push(q);
      const parts = q.replace(/^::/, "").split("::");
      const name = parts.pop() ?? "";
      const scope = parts.join("::");
      return symbols.filter(
        (s) =>
          (s.containerName ?? "") === scope &&
          s.name.toLowerCase().startsWith(name.toLowerCase()),
      );
    },
    readLines: async (path: string) => FILES[path] ?? null,
  };
}

const SYMBOLS: IndexSymbol[] = [
  { name: "ANFCharacter", kind: 5, path: "NFCharacter.h", line: 2 },
  { name: "ACharacter", kind: 5, path: "Character.h", line: 1 },
  { name: "APawn", kind: 5, path: "Pawn.h", line: 1 },
  { name: "AActor", kind: 5, path: "Actor.h", line: 1 },
  { name: "UWeaponComponent", kind: 5, path: "Weapon.h", line: 1 },
  { name: "ANFCharacter", kind: 9, containerName: "ANFCharacter", path: "NFCharacter.h", line: 5 },
  { name: "Attack", kind: 6, containerName: "ANFCharacter", path: "NFCharacter.h", line: 6 },
  { name: "Weapon", kind: 8, containerName: "ANFCharacter", path: "NFCharacter.h", line: 4 },
  { name: "Jump", kind: 6, containerName: "ACharacter", path: "Character.h", line: 9 },
  { name: "Attack", kind: 6, containerName: "ACharacter", path: "Character.h", line: 10 },
  { name: "GetController", kind: 6, containerName: "APawn", path: "Pawn.h", line: 9 },
  { name: "GetActorLocation", kind: 6, containerName: "AActor", path: "Actor.h", line: 9 },
  { name: "GetWorldOrigin", kind: 6, containerName: "ANFCharacter", path: "NFCharacter.h", line: 11 },
  { name: "Fire", kind: 6, containerName: "UWeaponComponent", path: "Weapon.h", line: 9 },
  { name: "UAudioConfig", kind: 5, path: "Audio.h", line: 1 },
  { name: "AudioTriggerCfg", kind: 8, containerName: "ANFCharacter", path: "NFCharacter.h", line: 5 },
  { name: "Play", kind: 6, containerName: "UAudioConfig", path: "Audio.h", line: 3 },
  { name: "UDataTable", kind: 5, path: "DataTable.h", line: 1 },
  { name: "GetAllRows", kind: 6, containerName: "UDataTable", path: "DataTable.h", line: 3 },
  // Listed first: a `.gen.cpp` property record must not hide the header declaration.
  { name: "AudioTriggerCfg", kind: 8, containerName: "ANFCharacter", path: "NFCharacter.gen.cpp", line: 1 },
];

test("class chain walks engine bases through index-located class heads", async () => {
  const index = new ClangdIndexCompletion(fakeIndex(SYMBOLS));
  const chain = await index.classChain("ANFCharacter");
  assert.deepEqual(
    chain.map((c) => `${c.name}@${c.depth}`),
    ["ANFCharacter@0", "ACharacter@1", "IAbilityHost@1", "APawn@2", "AActor@3", "UObject@4"],
  );
});

test("this-> members: own first, overrides win, inherited engine members follow", async () => {
  const index = new ClangdIndexCompletion(fakeIndex(SYMBOLS));
  const hits = await index.complete({ prefix: "", memberOf: "ANFCharacter" });
  const names = hits.map((h) => `${h.name}@${h.depth}`);
  assert.deepEqual(names.slice(0, 2).sort(), ["Attack@0", "Weapon@0"]);
  assert.ok(names.includes("Jump@1") && names.includes("GetController@2") && names.includes("GetActorLocation@3"));
  assert.equal(hits.filter((h) => h.name === "Attack").length, 1, "override collapses to the derived one");
  assert.equal(hits.some((h) => h.name === "ANFCharacter"), false, "constructors are skipped");
});

test("member chain walks each field type (Target->Audio->)", async () => {
  const index = new ClangdIndexCompletion(fakeIndex(SYMBOLS));
  const hits = await index.complete({
    prefix: "",
    container: "ANFCharacter",
    memberOf: "ANFCharacter",
    chain: ["AudioTriggerCfg"],
  });
  assert.deepEqual(hits.map((h) => h.name), ["Play"]);
  assert.deepEqual(
    await index.complete({ prefix: "P", container: "ANFCharacter", chain: ["Missing"] }),
    [],
  );
});

test("header declaration wins over a .gen.cpp property record", async () => {
  const files: Record<string, string[]> = {
    ...FILES,
    "NFCharacter.h": [
      "UCLASS()",
      "class NFGAME_API ANFCharacter : public ACharacter",
      "{",
      "    UPROPERTY(EditAnywhere)",
      "    UDataTable* AudioTriggerCfg;",
    ],
  };
  const index = new ClangdIndexCompletion({
    ...fakeIndex(SYMBOLS),
    readLines: async (path: string) => files[path] ?? null,
  });
  const hits = await index.complete({
    prefix: "Get",
    container: "UNFGameEventTriggerBase",
    memberOf: "ANFCharacter",
    chain: ["AudioTriggerCfg"],
  });
  assert.deepEqual(hits.map((h) => h.name), ["GetAllRows"]);
});

test("receiver type comes from the field declaration line (TObjectPtr unwrapped)", async () => {
  const index = new ClangdIndexCompletion(fakeIndex(SYMBOLS));
  const hits = await index.complete({ prefix: "", container: "ANFCharacter", receiver: "Weapon" });
  assert.deepEqual(hits.map((h) => h.name), ["Fire"]);
});

test("bare identifiers add global-scope functions, variables and types", async () => {
  const globals: IndexSymbol[] = [
    { name: "GetWorldFromContext", kind: 12, path: "Kismet.h", line: 1 },
    { name: "GEngine", kind: 13, path: "Engine.h", line: 1 },
    { name: "GetTypeHash", kind: 12, containerName: "UE::Core", path: "Hash.h", line: 1 },
    { name: "ANFCharacter", kind: 5, path: "NFCharacter.h", line: 2 },
  ];
  // Fuzzy-ish like clangd: any symbol containing the typed text.
  const query = async (q: string) => {
    const parts = q.replace(/^::/, "").split("::");
    const name = (parts.pop() ?? "").toLowerCase();
    const scope = parts.join("::");
    return [...SYMBOLS, ...globals].filter(
      (s) => (s.containerName ?? "") === scope && s.name.toLowerCase().includes(name),
    );
  };
  const index = new ClangdIndexCompletion({ query, readLines: async (p) => FILES[p] ?? null });

  const short = await index.complete({ prefix: "Get", container: "ANFCharacter" });
  const shortNames = short.map((h) => h.name);
  assert.ok(shortNames.includes("GetController") && shortNames.includes("GetActorLocation"), "class chain first");
  assert.equal(shortNames.includes("GetWorldFromContext"), false, "global query waits for 5 characters");

  const get = await index.complete({ prefix: "GetWo", container: "ANFCharacter" });
  const names = get.map((h) => h.name);
  assert.ok(names.includes("GetWorldOrigin") && names.includes("GetWorldFromContext"));
  assert.equal(names.includes("GetTypeHash"), false, "namespaced symbols are not global scope");
  assert.ok(names.indexOf("GetWorldOrigin") < names.indexOf("GetWorldFromContext"));

  assert.deepEqual((await index.globals("GEngi")).map((h) => h.name), ["GEngine"]);
  assert.deepEqual(await index.globals("Get"), [], "global queries wait for 5 characters");
  assert.deepEqual(await index.globals("GetW"), [], "four characters still wait");
  assert.deepEqual((await index.globals("NFChar")).map((h) => h.name), ["ANFCharacter"], "UE type prefix");
  assert.deepEqual(await index.globals(""), []);
  // Member access never mixes in globals.
  const viaThis = await index.complete({ prefix: "Get", memberOf: "ANFCharacter" });
  assert.equal(viaThis.some((h) => h.name === "GetWorldFromContext"), false);
});

test("Super:: resolves to the direct base; an empty index caches nothing", async () => {
  const fake = fakeIndex(SYMBOLS);
  const index = new ClangdIndexCompletion(fake);
  const viaSuper = await index.complete({ prefix: "J", container: "ANFCharacter", memberOf: "Super" });
  assert.deepEqual(viaSuper.map((h) => h.name), ["Jump"]);

  const empty = new ClangdIndexCompletion({ query: async () => [], readLines: async () => null });
  assert.deepEqual(await empty.complete({ prefix: "", memberOf: "ANFCharacter" }), []);
  assert.deepEqual(await empty.classChain("ANFCharacter"), [{ name: "ANFCharacter", depth: 0 }]);
});
