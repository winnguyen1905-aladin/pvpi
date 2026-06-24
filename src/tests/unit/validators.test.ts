import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregatorPeer, buildRegistry, loadKey, partyConfig } from "../../infra/parties.ts";
import { Aggregator } from "../../model/aggregator.model.ts";
import { Trainer } from "../../model/trainer.model.ts";
import { validateDepositGradient } from "../../service/aggregator-service.ts";
import { validateBroadcast } from "../../service/trainer-service.ts";

// Build a signed UPDATE_GRADIENT leaf using a party's CONFIGURED key, so its actor
// pubKeyRef matches refOf(name) inside the validator.
function gradientLeaf(name: string, opts: { session_id?: string; round_id?: number; payload?: number } = {}) {
  const t = new Trainer(name, 0, loadKey(name), partyConfig(name).id);
  return t.createLeaf({
    type: "UPDATE_GRADIENT",
    session_id: opts.session_id ?? "s1",
    round_id: opts.round_id ?? 1,
    payload: opts.payload ?? 110,
    version: "v1",
    timestamp: 1,
  });
}

test("validateDepositGradient: accepts a well-formed, correctly-signed gradient", () => {
  const reg = buildRegistry();
  const leaf = gradientLeaf("B");
  const res = validateDepositGradient({ sender: "B", wireLeaf: leaf.toWire(), session_id: "s1", round_id: 1, registry: reg });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.leaf.leaf_hash, leaf.leaf_hash);
});

test("validateDepositGradient: rejects an unknown trainer", () => {
  const reg = buildRegistry();
  const leaf = gradientLeaf("B");
  const res = validateDepositGradient({ sender: "Z", wireLeaf: leaf.toWire(), session_id: "s1", round_id: 1, registry: reg });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /unknown trainer/);
});

test("validateDepositGradient: rejects a malformed leaf body", () => {
  const reg = buildRegistry();
  const res = validateDepositGradient({ sender: "B", wireLeaf: null, session_id: "s1", round_id: 1, registry: reg });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /malformed/);
});

test("validateDepositGradient: rejects when the leaf signer is not the x-party sender", () => {
  const reg = buildRegistry();
  const leaf = gradientLeaf("C"); // signed by C
  const res = validateDepositGradient({ sender: "B", wireLeaf: leaf.toWire(), session_id: "s1", round_id: 1, registry: reg });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /does not match leaf signer/);
});

test("validateDepositGradient: rejects a session mismatch with the request", () => {
  const reg = buildRegistry();
  const leaf = gradientLeaf("B", { session_id: "other" });
  const res = validateDepositGradient({ sender: "B", wireLeaf: leaf.toWire(), session_id: "s1", round_id: 1, registry: reg });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /session does not match/);
});

test("validateDepositGradient: rejects a round mismatch with the request", () => {
  const reg = buildRegistry();
  const leaf = gradientLeaf("B", { round_id: 2 });
  const res = validateDepositGradient({ sender: "B", wireLeaf: leaf.toWire(), session_id: "s1", round_id: 1, registry: reg });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /different round/);
});

test("validateDepositGradient: rejects a tampered (bad signature) leaf", () => {
  const reg = buildRegistry();
  const wire = gradientLeaf("B").toWire();
  // mutate a signed field after signing, keeping actor/session/round intact so it
  // reaches the signature check
  const tampered = { ...wire, fields: { ...wire.fields, payload: 999 } };
  const res = validateDepositGradient({ sender: "B", wireLeaf: tampered, session_id: "s1", round_id: 1, registry: reg });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /signature/);
});

// Build a signed SEND leaf using a party's CONFIGURED key, so its actor pubKeyRef
// matches refOf(name). The aggregator A signs real SENDs; B is used only to forge a
// SEND signed by a non-aggregator.
function sendLeaf(signer: string, opts: { session_id?: string; round_id?: number; payload?: number } = {}) {
  const a = new Aggregator(signer, loadKey(signer), undefined, partyConfig(signer).id);
  return a.createLeaf({
    type: "SEND",
    session_id: opts.session_id ?? "s1",
    round_id: opts.round_id ?? 1,
    payload: opts.payload ?? 100,
    version: "v1",
    timestamp: 1,
  });
}

test("validateBroadcast: accepts a well-formed SEND signed by the aggregator", () => {
  const res = validateBroadcast({ sender: "A", wireSend: sendLeaf("A").toWire(), session_id: "s1", round_id: 1, aggregator: aggregatorPeer(), registry: buildRegistry() });
  assert.equal(res.ok, true);
});

test("validateBroadcast: rejects a sender that is not the aggregator", () => {
  const res = validateBroadcast({ sender: "B", wireSend: sendLeaf("A").toWire(), session_id: "s1", round_id: 1, aggregator: aggregatorPeer(), registry: buildRegistry() });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /not the aggregator/);
});

test("validateBroadcast: rejects a malformed SEND body", () => {
  const res = validateBroadcast({ sender: "A", wireSend: null, session_id: "s1", round_id: 1, aggregator: aggregatorPeer(), registry: buildRegistry() });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /malformed/);
});

test("validateBroadcast: rejects when the SEND signer is not the aggregator", () => {
  const res = validateBroadcast({ sender: "A", wireSend: sendLeaf("B").toWire(), session_id: "s1", round_id: 1, aggregator: aggregatorPeer(), registry: buildRegistry() });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /does not match SEND signer/);
});

test("validateBroadcast: rejects a tampered (bad signature) SEND", () => {
  const wire = sendLeaf("A").toWire();
  const tampered = { ...wire, fields: { ...wire.fields, payload: 999 } };
  const res = validateBroadcast({ sender: "A", wireSend: tampered, session_id: "s1", round_id: 1, aggregator: aggregatorPeer(), registry: buildRegistry() });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /signature/);
});

test("validateBroadcast: rejects a session mismatch with the request", () => {
  const res = validateBroadcast({ sender: "A", wireSend: sendLeaf("A", { session_id: "other" }).toWire(), session_id: "s1", round_id: 1, aggregator: aggregatorPeer(), registry: buildRegistry() });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /session does not match/);
});

test("validateBroadcast: rejects a round mismatch with the request", () => {
  const res = validateBroadcast({ sender: "A", wireSend: sendLeaf("A", { round_id: 2 }).toWire(), session_id: "s1", round_id: 1, aggregator: aggregatorPeer(), registry: buildRegistry() });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /different round/);
});
