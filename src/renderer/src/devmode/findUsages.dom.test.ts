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
  // Stale column (trimmed text drift) falls back to the word position.
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

  chips[0]!.click(); // back to all
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
  // File head: icon + name + dir + hit count.
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
  // Rows: "Line N" pill, highlighted token, badges for call/address only.
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
