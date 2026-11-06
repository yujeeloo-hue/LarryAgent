import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLASH_COMMANDS,
  filterSlashCommands,
  matchModeSlashCommand,
  matchSlashCommand,
  matchSlashCommandWithArgs,
  matchSlashEscape,
  matchWorkspaceTaskCommand,
} from "./slashCommands.js";

const pause = SLASH_COMMANDS[0];
const resume = SLASH_COMMANDS[1];
const compact = SLASH_COMMANDS[2];
const opt = SLASH_COMMANDS[3];
const clear = SLASH_COMMANDS[4];
const end = SLASH_COMMANDS[5];
const plan = SLASH_COMMANDS[6];
const ask = SLASH_COMMANDS[7];
const auto = SLASH_COMMANDS[8];
const build = SLASH_COMMANDS[9];
const dev = SLASH_COMMANDS[10];

describe("matchSlashCommand", () => {
  it("matches each registered command exactly", () => {
    assert.equal(matchSlashCommand("/pause"), pause);
    assert.equal(matchSlashCommand("/resume"), resume);
    assert.equal(matchSlashCommand("/compact"), compact);
    assert.equal(matchSlashCommand("/clear"), clear);
    assert.equal(matchSlashCommand("/end"), end);
    assert.equal(matchSlashCommand("/plan"), plan);
    assert.equal(matchSlashCommand("/ask"), ask);
    assert.equal(matchSlashCommand("/auto"), auto);
    assert.equal(matchSlashCommand("/build"), build);
    assert.equal(matchSlashCommand("/dev"), dev);
  });

  it("rejects uppercase and mixed-case input", () => {
    assert.equal(matchSlashCommand("/PAUSE"), null);
    assert.equal(matchSlashCommand("/Pause"), null);
    assert.equal(matchSlashCommand("/COMPACT"), null);
  });

  it("trims surrounding whitespace but rejects trailing text", () => {
    assert.equal(matchSlashCommand("  /pause  "), pause);
    assert.equal(matchSlashCommand("/resume\n"), resume);
    assert.equal(matchSlashCommand("/pause now"), null);
    assert.equal(matchSlashCommand("/resume\nplease"), null);
    assert.equal(matchSlashCommand("/compact --force"), null);
  });

  it("returns null for unknown commands", () => {
    assert.equal(matchSlashCommand("/foo"), null);
    assert.equal(matchSlashCommand("/pauses"), null);
    assert.equal(matchSlashCommand("//"), null);
    assert.equal(matchSlashCommand("/pause/resume"), null);
  });

  it("returns null for partial prefixes and non-slash text", () => {
    assert.equal(matchSlashCommand("/pa"), null);
    assert.equal(matchSlashCommand("/"), null);
    assert.equal(matchSlashCommand(""), null);
    assert.equal(matchSlashCommand("   "), null);
    assert.equal(matchSlashCommand("pause"), null);
    assert.equal(matchSlashCommand("run /pause"), null);
  });
});

