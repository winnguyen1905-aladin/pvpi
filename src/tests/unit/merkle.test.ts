import { test } from "node:test";
import assert from "node:assert/strict";
import { Aggregator } from "../../model/aggregator.model.ts";
import { KeyRegistry } from "../../types/key-registry.ts";
import { MerkleLeaf } from "../../model/merkle-leaf.model.ts";
import { MerkleTree } from "../../model/merkle-tree.model.ts";

function party() {
  const A = new Aggregator("A");
  const reg = new KeyRegistry();
  reg.register(A.key);
  return { A, reg };
}

function makeLeaves(n: number): MerkleLeaf[] {
  const { A } = party();
  return Array.from({ length: n }, (_, i) =>
    A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: i, version: "v1", timestamp: i }),
  );
}

test("MerkleLeaf: sign/verify roundtrip and tamper rejection", () => {
  const { A, reg } = party();
  const leaf = A.createLeaf({ type: "SEND", session_id: "s1", round_id: 1, payload: 100, version: "v1", timestamp: 1 });
  assert.equal(leaf.verify(reg).ok, true);

  const forged = new MerkleLeaf({ ...leaf.fields, payload: 999 }, leaf.signature);
  const v = forged.verify(reg);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /invalid signature/);

  assert.equal(leaf.verify(new KeyRegistry()).ok, false); // unknown actor
});

test("MerkleLeaf: leaf_hash changes with content and is 64 hex chars", () => {
  const { A } = party();
  const a = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 1, version: "v1", timestamp: 1 });
  const b = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 2, version: "v1", timestamp: 1 });
  assert.notEqual(a.leaf_hash, b.leaf_hash);
  assert.match(a.leaf_hash, /^[0-9a-f]{64}$/);
});

test("MerkleLeaf: wire round-trip preserves hashes", () => {
  const { A } = party();
  const leaf = A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 42, version: "v1", timestamp: 7 });
  const back = MerkleLeaf.fromWire(JSON.parse(JSON.stringify(leaf.toWire())));
  assert.equal(back.leaf_hash, leaf.leaf_hash);
  assert.equal(back.inner_hash, leaf.inner_hash);
  assert.equal(back.id, leaf.id); // the leaf id travels on the wire
});

test("MerkleTree root is deterministic and order-sensitive", () => {
  const ls = makeLeaves(4);
  assert.equal(new MerkleTree(ls).root, new MerkleTree(ls).root);
  assert.notEqual(new MerkleTree(ls).root, new MerkleTree([ls[1], ls[0], ls[2], ls[3]]).root);
});

test("MerkleTree inclusion proofs verify for every index incl odd counts", () => {
  for (const n of [1, 2, 3, 4, 5, 7]) {
    const ls = makeLeaves(n);
    const tree = new MerkleTree(ls);
    for (let i = 0; i < n; i++) {
      assert.equal(ls[i].verifyProof(tree.proof(i), tree.root), true, `proof[${i}] of ${n}`);
      assert.equal(ls[i].verifyProof(tree.proof(i), "00".repeat(32)), false);
    }
  }
});
