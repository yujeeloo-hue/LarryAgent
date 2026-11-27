import assert from "node:assert/strict";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Node: dom.Node,
});

type ViewType = typeof import("./FindUsagesView.js")["FindUsagesView"];
let FindUsagesView: ViewType;

test("FindUsagesView loading state shows a centered spinner, then yields to results", () => {
  const view = new FindUsagesView();
  view.renderLoading("OpenWindow");
  const spinner = view.root.querySelector(".devmode-references-spinner");
  assert.ok(spinner, "spinner element present while loading");
  assert.match(
    view.root.querySelector(".devmode-references-loading")?.textContent ?? "",
    /Searching for OpenWindow/,
  );
  assert.ok(
    (view.root.querySelector(".devmode-references-status") as HTMLElement).hidden,
    "status line hidden while loading",
  );
  view.renderResults(
    "OpenWindow",
    [
      { path: "E:/Game/A.cpp", line: 2, column: 3, lineText: "OpenWindow();", kind: "call" },
    ],
  );
  assert.ok(
    !(view.root.querySelector(".devmode-references-loading") as HTMLElement).hidden ===
      false,
    "loading hidden once results render",
  );
  assert.ok(
    !(view.root.querySelector(".devmode-references-status") as HTMLElement).hidden,
    "status visible again once results render",
  );
});

before(async () => {
  ({ FindUsagesView } = await import("./FindUsagesView.js"));
});

test("usageKind separates writes, reads, calls and address-of", async () => {
  const { usageKind } = await import("./cppFindUsages.js");
  assert.equal(usageKind("Count = 1;", 1, "Count"), "write");
  assert.equal(usageKind("Count += 2;", 1, "Count"), "write");
  assert.equal(usageKind("++Count;", 3, "Count"), "write");
  assert.equal(usageKind("Count++;", 1, "Count"), "write");
  assert.equal(usageKind("if (Count == 0)", 5, "Count"), "read", "== is a comparison, not an assignment");
  assert.equal(usageKind("int X = Count;", 9, "Count"), "read");
  assert.equal(usageKind("Count(1);", 1, "Count"), "call");
  assert.equal(usageKind("Foo(Count);", 5, "Count"), "read", "an argument is a read, not a call");
  assert.equal(usageKind("Register(&Count);", 10, "Count"), "address");
  assert.equal(usageKind("  Count = 1;", 99, "Count"), "write");
});

test("FindUsagesView kind chips filter the rendered rows", () => {
  const view = new FindUsagesView();
  view.renderResults(
    "Health",
    [
      { path: "E:/Game/A.cpp", line: 3, column: 5, lineText: "Health = 100;", kind: "write" },
      { path: "E:/Game/A.cpp", line: 8, column: 9, lineText: "int X = Health;", kind: "read" },
      { path: "E:/Game/B.cpp", line: 4, column: 2, lineText: "Log(Health);", kind: "call" },
    ],
  );
  const chips = [...view.root.querySelectorAll<HTMLButtonElement>(".devmode-references-chip")];
  assert.equal(chips.length, 4, "all + one chip per present kind");
  assert.match(chips[0]!.textContent ?? "", /all · 3/);

  chips.find((chip) => /write/.test(chip.textContent ?? ""))!.click();
  assert.equal(view.root.querySelectorAll(".devmode-references-row").length, 1);
  assert.match(
    view.root.querySelector(".devmode-references-status")?.textContent ?? "",
    /1 of 3 usages/,
  );
  assert.equal(
    view.root.querySelector(".devmode-references-row code")?.textContent,
    "Health = 100;",
  );

  chips.find((chip) => /read/.test(chip.textContent ?? ""))!.click();
  assert.equal(view.root.querySelectorAll(".devmode-references-row").length, 1);
  assert.match(
    view.root.querySelector(".devmode-references-row code")?.textContent ?? "",
    /int X = Health;/,
  );

  chips[0]!.click();
  assert.equal(view.root.querySelectorAll(".devmode-references-row").length, 3);
});

test("FindUsagesView skips chips when every row shares one kind", () => {
  const view = new FindUsagesView();
  view.renderResults("Foo", [
    { path: "E:/Game/A.cpp", line: 3, column: 5, lineText: "Foo();", kind: "call" },
    { path: "E:/Game/A.cpp", line: 8, column: 9, lineText: "Bar(Foo());", kind: "call" },
  ]);
  assert.equal(view.root.querySelectorAll(".devmode-references-chip").length, 0);
});

