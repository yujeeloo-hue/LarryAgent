import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CppCompletionIndex, parseBaseClasses } from "./complete.js";
import { openCppSymbolDatabase } from "./db.js";
import { cppSymbolDatabasePath } from "./paths.js";
import { scanCppSymbolDatabase } from "./scanWorkspace.js";

const BASE_H = `#pragma once
class ACharacterBase
{
public:
    void Jump();
    float GetSpeed() const;
    int32 JumpCount;
};
`;

const CHAR_H = `#pragma once
#include "CharacterBase.h"
UCLASS()
class NFGAME_API ANFCharacter : public ACharacterBase, public IAbilityHost
{
public:
    void Attack(float Damage, int32 Combo);
    void AttackHeavy();
    UPROPERTY()
    TObjectPtr<UWeaponComponent> Weapon;
    UPROPERTY()
    UAudioConfig* AudioTriggerCfg;
};
`;

const WEAPON_H = `#pragma once
class UWeaponComponent
{
public:
    void Fire(int32 Shots);
};
`;

const AUDIO_H = `#pragma once
class UAudioConfig
{
public:
    void Play();
};
`;

const LOGGER_H = `#pragma once
void AttachLogger(int Level)
{
}
`;

const TABLE_H = `#pragma once
class FAttackTable
{
};
`;

test("parseBaseClasses reads UE heads (API macro, multiple bases, templates)", () => {
  assert.deepEqual(
    parseBaseClasses("class NFGAME_API ANFCharacter : public ACharacter, public IAbilitySystemInterface", "ANFCharacter"),
    ["ACharacter", "IAbilitySystemInterface"],
  );
  assert.deepEqual(
    parseBaseClasses("struct FRow final : public TBase<int32, TArray<float>>, virtual UE::FOther {", "FRow"),
    ["TBase", "FOther"],
  );
  assert.deepEqual(parseBaseClasses("class FLeaf {", "FLeaf"), []);
});

test("completion searches own class, then bases, then globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpp-complete-"));
  try {
    await mkdir(join(root, "Source"), { recursive: true });
    await writeFile(join(root, "Source", "CharacterBase.h"), BASE_H);
    await writeFile(join(root, "Source", "NFCharacter.h"), CHAR_H);
    await writeFile(join(root, "Source", "WeaponComponent.h"), WEAPON_H);
    await writeFile(join(root, "Source", "AudioConfig.h"), AUDIO_H);
    await writeFile(join(root, "Source", "Logger.h"), LOGGER_H);
    await writeFile(join(root, "Source", "AttackTable.h"), TABLE_H);
    const db = openCppSymbolDatabase(cppSymbolDatabasePath(root));
    try {
      await scanCppSymbolDatabase({ db, root });
      const index = new CppCompletionIndex();

      // `this->` (empty prefix): own members first, inherited after.
      const members = index.complete(db, { prefix: "", memberOf: "ANFCharacter" });
      const names = members.map((hit) => hit.name);
      assert.ok(names.includes("Attack") && names.includes("Jump") && names.includes("JumpCount"));
      assert.ok(names.indexOf("Attack") < names.indexOf("Jump"));
      assert.equal(members.find((hit) => hit.name === "Jump")?.depth, 1);
      assert.equal(names.includes("AttachLogger"), false);

      // Bare identifier: class members, then globals.
      const bare = index.complete(db, { prefix: "attac", container: "ANFCharacter" });
      const bareNames = bare.map((hit) => hit.name);
      assert.deepEqual(bareNames.slice(0, 2).sort(), ["Attack", "AttackHeavy"]);
      // File-scope free functions are globals too.
      assert.ok(bareNames.includes("AttachLogger"));
      assert.equal(bare.find((hit) => hit.name === "AttachLogger")?.params, "int Level");
      // UE type prefixes: `attac` also reaches FAttackTable, `characterb` ACharacterBase.
      assert.ok(bareNames.includes("FAttackTable"));
      assert.ok(
        index.complete(db, { prefix: "characterb" }).some((hit) => hit.name === "ACharacterBase"),
      );
      assert.equal(bare.find((hit) => hit.name === "Attack")?.params, "float Damage, int32 Combo");

      // Member variable receiver resolves through TObjectPtr<…>.
      const viaReceiver = index.complete(db, {
        prefix: "",
        container: "ANFCharacter",
        receiver: "Weapon",
      });
      assert.deepEqual(viaReceiver.map((hit) => hit.name), ["Fire"]);

      // `TargetCharacter->AudioTriggerCfg->` walks the field's type.
      const viaChain = index.complete(db, {
        prefix: "",
        container: "ANFCharacter",
        memberOf: "ANFCharacter",
        chain: ["AudioTriggerCfg"],
      });
      assert.deepEqual(viaChain.map((hit) => hit.name), ["Play"]);
      assert.deepEqual(
        index.complete(db, { prefix: "", container: "ANFCharacter", chain: ["Missing"] }),
        [],
      );

      // Super:: → direct base.
      const viaSuper = index.complete(db, { prefix: "j", container: "ANFCharacter", memberOf: "Super" });
      assert.deepEqual(viaSuper.map((hit) => hit.name).sort(), ["Jump", "JumpCount"]);

      // Unknown receiver: nothing rather than a misleading global list.
      assert.deepEqual(index.complete(db, { prefix: "a", receiver: "Mystery" }), []);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
