import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");

type FakeEntry = { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } };
const observers: FakeIntersectionObserver[] = [];
class FakeIntersectionObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: (entries: FakeEntry[]) => void) {
    observers.push(this);
  }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); }
  fire(entries: FakeEntry[]): void { this.callback(entries); }
}

Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  MutationObserver: dom.window.MutationObserver,
  IntersectionObserver: FakeIntersectionObserver,
});

let Virtualizer: typeof import("./ConversationTurnVirtualizer.js")["ConversationTurnVirtualizer"];
let MIN_TURNS: number;
const created: Array<{ destroy(): void }> = [];

before(async () => {
  const mod = await import("./ConversationTurnVirtualizer.js");
  Virtualizer = mod.ConversationTurnVirtualizer;
  MIN_TURNS = mod.TURN_VIRTUALIZE_MIN_TURNS;
});

afterEach(() => {
  for (const item of created.splice(0)) item.destroy();
  observers.splice(0);
  document.body.replaceChildren();
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function transcript(count: number) {
  const scrollport = document.createElement("div");
  const list = document.createElement("div");
  scrollport.append(list);
  document.body.append(scrollport);
  const turns: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const turn = document.createElement("div");
    turn.className = "conversation-turn";
    const row = document.createElement("article");
    row.className = "conversation-msg conversation-msg-user";
    row.dataset.messageId = `u${i}`;
    row.textContent = `Prompt ${i}`;
    turn.append(row);
    list.append(turn);
    turns.push(turn);
  }
  turns.at(-1)?.classList.add("is-latest");
  let restored = 0;
  const virtualizer = new Virtualizer(scrollport, list, { onRestore: () => { restored += 1; } });
  created.push(virtualizer);
  return { list, turns, virtualizer, observer: observers.at(-1)!, restoredCount: () => restored };
}

const away = (target: Element, height = 120): FakeEntry => ({ target, isIntersecting: false, boundingClientRect: { height } });
const near = (target: Element): FakeEntry => ({ target, isIntersecting: true, boundingClientRect: { height: 120 } });

describe("conversation turn virtualizer", () => {
  it("parks offscreen turns into height placeholders and restores them on approach", () => {
    const { turns, observer } = transcript(MIN_TURNS + 2);
    const first = turns[0]!;
    observer.fire([away(first, 240)]);
    assert.equal(first.childElementCount, 0);
    assert.equal(first.style.height, "240px");
    assert.equal(first.getAttribute("data-turn-parked"), "1");

    observer.fire([near(first)]);
    assert.equal(first.childElementCount, 1);
    assert.equal(first.querySelector(".conversation-msg-user")?.textContent, "Prompt 0");
    assert.equal(first.getAttribute("data-turn-parked"), null);
    assert.equal(first.style.height, "");
  });

  it("keeps short transcripts, the latest turn and live turns mounted", () => {
    const short = transcript(MIN_TURNS - 1);
    short.observer.fire([away(short.turns[0]!)]);
    assert.equal(short.virtualizer.parkedCount, 0);

    const long = transcript(MIN_TURNS + 2);
    long.observer.fire([away(long.turns.at(-1)!)]);
    const live = long.turns[1]!;
    const streaming = document.createElement("div");
    streaming.dataset.streaming = "1";
    live.append(streaming);
    long.observer.fire([away(live)]);
    assert.equal(long.virtualizer.parkedCount, 0);
  });

  it("finds parked rows by restoring their turn and counts them without restoring", () => {
    const { list, turns, observer, virtualizer, restoredCount } = transcript(MIN_TURNS + 2);
    observer.fire(turns.slice(0, 3).map((turn) => away(turn)));
    assert.equal(virtualizer.parkedCount, 3);
    assert.equal(list.querySelectorAll(".conversation-msg-user").length, MIN_TURNS - 1);
    assert.equal(virtualizer.collect(".conversation-msg-user").length, MIN_TURNS + 2);
    assert.equal(virtualizer.exists("[data-message-id='u1']"), true);
    assert.equal(virtualizer.parkedCount, 3);

    const row = virtualizer.find<HTMLElement>("[data-message-id='u1']");
    assert.equal(row?.isConnected, true);
    assert.equal(turns[1]!.contains(row!), true);
    assert.equal(virtualizer.parkedCount, 2);
    assert.equal(restoredCount(), 1);
  });

  it("puts parked content back before the list is cleared or destroyed", async () => {
    const { list, turns, observer, virtualizer } = transcript(MIN_TURNS + 2);
    const first = turns[0]!;
    observer.fire([away(first)]);
    const row = virtualizer.collect("[data-message-id='u0']")[0]!;
    assert.equal(virtualizer.isParked(row), true);

    virtualizer.releaseAll();
    assert.equal(virtualizer.isParked(row), false);
    assert.equal(first.contains(row), true);

    observer.fire([away(first)]);
    first.remove();
    await flush();
    assert.equal(virtualizer.parkedCount, 0);
    assert.equal(first.contains(row), true);

    observer.fire([away(turns[1]!)]);
    virtualizer.destroy();
    assert.equal(turns[1]!.childElementCount, 1);
    assert.equal(list.querySelectorAll("[data-turn-parked]").length, 0);
  });
});
