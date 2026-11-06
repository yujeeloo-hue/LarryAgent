import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const srcRoot = fileURLToPath(new URL("..", import.meta.url));

// Path filters below match on POSIX separators; normalize on Windows.
const toPosix = (p: string): string => p.split(sep).join("/");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith(".ts")) acc.push(toPosix(p));
  }
  return acc;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  const re =
    /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!);
  return out;
}

describe("isolation boundaries", () => {
  const files = walk(toPosix(join(srcRoot, "agent")));
  const tools = walk(toPosix(join(srcRoot, "tools")));

  it("turnHost does not import fsm, workflow, roles, domain, or policy", () => {
    const hostFiles = files.filter((f) => f.includes("/turnHost/"));
    for (const f of hostFiles) {
      for (const spec of importsOf(f)) {
        assert.equal(
          spec.includes("/fsm/") || spec.includes("../fsm/") || spec.includes("/workflow/"),
          false,
          `${relative(srcRoot, f)} imports ${spec}`,
        );
        assert.equal(
          spec.includes("planPhase.js"),
          false,
          `${relative(srcRoot, f)} imports ${spec}`,
        );
        assert.equal(
          spec.includes("../roles") || spec.includes("/roles/"),
          false,
          `${relative(srcRoot, f)} imports ${spec}`,
        );
        assert.equal(
          spec.includes("../domain") || spec.includes("/domain/"),
          false,
          `${relative(srcRoot, f)} imports ${spec}`,
        );
        assert.equal(
          spec.includes("../policy") || spec.includes("/policy/"),
          false,
          `${relative(srcRoot, f)} imports ${spec}`,
        );
      }
    }
  });

  it("tools do not import agent/fsm or workflow", () => {
    for (const f of tools) {
      for (const spec of importsOf(f)) {
        assert.equal(
          /agent\/(fsm|workflow|legacy)/.test(spec) ||
            spec.includes("../agent/fsm") ||
            spec.includes("../agent/workflow"),
          false,
          `${relative(srcRoot, f)} imports ${spec}`,
        );
      }
    }
  });

  it("fsm actions do not import tools/builtin or legacy", () => {
    const actionFiles = files.filter((f) => f.includes("/fsm/actions/"));
    for (const f of actionFiles) {
      for (const spec of importsOf(f)) {
        assert.equal(
          spec.includes("tools/builtin") || spec.includes("/legacy/"),
          false,
          `${relative(srcRoot, f)} imports ${spec}`,
        );
      }
    }
  });

  it("runTools does not import fsm configs", () => {
    const runTools = files.find((f) => f.endsWith("/runTools.ts"));
    assert.ok(runTools);
    for (const spec of importsOf(runTools!)) {
      assert.equal(
        spec.includes("fsm/configs"),
        false,
        `runTools imports ${spec}`,
      );
    }
  });

  it("no agent module imports deleted legacy engine", () => {
    for (const f of files) {
      for (const spec of importsOf(f)) {
        assert.equal(
          spec.includes("/legacy/") || spec.includes("agent/legacy"),
          false,
          `${relative(srcRoot, f)} imports ${spec}`,
        );
      }
    }
  });

  it("sessionRuntime does not import agent policy/roles/domain or plan_execute", () => {
    const runtime = join(srcRoot, "main", "sessionRuntime.ts");
    const text = readFileSync(runtime, "utf8");
    const specs = importsOf(runtime);
    for (const spec of specs) {
      assert.equal(
        spec.includes("agent/policy") ||
          spec.includes("agent/roles") ||
          spec.includes("agent/domain"),
        false,
        `sessionRuntime imports ${spec}`,
      );
    }
    assert.equal(
      text.includes("plan_execute"),
      false,
      "sessionRuntime must not contain plan_execute",
    );
  });
});
