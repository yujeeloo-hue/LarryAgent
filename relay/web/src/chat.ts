import type { DemoCardState, DemoSettled, DemoSubmitReceipt } from "../../../src/session/demoCardState.js";
import { icon } from "./icons.js";
import { el } from "./render.js";
import { parseMarkdownBlocks, renderMarkdownBlocks } from "./markdown.js";
import {
  requestRaf,
  cancelRaf,
  createReasoningBlock,
  estimateReasoningTokensFromText,
  finalizeReasoningBlock,
  markReasoningBlockContent,
  reasoningBlockToolHints,
  reasoningBlockToolRecords,
  resumeReasoningBlockStreaming,
  setReasoningBlockStatusText,
  setReasoningBlockStats,
  setReasoningBlockText,
  setReasoningBlockToolHints,
  upsertReasoningToolRecord,
  type ReasoningToolRecord,
} from "./reasoningBlock.js";
import {
  armLiveOutcomeFade,
  createToolInvocationCard,
  unwrapToolCallBridge,
  type AskUserAnswer,
  type PendingAskSnapshot,
  type ToolCallPart,
} from "./toolCards.js";
import { createDemoConfirmCard } from "./demoCard.js";
import { parseDemoConfirmMessage } from "../../../src/session/demoConfirm.js";
import { uploadLiveFromPayload } from "./uploadCard.js";
import { patchUploadLiveZone } from "./uploadCardView.js";
import {
  buildPlansByCreateToolCallId,
  createPlanCard,
  createPlanToolCard,
} from "./planCards.js";
import type { Message, Session, StreamEvent, ToolResultPart } from "./types.js";
import {
  isConversationCardVisible,
  projectTranscriptMessages,
  pushToolHint,
  toolHintLabel,
} from "../../../src/renderer/src/screens/conversation/turnDisplay.js";
import { isAnimatedProgressText } from "../../../src/renderer/src/screens/conversation/turnProgress.js";
import { ConversationAutoScroll } from "../../../src/renderer/src/ui/ConversationAutoScroll.js";
import { ConversationScrollViewport } from "../../../src/renderer/src/ui/ConversationScrollViewport.js";

export type ChatStreamCallbacks = {
  pendingAsk?: PendingAskSnapshot | null;
  onAnswerAsk?: (requestId: string, answer: AskUserAnswer) => void;
  demoSettledByCallId?: Map<string, DemoSettled> | null;
  demoOpenCallId?: string | null;
  demoStates?: Map<string, DemoCardState>;
  onSubmitDemoParams?: (
    toolCallId: string,
    values: Record<string, string | number | boolean | null>,
    note?: string,
  ) => void | Promise<void | DemoSubmitReceipt>;
};


const REASONING_MIN_PAINT_MS = 100;
const REASONING_MAX_PAINT_MS = 280;
const REASONING_TAIL_CHARS = 12_000;
const REASONING_META_TICK_MS = 250;
const SCROLL_BOTTOM_EASE = 0.22;
const SCROLL_BOTTOM_SNAP_PX = 2;

function userMessageNode(msg: Message): HTMLElement {
  const body = el("div", { class: "conversation-msg-body" });
  let demoConfirm = false;
  for (const part of msg.parts) {
    if (part.type === "text") {
      const parsed = parseDemoConfirmMessage(part.text);
      if (parsed) {
        demoConfirm = true;
        body.append(createDemoConfirmCard(parsed));
        continue;
      }
      body.append(el("div", { class: "message-part-text" }, part.text));
    } else if (part.type === "attachment") {
      body.append(el("div", { class: "chat-attachment-chip" }, icon("file", 12), part.name ?? part.uri));
    }
  }
  const row = el("div", { class: "conversation-msg conversation-msg-user" }, body);
  if (demoConfirm) row.classList.add("is-demo-confirm");
  return row;
}

function hasVisibleContent(node: Element): boolean {
  if (node.classList.contains("conversation-reasoning")) return false;
  if ((node.textContent ?? "").trim()) return true;
  return node.querySelector("img, video, iframe, canvas, svg") !== null;
}

