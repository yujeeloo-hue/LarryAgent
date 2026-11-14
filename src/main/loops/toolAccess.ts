/**
 * Module-level holder for the Loops service port (loops tool).
 *
 * The LoopsService instance is created in main/index.ts after the session
 * store boots, while the runAgentTurn input is built inside sessionRuntime —
 * a holder decouples the two without threading a new param through the
 * store. The tool itself stays pure: it reads the port from
 * ToolExecuteContext.loops (never imports this module), so node:test can
 * inject fakes directly.
 *
 * `LoopsService` is assignable to `LoopsToolPort` by structure (locked by a
 * compile-time check in src/tools/builtin/loops.test.ts).
 */
import type { LoopsToolPort } from "../../tools/loopsTool.js";

let port: LoopsToolPort | null = null;

/** Register the live service (main boot); null = Loops unavailable. */
export function setLoopsToolPort(next: LoopsToolPort | null): void {
  port = next;
}

export function getLoopsToolPort(): LoopsToolPort | null {
  return port;
}

