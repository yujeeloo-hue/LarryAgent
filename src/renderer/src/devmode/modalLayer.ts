/**
 * Dev Mode modal bookkeeping.
 *
 * The workbench owns capture-phase shortcuts on `window` (⌘T Quick Open, ⌘F
 * Find, ⌘S Save), which fire before anything a modal can register. They ask
 * this flag so a modal that covers the workbench does not get shortcuts
 * targeting the editor underneath it.
 */
let openCount = 0;

export function isDevModalOpen(): boolean {
  return openCount > 0;
}

/** Call on mount; the returned function releases the claim on teardown. */
export function claimDevModal(): () => void {
  openCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount = Math.max(0, openCount - 1);
  };
}
