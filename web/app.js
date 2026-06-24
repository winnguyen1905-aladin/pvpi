import { leafHash, merkleRoot, verifyLeafSignature, cryptoAvailable } from "./crypto.js";

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const trunc = (s, n = 18) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || `${r.status} ${url}`); return j;
}

function highlightJson(obj) {
  const s = JSON.stringify(obj, null, 2).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return s
    .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>')
    .replace(/: (-?\d+\.?\d*)/g, ': <span class="n">$1</span>');
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// keys-only preview: shows every key name but masks the actual values (used inline; full values live in the modal)
function maskedJson(obj, indent = 1) {
  const pad = "  ".repeat(indent), pad0 = "  ".repeat(indent - 1);
  if (Array.isArray(obj)) {
    if (!obj.length) return "[]";
    return `[\n${obj.map((v) => pad + maskedJson(v, indent + 1)).join(",\n")}\n${pad0}]`;
  }
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj);
    if (!keys.length) return "{}";
    return `{\n${keys.map((k) => `${pad}<span class="k">"${escHtml(k)}"</span>: ${maskedJson(obj[k], indent + 1)}`).join(",\n")}\n${pad0}}`;
  }
  return '<span class="mask">*****</span>';
}

// ---------- state ----------
const ENDPOINTS = JSON.parse(localStorage.getItem("fl-endpoints") || "null") || {
  // same-origin proxy paths: the present server forwards /svc/a|b|c to the A/B/C party servers,
  // so the whole demo works behind ONE port and nothing else needs to be exposed
  A: "/svc/a", B: "/svc/b", C: "/svc/c",
};
const S = { ids: {}, pubByRef: {}, session: null, round: null, steps: [], idx: -1, auto: null, ledger: [] };

// ---------- party identity cards ----------
const PARTY_ROLE = {
  A: { tag: "Coordinator", desc: "Shares x with B and C, averages their results, then stores the round's records off-chain and anchors the seal on-chain." },
  B: { tag: "Collaborator", desc: "Adds a private secret to x, signs the result, and sends it back to A." },
  C: { tag: "Collaborator", desc: "Adds a private secret to x, signs the result, and sends it back to A." },
};
function renderParties() {
  const wrap = $("party-cards"); if (!wrap) return; wrap.innerHTML = "";
  for (const name of ["A", "B", "C"]) {
    const id = S.ids[name];
    const lc = name.toLowerCase();
    const role = PARTY_ROLE[name];
    const card = el("div", `pcard ${lc}`);
    if (!id) { card.innerHTML = `<div class="pcard-head"><span class="nm ${lc}">Party ${name}</span><span class="role">offline</span></div><p class="pcard-role">Not connected.</p>`; wrap.appendChild(card); continue; }
    card.innerHTML = `
      <div class="pcard-head"><span class="nm ${lc}">Party ${name}</span><span class="role">${role.tag}</span></div>
      <p class="pcard-role">${role.desc}</p>
      <div class="kv"><span class="lab">id</span> <span class="val">${id.id}</span></div>
      <div class="kv"><span class="lab">pubKeyRef</span> <span class="val">${id.pubKeyRef}</span></div>
      ${id.secret != null ? `<div class="kv"><span class="lab">secret</span> <span class="val">${id.secret}</span></div>` : ""}
      ${id.walletAddress ? `<div class="kv"><span class="lab">wallet</span> <span class="val">${id.walletAddress}</span></div>` : ""}
      <button class="pcard-keys" data-party="${name}">⛶ Show keys</button>`;
    wrap.appendChild(card);
  }
}
function openKeysModal(name) {
  const id = S.ids[name]; if (!id) return;
  const pub = (id.publicKeyPem || "").trim() || "(no public key available)";
  const priv = (id.privateKeyPem || "").trim() || "(no private key available)";
  const html = `<div class="keys-modal">
    <h4>Public key</h4>
    <pre class="keypem">${escHtml(pub)}</pre>
    <h4>Private key <span class="badge">demo only</span></h4>
    <pre class="keypem">${escHtml(priv)}</pre>
  </div>`;
  showModal(`Party ${name} keys`, html);
}

async function connect() {
  S.ids = {}; S.pubByRef = {}; S.session = null;
  ENDPOINTS.A = $("ep-a").value.trim(); ENDPOINTS.B = $("ep-b").value.trim(); ENDPOINTS.C = $("ep-c").value.trim();
  localStorage.setItem("fl-endpoints", JSON.stringify(ENDPOINTS));
  // every (re)connect returns to the pre-session state
  $("sim-workspace").classList.add("gated");
  $("sim-empty").style.display = "";
  resetWorkspace();
  try {
    for (const name of ["A", "B", "C"]) {
      const id = await getJSON(`${ENDPOINTS[name]}/api/identity`);
      S.ids[name] = id; S.pubByRef[id.pubKeyRef] = id.publicKeyPem;
    }
    renderParties();
    $("sim-status").textContent = "Connected to A, B, C. Create a session to begin.";
    setGuidance("connected");
  } catch (e) {
    renderParties();
    $("sim-status").textContent = `Cannot reach the servers (${e.message}). Start them with npm run web, then Reconnect.`;
    setGuidance("disconnected");
  }
}

// ---------- guided button state machine (idempotent across connect / session / round) ----------
function setGuidance(phase) {
  const s = $("btn-session"), r = $("btn-round");
  s.classList.toggle("primary", phase === "connected");
  s.classList.toggle("muted", phase === "session" || phase === "ran");
  s.disabled = phase !== "connected"; // clickable only when connected with no active session (prevents mis-clicks)
  r.disabled = !(phase === "session" || phase === "ran");
  r.classList.toggle("primary", phase === "session" || phase === "ran");
  r.classList.toggle("cta-pulse", phase === "session"); // pulse only until the first round runs
}

