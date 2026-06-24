import { test } from "node:test";
import assert from "node:assert/strict";
import { PARTIES, buildRegistry, loadKey } from "../../infra/parties.ts";
import { Aggregator } from "../../model/aggregator.model.ts";

test("config ed25519 keys are deterministic and verifiable", () => {
  assert.equal(Object.keys(PARTIES).length, 3); // A, B, C

  const ref1 = loadKey("A").pubKeyRef;
  const ref2 = loadKey("A").pubKeyRef;
  assert.equal(ref1, ref2); // same key every load
  assert.match(ref1, /^key:/);

  // a leaf signed with the config key verifies against the config-seeded registry
  const A = new Aggregator("A", loadKey("A"));
  const leaf = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 1, version: "v1", timestamp: 1 });
  assert.equal(leaf.verify(buildRegistry()).ok, true);
});

test("each party config has its own stable id, carried into the leaf party_id", () => {
  const ids = Object.values(PARTIES).map((p) => p.id);
  assert.equal(new Set(ids).size, 3); // all distinct
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/); // uuid

  const A = new Aggregator("A", loadKey("A"), undefined, PARTIES.A.id);
  assert.equal(A.id, PARTIES.A.id);
  const leaf = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 1, version: "v1", timestamp: 1 });
  assert.equal(leaf.fields.party_id, PARTIES.A.id);
});

test("unknown party name throws", () => {
  assert.throws(() => loadKey("Z"), /unknown party/);
});
