/**
 * DAP stdio framing: `Content-Length: N\r\n\r\n` + JSON body.
 */

export type DapRequest = {
  type: "request";
  seq: number;
  command: string;
  arguments?: unknown;
};

export type DapResponse = {
  type: "response";
  seq: number;
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
};

export type DapEvent = {
  type: "event";
  seq: number;
  event: string;
  body?: unknown;
};

export type DapMessage = DapRequest | DapResponse | DapEvent;

export function encodeDapMessage(message: DapMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "utf8"),
    json,
  ]);
}

export class DapFramer {
  private buf = Buffer.alloc(0);

  feed(chunk: Buffer): DapMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: DapMessage[] = [];
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m?.[1]) {
        throw new Error(`DAP framing: missing Content-Length in ${JSON.stringify(header)}`);
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) break;
      const json = this.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + len);
      out.push(JSON.parse(json) as DapMessage);
    }
    return out;
  }
}
