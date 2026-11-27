const FADE_EDGE_PX = 2;
const TOP_CLASS = "is-fade-top";
const BOTTOM_CLASS = "is-fade-bottom";

function requestFrame(callback: () => void): number {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : (setTimeout(callback, 16) as unknown as number);
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id);
}

export function syncScrollFade(scroller: HTMLElement): void {
  const remaining =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  scroller.classList.toggle(TOP_CLASS, scroller.scrollTop > FADE_EDGE_PX);
  scroller.classList.toggle(BOTTOM_CLASS, remaining > FADE_EDGE_PX);
}

export function bindScrollFade(scroller: HTMLElement): () => void {
  let frame = 0;

  const sync = (): void => {
    if (frame) return;
    frame = requestFrame(() => {
      frame = 0;
      syncScrollFade(scroller);
    });
  };

  const resize =
    typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
  const observeContent = (): void => {
    if (!resize) return;
    resize.disconnect();
    resize.observe(scroller);
    for (const child of Array.from(scroller.children)) resize.observe(child);
  };
  observeContent();

  const mutations =
    typeof MutationObserver === "function"
      ? new MutationObserver(() => {
          observeContent();
          sync();
        })
      : null;
  mutations?.observe(scroller, { childList: true, subtree: true });

  scroller.addEventListener("scroll", sync, { passive: true });
  syncScrollFade(scroller);

  return () => {
    if (frame) cancelFrame(frame);
    frame = 0;
    scroller.removeEventListener("scroll", sync);
    resize?.disconnect();
    mutations?.disconnect();
    scroller.classList.remove(TOP_CLASS, BOTTOM_CLASS);
  };
}
