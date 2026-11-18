let openCount = 0;

export function isDevModalOpen(): boolean {
  return openCount > 0;
}

export function claimDevModal(): () => void {
  openCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount = Math.max(0, openCount - 1);
  };
}
