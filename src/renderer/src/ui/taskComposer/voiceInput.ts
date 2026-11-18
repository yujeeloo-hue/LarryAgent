import type { TaskComposerView } from "./TaskComposerView.js";
import {
  getComposerVoiceMode,
  setComposerVoiceMode,
  subscribeComposerVoiceMode,
} from "../../state/composerVoiceModeState.js";

function requireBridge(): NonNullable<Window["jellybot"]> {
  const bridge = window.jellybot;
  if (!bridge) {
    throw new Error("JellyBot bridge is unavailable");
  }
  return bridge;
}

function focusedOutsideComposer(composer: TaskComposerView): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active === composer.textarea) return false;
  return (
    active.isContentEditable ||
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  );
}

export type VoiceInputHandle = {
  destroy(): void;
};

export type VoiceInputOptions = {
  composer: TaskComposerView;
  onSubmitText: (text: string, send: () => void) => void;
  syncSendEnabled?: () => void;
};

export function createVoiceInput(options: VoiceInputOptions): VoiceInputHandle {
  if (requireBridge().platform === "win32") {
    return { destroy() {} };
  }
  const { composer, onSubmitText } = options;

  let voiceMode = getComposerVoiceMode();
  let recording = false;
  let stopping = false;
  let programmaticSend = false;
  let pointerRecording = false;

  const send = (): void => {
    programmaticSend = true;
    try {
      composer.sendButton.click();
    } finally {
      programmaticSend = false;
    }
  };

  const applyModeToComposer = (on: boolean): void => {
    composer.setVoiceMode(on);
    if (on) {
      composer.setVoiceStatus(null);
      if (document.activeElement === composer.textarea) {
        composer.textarea.blur();
      }
    } else {
      options.syncSendEnabled?.();
    }
  };

  const setMode = (on: boolean): void => {
    if (voiceMode === on) return;
    voiceMode = on;
    applyModeToComposer(on);
    setComposerVoiceMode(on);
  };

  const failRecording = (message: string): void => {
    recording = false;
    stopping = false;
    composer.setVoiceRecording({ active: false });
    composer.setVoiceStatus({ kind: "error", message });
  };

  const startRecording = (): void => {
    if (recording || stopping) return;
    recording = true;
    composer.setVoiceStatus(null);
    composer.setVoiceRecording({ active: true });
    try {
      void requireBridge()
        .speechStart()
        .catch((err: unknown) => {
          failRecording(
            err instanceof Error ? err.message : "Could not start voice input.",
          );
        });
    } catch (err) {
      failRecording(
        err instanceof Error ? err.message : "Could not start voice input.",
      );
    }
  };

  const stopRecording = (submit: boolean): void => {
    if (!recording || stopping) return;
    stopping = true;
    void (async () => {
      let text = "";
      let failure: string | null = null;
      try {
        const result = await requireBridge().speechStop();
        text = result.text;
      } catch (err) {
        failure = err instanceof Error ? err.message : "Voice input failed.";
      }
      recording = false;
      stopping = false;
      composer.setVoiceRecording({ active: false });
      composer.setVoiceStatus(
        failure ? { kind: "error", message: failure } : null,
      );
      if (submit && !failure && text.trim()) {
        onSubmitText(text, send);
      }
    })();
  };

  const onSpeechEvent = (event: SpeechHelperEvent): void => {
    if (!recording) return;
    switch (event.type) {
      case "waiting":
        composer.setVoiceStatus({ kind: "waiting", message: event.message });
        return;
      case "ready":
        composer.setVoiceStatus(null);
        return;
      case "level":
        composer.setVoiceRecording({ active: true, level: event.value });
        return;
      default:
        return;
    }
  };

  const isModifierPairTap = (event: KeyboardEvent): boolean => {
    if (event.repeat || event.metaKey || event.shiftKey) return false;
    if (event.key === "Alt") return event.ctrlKey;
    if (event.key === "Control") return event.altKey;
    return false;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isModifierPairTap(event)) {
      setMode(!voiceMode);
      return;
    }
    if (
      !voiceMode ||
      event.key.toLowerCase() !== "v" ||
      event.repeat ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing
    ) {
      return;
    }
    if (focusedOutsideComposer(composer)) return;
    event.preventDefault();
    event.stopPropagation();
    startRecording();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!recording) return;
    if (event.key.toLowerCase() !== "v") return;
    stopRecording(true);
  };

  const onBlur = (): void => {
    if (recording) stopRecording(true);
  };

  const onSendCaptureClick = (event: MouseEvent): void => {
    if (!voiceMode || programmaticSend) return;
    if (!recording && composer.isStopMode()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onSendPointerDown = (event: PointerEvent): void => {
    if (!voiceMode || composer.sendButton.disabled) return;
    if (event.button !== 0) return;
    if (!recording && composer.isStopMode()) return;
    event.preventDefault();
    try {
      composer.sendButton.setPointerCapture(event.pointerId);
    } catch {
    }
    pointerRecording = true;
    startRecording();
  };

  const onSendPointerEnd = (): void => {
    if (!pointerRecording) return;
    pointerRecording = false;
    stopRecording(true);
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  composer.sendWrap.addEventListener("click", onSendCaptureClick, true);
  composer.sendButton.addEventListener("pointerdown", onSendPointerDown);
  composer.sendButton.addEventListener("pointerup", onSendPointerEnd);
  composer.sendButton.addEventListener("pointercancel", onSendPointerEnd);
  const unsubscribeSpeech = requireBridge().onSpeechEvent(onSpeechEvent);

  const unsubscribeVoiceMode = subscribeComposerVoiceMode((on) => {
    if (on === voiceMode) return;
    voiceMode = on;
    applyModeToComposer(on);
  });

  if (voiceMode) applyModeToComposer(true);

  return {
    destroy(): void {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      composer.sendWrap.removeEventListener("click", onSendCaptureClick, true);
      composer.sendButton.removeEventListener("pointerdown", onSendPointerDown);
      composer.sendButton.removeEventListener("pointerup", onSendPointerEnd);
      composer.sendButton.removeEventListener("pointercancel", onSendPointerEnd);
      unsubscribeSpeech();
      unsubscribeVoiceMode();
      if (recording) stopRecording(false);
    },
  };
}
