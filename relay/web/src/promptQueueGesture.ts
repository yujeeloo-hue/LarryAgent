
export type ComposerSubmitContext = {
  hasContent: boolean;
  running: boolean;
  queueHasDeferred: boolean;
};

export type ComposerSubmitAction =
  | "send"
  | "enqueue"
  | "promote-head"
  | "stop"
  | "noop";

export function resolveComposerSubmitAction(
  context: ComposerSubmitContext,
): ComposerSubmitAction {
  if (!context.running) {
    return context.hasContent ? "send" : "noop";
  }
  if (context.hasContent) return "enqueue";
  return context.queueHasDeferred ? "promote-head" : "stop";
}
