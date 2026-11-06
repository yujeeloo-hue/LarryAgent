import type { PromptQueueHandlers, PromptQueueItem } from "../conversation/PromptQueueView.js";

type QueueBridge = Pick<NonNullable<Window["jellybot"]>,
  "listPromptQueue" | "enqueuePrompt" | "removeQueuedPrompt" | "updateQueuedPromptText" |
  "moveQueuedPromptToFront" | "promoteQueuedPrompt" | "deferQueuedPrompt">;

/** Mirrors the native session queue for CoCo's independently owned composer. */
export class CocoPromptQueueController {
  private sessionId = "";
  private revision = 0;
  private generation = 0;
  private items: QueuedPrompt[] = [];
  private destroyed = false;
  private pendingInsert = false;
  private enqueueSession = "";
  readonly handlers: PromptQueueHandlers = {
    onRemove: id => { void this.mutate((bridge, sessionId) => bridge.removeQueuedPrompt(sessionId, id)); },
    onUpdateText: (id, text) => { void this.mutate((bridge, sessionId) => bridge.updateQueuedPromptText(sessionId, id, text)); },
    onMoveToFront: id => { void this.mutate((bridge, sessionId) => bridge.moveQueuedPromptToFront(sessionId, id)); },
    onPromote: id => { void this.promote(id); },
    onDefer: id => { void this.mutate((bridge, sessionId) => bridge.deferQueuedPrompt(sessionId, id)); },
  };

  constructor(
    private bridge: () => QueueBridge | undefined,
    private changed: () => void,
    private error: (text: string) => void,
  ) {}

  get hasDeferred(): boolean { return this.items.some(item => item.mode === "deferred"); }
  get enqueuePending(): boolean { return !!this.enqueueSession; }
  get viewItems(): PromptQueueItem[] {
    return this.items.map(item => ({ id: item.id, text: item.userText, mode: item.mode, attachments: item.attachments.map((a, index) => ({ ...a, id: `${item.id}-${index}` })) }));
  }

  setSession(sessionId: string): void {
    if (this.destroyed || this.sessionId === sessionId) return;
    this.sessionId = sessionId; this.items = []; this.pendingInsert = false; this.enqueueSession = "";
    this.generation++;
    this.revision++; this.changed();
    if (sessionId) void this.hydrate(sessionId);
  }

  onStream(payload: AgentStreamPayload): void {
    if (this.destroyed || !this.sessionId || payload.sessionId !== this.sessionId || payload.event.type !== "prompt_queue") return;
    this.apply(Array.isArray(payload.event.items) ? payload.event.items : []);
  }

  /** A deliberate second Enter can arrive before enqueue IPC returns. */
  insertAfterEnqueue(): void { if (this.enqueuePending) this.pendingInsert = true; }

  async enqueue(text: string, workId?: string): Promise<boolean> {
    const bridge = this.bridge(), sessionId = this.sessionId, revision = this.revision, generation = this.generation;
    if (!bridge || !sessionId || this.enqueuePending || this.destroyed) return false;
    this.enqueueSession = sessionId;
    try {
      const response = await bridge.enqueuePrompt({ sessionId, userText: text, mode: "deferred", ...(workId ? { cocoWorkId: workId } : {}) });
      if (!this.current(sessionId, generation)) return false;
      if (this.revision === revision) this.apply(response.items);
      if (this.pendingInsert) {
        const head = this.items.find(item => item.mode === "deferred");
        if (head) await this.promote(head.id);
      }
      return true;
    } catch (error) {
      if (this.current(sessionId, generation)) this.error(String(error));
      return false;
    } finally {
      if (this.current(sessionId, generation)) { this.enqueueSession = ""; this.pendingInsert = false; this.changed(); }
    }
  }

  async promoteHead(): Promise<void> {
    const head = this.items.find(item => item.mode === "deferred");
    if (head) await this.promote(head.id);
  }

  destroy(): void { this.destroyed = true; this.sessionId = ""; this.items = []; this.pendingInsert = false; this.enqueueSession = ""; }

  private current(sessionId: string, generation: number): boolean { return !this.destroyed && this.sessionId === sessionId && this.generation === generation; }
  private apply(items: QueuedPrompt[]): void {
    this.items = items.filter(item => item.sessionId === this.sessionId);
    this.revision++; this.changed();
  }
  private async hydrate(sessionId: string): Promise<void> {
    const revision = this.revision, generation = this.generation;
    try {
      const items = await this.bridge()?.listPromptQueue(sessionId);
      // Hydration must never replay a pre-insertion snapshot over a live event.
      if (items && this.current(sessionId, generation) && this.revision === revision) this.apply(items);
    } catch (error) { if (this.current(sessionId, generation)) this.error(String(error)); }
  }
  private async promote(id: string): Promise<void> {
    await this.mutate((bridge, sessionId) => bridge.promoteQueuedPrompt(sessionId, id));
  }
  private async mutate(operation: (bridge: QueueBridge, sessionId: string) => Promise<PromptQueueMutationResponse>): Promise<void> {
    const bridge = this.bridge(), sessionId = this.sessionId, revision = this.revision, generation = this.generation;
    if (!bridge || !sessionId || this.destroyed) return;
    try {
      const response = await operation(bridge, sessionId);
      if (!this.current(sessionId, generation)) return;
      if (this.revision === revision) this.apply(response.items);
      if (!response.ok) this.error(response.reason === "coco_unavailable" ? "CoCo could not send this prompt. It is kept in the queue." : `Could not update the prompt queue: ${response.reason ?? "unavailable"}`);
    } catch (error) { if (this.current(sessionId, generation)) this.error(String(error)); }
  }
}