test("FindUsagesView groups results and opens a selected location", () => {
  const view = new FindUsagesView();
  let opened: { path: string; line: number } | null = null;
  view.onOpen = (row) => {
    opened = { path: row.path, line: row.line };
  };
  view.renderResults(
    "Run",
    [
      {
        path: "E:/Game/A.cpp",
        line: 3,
        column: 5,
        lineText: "Run();",
        kind: "call",
      },
      {
        path: "E:/Game/A.cpp",
        line: 8,
        column: 9,
        lineText: "Obj->Run();",
        kind: "call",
      },
      {
        path: "E:/Game/B.cpp",
        line: 4,
        column: 2,
        lineText: "&A::Run",
        kind: "address",
      },
      {
        path: "E:/Game/B.cpp",
        line: 9,
        column: 8,
        lineText: "int X = Run;",
        kind: "read",
      },
    ],
    { scannedFiles: 2 },
  );

  assert.equal(view.root.querySelectorAll(".devmode-references-group").length, 2);
  assert.equal(view.root.querySelectorAll(".devmode-references-row").length, 4);
  assert.match(
    view.root.querySelector(".devmode-references-status")?.textContent ?? "",
    /4 usages of Run/,
  );
  const head = view.root.querySelector(".devmode-references-file");
  assert.ok(head?.querySelector("svg"), "file icon present");
  assert.equal(
    head?.querySelector(".devmode-references-filename")?.textContent,
    "A.cpp",
  );
  assert.equal(
    head?.querySelector(".devmode-references-dir")?.textContent,
    "E:/Game/",
  );
  assert.equal(
    head?.querySelector(".devmode-references-count")?.textContent,
    "2",
  );
  assert.match(
    view.root.querySelector(".devmode-references-line")?.textContent ?? "",
    /Line 3/,
  );
  assert.equal(
    view.root.querySelector(".devmode-references-hit")?.textContent,
    "Run",
  );
  assert.equal(
    view.root.querySelectorAll(".devmode-references-kindbadge").length,
    3,
  );
  (view.root.querySelector(".devmode-references-row") as HTMLButtonElement).click();
  assert.deepEqual(opened, { path: "E:/Game/A.cpp", line: 3 });
});

test("FindUsagesView renders loading and empty states", () => {
  const view = new FindUsagesView();
  view.renderLoading();
  assert.match(view.root.textContent, /Searching…/);
  view.renderLoading("Health");
  assert.match(view.root.textContent, /Searching for Health/);
  view.renderEmpty("No usages found.");
  assert.match(view.root.textContent, /No usages found/);
  assert.equal(view.root.querySelectorAll(".devmode-references-row").length, 0);
});

test("the pane head carries its own Clear", () => {
  const view = new FindUsagesView();
  let cleared = 0;
  view.onClear = () => {
    cleared += 1;
  };
  const clear = view.root.querySelector<HTMLButtonElement>(
    ".devmode-references-clear",
  )!;
  assert.ok(clear.closest(".devmode-references-head"));
  assert.match(clear.querySelector("svg")?.innerHTML ?? "", /m16 22-1-4/);
  clear.click();
  assert.equal(cleared, 1);
});

