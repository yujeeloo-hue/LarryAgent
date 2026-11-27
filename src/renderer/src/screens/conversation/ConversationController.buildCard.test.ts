import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[
  ".css"
] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });

let ConversationController: typeof import("./ConversationController.js").ConversationController;
test.before(async () => {
  ({ ConversationController } = await import("./ConversationController.js"));
});

const WORKSPACE = "E:/Workspace/Game";

function buildSnapshot(runId: string) {
  return {
    task: "build",
    runId,
    workspacePath: WORKSPACE,
    startedAt: 1,
    progress: { phase: "compiling" },
  };
}

function harness(active: unknown[], ownRunId: string | null) {
  const mounted: string[] = [];
  const cleared: number[] = [];
  window.jellybot = {
    getDevTaskState: async () => ({ active }),
  } as unknown as NonNullable<Window["jellybot"]>;
  const controller = Object.assign(Object.create(ConversationController.prototype), {
    workspacePath: WORKSPACE,
    buildCard: null,
    buildCardWorkspace: "",
    buildCardRunId: ownRunId,
    destroyed: false,
    view: {
      setBuildStatusCard: (card: unknown) => {
        if (card) mounted.push(String(card));
        else cleared.push(cleared.length + 1);
      },
    },
    mountBuildCard: (snap: { runId: string }) => {
      mounted.push(snap.runId);
    },
  });
  return { controller, mounted, cleared };
}

test("Builds started from Dev Mode do not mount a build card in the conversation", async () => {
  const h = harness([buildSnapshot("dev-mode-run")], null);
  await h.controller.restoreBuildCard();
  assert.deepEqual(h.mounted, [], "No build was started in this conversation, so no card should be mounted");
  assert.equal(h.cleared.length, 1, "Should clear the build card host");
});

test("A build started from this conversation with /build mounts a card in the conversation", async () => {
  const h = harness([buildSnapshot("chat-run")], "chat-run");
  await h.controller.restoreBuildCard();
  assert.deepEqual(h.mounted, ["chat-run"]);
  assert.equal(h.cleared.length, 0);
});

test("A build previously started here but currently topped by someone else's build does not mount a card", async () => {
  const h = harness([buildSnapshot("dev-mode-run")], "finished-chat-run");
  await h.controller.restoreBuildCard();
  assert.deepEqual(h.mounted, []);
  assert.equal(h.cleared.length, 1);
});