// reset the round workspace to empty (fresh session / reconnect)
function resetWorkspace() {
  S.round = null; S.steps = []; S.idx = -1; S.ledger = [];
  clearFlowAnim(); // cancel any comet timers/tokens still in flight before the svg is wiped
  if (!$("modal").hidden) closeModal(); // tear down any open overlay on reset…
  if ($("sim-stage").classList.contains("focus-panel")) closeFocus(); // …and the walkthrough
  document.body.style.overflow = ""; // ensure the scroll lock is always released
  ["chain", "offchain", "console", "stepper", "step-summary", "step-json", "tamper-pick", "tamper-result"].forEach((id) => { const e = $(id); if (e) e.innerHTML = ""; });
  $("step-title").textContent = "Run a round to begin"; $("step-mech").textContent = "";
  $("step-json").hidden = true; $("step-log-label").hidden = true; $("step-raw-btn").hidden = true;
  $("step-prev").disabled = $("step-next").disabled = $("step-auto").disabled = true;
  $("tamper-pick").disabled = $("tamper-val").disabled = $("tamper-check").disabled = true;
  ["sim-stage", "sim-foot", "tamper", "walkthrough-bar"].forEach((id) => $(id).classList.add("gated")); // round output hidden until a round runs
  drawFlow([]);
}

// ---------- create session + run round ----------
async function createSession() {
  $("sim-status").textContent = "Creating session…";
  const meta = await postJSON(`${ENDPOINTS.A}/api/session`, { trainers: ["B", "C"] });
  resetWorkspace(); // a new session always starts clean
  S.session = meta.session_id;
  // reveal the workspace now that a session exists
  $("sim-empty").style.display = "none";
  $("sim-workspace").classList.remove("gated");
  renderParties();
  $("sim-status").textContent = `Session ${trunc(meta.session_id, 13)} ready. Now click “② Run a round”.`;
  setGuidance("session"); // dim Create session (now disabled), highlight + pulse Run a round
}

async function runRound() {
  setGuidance("ran"); // committed: drop the pulse, keep Run-a-round available for further rounds
  $("btn-round").disabled = true; $("sim-status").textContent = "Running round on the real backend…";
  try {
    const x = S.round ? undefined : 100; // first round x=100, then carry the model forward
    const data = await postJSON(`${ENDPOINTS.A}/api/session/${encodeURIComponent(S.session)}/round`, x !== undefined ? { x } : {});
    S.round = data;
    buildSteps(data);
    $("sim-status").textContent = `Round ${data.result.round_id} complete. New model x = ${data.result.x_new}. Step through it below.`;
    renderLedgerAppend(data.anchor, data.leaves);
    populateTamper(data.leaves);
    ["sim-foot", "tamper", "walkthrough-bar"].forEach((id) => $(id).classList.remove("gated")); // reveal the inline output + reopen control
    openWalkthrough(); // focus mode: the step-by-step walkthrough pops into a centered panel
    gotoStep(0);
    $("step-prev").disabled = $("step-next").disabled = $("step-auto").disabled = false;
  } catch (e) {
    $("sim-status").textContent = `Round failed: ${e.message}`;
  }
  $("btn-round").disabled = false;
}

// ---------- step model ----------
const byType = (leaves, t) => leaves.filter((l) => l.fields.type === t);
function bucketActivity(activity, kw) { return activity.filter((a) => a.toLowerCase().includes(kw)); }
const srow = (k, v, cls) => `<div class="srow"><span>${k}</span><b class="${cls || ""}">${v}</b></div>`;

