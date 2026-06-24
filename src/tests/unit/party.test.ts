import { test } from "node:test";
import assert from "node:assert/strict";
import { Aggregator } from "../../model/aggregator.model.ts";
import { KeyRegistry } from "../../types/key-registry.ts";

function party() {
  const A = new Aggregator("A");
  const reg = new KeyRegistry();
  reg.register(A.key);
  return { A, reg };
}

test("schema invariant: input_refs present iff UPDATE_MODEL", () => {
  const { A, reg } = party();
  const badSend = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 1, version: "v1", timestamp: 1, input_refs: ["deadbeef"] });
  assert.match(badSend.verify(reg).reason ?? "", /must not carry input_refs/);

  const badModel = A.createLeaf({ type: "UPDATE_MODEL", session_id: "s", round_id: 1, payload: 1, version: "v1", timestamp: 1 });
  assert.match(badModel.verify(reg).reason ?? "", /must carry .*input_refs/);
});

test("context binding rejects replay into a different round/session/type/actor", () => {
  const { A, reg } = party();
  const leaf = A.createLeaf({ type: "SEND", session_id: "sA", round_id: 5, payload: 1, version: "v1", timestamp: 1 });
  assert.equal(leaf.verify(reg, { session_id: "sA", round_id: 5, type: "SEND", actors: [A.pubKeyRef] }).ok, true);
  assert.match(leaf.verify(reg, { round_id: 6 }).reason ?? "", /round_id does not match/);
  assert.match(leaf.verify(reg, { session_id: "sB" }).reason ?? "", /session_id does not match/);
  assert.match(leaf.verify(reg, { type: "UPDATE_MODEL" }).reason ?? "", /expected UPDATE_MODEL/);
  assert.match(leaf.verify(reg, { actors: ["key:someone-else"] }).reason ?? "", /actor not in the allowed set/);
});

test("idempotency_key is derived (idem:...) and unique per seq", () => {
  const { A } = party();
  const a = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 1, version: "v1", timestamp: 1 });
  const b = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 1, version: "v1", timestamp: 1 });
  assert.match(a.fields.idempotency_key, /^idem:/);
  assert.notEqual(a.fields.idempotency_key, b.fields.idempotency_key);
});

test("leaf carries the author's party_id (signed) and its own unique leaf id (unsigned)", () => {
  const A = new Aggregator("A", undefined, undefined, "party-A"); // id = "party-A"
  const reg = new KeyRegistry();
  reg.register(A.key);
  const a = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 1, version: "v1", timestamp: 1 });
  const b = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 2, version: "v1", timestamp: 1 });

  assert.equal(a.fields.party_id, "party-A"); // creator id, inside signed fields
  assert.equal(a.verify(reg).ok, true); // party_id is covered by the signature
  assert.notEqual(a.id, b.id); // each leaf has its own unique id
  assert.equal((a.fields as unknown as Record<string, unknown>).id, undefined); // leaf id is NOT in the signed fields
});
