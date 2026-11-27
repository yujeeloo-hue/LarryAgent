import type { LoopsToolPort } from "../../tools/loopsTool.js";

let port: LoopsToolPort | null = null;

export function setLoopsToolPort(next: LoopsToolPort | null): void {
  port = next;
}

export function getLoopsToolPort(): LoopsToolPort | null {
  return port;
}

