import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import {
  descendantPids,
  httpUrlsForListenPorts,
  listenTcpPortsForProcessTree,
  parseLsofListenPorts,
  rankHttpListenPorts,
} from "./listenPorts.js";

describe("parseLsofListenPorts", () => {
  it("reads IPv4 and IPv6 listen rows", () => {
    const dump = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node    12345 you   23u  IPv4 0xabc      0t0  TCP *:3000 (LISTEN)",
      "node    12345 you   24u  IPv6 0xdef      0t0  TCP [::1]:3000 (LISTEN)",
      "node    12345 you   25u  IPv4 0xaaa      0t0  TCP 127.0.0.1:19229 (LISTEN)",
    ].join("\n");
    assert.deepEqual(parseLsofListenPorts(dump).sort((a, b) => a - b), [3000, 19229]);
  });
});

describe("rankHttpListenPorts", () => {
  it("prefers app ports over HMR leftovers", () => {
    assert.deepEqual(rankHttpListenPorts([24678, 5173, 3000]), [3000, 5173, 24678]);
  });
});

describe("httpUrlsForListenPorts", () => {
  it("builds loopback http origins", () => {
    assert.deepEqual(httpUrlsForListenPorts([5173]), ["http://127.0.0.1:5173/"]);
  });
});

describe("descendantPids", () => {
  it("walks a parent map", () => {
    const children = (pid: number): number[] => {
      if (pid === 10) return [11, 12];
      if (pid === 11) return [13];
      return [];
    };
    assert.deepEqual(descendantPids(10, children), [10, 11, 12, 13]);
  });
});

describe("listenTcpPortsForProcessTree", () => {
  it("uses lsof output and drops excluded inspector ports", () => {
    const ports = listenTcpPortsForProcessTree(99, {
      platform: "darwin",
      posixChildren: () => [100],
      lsofListen: () =>
        "node 100 you 23u IPv4 0x1 0t0 TCP *:3000 (LISTEN)\nnode 100 you 24u IPv4 0x2 0t0 TCP 127.0.0.1:19229 (LISTEN)\n",
      excludePorts: [19229],
    });
    assert.deepEqual(ports, [3000]);
  });

  it("keeps netstat rows whose PID is under the debuggee", () => {
    const dump = [
      "  TCP    127.0.0.1:3000        0.0.0.0:0              LISTENING       44520",
      "  TCP    127.0.0.1:19229       0.0.0.0:0              LISTENING       100",
    ].join("\r\n");
    const ports = listenTcpPortsForProcessTree(100, {
      platform: "win32",
      netstat: () => dump,
      windowsParents: () => new Map([[44520, 100]]),
      excludePorts: [19229],
    });
    assert.deepEqual(ports, [3000]);
  });

  it("finds a live HTTP listen port on this process", async () => {
    const server = createServer((_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      const ports = listenTcpPortsForProcessTree(process.pid, {
        excludePorts: [],
      });
      assert.ok(
        ports.includes(addr.port),
        `expected ${addr.port} in ${ports.join(",")}`,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