function hasVisibleContentAfter(block: HTMLElement, root: HTMLElement): boolean {
  let node: Element = block;
  while (node !== root) {
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      if (hasVisibleContent(sib)) return true;
    }
    const parent = node.parentElement;
    if (!parent) return true;
    node = parent;
  }
  return false;
}

function markerNode(kind: "compaction" | "clear", summary?: string): HTMLElement {
  if (kind === "clear") {
    return el("div", { class: "chat-marker" }, icon("refresh", 12), "Context cleared — earlier messages kept in history");
  }
  return el("div", { class: "chat-marker" }, icon("fold", 12), summary ? `Context compacted — ${summary}` : "Context compacted");
}

export function renderChatStream(
  session: Session,
  callbacks?: ChatStreamCallbacks,
): HTMLElement {
  const flow = el("div", { class: "conversation-flow" });
  const resultsByCallId = new Map<string, ToolResultPart>();
  const { plansByCreateToolCallId, progressByToolCallId } =
    buildPlansByCreateToolCallId(session.messages, session.plan);
  for (const msg of session.messages) {
    if (msg.role !== "tool") continue;
    for (const part of msg.parts) {
      if (part.type === "tool_result") resultsByCallId.set(part.toolCallId, part);
    }
  }

  const pendingCallId = callbacks?.pendingAsk?.toolCallId;
  const projected = projectTranscriptMessages(session.messages, pendingCallId ? new Set([pendingCallId]) : undefined);
  for (const msg of projected) {
    if (msg.role === "system") continue;
    if (msg.role === "tool") continue;

    if (msg.role === "user") {
      const hasMarker = msg.parts.some((p) => p.type === "context_compaction" || p.type === "context_clear");
      for (const part of msg.parts) {
        if (part.type === "context_compaction") flow.append(markerNode("compaction", part.summary));
        else if (part.type === "context_clear") flow.append(markerNode("clear"));
      }
      if (!hasMarker) flow.append(userMessageNode(msg));
      continue;
    }

    const body = el("div", { class: "conversation-msg-body" });
    let hasContent = false;
    for (const part of msg.parts) {
      switch (part.type) {
        case "reasoning":
          const rawHints = (part as { toolHints?: unknown }).toolHints;
          const toolHints = Array.isArray(rawHints)
            ? rawHints.filter((hint): hint is string => typeof hint === "string")
            : [];
          const rawRecords = (part as { toolRecords?: unknown }).toolRecords;
          const toolRecords: ReasoningToolRecord[] = [];
          if (Array.isArray(rawRecords)) {
            for (const item of rawRecords) {
              if (item === null || typeof item !== "object") continue;
              const record = item as Record<string, unknown>;
              if (typeof record.hint !== "string" || !record.hint) continue;
              toolRecords.push({
                id: typeof record.id === "string" ? record.id : record.hint,
                hint: record.hint,
                ...(typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
                  ? { durationMs: record.durationMs }
                  : {}),
                ...(record.failed === true ? { failed: true } : {}),
              });
            }
          }
          if (!part.text.trim() && toolHints.length === 0 && toolRecords.length === 0) break;
          const block = createReasoningBlock({
            text: part.text,
            mode: "collapsed",
            toolHints,
            ...(toolRecords.length > 0 ? { toolRecords } : {}),
          });
          if (part.id === "turn-reasoning") block.dataset.turnReasoning = "1";
          const durationMs = (part as { durationMs?: unknown }).durationMs;
          if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
            block.dataset.durationMs = String(Math.round(durationMs));
          }
          body.append(block);
          hasContent = true;
          break;
        case "text": {
          if (!part.text.trim()) break;
          const md = el("div", { class: "message-part-text" });
          renderMarkdownBlocks(parseMarkdownBlocks(part.text), md);
          body.append(md);
          hasContent = true;
          break;
        }
        case "tool_call": {
          const bridged = unwrapToolCallBridge(part.name, part.arguments);
          if (!isConversationCardVisible(bridged.name, bridged.arguments, part.id === pendingCallId)) break;
          const toolPart = bridged.name === part.name
            ? part
            : ({ ...part, name: bridged.name, arguments: bridged.arguments } as typeof part);
          if (toolPart.name === "create_plan") {
            const plan = plansByCreateToolCallId.get(toolPart.id);
            if (plan) {
              body.append(createPlanCard(plan));
              hasContent = true;
              break;
            }
          } else if (toolPart.name === "update_plan" || toolPart.name === "complete_plan") {
            const progress = progressByToolCallId.get(toolPart.id);
            if (progress) {
              body.append(createPlanToolCard(toolPart, progress));
              hasContent = true;
              break;
            }
          }
          body.append(createToolInvocationCard(toolPart, resultsByCallId.get(toolPart.id), callbacks));
          hasContent = true;
          break;
        }
        case "attachment":
          body.append(el("div", { class: "chat-attachment-chip" }, icon("file", 12), part.name ?? part.uri));
          hasContent = true;
          break;
        default:
          break;
      }
    }
    if (!hasContent) continue;
    flow.append(el("div", { class: "conversation-msg conversation-msg-assistant" }, body));
  }
  return flow;
}

