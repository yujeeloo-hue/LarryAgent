import {
  getComposerPrefs,
  subscribeComposerPrefs,
  type SessionComposerPrefs,
} from "../state/sessionComposerPrefs.js";
import { FsmPaneView } from "./FsmPaneView.js";

type BuiltinFsmGraphMode = "react" | "ask" | "plan_execute" | "subagent";
type GraphKey = BuiltinFsmGraphMode | `custom:${string}`;

/** composer runMode → workflow graph mode (builtins only). */
function graphModeForRunMode(
  runMode: "agent" | "ask" | "plan" | "custom",
): BuiltinFsmGraphMode | null {
  switch (runMode) {
    case "ask":
      return "ask";
    case "plan":
      return "plan_execute";
    case "custom":
      return null;
    default:
      return "react";
  }
}

function keyLabel(key: GraphKey): string {
  if (key.startsWith("custom:")) return "custom";
  return key;
}

/**
 * Detail → FSM tab: renders the focused session's workflow graph.
 * Idle preview follows the composer run mode (what the next send will use),
 * including Custom graphs via library id.
 * While a turn is running, follow session.fsmLastGraphId / fsmLastGraphMode.
 * Live `fsm_node` stream events move the active highlight; an event
 * whose nodeId is unknown in the current graph triggers a reload.
 */
export class FsmPaneController {
  private sessionId: string | null = null;
  private activeNodeId = "";
  private graph: FsmGraphViewData | null = null;
  private graphKey: GraphKey | null = null;
  private refreshSeq = 0;
  private refreshing = false;
  private readonly configCache = new Map<
    GraphKey,
    Promise<FsmGraphViewData | null>
  >();
  private unsubscribeStream: (() => void) | null = null;
  private unsubscribeComposerPrefs: (() => void) | null = null;

  constructor(private readonly view: FsmPaneView) {}

  mount(): HTMLElement {
    this.view.refreshButton.addEventListener("click", () => {
      void this.refresh();
    });
    const bridge = window.jellybot;
    if (bridge?.onAgentStream) {
      this.unsubscribeStream = bridge.onAgentStream((payload) => {
        if (payload.sessionId !== this.sessionId) return;
        const event = payload.event as {
          type?: string;
          nodeId?: string;
        };
        if (event?.type !== "fsm_node" || !event.nodeId) return;
        this.onFsmNodeEvent(event.nodeId);
      });
    }
    return this.view.root;
  }

  destroy(): void {
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.unsubscribeComposerPrefs?.();
    this.unsubscribeComposerPrefs = null;
    this.view.root.remove();
  }

  setSessionId(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.unsubscribeComposerPrefs?.();
    this.unsubscribeComposerPrefs = null;
    this.sessionId = sessionId;
    this.activeNodeId = "";
    this.graph = null;
    this.graphKey = null;
    this.refreshSeq += 1;
    if (!sessionId) {
      this.view.setEmpty("Open a conversation to see its FSM graph.");
      this.view.setStatus("");
      return;
    }
    this.unsubscribeComposerPrefs = subscribeComposerPrefs(
      sessionId,
      (prefs) => {
        this.onComposerPrefsChanged(prefs);
      },
    );
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const sessionId = this.sessionId;
    const bridge = window.jellybot;
    if (!sessionId || !bridge) {
      this.view.setEmpty(
        sessionId
          ? "FSM graph unavailable."
          : "Open a conversation to see its FSM graph.",
      );
      return;
    }
    this.refreshing = true;
    try {
      const session = await bridge.getSession(sessionId);
      if (seq !== this.refreshSeq) return;
      const key = await this.resolveGraphKey(session);
      if (!key) {
        this.view.setEmpty("No FSM graph selected.");
        this.view.setStatus("");
        return;
      }
      const graph = await this.fetchConfig(key);
      if (seq !== this.refreshSeq) return;
      this.graphKey = key;
      this.graph = graph;
      if (!graph) {
        this.view.setEmpty(`No FSM graph for "${keyLabel(key)}".`);
        this.view.setStatus("");
        return;
      }
      const known =
        !this.activeNodeId ||
        graph.nodes.some((node) => node.id === this.activeNodeId);
      const active = known
        ? this.activeNodeId
        : (session?.fsmLastNodeId ?? "");
      this.activeNodeId = active;
      this.view.setEmpty(null);
      this.view.render(graph, active || null);
      const title =
        graph.name && key.startsWith("custom:")
          ? `custom · ${graph.name}`
          : keyLabel(key);
      this.view.setStatus(
        `${title} · ${graph.nodes.length} nodes / ${graph.edges.length} edges` +
          (active ? ` · at ${active}` : ""),
      );
    } catch (err) {
      console.error("[fsm-pane] refresh failed", err);
      this.view.setEmpty("Failed to load FSM graph.");
    } finally {
      this.refreshing = false;
    }
  }

