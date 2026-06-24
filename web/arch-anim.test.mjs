// Regression test for the "How one round works" figure (#archfig) autoplay.
//
// Bug: when Play auto-advanced to the final step (6, "A anchors on-chain"), the
// advance() loop called archPause() *right after* archGoto(6). archPause clears
// archState.dots/timers, so it deleted the very tokens archGoto(6) had just
// created -> step 6 showed no animation. Manual "Next" worked because it runs
// archPause() *before* archGoto(6).
//
// This test runs the REAL archPlay/archGoto/archPause source out of app.js inside
// a stubbed SVG DOM + a discrete-event fake clock, drives autoplay to step 6, and
// asserts the step-6 token element is still connected the moment we arrive.
//
// Run:  node --test web/arch-anim.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "app.js"), "utf8");

// pull out only the arch animation block (ARCH_TOKENS .. end of initArch),
// skipping the module's load-time side effects (imports, wire(), reveal IO).
const START = SRC.indexOf("const ARCH_TOKENS");
const END = SRC.indexOf("// reveal on scroll");
assert.ok(START > 0 && END > START, "could not locate the arch block in app.js");
const ARCH_BLOCK = SRC.slice(START, END);

// the pre-fix (buggy) variant: collapse the soft-stop back to a hard archPause().
const BUGGY_BLOCK = ARCH_BLOCK.replace(
  /if \(archState\.step >= ARCH_STEPS\) \{[\s\S]*?\$\("arch-play"\)\.textContent = "▶ Play";\s*return;\s*\}/,
  'if (archState.step >= ARCH_STEPS) { archPause(); return; }'
);

// --- minimal SVG/DOM stub + discrete-event clock -----------------------------
function makeHarness() {
  // a controllable virtual clock: timers fire in scheduled order, clearTimeout removes them.
  let now = 0, seq = 1;
  const pending = new Map(); // id -> { at, fn }
  const setTimeoutStub = (fn, ms = 0) => { const id = seq++; pending.set(id, { at: now + ms, fn }); return id; };
  const clearTimeoutStub = (id) => { pending.delete(id); };
  // run the next due timer; returns false when none remain
  const tickOnce = () => {
    if (pending.size === 0) return false;
    let nid = null, best = Infinity;
    for (const [id, t] of pending) if (t.at < best) { best = t.at; nid = id; }
    const t = pending.get(nid); pending.delete(nid); now = t.at; t.fn();
    return true;
  };

  const svg = makeNode("svg");                 // doubles as #archfig
  const nodeById = new Map([["archfig", svg]]);
  const getById = (id) => {
    if (nodeById.has(id)) return nodeById.get(id);
    const n = makeNode(id.startsWith("e-") ? "path" : "div");
    if (id.startsWith("e-")) { n.ownerSVGElement = svg; n.getTotalLength = () => 100; n.getPointAtLength = () => ({ x: 0, y: 0 }); }
    nodeById.set(id, n);
    return n;
  };

  const document = {
    getElementById: getById,
    createElementNS: (_ns, tag) => makeNode(tag),
    querySelectorAll: () => [],
  };
  const window = { matchMedia: () => ({ matches: false }) };
  const performance = { now: () => now };
  const requestAnimationFrame = () => 0; // never tick the per-frame loop; we assert on creation, not motion
  const $ = (id) => document.getElementById(id);

  return { svg, document, window, performance, requestAnimationFrame, setTimeout: setTimeoutStub, clearTimeout: clearTimeoutStub, $, tickOnce };
}

function makeNode(tag) {
  const node = {
    nodeName: tag, _children: [], _parent: null, isConnected: false, textContent: "",
    _attr: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    style: { setProperty() {} },
    setAttribute(k, v) { this._attr[k] = v; },
    getAttribute(k) { return k in this._attr ? this._attr[k] : null; },
    appendChild(c) { c.isConnected = true; c._parent = this; this._children.push(c); return c; },
    remove() { this.isConnected = false; if (this._parent) this._parent._children = this._parent._children.filter((x) => x !== this); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  return node;
}

// build the arch module from a source block, run autoplay until step 6 is reached,
// return how many connected "arch-tok" tokens sit in the figure at that instant.
function connectedTokensAtFinalStep(block) {
  const h = makeHarness();
  const factory = new Function(
    "document", "window", "performance", "requestAnimationFrame", "setTimeout", "clearTimeout", "$", "SVGNS",
    block + "\n;return { archPlay, archGoto, archState };"
  );
  const mod = factory(h.document, h.window, h.performance, h.requestAnimationFrame, h.setTimeout, h.clearTimeout, h.$, "http://www.w3.org/2000/svg");
  mod.archState.revealed = true; // figure scrolled into view

  mod.archPlay();
  // drive the virtual clock until the autoplay chain lands on the final step
  let prev = mod.archState.step, guard = 0;
  while (guard++ < 10000) {
    if (mod.archState.step === 6 && prev !== 6) break; // just transitioned onto step 6
    prev = mod.archState.step;
    if (!h.tickOnce()) break;
  }
  assert.equal(mod.archState.step, 6, "autoplay should have reached the final step");

  return h.svg._children.filter((c) => c.isConnected && String(c.getAttribute("class") || "").includes("arch-tok")).length;
}

test("autoplay keeps step 6's token alive when it lands on the final step (fixed)", () => {
  const n = connectedTokensAtFinalStep(ARCH_BLOCK);
  assert.equal(n, 1, "step 6 should have its 'anchor' token present and connected, ready to animate");
});

test("the pre-fix source would wipe step 6's token (guard discriminates)", () => {
  const n = connectedTokensAtFinalStep(BUGGY_BLOCK);
  assert.equal(n, 0, "buggy archPause-on-final-step deletes the token archGoto(6) just created");
});
