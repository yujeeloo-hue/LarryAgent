const pending = new WeakMap<HTMLButtonElement, number>();

export function setButtonLoading(button: HTMLButtonElement, loading: boolean): void {
  const count = Math.max(0, (pending.get(button) ?? 0) + (loading ? 1 : -1));
  if (count) pending.set(button, count);
  else pending.delete(button);
  button.classList.toggle("is-running", count > 0);
}

export async function withButtonLoading<T>(
  button: HTMLButtonElement,
  work: () => Promise<T>,
): Promise<T> {
  setButtonLoading(button, true);
  try {
    return await work();
  } finally {
    setButtonLoading(button, false);
  }
}
