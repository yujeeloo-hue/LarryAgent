const revealTimers = new WeakMap<HTMLElement, number>();

export function staggerReveal(list: HTMLElement, rows: NodeListOf<HTMLElement>): void {
  if (rows.length === 0) return;
  window.clearTimeout(revealTimers.get(list));
  const stepMs = Math.min(28, Math.max(12, 160 / rows.length));
  rows.forEach((row, index) => {
    row.style.setProperty("--reveal-delay", `${Math.round(index * stepMs)}ms`);
  });
  list.classList.remove("is-revealing");
  void list.offsetWidth;
  list.classList.add("is-revealing");
  revealTimers.set(
    list,
    window.setTimeout(
      () => {
        revealTimers.delete(list);
        list.classList.remove("is-revealing");
        rows.forEach((row) => row.style.removeProperty("--reveal-delay"));
      },
      Math.round(rows.length * stepMs) + 320,
    ),
  );
}
