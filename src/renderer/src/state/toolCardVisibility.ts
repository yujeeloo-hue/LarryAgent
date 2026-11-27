
let hidden = new Set<string>();

export function isToolCardHidden(name: string): boolean {
  return hidden.has(name);
}

export function listHiddenToolCardNames(): string[] {
  return [...hidden];
}

export async function refreshHiddenToolCards(bridge: {
  getHiddenToolCards: () => Promise<string[]>;
}): Promise<void> {
  const names = await bridge.getHiddenToolCards();
  hidden = new Set(names);
}

export function applyToolDisplayLocally(
  name: string,
  visible: boolean,
): void {
  const key = name.trim();
  if (!key) return;
  const next = new Set(hidden);
  if (visible) next.delete(key);
  else next.add(key);
  hidden = next;
}

export function setHiddenToolCardsForTests(names: string[]): void {
  hidden = new Set(names);
}
