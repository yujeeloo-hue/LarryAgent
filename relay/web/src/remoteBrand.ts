/** The homepage's short letter scramble, with a stable slot and shared `re`. */
export function createRemoteBrand(): { root: HTMLElement; destroy(): void } {
  const root = document.createElement("span");
  root.className = "topbar-brand-sub";
  root.setAttribute("aria-label", "remote");
  root.textContent = "remote";
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let word = "remote";
  let timer: number | undefined;
  let frame: number | undefined;
  const glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  function settle(): void {
    if (frame !== undefined) window.clearInterval(frame);
    frame = undefined;
    root.textContent = word;
  }
  function jump(): void {
    if (!root.isConnected || root.getClientRects().length === 0) return;
    word = word === "remote" ? "relay" : "remote";
    root.setAttribute("aria-label", word);
    root.replaceChildren(document.createTextNode("re"));
    const letters = Array.from(word.slice(2), char => {
      const letter = document.createElement("span");
      letter.className = "remote-brand-letter";
      letter.setAttribute("aria-hidden", "true");
      letter.textContent = char;
      root.append(letter);
      letter.style.width = `${letter.getBoundingClientRect().width}px`;
      return { letter, char };
    });
    const started = performance.now();
    frame = window.setInterval(() => {
      const elapsed = performance.now() - started;
      const hop = Math.floor(elapsed / 50);
      letters.forEach(({ letter, char }, i) => {
        const done = elapsed >= 180 + i * 14;
        letter.textContent = done ? char : glyphs[(i * 17 + hop * 13) % glyphs.length]!;
        letter.style.transform = done ? "" : `translateY(${Math.round(Math.sin(i * 7 + hop * 2.7) * 3)}px)`;
      });
      if (elapsed >= 180 + (letters.length - 1) * 14) settle();
    }, 50);
  }
  function sync(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    settle();
    if (!motion.matches && !document.hidden) timer = window.setInterval(jump, 4500);
  }
  motion.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
  return { root, destroy() {
    if (timer !== undefined) window.clearInterval(timer);
    settle();
    motion.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
  } };
}