function buildSteps(d) {
  const send = byType(d.leaves, "SEND")[0];
  const ugs = byType(d.leaves, "UPDATE_GRADIENT");
  const model = byType(d.leaves, "UPDATE_MODEL")[0];
  const anchor = d.anchor;
  const x = send?.fields.payload;
  const ugB = ugs[0]?.fields.payload, ugC = ugs[1]?.fields.payload;
  const bExpr = `x' = ${x} + ${S.ids.B?.secret} = `, cExpr = `x'' = ${x} + ${S.ids.C?.secret} = `;
  const shortCid = anchor?.cid ? anchor.cid.replace(/^cid:sha256:/, "").slice(0, 10) + "…" : "";
  const shortTx = anchor?.tx_hash ? anchor.tx_hash.replace(/^tx:sha256:/, "").slice(0, 10) + "…" : "";
  S.steps = [
    {
      code: "B0", title: "Setup: who is allowed to sign", lit: ["a", "b", "c"], msgs: [],
      mech: "Each party generates its own key pair. The public key is shared so anyone can check a signature; the private key never leaves its owner.",
      summary: srow("A", trunc(S.ids.A?.pubKeyRef, 22), "pa") + srow("B", trunc(S.ids.B?.pubKeyRef, 22), "pb") + srow("C", trunc(S.ids.C?.pubKeyRef, 22), "pc"),
      annot: { a: "holds x", b: "secret y", c: "secret z" },
      json: { registry: Object.fromEntries(["A", "B", "C"].map((n) => [n, S.ids[n]?.pubKeyRef])) }, log: [],
    },
    {
      code: "B1", title: "Step 1: A shares the number x", lit: ["a", "b", "c"], msgs: [["a", "b", "x", 120], ["a", "c", "x", 120]],
      mech: "A writes a record saying \"the current value is x\", signs it, and broadcasts the same signed record to both collaborators.",
      summary: srow("From", "A | coordinator", "pa") + srow("To", "B and C") + srow("Value x", x) + srow("Signed", "yes ✓"),
      annot: { a: `shares x = ${x}` },
      json: send, log: bucketActivity(d.activity, "send"),
    },
    {
      code: "B2", title: "Step 2: B and C compute privately", lit: ["b", "c"], msgs: [],
      mech: "Each collaborator checks A's signature, then adds its own secret value to x. The secret never leaves; only the result is published.",
      summary: srow("B computes", `x' = ${x} + ${S.ids.B?.secret} = ${ugB}`, "pb") + srow("C computes", `x'' = ${x} + ${S.ids.C?.secret} = ${ugC}`, "pc") + srow("Secrets", "stay private"),
      annot: { b: bExpr + ugB, c: cExpr + ugC },
      compute: { b: { prefix: bExpr, from: x, to: ugB }, c: { prefix: cExpr, from: x, to: ugC } },
      json: ugs, log: [`B: x' = ${x} + ${S.ids.B?.secret} = ${ugB}`, `C: x'' = ${x} + ${S.ids.C?.secret} = ${ugC}`],
    },
    {
      code: "B3", title: "Step 3: B and C send signed results back", lit: ["a", "b", "c"], msgs: [["b", "a", "x'", 120], ["c", "a", "x''", 120]],
      mech: "Both send their signed results to A. A confirms the sender matches the signature and that it belongs to this round before accepting.",
      summary: srow("B to A", "signed result ✓", "pb") + srow("C to A", "signed result ✓", "pc") + srow("A checks", "sender = signer"),
      annot: { a: "verifies signers", b: `sends x' = ${ugB}`, c: `sends x'' = ${ugC}` },
      json: ugs, log: bucketActivity(d.activity, "update_gradient"),
    },
    {
      code: "B4", title: "Step 4: A combines into the new model", lit: ["a"], msgs: [],
      mech: "A re-checks both results, averages them into the next model value, and signs that result too, linked to exactly the inputs that produced it.",
      summary: srow("Inputs", `${ugB}, ${ugC}`) + srow("New model x", d.result.x_new, "pa") + srow("Signed", "yes ✓"),
      annot: { a: `mean = ${d.result.x_new}` },
      json: model, log: bucketActivity(d.activity, "aggregate"),
    },
    {
      code: "B5", title: "Step 5: A stores the records off-chain", lit: ["a", "off"], msgs: [["a", "off", "leaves", 120], ["off", "a", "cid", 880]],
      mech: "A bundles the four signed Merkle leaves and pushes them to the off-chain store (IPFS-style). It gets back a content id (cid), the address and fingerprint of the bundle, which must exist before anything goes on-chain.",
      summary: srow("Leaves stored", d.leaves.length, "pa") + srow("Batch fingerprint", trunc(anchor?.merkle_root, 22)) + srow("Off-chain id (cid)", trunc(anchor?.cid, 22)),
      annot: { a: "bundle leaves", off: `cid ${shortCid}` },
      json: { cid: anchor?.cid, merkle_root: anchor?.merkle_root, leaves: d.leaves },
      log: [`A: stored ${d.leaves.length} leaves off-chain, cid ${anchor?.cid}`],
    },
    {
      code: "B6", title: "Step 6: A anchors on-chain", lit: ["a", "on"], msgs: [["a", "on", "anchor", 120], ["on", "a", "tx", 880]],
      mech: "A posts a tiny anchor to the public ledger: the batch fingerprint plus the off-chain cid, signed by its wallet and linked to the previous anchor (previous_tx_hash) so the history can't be rewritten.",
      summary: srow("References cid", trunc(anchor?.cid, 22)) + srow("Seal id (tx_hash)", trunc(anchor?.tx_hash, 22)) + srow("Links to", anchor?.previous_tx_hash ? trunc(anchor.previous_tx_hash, 20) : "genesis block"),
      annot: { a: "anchor cid", on: `tx ${shortTx}` },
      json: anchor, log: bucketActivity(d.activity, "anchor"),
    },
  ];
  renderStepper();
}

function renderStepper() {
  const ol = $("stepper"); ol.innerHTML = "";
  S.steps.forEach((s, i) => {
    const li = el("li", "", `${s.title}<small>${s.code}</small>`);
    li.tabIndex = 0; li.setAttribute("role", "button"); // keyboard-operable inside the focus panel
    li.onclick = () => gotoStep(i);
    li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); gotoStep(i); } };
    ol.appendChild(li);
  });
}

function gotoStep(i) {
  if (i < 0 || i >= S.steps.length) return;
  S.idx = i;
  const step = S.steps[i];
  [...$("stepper").children].forEach((li, k) => {
    li.classList.toggle("active", k === i);
    li.classList.toggle("done", k < i);
  });
  $("step-title").textContent = step.title;
  $("step-mech").textContent = step.mech;
  $("step-summary").innerHTML = step.summary || "";
  // inline shows keys only (values masked); the ⛶ button opens the full log in a centered panel
  $("step-json").innerHTML = step.json ? maskedJson(step.json) : "";
  $("step-json").hidden = !step.json;
  $("step-log-label").hidden = !step.json;
  $("step-raw-btn").hidden = !step.json;
  clearFlowAnim(); // cancel any tokens/timers still scheduled from the previous step
  drawFlow(step.lit, step.annot);
  if (step.compute) { // step 2: count up x'/x'' AND pulse each collaborator that is computing
    Object.entries(step.compute).forEach(([n, c]) => { animateCompute(n, c); flowPulse($("flow"), center(n).x, center(n).y, TINT[n] || TINT.primary); });
  }
  step.msgs.forEach((m, k) => flowTimers.push(setTimeout(() => animateDot(m[0], m[1], m[2]), m[3] != null ? m[3] : 120 + k * 220)));
  renderConsole(i); // rebuild from steps 0..i so navigating back/forth never duplicates lines
}

// autoplay dwell for a step: long enough for its slowest comet (delay + 760ms travel) to arrive and pulse,
// so a two-way step's return leg (e.g. cid/tx back to A at delay 880) is never clipped by the next gotoStep
function stepDwell(step) {
  const base = 1100;
  if (!step.msgs || !step.msgs.length) return base;
  const lastArrival = Math.max(...step.msgs.map((m, k) => (m[3] != null ? m[3] : 120 + k * 220) + 760));
  return Math.max(base, lastArrival + 180); // small breath for the arrival pulse before advancing
}

