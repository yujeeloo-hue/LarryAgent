import assert from "node:assert/strict";
import Module from "node:module";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";
import { colorIconSources } from "../../../../shared/icons/colorIcons.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  Event: dom.window.Event,
  requestAnimationFrame: () => 0,
});
if (typeof globalThis.CSS === "undefined" || !globalThis.CSS?.escape) {
  Object.assign(globalThis, {
    CSS: { escape: (value: string) => value.replace(/["\\\]]/g, "\\$&") },
  });
}

let ToolsView: typeof import("./ToolsView.js").ToolsView;
type Row = import("./ToolsView.js").ToolsTableRow;
type Group = import("./ToolsView.js").ToolsTableGroup;
type McpServerRow = import("./ToolsView.js").ToolsMcpServerRow;
before(async () => {
  ({ ToolsView } = await import("./ToolsView.js"));
});

function tool(name: string): Row {
  return {
    name,
    displayName: name,
    description: `${name} description`,
    permissionLevel: 0,
    defaultPermissionLevel: 0,
    offered: false,
    visible: true,
    callCount: 3,
  };
}

function group(categoryId: string, names: string[]): Group {
  return {
    categoryId,
    label: categoryId,
    description: `${categoryId} tools`,
    tools: names.map(tool),
  };
}

function mcpServer(name: string): McpServerRow {
  return {
    id: name,
    name,
    enabled: true,
    transportSummary: `stdio: ${name}`,
    status: "connected",
    tools: [
      {
        name: `${name}_tool`,
        description: "example",
        registryName: `mcp__${name}__tool`,
        permissionLevel: 0,
        defaultPermissionLevel: 0,
        offered: false,
        callCount: 1,
      },
    ],
  };
}

function clickTab(
  view: InstanceType<typeof ToolsView>,
  categoryId: string,
): void {
  view.root
    .querySelector<HTMLButtonElement>(`.tools-category-tab[data-category="${categoryId}"]`)!
    .dispatchEvent(new dom.window.Event("click", { bubbles: true }));
}

function visiblePanels(view: InstanceType<typeof ToolsView>): string[] {
  return Array.from(view.root.querySelectorAll<HTMLElement>(".tools-category-panel"))
    .filter((panel) => !panel.hidden)
    .map((panel) => panel.dataset.category ?? panel.className);
}

test("nav lists MCP servers plus every tool category with counts and aria wiring", () => {
  const view = new ToolsView();
  const tabs = Array.from(view.root.querySelectorAll<HTMLButtonElement>(".tools-category-tab"));
  assert.deepEqual(
    tabs.map((tab) => tab.dataset.category),
    ["mcp-servers", "filesystem", "search", "shell", "interaction", "orchestration", "vision", "mcp", "skills", "memory"],
  );
  assert.deepEqual(
    Array.from(view.root.querySelectorAll(".tools-category-group")).map((el) => el.textContent),
    ["Servers", "Built-in tools"],
  );
  for (const tab of tabs) {
    const panel = view.root.querySelector(`#${tab.getAttribute("aria-controls")}`);
    assert.ok(panel, `panel for ${tab.dataset.category}`);
    assert.equal(panel!.getAttribute("aria-labelledby"), tab.id);
    const artwork = tab.querySelector<HTMLImageElement>("img.tools-category-artwork");
    assert.ok(artwork, `approved color icon for ${tab.dataset.category}`);
    assert.equal(artwork.src, colorIconSources.tools[tab.dataset.category as keyof typeof colorIconSources.tools]);
    assert.equal(artwork.getAttribute("aria-hidden"), "true");
    assert.equal(artwork.alt, "");
    assert.equal(artwork.width, 16);
    assert.equal(artwork.height, 16);
  }
  assert.ok(view.root.querySelector(".tools-search-icon svg"));
  assert.ok(view.root.querySelector(".tools-auto-organize-btn svg"));
  assert.deepEqual(visiblePanels(view), ["mcp-servers"]);
});

test("switching tabs shows one panel, keeps tables mounted and updates badges", () => {
  const view = new ToolsView();
  view.setMcpServers([mcpServer("alpha"), mcpServer("beta")]);
  view.setGroups([group("filesystem", ["read_file", "write_file"]), group("search", ["grep"])]);
  assert.equal(
    view.root.querySelector<HTMLButtonElement>('.tools-category-tab[data-category="mcp-servers"] .tools-category-count')?.textContent,
    "2",
  );
  assert.equal(
    view.root.querySelector<HTMLButtonElement>('.tools-category-tab[data-category="filesystem"] .tools-category-count')?.textContent,
    "2",
  );

  clickTab(view, "filesystem");
  assert.deepEqual(visiblePanels(view), ["filesystem"]);
  const select = view.root.querySelector<HTMLSelectElement>('select.tools-permission-select[data-tool-name="read_file"]');
  assert.ok(select);

  clickTab(view, "search");
  assert.deepEqual(visiblePanels(view), ["search"]);
  // Filesystem rows stay mounted for instant switching back.
  assert.ok(view.root.querySelector('tr[data-tool-name="read_file"]'));

  const selected = view.root.querySelector('.tools-category-tab[aria-selected="true"]')!;
  assert.equal(selected.dataset.category, "search");
  const tabindex0 = view.root.querySelectorAll<HTMLButtonElement>('.tools-category-tab[tabindex="0"]');
  assert.equal(tabindex0.length, 1);
});

test("keyboard navigation moves through tabs with Home/End support", () => {
  const view = new ToolsView();
  const press = (key: string): void => {
    const selected = view.root.querySelector('.tools-category-tab[aria-selected="true"]')!;
    const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    selected.dispatchEvent(event);
  };
  press("ArrowDown");
  assert.deepEqual(visiblePanels(view), ["filesystem"]);
  press("End");
  assert.deepEqual(visiblePanels(view), ["memory"]);
  press("Home");
  assert.deepEqual(visiblePanels(view), ["mcp-servers"]);
});

test("non-empty query swaps to the cross-category results view", () => {
  const view = new ToolsView();
  const queries: string[] = [];
  view.setOnQueryChange((q) => queries.push(q));

  const input = view.root.querySelector<HTMLInputElement>(".tools-search-input")!;
  input.value = "file";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.deepEqual(queries, ["file"]);

  view.setMcpServers([mcpServer("alpha")]);
  view.setGroups([group("filesystem", ["read_file"])]);

  const results = view.root.querySelector<HTMLElement>(".tools-results")!;
  assert.equal(results.hidden, false);
  assert.equal(view.root.classList.contains("is-searching"), true);
  assert.ok(results.querySelector(".tools-mcp-card"));
  assert.ok(results.querySelector('tr[data-tool-name="read_file"]'));
  assert.equal(view.root.querySelector('.tools-category-tab[aria-selected="true"]')!.classList.contains("tools-category-tab"), true);

  // Picking a tab clears the query, notifies the controller and shows the panel.
  clickTab(view, "filesystem");
  assert.deepEqual(queries, ["file", ""]);
  assert.equal(view.root.classList.contains("is-searching"), false);
  assert.equal(results.hidden, true);
  assert.deepEqual(visiblePanels(view), ["filesystem"]);
});

test("search with no matches shows the controller empty message", () => {
  const view = new ToolsView();
  const input = view.root.querySelector<HTMLInputElement>(".tools-search-input")!;
  input.value = "zzz";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  view.setMcpServers([]);
  view.setGroups([], { emptyMessage: "No tools match “zzz”." });
  const results = view.root.querySelector<HTMLElement>(".tools-results")!;
  assert.equal(results.textContent?.includes("No tools match"), true);
});
