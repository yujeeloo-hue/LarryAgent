export const DEVMODE_TEXT_SEARCH_CHANNEL = "devmode:textSearch";
export const DEVMODE_TEXT_SEARCH_CANCEL_CHANNEL = "devmode:textSearchCancel";
export const DEVMODE_TEXT_SEARCH_CHUNK_CHANNEL = "devmode:textSearchChunk";

export type DevModeTextSearchOptions = {
  includeEngine?: boolean;
  engineOnly?: boolean;
  limit?: number;
};

export type DevModeTextHit = {
  path: string;
  rel: string;
  line: number;
  column: number;
  preview: string;
};

export type DevModeTextSearchChunk = {
  requestId: number;
  hits: DevModeTextHit[];
  done: boolean;
  truncated: boolean;
  error?: string;
};