describe("filterSlashCommands", () => {
  it("prefix-filters case-insensitively", () => {
    assert.deepEqual(
      filterSlashCommands("/p").map((c) => c.name),
      ["/pause", "/plan"],
    );
    assert.deepEqual(
      filterSlashCommands("/R").map((c) => c.name),
      ["/resume"],
    );
    assert.deepEqual(
      filterSlashCommands("/a").map((c) => c.name),
      ["/ask", "/auto"],
    );
    assert.deepEqual(
      filterSlashCommands("/compact").map((c) => c.name),
      ["/compact"],
    );
    assert.deepEqual(
      filterSlashCommands("/bu").map((c) => c.name),
      ["/build"],
    );
  });

  it("lists every command for the bare slash", () => {
    assert.deepEqual(
      filterSlashCommands("/").map((c) => c.name),
      [
        "/pause",
        "/resume",
        "/compact",
        "/opt",
        "/clear",
        "/end",
        "/plan",
        "/ask",
        "/auto",
        "/build",
        "/dev",
      ],
    );
    assert.deepEqual(
      filterSlashCommands("  /  ").map((c) => c.name),
      [
        "/pause",
        "/resume",
        "/compact",
        "/opt",
        "/clear",
        "/end",
        "/plan",
        "/ask",
        "/auto",
        "/build",
        "/dev",
      ],
    );
  });

  it("hides for non-slash, mid-text, or non-matching input", () => {
    assert.deepEqual(filterSlashCommands(""), []);
    assert.deepEqual(filterSlashCommands("pause"), []);
    assert.deepEqual(filterSlashCommands("run /p"), []);
    assert.deepEqual(filterSlashCommands("/xyz"), []);
  });

  it("keeps arg commands listed once typing continues into the argument", () => {
    assert.deepEqual(
      filterSlashCommands("/opt fix this").map((c) => c.name),
      ["/opt"],
    );
    assert.deepEqual(
      filterSlashCommands("/opt fix\nsecond line").map((c) => c.name),
      ["/opt"],
    );
    assert.deepEqual(
      filterSlashCommands("/compact 0.1").map((c) => c.name),
      ["/compact"],
    );
    assert.deepEqual(filterSlashCommands("/o").map((c) => c.name), ["/opt"]);
    assert.deepEqual(filterSlashCommands("/optx"), []);
  });

  it("keeps mode commands listed once typing continues into the prompt", () => {
    assert.deepEqual(
      filterSlashCommands("/plan refactor the auth module").map((c) => c.name),
      ["/plan"],
    );
    assert.deepEqual(filterSlashCommands("/ask what does").map((c) => c.name), [
      "/ask",
    ]);
    assert.deepEqual(filterSlashCommands("/planx"), []);
  });

  it("hides the popup while typing an escape (//…)", () => {
    assert.deepEqual(filterSlashCommands("//opt hi"), []);
    assert.deepEqual(filterSlashCommands("//"), []);
  });
});

describe("matchSlashCommandWithArgs", () => {
  it("matches /opt with its trailing argument", () => {
    assert.deepEqual(matchSlashCommandWithArgs("/opt fix this"), {
      command: opt,
      args: "fix this",
    });
  });

  it("preserves internal blank lines in the argument", () => {
    assert.deepEqual(matchSlashCommandWithArgs("/opt line one\nline two"), {
      command: opt,
      args: "line one\nline two",
    });
  });

  it("trims the outer whitespace of the whole input and argument", () => {
    assert.deepEqual(matchSlashCommandWithArgs("  /opt hi  "), {
      command: opt,
      args: "hi",
    });
    assert.equal(matchSlashCommandWithArgs("/opt   "), null);
  });

  it("rejects bare /opt, run-ons, wrong case, and other commands", () => {
    assert.equal(matchSlashCommandWithArgs("/opt"), null);
    assert.equal(matchSlashCommandWithArgs("/OPT fix this"), null);
    assert.equal(matchSlashCommandWithArgs("/option hi"), null);
    assert.equal(matchSlashCommandWithArgs("/pause now"), null);
    assert.equal(matchSlashCommandWithArgs("/resume\nplease"), null);
    assert.equal(matchSlashCommandWithArgs("run /opt hi"), null);
    assert.equal(matchSlashCommandWithArgs(""), null);
  });

  it("matches /compact with its trailing keep ratio", () => {
    assert.deepEqual(matchSlashCommandWithArgs("/compact 0.1"), {
      command: compact,
      args: "0.1",
    });
    assert.deepEqual(matchSlashCommandWithArgs("  /compact 0.05  "), {
      command: compact,
      args: "0.05",
    });
    // Free-text args still match at this layer — the shared parser rejects
    // them and the composer answers with a usage hint instead of a send.
    assert.deepEqual(matchSlashCommandWithArgs("/compact --force"), {
      command: compact,
      args: "--force",
    });
  });

  it("rejects bare /compact and run-ons", () => {
    assert.equal(matchSlashCommandWithArgs("/compact"), null);
    assert.equal(matchSlashCommandWithArgs("/COMPACT 0.1"), null);
    assert.equal(matchSlashCommandWithArgs("/compacted 0.1"), null);
    assert.equal(matchSlashCommandWithArgs("/compact  "), null);
  });

  it("matches mode commands with their trailing prompt", () => {
    assert.deepEqual(matchSlashCommandWithArgs("/plan refactor the db"), {
      command: plan,
      args: "refactor the db",
    });
    assert.deepEqual(matchSlashCommandWithArgs("/ask what is this file"), {
      command: ask,
      args: "what is this file",
    });
    assert.deepEqual(matchSlashCommandWithArgs("/auto ship it"), {
      command: auto,
      args: "ship it",
    });
  });

  it("rejects bare mode commands and run-ons", () => {
    assert.equal(matchSlashCommandWithArgs("/plan"), null);
    assert.equal(matchSlashCommandWithArgs("/ask   "), null);
    assert.equal(matchSlashCommandWithArgs("/planning ahead"), null);
    assert.equal(matchSlashCommandWithArgs("/PLAN do this"), null);
  });
});

