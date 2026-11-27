type TransitionScope = HTMLElement & {
  startViewTransition?(update: () => void): ViewTransition;
};

export class MainScreenTransition {
  private active: { transition: ViewTransition; commit: () => void } | undefined;
  private updating = false;

  constructor(private readonly scope: TransitionScope) {}

  run(update: () => void, shouldAnimate?: () => boolean): void {
    if (this.updating) {
      update();
      return;
    }

    this.flush();
    const doc = this.scope.ownerDocument;
    let pending = true;
    const commit = (): void => {
      if (!pending) return;
      pending = false;
      this.updating = true;
      try {
        update();
      } finally {
        this.updating = false;
      }
    };

    if (
      !this.scope.startViewTransition ||
      !this.scope.isConnected ||
      !this.scope.firstElementChild ||
      doc.visibilityState !== "visible" ||
      doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      shouldAnimate?.() === false
    ) {
      commit();
      return;
    }

    const transition = this.scope.startViewTransition(commit);
    const active = { transition, commit };
    this.active = active;
    // Interrupted captures reject ready even though the screen update still runs.
    void transition.ready.catch(() => {});
    void transition.finished.finally(() => {
      if (this.active === active) this.active = undefined;
    }).catch((error: unknown) => console.error("[shell] screen transition failed", error));
  }

  flush(): void {
    const active = this.active;
    if (!active || this.updating) return;
    this.active = undefined;
    active.transition.skipTransition();
    // A skipped capture still calls its update later. Commit now to keep navigation in order.
    active.commit();
  }
}