export class ChatLiveStream {
  private body: HTMLElement | null = null;
  private textHost: HTMLElement | null = null;
  private textBuffer = "";

  private thoughtPinned = false;
  private reasoningBuffer = "";
  private reasoningJoinPending = false;
  private reasoningEl: HTMLElement | null = null;
  private reasoningStartedAt = 0;
  private reasoningPaintTimer: number | null = null;
  private reasoningPaintRafId: number | null = null;
  private reasoningPaintQueued = false;
  private lastReasoningPaintAt = 0;
  private reasoningBodyScrollRafId: number | null = null;
  private reasoningMetaTimer: number | null = null;
  private renderTimer: number | null = null;
  private hasAppendedToolCard = false;

  private callbacks: ChatStreamCallbacks | null = null;

  readonly autoScroll: ConversationAutoScroll;
  private scrollViewport: ConversationScrollViewport | null = null;

  constructor(private flow: HTMLElement, scroller: HTMLElement, following = true, onScrollChange?: () => void) {
    this.autoScroll = new ConversationAutoScroll(scroller, flow, onScrollChange, following);
  }

  attachComposerViewport(scroller: HTMLElement, composer: HTMLElement): void {
    this.scrollViewport?.destroy();
    this.scrollViewport = new ConversationScrollViewport(scroller, this.flow, composer, () => {
      this.autoScroll.snapIfFollowing();
      this.autoScroll.contentChanged();
    });
  }

  shouldShowScrollBottomButton(): boolean {
    return this.scrollViewport?.shouldShowButton(this.autoScroll.following) ?? false;
  }