// count the x' / x'' result up from `from` to `to` on the node's annotation, ending with a brief highlight
function animateCompute(node, c) {
  const t = $("flow")?.querySelector(`.fn.${node} .fn-annot`);
  if (!t) return;
  if (prefersReducedMotion()) { t.textContent = c.prefix + c.to; return; }
  const dur = 750, t0 = performance.now();
  t.classList.add("computing");
  const tick = (now) => {
    if (!t.isConnected) return; // step changed
    const p = Math.min(1, (now - t0) / dur);
    t.textContent = c.prefix + Math.round(c.from + (c.to - c.from) * p);
    if (p < 1) requestAnimationFrame(tick);
    else { t.textContent = c.prefix + c.to; t.classList.remove("computing"); t.classList.add("computed"); }
  };
  requestAnimationFrame(tick);
}

// ---------- flow svg ----------
const NODE = {
  a: { x: 250, y: 28, w: 140, h: 46, label: "A | coordinator" },
  b: { x: 40, y: 140, w: 130, h: 46, label: "B | collaborator" },
  c: { x: 470, y: 140, w: 130, h: 46, label: "C | collaborator" },
  off: { x: 150, y: 258, w: 140, h: 46, label: "Off-chain store" },
  on: { x: 350, y: 258, w: 140, h: 46, label: "Public ledger" },
};
const SVGNS = "http://www.w3.org/2000/svg";
const center = (n) => ({ x: NODE[n].x + NODE[n].w / 2, y: NODE[n].y + NODE[n].h / 2 });
const LINKS = [["a", "b"], ["a", "c"], ["a", "off"], ["a", "on"]];

function drawFlow(lit = [], annot = {}) {
  const svg = $("flow"); if (!svg) return;
  svg.innerHTML = "";
  for (const [u, v] of LINKS) {
    const a = center(u), b = center(v);
    const p = document.createElementNS(SVGNS, "line");
    p.setAttribute("x1", a.x); p.setAttribute("y1", a.y); p.setAttribute("x2", b.x); p.setAttribute("y2", b.y);
    p.setAttribute("class", "lnk");
    svg.appendChild(p);
  }
  for (const [name, n] of Object.entries(NODE)) {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", `fn ${name} ${lit.includes(name) ? "" : "dim"}`);
    const r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("x", n.x); r.setAttribute("y", n.y); r.setAttribute("width", n.w); r.setAttribute("height", n.h); r.setAttribute("rx", 9);
    const t = document.createElementNS(SVGNS, "text");
    t.setAttribute("x", n.x + n.w / 2); t.setAttribute("y", n.y + n.h / 2 + 4); t.textContent = n.label;
    g.appendChild(r); g.appendChild(t);
    // per-node computation label for the current step
    const note = annot && annot[name];
    if (note) {
      const below = name === "a"; // A's note sits above its box (top node), others below
      const at = document.createElementNS(SVGNS, "text");
      at.setAttribute("class", "fn-annot");
      at.setAttribute("x", n.x + n.w / 2);
      at.setAttribute("y", below ? n.y - 8 : n.y + n.h + 16);
      at.textContent = note;
      g.appendChild(at);
    }
    svg.appendChild(g);
  }
}

// the same polished "comet" used by #archfig, here gliding the straight #flow links: glow bead + tapering
// trail + haloed label, eased, tinted by the sender, with an arrival pulse. Returns (to A) render hollow.
let flowTokens = [], flowTimers = [];
function animateDot(from, to, label) {
  const svg = $("flow"); if (!svg || prefersReducedMotion()) return;
  const a = center(from), b = center(to), tint = TINT[from] || TINT.primary, kind = to === "a" ? "return" : "send";
  const g = document.createElementNS(SVGNS, "g"); g.setAttribute("class", `arch-tok t-${from} ${kind}`);
  g.style.setProperty("--tok", tint);
  const ghosts = [];
  for (let i = 0; i < TRAIL; i++) { const c = document.createElementNS(SVGNS, "circle"); c.setAttribute("r", 4 - i); c.setAttribute("class", "arch-tok-ghost"); c.style.opacity = String(0.28 * (1 - (i + 1) / (TRAIL + 1))); g.appendChild(c); ghosts.push(c); }
  const glow = document.createElementNS(SVGNS, "circle"); glow.setAttribute("r", 10); glow.setAttribute("class", "arch-tok-glow"); g.appendChild(glow);
  const bead = document.createElementNS(SVGNS, "circle"); bead.setAttribute("r", 5); bead.setAttribute("class", "arch-tok-bead"); g.appendChild(bead);
  if (label) { const t = document.createElementNS(SVGNS, "text"); t.setAttribute("class", "arch-tok-label"); t.setAttribute("y", -12); t.textContent = label; g.appendChild(t); }
  svg.appendChild(g); flowTokens.push(g);
  const t0 = performance.now(), dur = 760;
  const tick = (t) => {
    if (!g.isConnected) return;
    const raw = Math.min(1, (t - t0) / dur), e = easeInOut(raw);
    const x = a.x + (b.x - a.x) * e, y = a.y + (b.y - a.y) * e;
    g.setAttribute("transform", `translate(${x},${y})`);
    for (let i = 0; i < TRAIL; i++) { const e2 = Math.max(0, e - 0.05 * (i + 1)); ghosts[i].setAttribute("cx", a.x + (b.x - a.x) * e2 - x); ghosts[i].setAttribute("cy", a.y + (b.y - a.y) * e2 - y); }
    if (raw < 1) requestAnimationFrame(tick); else { flowPulse(svg, b.x, b.y, tint); g.remove(); flowTokens = flowTokens.filter((d) => d !== g); }
  };
  requestAnimationFrame(tick);
}
function flowPulse(svg, x, y, tint) {
  if (!svg || prefersReducedMotion()) return;
  const ring = document.createElementNS(SVGNS, "circle");
  ring.setAttribute("cx", x); ring.setAttribute("cy", y); ring.setAttribute("r", 6);
  ring.setAttribute("class", "arch-pulse"); ring.style.setProperty("--tok", tint);
  svg.appendChild(ring); flowTokens.push(ring);
  flowTimers.push(setTimeout(() => { ring.remove(); flowTokens = flowTokens.filter((d) => d !== ring); }, 560));
}
function clearFlowAnim() {
  flowTimers.forEach(clearTimeout); flowTimers = [];
  flowTokens.forEach((d) => d.remove()); flowTokens = [];
}

