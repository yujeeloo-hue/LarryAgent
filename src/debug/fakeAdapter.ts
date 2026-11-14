/**
 * In-process DAP adapter used by unit tests (PassThrough stdio).
 */
import type { Readable, Writable } from "node:stream";
import {
  DapFramer,
  encodeDapMessage,
  type DapEvent,
  type DapRequest,
  type DapResponse,
} from "./dapFraming.js";

export type FakeAdapterHandler = (
  req: DapRequest,
) => {
  response?: unknown;
  skipResponse?: boolean;
  success?: boolean;
  message?: string;
  extraResponses?: Array<{ request_seq: number; command: string; body?: unknown }>;
  events?: Array<{ event: string; body?: unknown }>;
} | void;

export function attachFakeAdapter(
  readable: Readable,
  writable: Writable,
  handle: FakeAdapterHandler,
): void {
  const framer = new DapFramer();
  let seq = 1;
  readable.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (const msg of framer.feed(buf)) {
      if (msg.type !== "request") continue;
      const out = handle(msg) ?? {};
      if (!out.skipResponse) {
        const response: DapResponse = {
          type: "response",
          seq: seq++,
          request_seq: msg.seq,
          success: out.success !== false,
          command: msg.command,
        };
        if (out.message) response.message = out.message;
        if (out.response !== undefined) response.body = out.response;
        writable.write(encodeDapMessage(response));
      }
      for (const extra of out.extraResponses ?? []) {
        const response: DapResponse = {
          type: "response",
          seq: seq++,
          request_seq: extra.request_seq,
          success: true,
          command: extra.command,
        };
        if (extra.body !== undefined) response.body = extra.body;
        writable.write(encodeDapMessage(response));
      }
      for (const ev of out.events ?? []) {
        const event: DapEvent = {
          type: "event",
          seq: seq++,
          event: ev.event,
        };
        if (ev.body !== undefined) event.body = ev.body;
        writable.write(encodeDapMessage(event));
      }
    }
  });
}