describe("matchModeSlashCommand", () => {
  it("maps mode commands to their run-mode target", () => {
    assert.equal(matchModeSlashCommand("/plan"), "plan");
    assert.equal(matchModeSlashCommand("/ask"), "ask");
    assert.equal(matchModeSlashCommand("/auto"), "agent");
  });

  it("returns null for non-mode commands and unknown names", () => {
    assert.equal(matchModeSlashCommand("/pause"), null);
    assert.equal(matchModeSlashCommand("/opt"), null);
    assert.equal(matchModeSlashCommand("/foo"), null);
  });
});

describe("matchSlashEscape", () => {
  it("unescapes //opt by stripping one leading slash", () => {
    assert.equal(matchSlashEscape("//opt hi"), "/opt hi");
    assert.equal(matchSlashEscape("  //opt hi  "), "/opt hi");
    assert.equal(matchSlashEscape("//opt"), "/opt");
    assert.equal(matchSlashEscape("//opt hi\nline two"), "/opt hi\nline two");
  });

  it("ignores other escapes, run-ons, and non-escape input", () => {
    assert.equal(matchSlashEscape("//optx hi"), null);
    assert.equal(matchSlashEscape("//pause now"), null);
    assert.equal(matchSlashEscape("//"), null);
    assert.equal(matchSlashEscape("/opt hi"), null);
    assert.equal(matchSlashEscape("hello"), null);
    assert.equal(matchSlashEscape(""), null);
  });

  it("unescapes mode commands by stripping one leading slash", () => {
    assert.equal(matchSlashEscape("//plan do this"), "/plan do this");
    assert.equal(matchSlashEscape("//ask why"), "/ask why");
    assert.equal(matchSlashEscape("//auto"), "/auto");
    assert.equal(matchSlashEscape("//planx hi"), null);
  });

  it("unescapes /compact by stripping one leading slash", () => {
    assert.equal(matchSlashEscape("//compact 0.5"), "/compact 0.5");
    assert.equal(matchSlashEscape("//compact"), "/compact");
    assert.equal(matchSlashEscape("//compacted"), null);
  });
});

describe("matchWorkspaceTaskCommand", () => {
  it("maps /build to its task id", () => {
    assert.equal(matchWorkspaceTaskCommand("/build"), "build");
  });

  it("returns null for every other input", () => {
    assert.equal(matchWorkspaceTaskCommand("/dev"), null);
    assert.equal(matchWorkspaceTaskCommand("/pause"), null);
    assert.equal(matchWorkspaceTaskCommand("build"), null);
    assert.equal(matchWorkspaceTaskCommand(""), null);
  });
});