// ---------- centered float panel (full views: record / activity log / ledger) ----------
let modalOpener = null;
function showModal(title, bodyHtml, opts = {}) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHtml || "<p class='modal-empty'>Nothing yet. Run a round first.</p>";
  const panel = $("modal").querySelector(".modal-panel");
  if (panel) panel.classList.toggle("wide", !!opts.wide); // ledger panel opens wider; reset for every other modal
  modalOpener = document.activeElement;
  $("modal").hidden = false;
  document.body.style.overflow = "hidden";
  $("modal-close").focus(); // move focus into the dialog
}
function openModal(title, sourceId, kind) {
  const src = $(sourceId);
  const inner = src && src.innerHTML.trim() ? src.innerHTML : "";
  let html = "";
  if (!inner) html = "";
  else if (kind === "console") html = `<pre class="console modal-fill">${inner}</pre>`;
  else if (kind === "chain") html = `<div class="chain modal-fill">${inner}</div>`;
  else html = inner;
  showModal(title, html);
}
function openRecordModal() {
  const step = S.steps[S.idx];
  if (!step || !step.json) return;
  showModal(`Full log: ${step.title}`, `<pre class="json-view modal-fill">${highlightJson(step.json)}</pre>`);
}
function closeModal() {
  $("modal").hidden = true;
  $("modal-body").innerHTML = "";
  // keep the scroll lock if the walkthrough focus-panel is still open underneath
  document.body.style.overflow = $("sim-stage").classList.contains("focus-panel") ? "hidden" : "";
  if (modalOpener && modalOpener.focus) modalOpener.focus(); // restore focus to the trigger
  modalOpener = null;
}

