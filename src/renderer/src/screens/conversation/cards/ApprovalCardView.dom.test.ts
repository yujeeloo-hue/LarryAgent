/**
 * Level-2 approval card (Shell Safe Mode redesign): tone dataset, reason
 * block order, command vs arguments body branch, countdown single source.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { before, describe, it } from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })
  ._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
});

let createApprovalCard: typeof import("./ApprovalCardView.js")["createApprovalCard"];

before(async () => {
  ({ createApprovalCard } = await import("./ApprovalCardView.js"));
});

function baseInput() {
  return {
    requestId: "req-1",
    toolName: "run_shell",
    arguments: { command: "rm -rf build/ dist/" } as Record<string, unknown>,
    expiresAt: Date.now() + 30_000,
    onAllow: () => {},
    onDeny: () => {},
  };
}

describe("approval card structure", () => {
  it("high-risk card: tone, chip, reason order, command body", () => {
    const card = createApprovalCard({
      ...baseInput(),
      risk: { fatal: false, reason: "rm removes files permanently.", trashRewrite: true },
    });
    assert.equal(card.dataset.tone, "high");

    const header = card.querySelector(".content-card-approval-header");
    assert.ok(header, "header present");
    const chip = header!.querySelector(".content-card-approval-chip");
    assert.equal(chip?.textContent, "High risk");
    assert.equal(header!.querySelector(".content-card-approval-tool")?.textContent, "run_shell");

    // Reason block sits between header and body; two paragraph lines.
    const reason = card.querySelector(".content-card-approval-reason");
    assert.ok(reason, "reason block present");
    const lines = reason!.querySelectorAll("p");
    assert.equal(lines.length, 2, "risk line + rewrite line");
    assert.equal(lines[0]!.className, "content-card-approval-reason-risk");
    assert.equal(lines[0]!.textContent, "rm removes files permanently.");
    assert.match(lines[1]!.textContent, /recoverable variant/);

    const order = [...card.children].map((n) => (n as HTMLElement).className);
    const headerAt = order.findIndex((c) => c.includes("approval-header"));
    const reasonAt = order.findIndex((c) => c.includes("approval-reason"));
    const bodyAt = order.findIndex((c) => c.includes("approval-body"));
    assert.ok(headerAt < reasonAt && reasonAt < bodyAt, "header → reason → body");

    // Shell command renders the prompt-prefixed Command block.
    const bodyLabel = card.querySelector(".content-card-approval-body-label");
    assert.equal(bodyLabel?.textContent, "Command");
    const pre = card.querySelector(".content-card-approval-body pre");
    assert.equal(pre?.textContent, "$  rm -rf build/ dist/");
  });

  it("fatal card: fatal tone drives chip + reason, no rewrite line without trashRewrite", () => {
    const card = createApprovalCard({
      ...baseInput(),
      risk: { fatal: true, reason: "dd writes a raw image to a block device.", trashRewrite: false },
    });
    assert.equal(card.dataset.tone, "fatal");
    assert.equal(
      card.querySelector(".content-card-approval-header .content-card-approval-chip")?.textContent,
      "Fatal",
    );
    const lines = card.querySelectorAll(".content-card-approval-reason p");
    assert.equal(lines.length, 1, "fatal without rewrite: risk line only");
  });

  it("plain level-2 card: no risk chip/reason, arguments body", () => {
    const card = createApprovalCard({
      ...baseInput(),
      arguments: { path: "/tmp/notes.txt", content: "hello" },
    });
    assert.equal(card.dataset.tone, "plain");
    assert.equal(card.querySelector(".content-card-approval-chip"), null);
    assert.equal(card.querySelector(".content-card-approval-reason"), null);
    assert.equal(card.querySelector(".content-card-approval-body-label")?.textContent, "Arguments");
    assert.match(
      card.querySelector(".content-card-approval-body pre")?.textContent ?? "",
      /path: \/tmp\/notes\.txt/,
    );
  });

  it("countdown: label text + expiresAt dataset share the single deadline; deny fill duration matches", () => {
    const expiresAt = Date.now() + 30_000;
    const card = createApprovalCard({ ...baseInput(), expiresAt });
    const countdown = card.querySelector<HTMLElement>(".content-card-approval-countdown");
    assert.ok(countdown, "countdown present");
    assert.equal(Number(countdown!.dataset.expiresAt), expiresAt);
    assert.match(
      countdown!.querySelector(".content-card-approval-countdown-label")?.textContent ?? "",
      /^Auto-deny in \d+s$/,
    );
    const fill = card.querySelector<HTMLElement>(".content-card-approval-deny-fill");
    assert.ok(fill, "deny fill present (deny-fill countdown confirmed)");
    const duration = Number(String(fill!.style.getPropertyValue("animation-duration")).replace(/[^\d]/g, ""));
    assert.ok(duration > 25_000 && duration <= 30_000, `fill duration ≈ ttl (${duration}ms)`);
  });

  it("Allow / Deny wire the callbacks", () => {
    let allowed = 0;
    let denied = 0;
    const card = createApprovalCard({
      ...baseInput(),
      onAllow: () => { allowed += 1; },
      onDeny: () => { denied += 1; },
    });
    (card.querySelector(".content-card-approval-allow") as HTMLElement).click();
    (card.querySelector(".content-card-approval-deny") as HTMLElement).click();
    assert.equal(allowed, 1);
    assert.equal(denied, 1);
  });
});