test("FindUsagesController shows clangd references and every failure state", async () => {
  const { FindUsagesController } = await import("./FindUsagesController.js");
  type Result = Awaited<ReturnType<ConstructorParameters<typeof FindUsagesController>[1]["getSemanticReferences"]>>;
  let next: Result = { status: "unsupported" };
  let revealed = 0;
  const opened: Array<{ path: string; line: number; column: number }> = [];
  const view = new FindUsagesView();
  const controller = new FindUsagesController(view, {
    getSemanticReferences: async () => next,
    getLiveText: (path) => (path === "E:/Game/A.cpp" ? "int Health = 0;\nHealth = 5;\n" : null),
    readText: async (path) => (path === "E:/Game/B.cpp" ? "Log(Health);\n" : null),
    revealFileLine: (path, line, column) => opened.push({ path, line, column }),
    revealPanel: () => {
      revealed++;
    },
  });
  const text = () => view.root.textContent ?? "";

  await controller.find();
  assert.match(text(), /Find Usages works on C\+\+, JavaScript and TypeScript symbols/);
  next = { status: "no-symbol" };
  await controller.find();
  assert.match(text(), /No symbol at the caret/);
  next = { status: "unavailable", server: "clangd" };
  await controller.find();
  assert.match(text(), /needs clangd/);
  next = { status: "failed", server: "clangd", word: "Health", message: "timed out" };
  await controller.find();
  assert.match(text(), /clangd could not find usages of Health: timed out/);
  next = { status: "failed", server: "The TypeScript language server", word: "addVec", message: "timed out" };
  await controller.find();
  assert.match(text(), /The TypeScript language server could not find usages of addVec: timed out/);
  next = { status: "ok", word: "Health", references: [] };
  await controller.find();
  assert.match(text(), /No usages found for Health/);

  next = {
    status: "ok",
    word: "Health",
    references: [
      { path: "E:\\Game\\A.cpp", line: 2, column: 1 },
      { path: "E:/Game/B.cpp", line: 1, column: 5 },
      { path: "E:/Game/Missing.cpp", line: 1, column: 1 },
    ],
  };
  await controller.find();
  assert.equal(revealed, 7);
  const rows = [...view.root.querySelectorAll<HTMLButtonElement>(".devmode-references-row")];
  assert.equal(rows.length, 2);
  assert.match(text(), /2 usages of Health/);
  rows[0]!.click();
  assert.deepEqual(opened, [{ path: "E:/Game/A.cpp", line: 2, column: 1 }]);
});