// ---------- focus-mode walkthrough panel (#sim-stage as a centered overlay) ----------
let focusOpener = null;
function openWalkthrough() {
  const stage = $("sim-stage");
  focusOpener = document.activeElement;
  stage.classList.remove("gated");
  stage.classList.add("focus-panel");
  stage.setAttribute("aria-modal", "true");
  $("focus-backdrop").hidden = false;
  document.body.style.overflow = "hidden";
  $("focus-close").focus();
}
function closeFocus() {
  const stage = $("sim-stage");
  stage.classList.remove("focus-panel");
  stage.classList.add("gated");
  stage.removeAttribute("aria-modal");
  $("focus-backdrop").hidden = true;
  if ($("modal").hidden) document.body.style.overflow = "";
  if (focusOpener && focusOpener.focus) focusOpener.focus();
  focusOpener = null;
}
// Esc closes the overlay; Tab cycles within it so the background stays unreachable and the panel's own controls stay reachable
function handleOverlayKey(e, container, onClose) {
  if (e.key === "Escape") { onClose(); return; }
  if (e.key !== "Tab" || !container) return;
  const f = [...container.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
    .filter((el) => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ---------- console ----------
function appendConsole(lines) {
  const c = $("console");
  for (const ln of lines || []) {
    const m = ln.match(/^\[(.+?)\]\[(.+?)\]\[(.+?)\] - (.*)$/);
    const div = el("div");
    if (m) div.innerHTML = `<span class="ts">[${m[1].slice(11, 23)}]</span><span class="fr">[${m[2]}]</span><span class="to">[${m[3]}]</span> <span class="ct">${m[4]}</span>`;
    else div.innerHTML = `<span class="ct">${ln}</span>`;
    c.appendChild(div);
  }
  c.scrollTop = c.scrollHeight;
}
// rebuild the round's activity log from steps 0..i (idempotent, no duplicates on back/forth navigation)
function renderConsole(uptoIdx) {
  $("console").innerHTML = "";
  for (let k = 0; k <= uptoIdx; k++) appendConsole(S.steps[k]?.log);
}

// ---------- ledger (off-chain = CID maps to stored leaves bundle; on-chain = tx maps to anchor) ----------
const roundLabel = (r) => (r && typeof r === "object") ? `${r.round_start}-${r.round_end}` : r; // batched anchors use a range
// off-chain block: addressed by CID; the stored content is the leaves array, exactly what IPFS would return for that CID
function offBlockHtml(anchor, leaves) {
  const count = Array.isArray(leaves) ? leaves.length : 0;
  return `<div class="lhi"><span class="lhi-k">CID</span><span class="lhi-v">${escHtml(anchor.cid)}</span></div>` +
    `<div class="lmeta">round ${escHtml(roundLabel(anchor.round_id))}, stored bundle (${count} signed leaves):</div>` +
    `<pre class="json-view ledger-json">${highlightJson(leaves || [])}</pre>`;
}
// on-chain block: addressed by tx_hash; the content is the anchor, a blockchain transaction that references the CID
function onBlockHtml(anchor) {
  return `<div class="lhi"><span class="lhi-k">tx_hash</span><span class="lhi-v">${escHtml(anchor.tx_hash)}</span></div>` +
    `<div class="lmeta">round ${escHtml(roundLabel(anchor.round_id))}, sealed transaction:</div>` +
    `<pre class="json-view ledger-json">${highlightJson(anchor)}</pre>`;
}
function renderLedgerAppend(anchor, leaves) {
  if (!anchor) return;
  S.ledger.unshift({ anchor, leaves: leaves || [] }); // newest first, matches the prepend order below; rebuilt as paired rows in the modal
  const off = el("div", "lblock"); off.innerHTML = offBlockHtml(anchor, leaves); $("offchain").prepend(off);
  const on = el("div", "lblock"); on.dataset.tx = anchor.tx_hash; on.innerHTML = onBlockHtml(anchor); $("chain").prepend(on);
}
function openLedgerModal() {
  if (!S.ledger.length) { showModal("Ledger: off-chain & on-chain", "", { wide: true }); return; }
  // one grid row per round: the round label, its off-chain bundle, and the matching on-chain seal, all top-aligned
  const rows = S.ledger.map(({ anchor, leaves }) =>
    `<div class="ledger-rnum"><span>round</span><b>${escHtml(roundLabel(anchor.round_id))}</b></div>` +
    `<div class="lblock">${offBlockHtml(anchor, leaves)}</div>` +
    `<div class="lblock" data-tx="${escHtml(anchor.tx_hash)}">${onBlockHtml(anchor)}</div>`
  ).join("");
  const html = `<div class="ledger-book">` +
    `<div class="lcol-h lbh-num">Round</div>` +
    `<div class="lcol-h lbh-off">Off-chain: the stored records</div>` +
    `<div class="lcol-h lbh-on">On-chain: the sealed anchors</div>` +
    rows + `</div>`;
  showModal("Ledger: off-chain & on-chain", html, { wide: true });
}

// ---------- tamper demo ----------
function populateTamper(leaves) {
  const sel = $("tamper-pick"); sel.innerHTML = "";
  leaves.forEach((l, i) => {
    const opt = el("option", "", `${l.fields.type} (value=${l.fields.payload})`);
    opt.value = String(i);
    sel.appendChild(opt);
  });
  sel.disabled = false; $("tamper-val").disabled = false; $("tamper-check").disabled = false;
  syncTamperVal();
}
function syncTamperVal() {
  const l = S.round.leaves[Number($("tamper-pick").value)];
  $("tamper-val").value = String(l.fields.payload);
}
async function tamperCheck() {
  const leaves = S.round.leaves.map((l) => ({ ...l, fields: { ...l.fields } }));
  const i = Number($("tamper-pick").value);
  const raw = $("tamper-val").value.trim();
  const newVal = isNaN(Number(raw)) ? raw : Number(raw);
  const changed = newVal !== leaves[i].fields.payload;
  leaves[i].fields.payload = newVal;

  // 1) signature of the edited leaf
  const sigOk = await verifyLeafSignature(leaves[i].fields, leaves[i].signature, S.pubByRef[leaves[i].fields.actor] || "");
  // 2) recompute merkle root over all leaves and compare to the anchored root
  const hashes = [];
  for (const l of leaves) hashes.push(await leafHash(l.fields, l.signature));
  const root = await merkleRoot(hashes);
  const anchored = S.round.anchor.merkle_root;
  const rootOk = root === anchored;

  const out = $("tamper-result"); out.innerHTML = "";
  const check = (ok, title, detail) => {
    const c = el("div", `check ${ok ? "pass" : "fail"}`);
    c.innerHTML = `<b>${ok ? "✓ " : "✗ "}${title}</b><span class="detail">${detail}</span>`;
    return c;
  };
  out.appendChild(check(sigOk, "The signature", sigOk ? "still matches the author's key" : "no longer matches, the change is caught"));
  out.appendChild(check(rootOk, "The batch fingerprint", rootOk ? "matches the sealed batch" : "no longer matches the sealed batch"));
  out.appendChild(check(rootOk, "The public seal", rootOk ? "agrees with the ledger" : "disagrees with the ledger, tamper detected"));

  // visually break the affected on-chain block
  const blk = $("chain").querySelector(`[data-tx="${S.round.anchor.tx_hash}"]`);
  if (blk) blk.classList.toggle("bad", changed && !rootOk);
}

// ---------- wiring ----------
function wire() {
  $("ep-a").value = ENDPOINTS.A; $("ep-b").value = ENDPOINTS.B; $("ep-c").value = ENDPOINTS.C;
  $("ep-connect").onclick = connect;
  $("btn-session").onclick = () => createSession().catch((e) => ($("sim-status").textContent = e.message));
  $("btn-round").onclick = runRound;
  $("step-prev").onclick = () => gotoStep(S.idx - 1);
  $("step-next").onclick = () => gotoStep(S.idx + 1);
  $("step-auto").onclick = async () => { for (let i = S.idx + 1; i < S.steps.length; i++) { gotoStep(i); await sleep(stepDwell(S.steps[i])); } };
  $("step-raw-btn").onclick = openRecordModal;
  $("party-cards").onclick = (e) => { const b = e.target.closest(".pcard-keys"); if (b) openKeysModal(b.dataset.party); };
  $("console-open").onclick = () => openModal("Activity log: this round", "console", "console");
  $("chain-open").onclick = openLedgerModal;
  $("modal-close").onclick = closeModal;
  $("modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
  $("walkthrough-open").onclick = openWalkthrough;
  $("focus-close").onclick = closeFocus;
  $("focus-backdrop").onclick = closeFocus;
  document.addEventListener("keydown", (e) => {
    // the #modal (record/log/ledger/keys) can sit ABOVE the focus panel, so it takes precedence
    if (!$("modal").hidden) { handleOverlayKey(e, $("modal").querySelector(".modal-panel"), closeModal); return; }
    if ($("sim-stage").classList.contains("focus-panel")) handleOverlayKey(e, $("sim-stage"), closeFocus);
  });
  $("tamper-pick").onchange = syncTamperVal;
  $("tamper-check").onclick = () => tamperCheck().catch((e) => ($("tamper-result").textContent = e.message));
  if (!cryptoAvailable()) $("sim-status").textContent = "Web Crypto unavailable. Open the page over http://localhost (npm run web), not as a file://.";
  drawFlow([]); renderParties();
  initArch();
  wireGlossary();
  wireCollapsibles();
  connect(); // attempt with defaults
}

// collapsible Q&A sections: the header is a button that shows/hides the section body
function wireCollapsibles() {
  document.querySelectorAll(".q-collapse > .q-head").forEach((h) => {
    const sec = h.parentElement;
    h.setAttribute("role", "button");
    h.setAttribute("tabindex", "0");
    h.setAttribute("aria-expanded", "false");
    const toggle = () => h.setAttribute("aria-expanded", sec.classList.toggle("open") ? "true" : "false");
    h.addEventListener("click", toggle);
    h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  });
  // following an in-page link to a collapsed section opens it (nav links + hero cards)
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]'); if (!a) return;
    const href = a.getAttribute("href"); if (href.length < 2) return;
    const t = document.querySelector(href);
    if (t && t.classList.contains("q-collapse") && !t.classList.contains("open")) {
      t.classList.add("open"); t.querySelector(".q-head")?.setAttribute("aria-expanded", "true");
    }
  });
}

// filter the glossary rows by term / meaning / form
function wireGlossary() {
  const input = $("glossary-search"); if (!input) return;
  const rows = [...document.querySelectorAll(".glossary tbody tr")];
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    let any = false;
    rows.forEach((r) => { const show = !q || r.textContent.toLowerCase().includes(q); r.hidden = !show; any = any || show; });
    $("glossary-empty").hidden = any;
  };
}

