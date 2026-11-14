import { createCocoIcon } from "../../ui/cocoIcon.js";
import { button, el } from "./dom.js";
import "./coco.css";

/** Shared confirmation for the first visit, disabled page, and Settings. */
export function showCocoActivationDialog(options: {
  onEnable: () => Promise<void>;
  owner?: HTMLElement;
  onReviewSettings?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}): () => void {
  const dialog = el("dialog", "coco-activation-dialog");
  dialog.setAttribute("aria-labelledby", "coco-activation-title");
  dialog.setAttribute("aria-describedby", "coco-activation-copy");
  const title = el("h2", "", "Enable CoCo?"); title.id = "coco-activation-title";
  const copy = el("p", "", "Turn your goals into action, with CoCo following through."); copy.id = "coco-activation-copy";
  const benefits = el("div", "coco-activation-benefits");
  ["Plan and carry out work toward your goals", "Check for next steps at startup and follow up on your goals", "Ask you when a decision needs your input"].forEach((text, i) => {
    const row = el("div", "coco-activation-benefit"); row.append(el("span", "", String(i + 1)), document.createTextNode(text)); benefits.append(row);
  });
  const note = el("p", "coco-activation-note", "CoCo uses your current model and tools with Full permissions and consumes model credits. You can turn it off anytime in Settings / CoCo.");
  const error = el("p", "coco-error"); error.setAttribute("role", "alert");
  const actions = el("div", "coco-activation-actions");
  let pending = false;
  const close = (): void => { if (dialog.open) dialog.close(); else dialog.remove(); };
  const cancel = button("Not now", close); cancel.autofocus = true;
  const enable = button("Enable CoCo", () => {
    if (pending) return;
    pending = true; error.textContent = ""; enable.textContent = "Enabling…";
    cancel.disabled = enable.disabled = true;
    if (review) review.disabled = true;
    void options.onEnable().then(close).catch(reason => { error.textContent = String(reason); }).finally(() => {
      pending = false; cancel.disabled = enable.disabled = false; enable.textContent = "Enable CoCo";
      if (review) review.disabled = false;
    });
  }, true);
  const review = options.onReviewSettings ? button("Review settings", () => { close(); options.onReviewSettings?.(); }) : undefined;
  if (review) review.classList.add("coco-activation-link");
  actions.append(cancel, enable);
  dialog.append(createCocoIcon(46, "global", { alwaysAnimate: true }), title, copy, benefits, note, error, actions);
  if (review) dialog.append(review);
  dialog.addEventListener("cancel", event => { if (pending) event.preventDefault(); });
  dialog.addEventListener("click", event => {
    if (pending || event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  const observer = options.owner ? new MutationObserver(() => { if (!options.owner!.isConnected) close(); }) : undefined;
  observer?.observe(document.body, { childList: true, subtree: true });
  dialog.addEventListener("close", () => { observer?.disconnect(); dialog.remove(); options.onClose?.(); }, { once: true });
  document.body.append(dialog); dialog.showModal();
  return close;
}
