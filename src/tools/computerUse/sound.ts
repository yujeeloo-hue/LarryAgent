export type ComputerUseSound =
  | { kind: "click"; count: number }
  | { kind: "handoff" };

let publish: ((sound: ComputerUseSound) => void) | null = null;

export function configureComputerUseSoundPublisher(next: typeof publish): void {
  publish = next;
}

export function publishComputerUseSound(sound: ComputerUseSound): void {
  try {
    publish?.(sound);
  } catch {
    // The desktop window can close while Computer Use is still running.
  }
}
