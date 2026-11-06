/**
 * Voice input wiring for the task composer.
 *
 * Keyboard state machine (window-level, capture phase):
 * - Option+Control tap toggles the composer's voice mode (mic button,
 *   collapsed single-line layout). The toggle fires when the second modifier
 *   of the pair goes down while the first is still held — an isolated Option
 *   or Control press never toggles, and other ⌥⌃+letter chords keep working.
 * - While voice mode is on, holding V starts push-to-talk transcription;
 *   releasing V stops it and routes the transcript through the normal send
 *   path (same handlers as the send button). Exiting voice mode mid-recording
 *   does NOT interrupt the take — V release stays the only submit trigger.
 *
 * Speech events stream over the preload bridge (speechStart/speechStop/
 * onSpeechEvent) and only feed the composer's waveform/status UI.
 */
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

/** True when focus sits in an editable area that is not this composer. */
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
  /**
   * Commit a transcript: fill the composer, then call `send()` (a guarded
   * programmatic send-button click that bypasses the mic-click suppression).
   */
  onSubmitText: (text: string, send: () => void) => void;
  /**
   * Restore send/stop enablement after voice mode exits — the controllers
   * own that state (empty composer disables send; voice mode forces the mic
   * face on regardless).
   */
  syncSendEnabled?: () => void;
};

export function createVoiceInput(options: VoiceInputOptions): VoiceInputHandle {
  // Windows v1: voice input is macOS-only — install nothing (no keyboard
  // state machine, no mic strip). The composer never enters voice mode.
  if (requireBridge().platform === "win32") {
    return { destroy() {} };
  }
  const { composer, onSubmitText } = options;

  let voiceMode = getComposerVoiceMode();
  let recording = false;
  /** Stop in flight — blocks a second V press until the final text lands. */
  let stopping = false;
  /** Set only around the programmatic send click (mic-click suppression). */
  let programmaticSend = false;
  /** Mic-button take is live — pointerup/pointercancel ends and sends it. */
  let pointerRecording = false;

  const send = (): void => {
    programmaticSend = true;
    try {
      composer.sendButton.click();
    } finally {
      programmaticSend = false;
    }
  };

  /** Push the mode's visual state onto this composer instance. */
  const applyModeToComposer = (on: boolean): void => {
    composer.setVoiceMode(on);
    if (on) {
      composer.setVoiceStatus(null);
      // The textarea is visually collapsed; drop the invisible caret.
      if (document.activeElement === composer.textarea) {
        composer.textarea.blur();
      }
    } else {
      // The mic face forced the send button on; give the enablement back to
      // the controller's own send/stop logic.
      options.syncSendEnabled?.();
    }
  };

  const setMode = (on: boolean): void => {
    if (voiceMode === on) return;
    voiceMode = on;
    applyModeToComposer(on);
    // App-wide flag: other screens follow it, settings.json persists it.
    // Same-value calls don't broadcast, so our own subscriber never echoes.
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
      // partials/final arrive via the speechStop result; the waveform is the
      // only live readout while recording.
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
    // Let other inputs (ask panels, search, dialogs) keep their keystrokes.
    if (focusedOutsideComposer(composer)) return;
    // Keep "v" out of the composer and ahead of any other key handler.
    event.preventDefault();
    event.stopPropagation();
    startRecording();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    // Deliberately not gated on voiceMode: exiting voice mode mid-take must
    // NOT interrupt the recording — V release stays the only submit trigger.
    if (!recording) return;
    if (event.key.toLowerCase() !== "v") return;
    stopRecording(true);
  };

  const onBlur = (): void => {
    // Window lost focus mid-take: there will be no V keyup — finish the
    // utterance instead of hanging in recording state.
    if (recording) stopRecording(true);
  };

  /** Mic face swallows clicks; the guarded programmatic click passes.
   *  When the button wears the Stop face (turn running), clicks flow
   *  through to the controller's cancel/steer path, same as text mode. */
  const onSendCaptureClick = (event: MouseEvent): void => {
    if (!voiceMode || programmaticSend) return;
    if (!recording && composer.isStopMode()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  /**
   * Mic-button push-to-talk: press and hold to record, release to send.
   * Pointer capture keeps the pointerup on the button even when the cursor
   * slides off mid-take; pointercancel commits what was captured (same as a
   * window blur) instead of dropping the utterance.
   */
  const onSendPointerDown = (event: PointerEvent): void => {
    if (!voiceMode || composer.sendButton.disabled) return;
    if (event.button !== 0) return;
    // Stop face: the button cancels the running turn on click — starting a
    // take here would swallow the stop. Steer takes stay on the V key.
    if (!recording && composer.isStopMode()) return;
    // Keep focus where it is — the take commits on release, not click.
    event.preventDefault();
    try {
      composer.sendButton.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; pointerup on the button still fires.
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

  /** External mode changes (another screen's toggle) land here; own echoes
   *  are same-value and skipped by the global store. */
  const unsubscribeVoiceMode = subscribeComposerVoiceMode((on) => {
    if (on === voiceMode) return;
    voiceMode = on;
    applyModeToComposer(on);
  });

  // Restore the persisted mode onto this freshly wired composer — voice
  // mode survives screen switches and app restarts.
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
      // Finish any live take without submitting — the screen is going away.
      // Voice mode itself is a global persistent flag: it deliberately
      // survives this screen; the next composer restores it on mount.
      if (recording) stopRecording(false);
    },
  };
}
