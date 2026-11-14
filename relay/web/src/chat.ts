import type { DemoCardState, DemoSettled, DemoSubmitReceipt } from "../../../src/session/demoCardState.js";
/**
 * Chat stream rendering — Mac-parity port of the desktop conversation view
 * (conversation.css + content-cards family). Class names intentionally match
 * the main project so future style changes port by copy-paste.
 */
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

// ── tool display meta (compact port of cards/toolDisplay.ts) ───────────
// (moved to toolCards.ts)

// ── reasoning ──────────────────────────────────────────────────────────
// Live-block paint throttling — desktop ConversationView parity. Body DOM
// writes are skipped entirely while the streaming block is collapsed; the
// expanded body only ever paints the live tail.
const REASONING_MIN_PAINT_MS = 100;
const REASONING_MAX_PAINT_MS = 280;
const REASONING_TAIL_CHARS = 12_000;
const REASONING_META_TICK_MS = 250;
/** Eased body-scroll chase while CoT streams into an expanded block. */
const SCROLL_BOTTOM_EASE = 0.22;
const SCROLL_BOTTOM_SNAP_PX = 2;

// ── message rows ───────────────────────────────────────────────────────
function userMessageNode(msg: Message): HTMLElement {
  const body = el("div", { class: "conversation-msg-body" });
  let demoConfirm = false;
  for (const part of msg.parts) {
    if (part.type === "text") {
      // D7 confirm marker → compact summary card (plan §4); the marker
      // text never renders as raw prose.
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

function markerNode(kind: "compaction" | "clear", summary?: string): HTMLElement {
  if (kind === "clear") {
    return el("div", { class: "chat-marker" }, icon("refresh", 12), "Context cleared — earlier messages kept in history");
  }
  return el("div", { class: "chat-marker" }, icon("fold", 12), summary ? `Context compacted — ${summary}` : "Context compacted");
}

/**
 * Group a session's messages into chat rows: user bubbles, assistant turns
 * (reasoning + markdown + tool cards) and marker lines. Tool results are
 * joined to their tool_call by id.
 */
export function renderChatStream(
  session: Session,
  callbacks?: ChatStreamCallbacks,
): HTMLElement {
  const flow = el("div", { class: "conversation-flow" });
  const resultsByCallId = new Map<string, ToolResultPart>();
  // Rebuild plan snapshots with the same logic the Mac conversation view
  // uses, overlaying the live session.plan when present.
  const { plansByCreateToolCallId, progressByToolCallId } =
    buildPlansByCreateToolCallId(session.messages, session.plan);
  for (const msg of session.messages) {
    if (msg.role !== "tool") continue;
    for (const part of msg.parts) {
      if (part.type === "tool_result") resultsByCallId.set(part.toolCallId, part);
    }
  }

  const projected = projectTranscriptMessages(session.messages);
  for (const msg of projected) {
    if (msg.role === "system") continue;
    if (msg.role === "tool") continue; // results rendered inside call cards

    if (msg.role === "user") {
      const hasMarker = msg.parts.some((p) => p.type === "context_compaction" || p.type === "context_clear");
      for (const part of msg.parts) {
        if (part.type === "context_compaction") flow.append(markerNode("compaction", part.summary));
        else if (part.type === "context_clear") flow.append(markerNode("clear"));
      }
      if (!hasMarker) flow.append(userMessageNode(msg));
      continue;
    }

    // assistant
    const body = el("div", { class: "conversation-msg-body" });
    let hasContent = false;
    for (const part of msg.parts) {
      switch (part.type) {
        case "reasoning":
          // Empty reasoning parts (providers emit them at tool-call turn
          // openings) never render — Mac MessageView `part.text.trim()` parity.
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
          // Deferred tool_call bridge: hidden-check and render by the INNER
          // tool name (Mac MessageView parity) — the wrapper name "tool_call"
          // is commonly hidden via toolDisplayOverrides, which must not hide
          // the wrapped upload_files / create_plan / … cards.
          const bridged = unwrapToolCallBridge(part.name, part.arguments);
          if (!isConversationCardVisible(bridged.name, bridged.arguments)) break;
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

// ── live stream (Mac-style classes, debounced markdown re-render) ─────
export class ChatLiveStream {
  private body: HTMLElement | null = null;
  private textHost: HTMLElement | null = null;
  private textBuffer = "";
  /** Short streamed text not yet painted (may still fold into Thinking). */

  /** Reply text painted below Thinking since it last thought: the next thought opens a new block. */
  private thoughtPinned = false;
  private reasoningBuffer = "";
  private reasoningEl: HTMLElement | null = null;
  private reasoningStartedAt = 0;
  private reasoningPaintTimer: number | null = null;
  private reasoningPaintRafId: number | null = null;
  private reasoningPaintQueued = false;
  private lastReasoningPaintAt = 0;
  private reasoningBodyScrollRafId: number | null = null;
  private reasoningMetaTimer: number | null = null;
  private renderTimer: number | null = null;
  /** Set once a live tool card was appended — reasoning after it opens new blocks. */
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

  /** Live cards reuse the same rich-card pipeline (ask panels etc.). */
  setCallbacks(callbacks: ChatStreamCallbacks | null): void {
    this.callbacks = callbacks;
  }

  /**
   * Mount the interactive ask panel onto the running ask_user /
   * request_full_permissions card (user_ask event). Returns false when the
   * card has not streamed into this flow yet — caller falls back to a
   * snapshot reload.
   */
  attachPendingAsk(ask: PendingAskSnapshot): boolean {
    const card = this.flow.querySelector<HTMLElement>(
      `.content-card-tool-invocation[data-tool-call-id="${ask.toolCallId.replace(/["\\]/g, "\\$&")}"]`,
    );
    // Rebuild the card through the same pipeline that renders finished
    // cards (refreshToolCards style) — no hand-patched classes/status text
    // drifting out of sync with createToolInvocationCard's ask branch.
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
        // Mac ephemeral Thinking parity: streaming block starts COLLAPSED
        // (spinner + "Thinking · Xs · ~N tokens"); the body only paints
        // when the user expands it (live tail) or on finalize (full text).
        // Providers (GLM / kimi) open tool-call turns with an EMPTY
        // reasoning chunk — never materialize a block for it (Mac rebuilds
        // history without empty reasoning parts; web keeps live DOM).
        if (event.text.length === 0) break;
        const block = this.beginThought();
        this.reasoningBuffer += event.text;
        // Only real CoT makes the row expandable before the lazy paint fills
        // the body (desktop parity) — a hidden-tool record alone never does
        // (it is invisible while streaming), and whitespace-only streams
        // never mark.
        if (this.reasoningBuffer.trim()) markReasoningBlockContent(block);
        if (this.reasoningEl?.classList.contains("is-open")) {
          this.scheduleReasoningPaint();
        }
        break;
      }
      case "text_delta": {
        // Reply text paints immediately — never held or folded into
        // Thinking (desktop parity).
        this.appendRevealedText(event.text);
        break;
      }
      case "tool_call": {
        this.foldHeldText();
        const bridged = unwrapToolCallBridge(event.name, event.arguments);
        const hint = toolHintLabel(event.name, event.arguments);
        if (hint) this.noteToolHint(hint);
        // Hidden tool: open its record row (duration/status re-stamped when
        // the snapshot rebuild lands — desktop parity).
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
        // Mid-execution live payload (rsync upload progress streamed by the
        // upload_files handler). Pure UI patching on the running card's
        // progress zone — never a structural change (Mac parity).
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

  /**
   * Find or open the current Thinking block in live (spinner) mode. Reply
   * text painted below the block closes it; thinking after that opens a new
   * block under the text (desktop parity).
   */
  private beginThought(): HTMLElement {
    const block = this.ensureTurnReasoningBlock({ pinToBottom: true });
    // First real content (CoT delta / tool hint) reached the row: the title
    // stops mirroring the turn progress and settles on "Thinking…".
    setReasoningBlockStatusText(block, "");
    if (!this.reasoningStartedAt) this.reasoningStartedAt = Date.now();
    this.ensureReasoningMetaTicker();
    return block;
  }

  /**
   * Materialize the live Thinking block if needed, without seeding CoT
   * state — the status line uses this to pin the "next block" at the bottom
   * before any reasoning arrives (desktop B-plan parity).
   */
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
    }
    this.ensure();
    if (!this.reasoningEl) {
      const block = createReasoningBlock({ text: "", mode: "streaming" });
      block.dataset.turnReasoning = "1";
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

  /**
   * Turn status line on the live Thinking block's title — the retired
   * composer-top-right status row, relocated onto the block (desktop
   * parity). The block materializes early (turn submit) and carries the
   * progress text until its first reasoning delta arrives. Hide/empty drops
   * a row that never received content.
   */
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

  /** True when the live block carries nothing but its status title. */
  private isEmptyStatusRow(block: HTMLElement): boolean {
    if (this.reasoningBuffer.trim()) return false; // live CoT owns this block
    if (reasoningBlockToolHints(block).length > 0) return false;
    if (reasoningBlockToolRecords(block).length > 0) return false;
    const body = block.querySelector<HTMLElement>(".conversation-reasoning-body");
    return !body?.textContent?.trim();
  }

  /** Drop a status row that never received CoT/tool hints (turn end / hide). */
  private removeEmptyStatusRow(): void {
    const block = this.reasoningEl;
    if (!block || !block.isConnected || block.dataset.mode !== "streaming") return;
    if (!this.isEmptyStatusRow(block)) return;
    block.remove();
    this.resetReasoningState();
  }

  /**
   * Keep the live Thinking block below the newest cards while the turn is
   * thinking. Once reply text paints below it, it stays put (desktop
   * parity). Moves only when out of place.
   */
  private settleThought(pinToBottom = false): void {
    const block = this.reasoningEl;
    const body = this.body;
    if (this.thoughtPinned || !block || !body || !block.isConnected) return;
    // Pure status row: the card lands under the live status line and the
    // line only moves to the bottom on the next thinking / status update
    // (pinToBottom) — writing a file keeps the status where it was.
    if (!pinToBottom && this.isEmptyStatusRow(block)) return;
    if (body.lastElementChild !== block) body.append(block);
  }

  private noteToolHint(hint: string): void {
    const block = this.beginThought();
    const hints = reasoningBlockToolHints(block);
    pushToolHint(hints, hint);
    setReasoningBlockToolHints(block, hints);
  }

  /** Track one hidden-tool call for the Thought's expandable record. */
  private noteToolRecord(record: ReasoningToolRecord): void {
    // Find the block that already owns this call id (slow calls may outlive
    // their segment); default to the current Thinking block.
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

  /** End the text segment: shown text stays; a later segment opens a new host. */
  private foldHeldText(): void {
    this.flushText();
  }

  private appendRevealedText(text: string): void {
    // The answer started — collapse the live Thinking block to Thought
    // (Mac appendStreamingText parity).
    this.finalizeReasoning();
    this.ensure();
    this.thoughtPinned = true;
    if (!this.textHost) {
      this.textHost = el("div", { class: "message-part-text" });
      this.textBuffer = "";
      this.body!.append(this.textHost);
    } else if (this.body!.lastElementChild !== this.textHost) {
      // A Thinking block or tool card landed after this host's segment.
      // Flush the pending 180ms render into the OLD host and open a fresh
      // one below the interruption — the already-presented text stays in
      // place.
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
      // Render in a throwaway node to keep the caret appending cheap.
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

  /**
   * Turn ended — collapse any live Thinking block and paint the final
   * buffered text at once (Mac finalizeTurn parity). The snapshot rebuild
   * that follows is authoritative; this only keeps the window honest.
   */
  finish(): void {
    this.finalizeReasoning();
    this.flushText();
    this.scroll();
  }

  // ── streaming reasoning (ConversationView parity) ────────────────────
  private resetReasoningState(): void {
    this.reasoningBuffer = "";
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

  /** Collapse the live Thinking block to Thought with its final stats. */
  private finalizeReasoning(): void {
    if (!this.reasoningEl) return;
    if (
      this.reasoningBuffer.trim().length === 0 &&
      reasoningBlockToolHints(this.reasoningEl).length === 0
    ) {
      // Whitespace-only CoT and no tool hints: no Thought card — drop the
      // block entirely (Mac history render skips empty reasoning parts).
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
    // ~+1ms per 400 chars, capped — keeps DOM updates sparse on long CoT.
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
    // Collapsed streaming: skip body writes (meta still updates). Paint the
    // full buffer once on finalize, or the live tail when expanded.
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

  /**
   * Keep the expanded Thinking body pinned to its bottom while CoT streams
   * in — the newest reasoning stays visible without touching the outer
   * transcript scroll (Mac ensureSmoothReasoningBodyScroll parity).
   */
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
    // Don't chase while the user has the Thinking body collapsed.
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

    // Same exponential ease-out used for the main transcript chase.
    body.scrollTop = current + remaining * SCROLL_BOTTOM_EASE;
    this.ensureSmoothReasoningBodyScroll(block);
  }

  /** Immediately render the buffered text into the current host (no 180ms wait). */
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

  /**
   * Mac `renderFinishedTool` parity: results never ride the event — the
   * finished card is rebuilt from a fresh session snapshot (real status,
   * return code, output) and swapped in place by toolCallId. Streaming text
   * and reasoning blocks are left untouched.
   */
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
      if (!part) return; // unknown to the snapshot — leave the card alone
      const result = resultsByCallId.get(id);
      if (!result && part.status === "running") return; // still in flight
      // Running card (no outcome badge yet) → just finished: arm the
      // success badge fade. Already-finished cards keep their (dormant or
      // fading) badge untouched so the 3s hold never restarts on refresh.
      const wasRunning = card.querySelector(".content-card-tool-outcome") === null;
      const wasOpen = card.tagName === "DETAILS" && (card as HTMLDetailsElement).open === true;
      const fresh = createToolInvocationCard(part, result, this.callbacks ?? undefined);
      const patchFailed = unwrapToolCallBridge(part.name, part.arguments).name === "patch" &&
        result !== undefined && result.returnCode !== 0;
      // Close the running preview on failure, then preserve later user toggles.
      if (wasOpen && fresh.tagName === "DETAILS" && !(wasRunning && patchFailed)) {
        (fresh as HTMLDetailsElement).open = true;
        // Direct .open writes never fire toggle — demo cards mount their
        // preview iframe off the event. Use the element's own window Event
        // (linkedom's dispatchEvent cannot drive Node's global Event).
        const view = fresh.ownerDocument?.defaultView;
        fresh.dispatchEvent(new (view?.Event ?? Event)("toggle"));
      }
      if (wasRunning) armLiveOutcomeFade(fresh);
      else {
        // A badge mid-hold (armed, not yet faded) survives the rebuild — a
        // fresh dormant badge would cut the 3s hold short. Already-faded
        // marks are equally invisible as fresh dormant ones.
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
