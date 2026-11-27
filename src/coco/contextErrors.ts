export class CocoContextCapacityError extends Error {
  constructor(message = "CoCo is automatically reducing its model context before retrying.") { super(message); this.name = "CocoContextCapacityError"; }
}
export function isContextCapacityError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return error instanceof CocoContextCapacityError || /context[_ -]length[_ -]exceeded|maximum context (?:length|window)|context (?:window|length|size).*(?:exceed|too (?:large|long)|limit)|(?:input|prompt).*(?:too long|token limit)|(?:CoCo|Coco) context is too large/i.test(text);
}

