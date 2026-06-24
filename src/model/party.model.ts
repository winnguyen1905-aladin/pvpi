import { sha256hex } from "../utils/crypto.ts";
import { Ed25519Key } from "../types/ed25519-key.ts";
import { MerkleLeaf } from "./merkle-leaf.model.ts";
import type { CreateLeafArgs, LogFields } from "../types/log.ts";

// Base party: identity (a logical `id` + an Ed25519 signing key) + a monotonic seq
// + leaf authoring. Round operations live in services. Aggregator/Trainer extend
// this in their own files. The key + id are injected (from config); tests may omit
// them (a fresh key is generated, id defaults to the name).
export class Party {
  readonly name: string;
  readonly id: string;
  readonly key: Ed25519Key;
  private seqCounter = 0;

  constructor(name: string, key: Ed25519Key = Ed25519Key.generate(), id: string = name) {
    this.name = name;
    this.key = key;
    this.id = id;
  }

  get pubKeyRef(): string {
    return this.key.pubKeyRef;
  }

  // Assemble the content fields (incl. party_id), sign the inner_hash, hand both to
  // MerkleLeaf which derives leaf_hash and gets its own unique leaf id.
  createLeaf(args: CreateLeafArgs): MerkleLeaf {
    const seq = ++this.seqCounter;
    const idempotency_key =
      args.idempotency_key ?? this.deriveIdempotencyKey(args.session_id, args.round_id, args.type, seq);

    const fields: LogFields = {
      actor: this.pubKeyRef,
      party_id: this.id,
      type: args.type,
      session_id: args.session_id,
      round_id: args.round_id,
      seq,
      idempotency_key,
      payload: args.payload,
      version: args.version,
      timestamp: args.timestamp,
      ...(args.input_refs ? { input_refs: args.input_refs } : {}),
    };

    const signature = this.key.sign(MerkleLeaf.innerHash(fields));
    return new MerkleLeaf(fields, signature);
  }

  private deriveIdempotencyKey(session: string, round: number, type: string, seq: number): string {
    return "idem:" + sha256hex(`${session}|${round}|${this.pubKeyRef}|${type}|${seq}`).slice(0, 24);
  }
}
