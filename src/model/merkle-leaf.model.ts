import { canonicalize, randomUUID, sha256hex } from "../utils/crypto.ts";
import type { LogFields, WireLeaf } from "../types/log.ts";
import type { ExpectedContext, ProofStep, PublicKeyLookup, VerifyResult } from "../types/verify.ts";
import { MerkleTree } from "./merkle-tree.model.ts";

// A signed, hashed log leaf. Built from (fields, signature); derives inner_hash +
// leaf_hash so it is always self-consistent — tampering surfaces as a failed
// signature check (and a diverged tree root), never as a stale cached hash.
// `id` is the leaf's own unique identifier: present from construction (before the
// tree is built) but NOT part of the signed fields / hashes.
export class MerkleLeaf {
  readonly id: string;
  readonly fields: LogFields;
  readonly signature: string;
  readonly inner_hash: string;
  readonly leaf_hash: string;

  constructor(fields: LogFields, signature: string, id: string = randomUUID()) {
    this.id = id;
    this.fields = fields;
    this.signature = signature;
    this.inner_hash = MerkleLeaf.innerHash(fields);
    this.leaf_hash = MerkleLeaf.leafHash(fields, signature);
  }

  static innerHash(fields: LogFields): string {
    return sha256hex(canonicalize(fields));
  }

  static leafHash(fields: LogFields, signature: string): string {
    return sha256hex(
      Buffer.concat([Buffer.from("00", "hex"), Buffer.from(canonicalize({ ...fields, signature }), "utf8")]),
    );
  }

  // 1. crypto integrity (signature over inner_hash), 2. schema (input_refs iff
  // UPDATE_MODEL), 3. context binding (session/round/type/actor) when supplied.
  verify(lookup: PublicKeyLookup, expected?: ExpectedContext): VerifyResult {
    const key = lookup.key(this.fields.actor);
    if (!key) return { ok: false, reason: "unknown actor pubKeyRef" };
    if (!key.verify(this.inner_hash, this.signature)) {
      return { ok: false, reason: "invalid signature (content tampered or wrong key)" };
    }

    const f = this.fields;
    const hasRefs = f.input_refs !== undefined && f.input_refs.length > 0;
    if (f.type === "UPDATE_MODEL" && !hasRefs) {
      return { ok: false, reason: "UPDATE_MODEL must carry non-empty input_refs" };
    }
    if (f.type !== "UPDATE_MODEL" && f.input_refs !== undefined) {
      return { ok: false, reason: `${f.type} must not carry input_refs` };
    }

    if (expected) {
      if (expected.session_id !== undefined && f.session_id !== expected.session_id) {
        return { ok: false, reason: "session_id does not match expected session" };
      }
      if (expected.round_id !== undefined && f.round_id !== expected.round_id) {
        return { ok: false, reason: "round_id does not match current round (replay?)" };
      }
      if (expected.type !== undefined && f.type !== expected.type) {
        return { ok: false, reason: `expected ${expected.type}, got ${f.type}` };
      }
      if (expected.actors !== undefined && !expected.actors.includes(f.actor)) {
        return { ok: false, reason: "actor not in the allowed set for this step" };
      }
    }

    return { ok: true };
  }

  verifyProof(steps: ProofStep[], root: string): boolean {
    return MerkleTree.verifyProof(this.leaf_hash, steps, root);
  }

  clone(): MerkleLeaf {
    return new MerkleLeaf(structuredClone(this.fields), this.signature, this.id);
  }

  toWire(): WireLeaf {
    return { id: this.id, fields: this.fields, signature: this.signature };
  }

  static fromWire(w: WireLeaf): MerkleLeaf {
    return new MerkleLeaf(w.fields, w.signature, w.id);
  }
}
