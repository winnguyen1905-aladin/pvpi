import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../../utils/crypto.ts";
import { Ed25519Key } from "../../types/ed25519-key.ts";

test("canonicalize is key-order independent, omits undefined, rejects non-finite", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ a: 1, x: undefined }), canonicalize({ a: 1 }));
  assert.equal(canonicalize([1, "two", true, null]), '[1,"two",true,null]');
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY));
});

test("Ed25519Key signs/verifies and exports/imports its public key", () => {
  const k = Ed25519Key.generate();
  const hash = "ab".repeat(32);
  const sig = k.sign(hash);
  assert.equal(k.verify(hash, sig), true);

  const pub = Ed25519Key.fromPublicPem(k.exportPublic());
  assert.equal(pub.pubKeyRef, k.pubKeyRef);
  assert.equal(pub.verify(hash, sig), true);
  assert.throws(() => pub.sign(hash), /cannot sign/);
});