  /** Live highlight; unknown nodeId ⇒ the graph mode changed under us. */
  private onFsmNodeEvent(nodeId: string): void {
    if (this.graph && this.graph.nodes.some((node) => node.id === nodeId)) {
      if (this.activeNodeId !== nodeId) {
        this.activeNodeId = nodeId;
        this.view.setActiveNode(nodeId);
        if (this.graphKey) {
          this.view.setStatus(
            `${keyLabel(this.graphKey)} · ${this.graph.nodes.length} nodes / ${this.graph.edges.length} edges · at ${nodeId}`,
          );
        }
      }
      return;
    }
    this.activeNodeId = nodeId;
    void this.refresh();
  }

  private onComposerPrefsChanged(prefs: SessionComposerPrefs): void {
    const nextKey =
      prefs.runMode === "custom" && prefs.fsmGraphId
        ? (`custom:${prefs.fsmGraphId}` as const)
        : graphModeForRunMode(prefs.runMode);
    if (!nextKey || this.graphKey === nextKey) return;
    this.activeNodeId = "";
    this.graphKey = null;
    this.refreshSeq += 1;
    void this.refresh();
  }

  private async resolveGraphKey(
    session: Session | null,
  ): Promise<GraphKey | null> {
    if (session?.status === "running") {
      if (
        typeof session.fsmLastGraphId === "string" &&
        session.fsmLastGraphId.trim()
      ) {
        return `custom:${session.fsmLastGraphId.trim()}`;
      }
      if (session.fsmLastGraphMode) {
        return session.fsmLastGraphMode;
      }
    }

    const sessionId = this.sessionId;
    const prefs = sessionId ? getComposerPrefs(sessionId) : null;
    if (prefs?.runMode === "custom" && prefs.fsmGraphId) {
      return `custom:${prefs.fsmGraphId}`;
    }
    if (session?.composerRunMode === "custom" && session.composerFsmGraphId) {
      return `custom:${session.composerFsmGraphId}`;
    }

    const runMode =
      prefs?.runMode ??
      session?.composerRunMode ??
      (await this.defaultRunMode()) ??
      "agent";
    if (runMode === "custom") return null;
    return graphModeForRunMode(runMode);
  }

  private defaultRunModeCache: Promise<"agent" | "ask" | "plan"> | null = null;

  private async defaultRunMode(): Promise<"agent" | "ask" | "plan" | null> {
    const bridge = window.jellybot;
    if (!bridge?.getWorkspaceSettings) return null;
    this.defaultRunModeCache ??= bridge
      .getWorkspaceSettings()
      .then(
        (settings) =>
          settings.composerRunMode === "ask" ||
          settings.composerRunMode === "plan"
            ? settings.composerRunMode
            : "agent",
      )
      .catch(() => "agent" as const);
    return this.defaultRunModeCache;
  }

  private fetchConfig(key: GraphKey): Promise<FsmGraphViewData | null> {
    let cached = this.configCache.get(key);
    if (!cached) {
      const bridge = window.jellybot;
      if (!bridge) {
        cached = Promise.resolve(null);
      } else if (key.startsWith("custom:")) {
        const id = key.slice("custom:".length);
        cached = bridge.fsmGraphViewById
          ? bridge.fsmGraphViewById(id).catch(() => null)
          : Promise.resolve(null);
      } else {
        const mode = key as BuiltinFsmGraphMode;
        cached = bridge.fsmGraphConfig
          ? bridge.fsmGraphConfig(mode).catch(() => null)
          : Promise.resolve(null);
      }
      this.configCache.set(key, cached);
    }
    return cached;
  }
}

/** Renderer-side mirror of main's FsmGraphView (env.d.ts). */
type FsmGraphViewData = {
  mode: string;
  entryNodeId: string;
  terminalNodeId: string;
  name?: string;
  graphId?: string;
  nodes: Array<{
    id: string;
    name?: string;
    selfLoop: boolean;
    actionTypes: string[];
  }>;
  edges: Array<{ from: string; to: string; type: string; when?: string }>;
};