// ---------- figure 1: controlled animated round ----------
// each step owns ordered token descriptors {edge,label,tint,kind,reverse?,delay?}; returns reuse the send path reversed
const ARCH_TOKENS = {
  1: [{ edge: "e-ab", label: "x", tint: "a", kind: "send" }, { edge: "e-ac", label: "x", tint: "a", kind: "send", delay: 160 }],
  2: [],
  3: [{ edge: "e-ba", label: "x'", tint: "b", kind: "send" }, { edge: "e-ca", label: "x''", tint: "c", kind: "send", delay: 160 }],
  4: [{ edge: "e-loop", label: "x_new", tint: "a", kind: "send" }],
  5: [{ edge: "e-off", label: "leaves", tint: "off", kind: "send" }, { edge: "e-off", label: "cid", tint: "off", kind: "return", reverse: true, delay: 1040 }],
  6: [{ edge: "e-on", label: "anchor", tint: "on", kind: "send" }, { edge: "e-on", label: "tx", tint: "on", kind: "return", reverse: true, delay: 1040 }],
};
const TINT = { a: "var(--a)", b: "var(--b)", c: "var(--c)", off: "var(--off)", on: "var(--on)", primary: "var(--primary)" };
const ARCH_DWELL = { 1: 1900, 2: 1200, 3: 1900, 4: 1700, 5: 2600, 6: 2600 }; // autoplay dwell so two-way steps finish their round trip
const ARCH_LAND = { "e-ab": ["b", "a"], "e-ac": ["c", "a"], "e-ba": ["a", "b"], "e-ca": ["a", "c"], "e-loop": ["a", "a"], "e-off": ["off", "a"], "e-on": ["on", "a"] };
const ARCH_STEPS = 6;
const TRAIL = 3;
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const archState = { step: 1, playing: false, timer: null, dots: [], timers: [], revealed: false };
const prefersReducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// a labeled "comet" token (glow bead + tapering trail + haloed label) eased along the real curve; returns retrace reversed
function animatePathToken(tok) {
  if (prefersReducedMotion()) return; // reduced motion: static lit/dim only, no token
  const pathEl = document.getElementById(tok.edge); if (!pathEl) return;
  const svg = pathEl.ownerSVGElement; if (!svg) return;
  const dur = tok.kind === "return" ? 860 : tok.edge === "e-loop" ? 1100 : 900;
  const ease = tok.edge === "e-loop" ? easeOut : easeInOut;
  const reverse = !!tok.reverse, dir = reverse ? -1 : 1;
  const start = () => {
    if (archState.step !== tok._step) return; // user navigated away during the delay
    const len = pathEl.getTotalLength(), lag = len * 0.02;
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", `arch-tok t-${tok.tint} ${tok.kind}`);
    g.style.setProperty("--tok", TINT[tok.tint] || TINT.primary);
    const ghosts = [];
    for (let i = 0; i < TRAIL; i++) {
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("r", 4.5 - i); c.setAttribute("class", "arch-tok-ghost");
      c.style.opacity = String(0.3 * (1 - (i + 1) / (TRAIL + 1)));
      g.appendChild(c); ghosts.push(c);
    }
    const glow = document.createElementNS(SVGNS, "circle"); glow.setAttribute("r", 11); glow.setAttribute("class", "arch-tok-glow"); g.appendChild(glow);
    const bead = document.createElementNS(SVGNS, "circle"); bead.setAttribute("r", 5.5); bead.setAttribute("class", "arch-tok-bead"); g.appendChild(bead);
    const lbl = document.createElementNS(SVGNS, "text"); lbl.setAttribute("class", "arch-tok-label"); lbl.setAttribute("y", -14); lbl.textContent = tok.label || ""; g.appendChild(lbl);
    svg.appendChild(g); archState.dots.push(g);
    const t0 = performance.now();
    const tick = (t) => {
      if (!g.isConnected) return; // cleared by archPause / archGoto
      const raw = Math.min(1, (t - t0) / dur), e = ease(raw), d = reverse ? len * (1 - e) : len * e;
      const pt = pathEl.getPointAtLength(d);
      g.setAttribute("transform", `translate(${pt.x},${pt.y})`);
      for (let i = 0; i < TRAIL; i++) {
        const dd = Math.max(0, Math.min(len, d - lag * (i + 1) * dir));
        const pp = pathEl.getPointAtLength(dd);
        ghosts[i].setAttribute("cx", pp.x - pt.x); ghosts[i].setAttribute("cy", pp.y - pt.y);
      }
      lbl.style.opacity = raw < 0.14 ? raw / 0.14 : raw > 0.86 ? (1 - raw) / 0.14 : 1; // fade in/out at the ends
      if (raw < 1) requestAnimationFrame(tick); else archLand(svg, pathEl, len, reverse, tok, g);
    };
    requestAnimationFrame(tick);
  };
  if (tok.delay) archState.timers.push(setTimeout(start, tok.delay)); else start();
}

