import type { TokenHubController } from "./TokenHubController.js";

function rows(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(".th-provider-row")];
}

/** Controller surface the row-reorder machinery needs (Token + MCP hubs). */
export type RowReorderAdapter = {
  getIds(): string[];
  isSaving(): boolean;
  reorder(ids: string[]): Promise<void>;
};

/** Move existing rows only: detail inputs, selection, focus and scroll survive. */
export function syncProviderRows(list: HTMLElement, ids: string[]): void {
  const current = rows(list);
  const byId = new Map(current.map((row) => [row.dataset.providerId, row]));
  if (current.length !== ids.length || ids.some((id) => !byId.has(id))) return;
  if (current.every((row, index) => row.dataset.providerId === ids[index])) return;
  const top = list.scrollTop;
  const active = list.ownerDocument.activeElement as HTMLElement | null;
  const restoreFocus = active && list.contains(active);
  for (const id of ids) list.append(byId.get(id)!);
  if (restoreFocus) active.focus({ preventScroll: true });
  list.scrollTop = top;
}

export function bindProviderReorder(
  list: HTMLElement, status: HTMLElement, controller: TokenHubController,
): void {
  bindRowReorder(list, status, {
    getIds: () => controller.getSnapshot().providers.map((provider) => provider.id),
    isSaving: () => controller.isProviderOrderSaving(),
    reorder: (ids) => controller.reorderProviders(ids),
  });
}

export function bindRowReorder(
  list: HTMLElement, status: HTMLElement, adapter: RowReorderAdapter,
): void {
  let saving = false;
  let dragging = false;
  let suppressClick = false;
  const setStatus = (text: string, failed = false): void => {
    // A selection or external snapshot may have mounted a new rail mid-save.
    const currentList = list.isConnected ? list : list.ownerDocument.querySelector<HTMLElement>(".th-provider-list") ?? list;
    const currentStatus = currentList.closest(".th-rail")?.querySelector<HTMLElement>(".th-order-status") ?? status;
    currentStatus.textContent = text;
    currentStatus.classList.toggle("is-error", failed);
    currentList.setAttribute("aria-busy", String(saving || adapter.isSaving()));
  };
  status.textContent = adapter.isSaving() ? "Saving order…" : "Drag the grip to reorder";
  list.setAttribute("aria-busy", String(adapter.isSaving()));
  const blocked = (): boolean => saving || adapter.isSaving()
    || !!list.closest(".token-hub-body")?.querySelector(".th-detail .th-name-input:disabled");
  const persist = async (): Promise<void> => {
    const ids = rows(list).map((row) => row.dataset.providerId!);
    const original = adapter.getIds();
    if (ids.every((id, index) => id === original[index])) return;
    saving = true;
    setStatus("Saving order…");
    try {
      await adapter.reorder(ids);
      setStatus("Order saved");
    } catch (error) {
      const currentList = list.isConnected ? list : list.ownerDocument.querySelector<HTMLElement>(".th-provider-list") ?? list;
      syncProviderRows(currentList, adapter.getIds());
      setStatus(error instanceof Error ? error.message : "Could not save order. Try again.", true);
    } finally {
      saving = false;
      list.setAttribute("aria-busy", "false");
      list.ownerDocument.querySelector(".th-provider-list")?.setAttribute("aria-busy", "false");
    }
  };
  list.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  list.addEventListener("keydown", (event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const row = (event.target as Element | null)?.closest<HTMLElement>(".th-provider-row");
    if (!row) return;
    event.preventDefault();
    if (dragging || blocked()) return;
    const ordered = rows(list);
    const index = ordered.indexOf(row);
    const next = index + (event.key === "ArrowUp" ? -1 : 1);
    if (next < 0 || next >= ordered.length) return;
    [ordered[index], ordered[next]] = [ordered[next]!, ordered[index]!];
    syncProviderRows(list, ordered.map((item) => item.dataset.providerId!));
    void persist();
  });

  list.addEventListener("pointerdown", (event) => {
    const grip = (event.target as Element | null)?.closest<HTMLElement>(".th-provider-grip");
    const row = grip?.closest<HTMLElement>(".th-provider-row");
    if (!row || !event.isPrimary || event.button !== 0 || dragging || blocked() || rows(list).length < 2) return;
    event.preventDefault();
    dragging = true;
    // Suppress native selection from the initial touch, not only after the
    // movement threshold (iOS also needs the prefixed CSS on this class).
    list.classList.add("is-reordering");
    const original = rows(list).map((item) => item.dataset.providerId!);
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = row.getBoundingClientRect();
    const grabOffset = startY - initial.top;
    let clientY = startY;
    let started = false;
    let ghost: HTMLElement | null = null;
    let frame = 0;
    const finish = (commit: boolean): void => {
      if (!dragging) return;
      dragging = false;
      cancelAnimationFrame(frame);
      ghost?.remove();
      row.classList.remove("is-drag-source");
      list.classList.remove("is-reordering");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
      if (list.hasPointerCapture?.(event.pointerId)) list.releasePointerCapture(event.pointerId);
      if (!started) return;
      suppressClick = true;
      // A drag may produce no click at all; never swallow the next real click.
      setTimeout(() => { suppressClick = false; }, 0);
      if (!commit) syncProviderRows(list, original);
      else void persist();
    };
    const tick = (): void => {
      if (!row.isConnected) { finish(false); return; }
      const bounds = list.getBoundingClientRect();
      const edge = Math.min(36, bounds.height / 4);
      if (clientY < bounds.top + edge) list.scrollTop -= Math.min(12, (bounds.top + edge - clientY) / 3);
      else if (clientY > bounds.bottom - edge) list.scrollTop += Math.min(12, (clientY - bounds.bottom + edge) / 3);
      if (ghost) ghost.style.top = `${clientY - grabOffset}px`;
      const others = rows(list).filter((item) => item !== row);
      const target = others.find((item) => {
        const rect = item.getBoundingClientRect();
        return clientY < rect.top + rect.height / 2;
      });
      const top = list.scrollTop;
      if (row.nextElementSibling !== (target ?? null)) list.insertBefore(row, target ?? null);
      list.scrollTop = top;
      frame = requestAnimationFrame(tick);
    };
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      clientY = next.clientY;
      if (!started && Math.hypot(next.clientX - startX, clientY - startY) >= 4) {
        started = true;
        ghost = row.cloneNode(true) as HTMLElement;
        ghost.classList.add("th-provider-drag-ghost");
        ghost.removeAttribute("role");
        ghost.removeAttribute("id");
        ghost.setAttribute("aria-hidden", "true");
        ghost.style.width = `${initial.width}px`;
        ghost.style.left = `${initial.left}px`;
        ghost.style.top = `${initial.top}px`;
        document.body.append(ghost);
        row.classList.add("is-drag-source");
        frame = requestAnimationFrame(tick);
      }
    };
    const up = (next: PointerEvent): void => { if (next.pointerId === event.pointerId) finish(true); };
    const cancel = (): void => finish(false);
    const key = (next: KeyboardEvent): void => {
      if (next.key !== "Escape") return;
      next.preventDefault();
      next.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    list.setPointerCapture?.(event.pointerId);
  });
}
