/**
 * Model-list filter for the provider wizard.
 * Empty query matches everything. Otherwise every whitespace-separated
 * word must appear in the id, so "claude sonnet" matches
 * "anthropic/claude-sonnet-4.5".
 */
export function modelMatchesQuery(modelId: string, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = modelId.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