  destroy(): void {
    this.scrollViewport?.destroy();
    this.scrollViewport = null;
    this.autoScroll.destroy();
    this.resetReasoningState();
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  setCallbacks(callbacks: ChatStreamCallbacks | null): void {
    this.callbacks = callbacks;
  }

  attachPendingAsk(ask: PendingAskSnapshot): boolean {
    const card = this.flow.querySelector<HTMLElement>(
      `.content-card-tool-invocation[data-tool-call-id="${ask.toolCallId.replace(/["\\]/g, "\\$&")}"]`,
    );
    if (!card) return false;
    const part: ToolCallPart = {
      type: "tool_call",
      id: ask.toolCallId,
      name: card.dataset.toolName ?? "ask_user",
      status: "running",
      arguments: {},
      argumentsRaw: "",
    };
    const fresh = createToolInvocationCard(part, undefined, {
      pendingAsk: ask,
      onAnswerAsk: this.callbacks?.onAnswerAsk,
    });
    if (fresh.tagName === "DETAILS") (fresh as HTMLDetailsElement).open = true;
    card.replaceWith(fresh);
    this.scroll();
    return true;
  }

  private ensure(): void {
    if (this.body) return;
    this.body = el("div", { class: "conversation-msg conversation-msg-assistant" });
    const body = el("div", { class: "conversation-msg-body" });
    this.body.append(body);
    this.textHost = el("div", { class: "message-part-text" });
    this.flow.append(this.body);
    this.body = body;
    this.body.append(this.textHost);
  }

  apply(event: StreamEvent): void {
    switch (event.type) {
      case "reasoning_delta": {
        if (event.text.length === 0) break;
        const block = this.beginThought();
        if (this.reasoningJoinPending) {
          this.reasoningJoinPending = false;
          this.reasoningBuffer += "\n\n";
        }
        this.reasoningBuffer += event.text;
        if (this.reasoningBuffer.trim()) markReasoningBlockContent(block);
        if (this.reasoningEl?.classList.contains("is-open")) {
          this.scheduleReasoningPaint();
        }
        break;
      }
      case "text_delta": {
        this.appendRevealedText(event.text);
        break;
      }
      case "tool_call": {
        this.foldHeldText();
        const bridged = unwrapToolCallBridge(event.name, event.arguments);
        const hint = toolHintLabel(event.name, event.arguments);
        if (hint) this.noteToolHint(hint);
        if (hint && typeof event.id === "string" && event.id) {
          this.noteToolRecord({ id: event.id, hint });
        }
        if (!isConversationCardVisible(bridged.name, bridged.arguments)) break;
        this.ensure();
        this.hasAppendedToolCard = true;
        this.body!.append(createToolInvocationCard({
          type: "tool_call",
          id: event.id,
          name: bridged.name,
          status: "running",
          arguments: (bridged.arguments ?? {}) as ToolCallPart["arguments"],
          argumentsRaw: event.argumentsRaw ?? "",
        }, undefined, this.callbacks ?? undefined));
        this.settleThought();
        this.scroll();
        break;
      }
      case "tool_live": {
        if (event.kind === "upload" && typeof event.toolCallId === "string") {
          const zone = this.flow.querySelector<HTMLElement>(
            `.content-card-tool-invocation[data-tool-call-id="${event.toolCallId.replace(/["\\]/g, "\\$&")}"] .content-card-tool-upload-zone`,
          );
          const state = zone ? uploadLiveFromPayload(event.payload) : null;
          if (zone && state) patchUploadLiveZone(zone, state);
        }
        break;
      }
      case "error": {
        this.ensure();
        this.body!.append(el("div", { class: "chat-error-line" }, icon("warn", 13), event.message));
        this.scroll();
        break;
      }
      default:
        break;
    }
  }

  private beginThought(): HTMLElement {
    const block = this.ensureTurnReasoningBlock({ pinToBottom: true });
    setReasoningBlockStatusText(block, "");
    if (!this.reasoningStartedAt) this.reasoningStartedAt = Date.now();
    this.ensureReasoningMetaTicker();
    return block;
  }

  private ensureTurnReasoningBlock(options?: { pinToBottom?: boolean }): HTMLElement {
    if (this.thoughtPinned && this.reasoningEl) {
      this.finalizeReasoning();
      this.resetReasoningState();
    }
    this.thoughtPinned = false;
    const detached = !this.reasoningEl || !this.reasoningEl.isConnected;
    if (detached) {
      this.reasoningBuffer = "";
      this.reasoningEl = null;
      if (!this.body) this.adoptTrailingThought();
    }
    this.ensure();
    if (!this.reasoningEl) {
      const block = createReasoningBlock({ text: "", mode: "streaming" });
      block.dataset.turnReasoning = "1";
      this.bindLiveToggle(block);
      this.reasoningEl = block;
      this.body!.append(block);
      this.settleThought(options?.pinToBottom === true);
      this.scroll();
    } else if (this.reasoningEl.dataset.mode !== "streaming") {
      resumeReasoningBlockStreaming(this.reasoningEl, this.currentReasoningStats());
      this.settleThought(options?.pinToBottom === true);
    }
    return this.reasoningEl;
  }

  private bindLiveToggle(block: HTMLElement): void {
    if (block.dataset.liveToggle === "1") return;
    block.dataset.liveToggle = "1";
    block
      .querySelector(".conversation-reasoning-toggle")
      ?.addEventListener("click", () => {
        if (
          this.reasoningEl === block &&
          block.classList.contains("is-open") &&
          block.dataset.mode === "streaming"
        ) {
          this.flushReasoningPaint();
        }
      });
  }

  private adoptTrailingThought(): void {
    const blocks = this.flow.querySelectorAll<HTMLElement>(
      ".conversation-reasoning[data-turn-reasoning='1']",
    );
    const block = blocks[blocks.length - 1];
    if (!block || hasVisibleContentAfter(block, this.flow)) return;
    const body = block.closest<HTMLElement>(".conversation-msg-body");
    if (!body || !this.flow.contains(body)) return;
    this.body = body;
    this.textHost = null;
    this.textBuffer = "";
    this.bindLiveToggle(block);
    this.reasoningEl = block;
    const seeded = block.querySelector<HTMLElement>(".conversation-reasoning-cot")?.textContent ?? "";
    this.reasoningBuffer = seeded.trim() ? seeded : "";
    this.reasoningJoinPending = this.reasoningBuffer.length > 0;
    const priorMs = Number(block.dataset.durationMs);
    this.reasoningStartedAt = Date.now() - (Number.isFinite(priorMs) && priorMs > 0 ? priorMs : 0);
  }

  setStatusLine(text: string, show: boolean): void {
    const trimmed = text.trim();
    if (!show || !trimmed) {
      this.removeEmptyStatusRow();
      return;
    }
    const block = this.ensureTurnReasoningBlock({ pinToBottom: true });
    setReasoningBlockStatusText(block, trimmed, {
      animated: isAnimatedProgressText(trimmed),
    });
    this.scroll();
  }

  private isEmptyStatusRow(block: HTMLElement): boolean {
    if (this.reasoningBuffer.trim()) return false;
    if (reasoningBlockToolHints(block).length > 0) return false;
    if (reasoningBlockToolRecords(block).length > 0) return false;
    const body = block.querySelector<HTMLElement>(".conversation-reasoning-body");
    return !body?.textContent?.trim();
  }

  private removeEmptyStatusRow(): void {
    const block = this.reasoningEl;
    if (!block || !block.isConnected || block.dataset.mode !== "streaming") return;
    if (!this.isEmptyStatusRow(block)) return;
    block.remove();
    this.resetReasoningState();
  }

  private settleThought(pinToBottom = false): void {
    const block = this.reasoningEl;
    const body = this.body;
    if (this.thoughtPinned || !block || !body || !block.isConnected) return;
    if (!pinToBottom && this.isEmptyStatusRow(block)) return;
    if (body.lastElementChild !== block) body.append(block);
  }

  private noteToolHint(hint: string): void {
    const block = this.beginThought();
    const hints = reasoningBlockToolHints(block);
    pushToolHint(hints, hint);
    setReasoningBlockToolHints(block, hints);
  }

  private noteToolRecord(record: ReasoningToolRecord): void {
    const blocks = [
      ...this.flow.querySelectorAll<HTMLElement>(".conversation-reasoning"),
    ].reverse();
    for (const block of blocks) {
      if (reasoningBlockToolRecords(block).some((item) => item.id === record.id)) {
        upsertReasoningToolRecord(block, record);
        return;
      }
    }
    const current = this.beginThought();
    upsertReasoningToolRecord(current, record);
  }

  private foldHeldText(): void {
    this.flushText();
  }

  private appendRevealedText(text: string): void {
    if (!this.thoughtPinned && !text.trim()) return;
    this.finalizeReasoning();
    this.ensure();
    this.thoughtPinned = true;
    if (!this.textHost) {
      this.textHost = el("div", { class: "message-part-text" });
      this.textBuffer = "";
      this.body!.append(this.textHost);
    } else if (this.body!.lastElementChild !== this.textHost) {
      this.flushText();
      this.textHost = el("div", { class: "message-part-text" });
      this.textBuffer = "";
      this.body!.append(this.textHost);
    }
    this.textBuffer += text;
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (!this.textHost) return;
      const md = el("div", { class: "message-part-text" });
      renderMarkdownBlocks(parseMarkdownBlocks(this.textBuffer), md);
      this.textHost!.replaceChildren(...md.childNodes);
      this.scroll();
    }, 180);
  }

  reset(): void {
    this.finalizeReasoning();
    this.reasoningEl = null;
    this.reasoningBuffer = "";
    this.body = null;
    this.textHost = null;
    this.textBuffer = "";
    this.thoughtPinned = false;
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.hasAppendedToolCard = false;
  }

  finish(): void {
    this.finalizeReasoning();
    this.flushText();
    this.scroll();
  }

  private resetReasoningState(): void {
    this.reasoningBuffer = "";
    this.reasoningJoinPending = false;
    this.reasoningEl = null;
    this.reasoningStartedAt = 0;
    this.reasoningPaintQueued = false;
    if (this.reasoningPaintTimer !== null) {
      window.clearTimeout(this.reasoningPaintTimer);
      this.reasoningPaintTimer = null;
    }
    if (this.reasoningPaintRafId !== null) {
      cancelRaf(this.reasoningPaintRafId);
      this.reasoningPaintRafId = null;
    }
    if (this.reasoningBodyScrollRafId !== null) {
      cancelRaf(this.reasoningBodyScrollRafId);
      this.reasoningBodyScrollRafId = null;
    }
    if (this.reasoningMetaTimer !== null) {
      window.clearInterval(this.reasoningMetaTimer);
      this.reasoningMetaTimer = null;
    }
  }

  private finalizeReasoning(): void {
    if (!this.reasoningEl) return;
    if (
      this.reasoningBuffer.trim().length === 0 &&
      reasoningBlockToolHints(this.reasoningEl).length === 0
    ) {
      this.reasoningEl.remove();
      this.resetReasoningState();
      return;
    }
    this.flushReasoningPaint({ full: true });
    finalizeReasoningBlock(this.reasoningEl, this.currentReasoningStats());
    if (this.reasoningMetaTimer !== null) {
      window.clearInterval(this.reasoningMetaTimer);
      this.reasoningMetaTimer = null;
    }
  }

  private currentReasoningStats(): { durationMs: number; tokenCount: number } {
    const durationMs =
      this.reasoningStartedAt > 0
        ? Math.max(0, Date.now() - this.reasoningStartedAt)
        : 0;
    return {
      durationMs,
      tokenCount: estimateReasoningTokensFromText(this.reasoningBuffer),
    };
  }

  private ensureReasoningMetaTicker(): void {
    if (this.reasoningMetaTimer !== null) return;
    this.reasoningMetaTimer = window.setInterval(() => {
      if (!this.reasoningEl || this.reasoningEl.dataset.mode !== "streaming") return;
      setReasoningBlockStats(this.reasoningEl, this.currentReasoningStats());
    }, REASONING_META_TICK_MS) as unknown as number;
  }

  private reasoningPaintIntervalMs(): number {
    return Math.min(
      REASONING_MAX_PAINT_MS,
      REASONING_MIN_PAINT_MS + Math.floor(this.reasoningBuffer.length / 400),
    );
  }

  private scheduleReasoningPaint(): void {
    if (this.reasoningPaintTimer !== null || this.reasoningPaintRafId !== null) {
      this.reasoningPaintQueued = true;
      return;
    }
    const elapsed = Date.now() - this.lastReasoningPaintAt;
    const delay = Math.max(0, this.reasoningPaintIntervalMs() - elapsed);
    this.reasoningPaintTimer = window.setTimeout(() => {
      this.reasoningPaintTimer = null;
      this.reasoningPaintRafId = requestRaf(() => {
        this.reasoningPaintRafId = null;
        this.flushReasoningPaint();
        if (this.reasoningPaintQueued) {
          this.reasoningPaintQueued = false;
          this.scheduleReasoningPaint();
        }
      });
    }, delay) as unknown as number;
  }

  private flushReasoningPaint(options?: { full?: boolean }): void {
    const block = this.reasoningEl;
    if (!block) return;
    this.lastReasoningPaintAt = Date.now();
    const full = Boolean(options?.full);
    const open = block.classList.contains("is-open");
    if (full || open) {
      const text = this.reasoningBuffer;
      const display =
        !full && text.length > REASONING_TAIL_CHARS
          ? `…\n${text.slice(-REASONING_TAIL_CHARS)}`
          : text;
      setReasoningBlockText(block, display);
      if (open && !full) this.ensureSmoothReasoningBodyScroll(block);
    }
    setReasoningBlockStats(block, this.currentReasoningStats());
  }

  private ensureSmoothReasoningBodyScroll(block: HTMLElement): void {
    if (this.reasoningBodyScrollRafId !== null) return;
    this.reasoningBodyScrollRafId = requestRaf(() => {
      this.reasoningBodyScrollRafId = null;
      this.tickSmoothReasoningBodyScroll(block);
    });
  }

  private tickSmoothReasoningBodyScroll(block: HTMLElement): void {
    if (!this.autoScroll.following) return;
    if (block.dataset.mode !== "streaming") return;
    if (!block.classList.contains("is-open")) return;
    if (this.reasoningEl !== block) return;

    const body = block.querySelector<HTMLElement>(".conversation-reasoning-body");
    if (!body) return;

    const target = Math.max(0, body.scrollHeight - body.clientHeight);
    const current = body.scrollTop;
    const remaining = target - current;

    if (remaining <= SCROLL_BOTTOM_SNAP_PX) {
      body.scrollTop = target;
      return;
    }

    body.scrollTop = current + remaining * SCROLL_BOTTOM_EASE;
    this.ensureSmoothReasoningBodyScroll(block);
  }

  private flushText(): void {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (!this.textHost) return;
    const md = el("div", { class: "message-part-text" });
    renderMarkdownBlocks(parseMarkdownBlocks(this.textBuffer), md);
    this.textHost.replaceChildren(...md.childNodes);
  }

  refreshToolCards(session: Session): void {
    const resultsByCallId = new Map<string, ToolResultPart>();
    const partsByCallId = new Map<string, ToolCallPart>();
    for (const msg of session.messages) {
      if (msg.role === "tool") {
        for (const part of msg.parts) {
          if (part.type === "tool_result") resultsByCallId.set(part.toolCallId, part);
        }
      } else if (msg.role === "assistant") {
        for (const part of msg.parts) {
          if (part.type === "tool_call") partsByCallId.set(part.id, part);
        }
      }
    }
    const cards = this.flow.querySelectorAll<HTMLElement>(
      ".content-card-tool-invocation[data-tool-call-id]",
    );
    cards.forEach((card) => {
      const id = card.dataset.toolCallId ?? "";
      const part = partsByCallId.get(id);
      if (!part) return;
      const result = resultsByCallId.get(id);
      if (!result && part.status === "running") return;
      const wasRunning = card.querySelector(".content-card-tool-outcome") === null;
      const wasOpen = card.tagName === "DETAILS" && (card as HTMLDetailsElement).open === true;
      const fresh = createToolInvocationCard(part, result, this.callbacks ?? undefined);
      const patchFailed = unwrapToolCallBridge(part.name, part.arguments).name === "patch" &&
        result !== undefined && result.returnCode !== 0;
      if (wasOpen && fresh.tagName === "DETAILS" && !(wasRunning && patchFailed)) {
        (fresh as HTMLDetailsElement).open = true;
        const view = fresh.ownerDocument?.defaultView;
        fresh.dispatchEvent(new (view?.Event ?? Event)("toggle"));
      }
      if (wasRunning) armLiveOutcomeFade(fresh);
      else {
        const held = card.querySelector<HTMLElement>(
          ".content-card-tool-outcome.is-ok:not(.is-dormant):not(.is-faded)",
        );
        const dormant = fresh.querySelector<HTMLElement>(
          ".content-card-tool-outcome.is-ok",
        );
        if (held && dormant) dormant.replaceWith(held);
      }
      card.replaceWith(fresh);
    });
    this.scroll();
  }

  private scroll(): void {
    this.autoScroll.contentChanged();
  }
}