test("FindUsagesController selects Blueprint usages on click and opens them on double click", async () => {
  const { FindUsagesController } = await import("./FindUsagesController.js");
  const selected: string[] = [];
  const opened: string[] = [];
  let openOk = true;
  let selectStatus: Awaited<
    ReturnType<NonNullable<ConstructorParameters<typeof FindUsagesController>[1]["selectBlueprint"]>>
  > = { status: "ok" };
  let blueprints: Awaited<ReturnType<NonNullable<ConstructorParameters<typeof FindUsagesController>[1]["getBlueprintReferences"]>>> = {
    status: "ok",
    complete: false,
    references: [
      { kind: "parent_class", assetPath: "/Game/Characters/BP_Hero.BP_Hero" },
      {
        kind: "call",
        assetPath: "/Game/Characters/BP_Hero.BP_Hero",
        graph: "EventGraph",
        nodeTitle: "Spawn Actor",
        nodeGuid: "112233445566778899AABBCCDDEEFF00",
      },
    ],
  };
  let codeRefs = [{ path: "E:/Game/A.cpp", line: 1, column: 1 }];
  const view = new FindUsagesView();
  const controller = new FindUsagesController(view, {
    getSemanticReferences: async () => ({ status: "ok", word: "ANFCharacter", references: codeRefs }),
    getBlueprintReferences: async () => blueprints,
    selectBlueprint: async (row) => {
      selected.push(row.assetPath);
      return selectStatus;
    },
    openBlueprint: async (row) => {
      opened.push(`${row.assetPath}#${row.nodeGuid ?? ""}`);
      return openOk ? { ok: true } : { ok: false, message: "Unreal Editor could not find this asset." };
    },
    getLiveText: () => "ANFCharacter* Hero;\n",
    readText: async () => null,
    revealFileLine: () => undefined,
    revealPanel: () => undefined,
  });
  const text = () => view.root.textContent ?? "";

  await controller.find();
  assert.match(text(), /3 usages of ANFCharacter in 1 files and 1 Blueprint/);
  assert.match(text(), /still indexing Blueprints/);
  const bpRows = [...view.root.querySelectorAll<HTMLButtonElement>(".devmode-references-row.is-blueprint")];
  assert.equal(bpRows.length, 2);
  assert.match(bpRows[1]!.textContent ?? "", /EventGraph · Spawn Actor/);
  assert.match(bpRows[0]!.textContent ?? "", /subclass/);
  bpRows[1]!.click();
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.deepEqual(selected, ["/Game/Characters/BP_Hero.BP_Hero"]);
  assert.deepEqual(opened, [], "a single click only selects the asset in Unreal Editor");

  bpRows[1]!.dispatchEvent(new dom.window.Event("dblclick"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(opened, ["/Game/Characters/BP_Hero.BP_Hero#112233445566778899AABBCCDDEEFF00"]);

  selectStatus = { status: "unsupported" };
  opened.length = 0;
  bpRows[1]!.click();
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.deepEqual(
    opened,
    ["/Game/Characters/BP_Hero.BP_Hero#"],
    "without the select capability the click falls back to opening the asset only",
  );

  selectStatus = { status: "failed", message: "Unreal Editor could not find this asset." };
  bpRows[0]!.click();
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.match(text(), /Could not select \/Game\/Characters\/BP_Hero\.BP_Hero: Unreal Editor could not find this asset/);

  openOk = false;
  opened.length = 0;
  bpRows[0]!.click();
  bpRows[0]!.dispatchEvent(new dom.window.Event("dblclick"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(text(), /Could not open \/Game\/Characters\/BP_Hero\.BP_Hero: Unreal Editor could not find this asset/);

  const chip = view.root.querySelector<HTMLButtonElement>('.devmode-references-chip[data-filter="blueprint"]');
  assert.ok(chip);
  chip!.click();
  assert.equal(view.root.querySelectorAll(".devmode-references-row:not(.is-blueprint)").length, 0);
  assert.equal(view.root.querySelectorAll(".devmode-references-row.is-blueprint").length, 2);

  codeRefs = [];
  blueprints = { status: "ok", complete: true, references: [{ kind: "cast", assetPath: "/Game/UI/W_Hud.W_Hud" }] };
  await controller.find();
  assert.match(text(), /1 usage of ANFCharacter in 1 Blueprint/);

  blueprints = { status: "unavailable" };
  await controller.find();
  assert.match(text(), /No usages found for ANFCharacter\./);
  assert.doesNotMatch(text(), /Blueprint/);

  blueprints = { status: "not_ready" };
  codeRefs = [{ path: "E:/Game/A.cpp", line: 1, column: 1 }];
  await controller.find();
  assert.match(text(), /1 usage of ANFCharacter in 1 files/);
  assert.match(text(), /Unreal Editor is not ready yet/);
});

test("FindUsagesController hides Unreal generated files", async () => {
  const { FindUsagesController } = await import("./FindUsagesController.js");
  let references = [
    { path: "E:/Game/Intermediate/Build/NFCharacter.gen.cpp", line: 1, column: 1 },
    { path: "E:\\Game\\Intermediate\\Inc\\NFCharacter.generated.h", line: 1, column: 1 },
    { path: "E:/Game/Source/NFCharacter.cpp", line: 1, column: 1 },
  ];
  const view = new FindUsagesView();
  const controller = new FindUsagesController(view, {
    getSemanticReferences: async () => ({ status: "ok", word: "ANFCharacter", references }),
    getLiveText: () => "ANFCharacter* Hero;\n",
    readText: async () => null,
    revealFileLine: () => undefined,
    revealPanel: () => undefined,
  });
  await controller.find();
  const rows = [...view.root.querySelectorAll<HTMLElement>(".devmode-references-file")];
  assert.deepEqual(rows.map((row) => row.title), ["E:/Game/Source/NFCharacter.cpp"]);
  assert.match(view.root.textContent ?? "", /1 usage of ANFCharacter in 1 files/);

  references = references.slice(0, 2);
  await controller.find();
  assert.match(view.root.textContent ?? "", /No usages found for ANFCharacter\./);
});

test("FindUsagesController drops a slow answer superseded by a newer search", async () => {
  const { FindUsagesController } = await import("./FindUsagesController.js");
  let release: (() => void) | undefined;
  let calls = 0;
  const view = new FindUsagesView();
  const controller = new FindUsagesController(view, {
    getSemanticReferences: async () => {
      calls++;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: "ok", word: "Old", references: [{ path: "E:/A.cpp", line: 1, column: 1 }] };
      }
      return { status: "no-symbol" };
    },
    getLiveText: () => "Old();\n",
    readText: async () => null,
    revealFileLine: () => undefined,
    revealPanel: () => undefined,
  });
  const first = controller.find();
  await controller.find();
  release?.();
  await first;
  assert.match(view.root.textContent ?? "", /No symbol at the caret/);
  assert.equal(view.root.querySelectorAll(".devmode-references-row").length, 0);
});
