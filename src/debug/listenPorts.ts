/**
 * TCP listen ports owned by a debuggee process tree.
 *
 * Web debug cannot wait on a Vite-style "Local:" banner — many Express /
 * static Node servers never print a URL. Chrome is launched against the
 * first HTTP port the spawned server (or npm child) is actually listening on.
 */
import { execFileSync } from "node:child_process";
import { parseNetstatListeningEntries } from "./killProcessTree.js";

function validPid(pid: number | undefined): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

function portFromLocalAddr(local: string): number | null {
  const match = local.match(/:(\d+)$/);
  if (!match) return null;
  const port = Number(match[1]);
  return port > 0 && port < 65536 ? port : null;
}

/** Prefer typical app ports over inspector / HMR leftovers. */
const PREFERRED_HTTP_PORTS = [
  80, 443, 3000, 3001, 5173, 5174, 8080, 8000, 4173, 4200, 5000, 4321, 1234,
  8081, 8888, 9000,
];

export function rankHttpListenPorts(ports: Iterable<number>): number[] {
  const unique = [...new Set([...ports].filter((port) => port > 0 && port < 65536))];
  unique.sort((a, b) => {
    const ia = PREFERRED_HTTP_PORTS.indexOf(a);
    const ib = PREFERRED_HTTP_PORTS.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a - b;
  });
  return unique;
}

export function parseLsofListenPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const raw of output.split(/\r?\n/)) {
    if (!/\(LISTEN\)/i.test(raw)) continue;
    const match = raw.match(/\bTCP\s+(\S+)\s+\(LISTEN\)/i);
    if (!match) continue;
    const port = portFromLocalAddr(match[1]!);
    if (port) ports.add(port);
  }
  return [...ports];
}

export function descendantPids(
  rootPid: number,
  listChildren: (pid: number) => number[],
): number[] {
  if (!validPid(rootPid)) return [];
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    out.push(pid);
    for (const child of listChildren(pid)) {
      if (!validPid(child) || seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return out;
}

function posixChildren(pid: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return out
      .split(/\s+/)
      .map((token) => Number(token))
      .filter(validPid);
  } catch {
    return [];
  }
}

function lsofListenForPids(pids: number[]): string {
  if (pids.length === 0) return "";
  const run = (list: number[]): string => {
    try {
      return execFileSync(
        "lsof",
        ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", list.join(",")],
        { encoding: "utf8", timeout: 3_000 },
      );
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout;
      return typeof stdout === "string" ? stdout : "";
    }
  };
  const dump = run(pids);
  if (dump.trim()) return dump;
  if (pids.length > 1) return run(pids.slice(0, 1));
  return "";
}

function parseWmicParentMap(output: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const csv = line.split(",");
    if (csv.length >= 3) {
      const parent = Number(csv[csv.length - 2]);
      const pid = Number(csv[csv.length - 1]);
      if (validPid(pid) && Number.isInteger(parent) && parent >= 0) {
        map.set(pid, parent);
      }
      continue;
    }
    const pair = line.match(/^(\d+)\s+(\d+)$/);
    if (pair) {
      const pid = Number(pair[1]);
      const parent = Number(pair[2]);
      if (validPid(pid) && Number.isInteger(parent) && parent >= 0) {
        map.set(pid, parent);
      }
    }
  }
  return map;
}

function windowsParentMap(): Map<number, number> {
  try {
    const out = execFileSync(
      "wmic",
      ["process", "get", "ProcessId,ParentProcessId", "/FORMAT:CSV"],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    const map = parseWmicParentMap(out);
    if (map.size > 0) return map;
  } catch {
    /* fall through */
  }
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
      ],
      { encoding: "utf8", timeout: 8_000, windowsHide: true },
    );
    return parseWmicParentMap(out);
  } catch {
    return new Map();
  }
}

function pidIsUnder(
  pid: number,
  rootPid: number,
  parents: Map<number, number>,
): boolean {
  let current = pid;
  const seen = new Set<number>();
  while (validPid(current) && !seen.has(current)) {
    if (current === rootPid) return true;
    seen.add(current);
    const parent = parents.get(current);
    if (parent === undefined) return false;
    current = parent;
  }
  return false;
}

export type ListenTcpPortsOpts = {
  excludePorts?: Iterable<number>;
  platform?: NodeJS.Platform;
  posixChildren?: (pid: number) => number[];
  lsofListen?: (pids: number[]) => string;
  netstat?: () => string;
  windowsParents?: () => Map<number, number>;
};

export function listenTcpPortsForProcessTree(
  rootPid: number,
  opts?: ListenTcpPortsOpts,
): number[] {
  if (!validPid(rootPid)) return [];
  const exclude = new Set(
    [...(opts?.excludePorts ?? [])].filter((port) => port > 0),
  );
  const platform = opts?.platform ?? process.platform;
  let ports: number[] = [];
  if (platform === "win32") {
    const netstat =
      opts?.netstat ??
      (() =>
        execFileSync("netstat", ["-ano", "-p", "tcp"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        }));
    const parents = (opts?.windowsParents ?? windowsParentMap)();
    const owned = new Set<number>();
    try {
      for (const entry of parseNetstatListeningEntries(netstat())) {
        if (exclude.has(entry.port)) continue;
        if (entry.pid === rootPid || pidIsUnder(entry.pid, rootPid, parents)) {
          owned.add(entry.port);
        }
      }
    } catch {
      return [];
    }
    ports = [...owned];
  } else {
    const pids = descendantPids(rootPid, opts?.posixChildren ?? posixChildren);
    const dump = (opts?.lsofListen ?? lsofListenForPids)(pids);
    ports = parseLsofListenPorts(dump).filter((port) => !exclude.has(port));
  }
  return rankHttpListenPorts(ports);
}

export function httpUrlsForListenPorts(ports: number[]): string[] {
  return rankHttpListenPorts(ports).map((port) => `http://127.0.0.1:${port}/`);
}
