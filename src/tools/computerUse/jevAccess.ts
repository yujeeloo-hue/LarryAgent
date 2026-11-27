import type { JevClientConfig } from "../../llm/jevClient.js";

type JevResolver = () => Promise<JevClientConfig | null>;

let resolver: JevResolver | null = null;

export function configureComputerUseJev(next: JevResolver | null): void {
  resolver = next;
}

export async function computerUseJevClient(): Promise<JevClientConfig | null> {
  if (!resolver) return null;
  try {
    return await resolver();
  } catch {
    return null;
  }
}
