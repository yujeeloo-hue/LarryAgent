export class ClangdDocumentCache {
  private readonly idle = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly close: (uri: string) => void,
    private readonly capacity = 2,
    private readonly ttlMs = 60_000,
  ) {}

  acquire(uri: string): void {
    const timer = this.idle.get(uri);
    if (timer !== undefined) clearTimeout(timer);
    this.idle.delete(uri);
  }

  release(uri: string): void {
    this.acquire(uri);
    const timer = setTimeout(() => {
      this.idle.delete(uri);
      this.close(uri);
    }, this.ttlMs);
    timer.unref?.();
    this.idle.set(uri, timer);
    while (this.idle.size > this.capacity) {
      const oldest = this.idle.keys().next().value!;
      this.acquire(oldest);
      this.close(oldest);
    }
  }

  dispose(): void {
    for (const timer of this.idle.values()) clearTimeout(timer);
    this.idle.clear();
  }
}
