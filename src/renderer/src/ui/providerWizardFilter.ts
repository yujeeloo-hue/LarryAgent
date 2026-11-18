export function modelMatchesQuery(modelId: string, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = modelId.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