// arrival "receipt": an expanding ring at the endpoint + a brief tint glow on the destination node
function archLand(svg, pathEl, len, reverse, tok, g) {
  const end = pathEl.getPointAtLength(reverse ? 0 : len);
  const ring = document.createElementNS(SVGNS, "circle");
  ring.setAttribute("cx", end.x); ring.setAttribute("cy", end.y); ring.setAttribute("r", 6);
  ring.setAttribute("class", "arch-pulse"); ring.style.setProperty("--tok", TINT[tok.tint] || TINT.primary);
  svg.appendChild(ring); archState.dots.push(ring);
  archState.timers.push(setTimeout(() => { ring.remove(); archState.dots = archState.dots.filter((d) => d !== ring); }, 540));
  const tgt = (ARCH_LAND[tok.edge] || [])[reverse ? 1 : 0];
  const node = $("archfig").querySelector(`.arch-node.${tgt}`);
  if (node) { node.style.setProperty("--tok", TINT[tok.tint] || TINT.primary); node.classList.add("recv"); archState.timers.push(setTimeout(() => node.classList.remove("recv"), 520)); }
  g.remove(); archState.dots = archState.dots.filter((d) => d !== g);
}

function archGoto(k) {
  k = Math.max(1, Math.min(ARCH_STEPS, k));
  archState.step = k;
  const fig = $("archfig"); if (!fig) return;
  fig.querySelectorAll("[data-steps]").forEach((elm) => {
    const on = elm.getAttribute("data-steps").split(" ").includes(String(k));
    elm.classList.toggle("lit", on);
    elm.classList.toggle("dim", !on);
  });
  document.querySelectorAll(".flow .fstep").forEach((c) => {
    const active = c.dataset.step === String(k);
    c.classList.toggle("on", active);     // highlight the current step
    c.classList.toggle("dim", !active);   // fade the rest
  });
  $("arch-stepnum").textContent = `Step ${k} / ${ARCH_STEPS}`;
  if (archState.revealed && !prefersReducedMotion()) {
    archState.timers.forEach(clearTimeout); archState.timers = [];          // cancel in-flight staggers / returns
    archState.dots.forEach((d) => d.remove()); archState.dots = [];          // remove the prior step's tokens / rings
    fig.querySelectorAll(".arch-node.recv").forEach((n) => n.classList.remove("recv"));
    fig.querySelectorAll(".arch-eq.compute-pop").forEach((e) => e.classList.remove("compute-pop"));
    if (k === 2) archComputeBeat(fig); // step 2 moves nothing along an edge, show B & C computing x'=x+y, x''=x+z
    (ARCH_TOKENS[k] || []).forEach((t) => { t._step = k; animatePathToken(t); });
  }
}

// step 2 "compute" beat: pulse B and C, flare their boxes, and pop their x'=x+y / x''=x+z equations
function archComputeBeat(fig) {
  [["b", 100, 277], ["c", 620, 277]].forEach(([n, cx, cy]) => {
    const tint = TINT[n];
    const ring = document.createElementNS(SVGNS, "circle");
    ring.setAttribute("cx", cx); ring.setAttribute("cy", cy); ring.setAttribute("r", 6);
    ring.setAttribute("class", "arch-pulse"); ring.style.setProperty("--tok", tint);
    fig.appendChild(ring); archState.dots.push(ring);
    archState.timers.push(setTimeout(() => { ring.remove(); archState.dots = archState.dots.filter((d) => d !== ring); }, 560));
    const node = fig.querySelector(`.arch-node.${n}`);
    if (node) { node.style.setProperty("--tok", tint); node.classList.add("recv"); archState.timers.push(setTimeout(() => node.classList.remove("recv"), 520)); }
  });
  fig.querySelectorAll(".arch-eq.lit").forEach((eq) => { eq.classList.add("compute-pop"); archState.timers.push(setTimeout(() => eq.classList.remove("compute-pop"), 640)); });
}

function archPause() {
  archState.playing = false;
  clearTimeout(archState.timer);
  archState.timers.forEach(clearTimeout); archState.timers = []; // cancel staggers, return delays, ring cleanups
  archState.dots.forEach((d) => d.remove()); archState.dots = []; // remove tokens + rings in flight
  $("archfig").querySelectorAll(".arch-node.recv").forEach((n) => n.classList.remove("recv"));
  $("archfig").querySelectorAll(".arch-eq.compute-pop").forEach((e) => e.classList.remove("compute-pop"));
  $("arch-play").textContent = "▶ Play";
}

function archPlay() {
  if (archState.playing) { archPause(); return; }
  archState.playing = true;
  $("arch-play").textContent = "❚❚ Pause";
  if (archState.step >= ARCH_STEPS) archGoto(1); else archGoto(archState.step);
  const advance = () => {
    if (!archState.playing) return;
    if (archState.step >= ARCH_STEPS) {
      // reached the last step: stop the loop but let its just-spawned tokens play out
      // (archPause would clear the dots/timers archGoto(6) just created, so soft-stop instead)
      archState.playing = false;
      clearTimeout(archState.timer);
      $("arch-play").textContent = "▶ Play";
      return;
    }
    archState.timer = setTimeout(() => { archGoto(archState.step + 1); advance(); }, ARCH_DWELL[archState.step] || 1700);
  };
  advance();
}

function initArch() {
  if (!$("archfig")) return;
  $("arch-prev").onclick = () => { archPause(); archGoto(archState.step - 1); };
  $("arch-next").onclick = () => { archPause(); archGoto(archState.step + 1); };
  $("arch-play").onclick = archPlay;
  $("arch-replay").onclick = () => { archPause(); archGoto(1); };
  document.querySelectorAll(".flow .fstep").forEach((c) => { c.onclick = () => { archPause(); archGoto(Number(c.dataset.step)); }; });
  archGoto(1); // static lit/dim state; token deferred until the figure scrolls into view
  const sec = document.getElementById("arch");
  if (sec && "IntersectionObserver" in window) {
    const ob = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting && !archState.revealed) { archState.revealed = true; archGoto(archState.step); ob.disconnect(); } });
    }, { threshold: 0.25 });
    ob.observe(sec);
  } else {
    archState.revealed = true;
  }
}

// reveal on scroll
const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach((s) => io.observe(s));

wire();
