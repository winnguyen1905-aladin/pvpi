import { canonicalize, sha256hex } from "../utils/crypto.ts";
import type { AnchorFields, AnchorHeader } from "../types/sim.ts";

// On-chain transaction / block (Table 3). The header (merkle_root, cid, round, ...,
// previous_tx_hash) is signed by the aggregator's wallet (tx_sig); tx_hash content-
// addresses the whole signed tx. Blocks chain via previous_tx_hash, so any edit
// changes tx_hash and breaks the next block's link.
export class Anchor {
  readonly merkle_root: string;
  readonly cid: string;
  readonly batch_id: string;
  readonly session_id: string;
  readonly round_id: number | { round_start: number; round_end: number };
  readonly timestamp: number;
  readonly submitter_id: string;
  readonly previous_tx_hash: string | null;
  readonly tx_sig: string;
  readonly tx_hash: string;

  constructor(f: AnchorFields) {
    this.merkle_root = f.merkle_root;
    this.cid = f.cid;
    this.batch_id = f.batch_id;
    this.session_id = f.session_id;
    this.round_id = f.round_id;
    this.timestamp = f.timestamp;
    this.submitter_id = f.submitter_id;
    this.previous_tx_hash = f.previous_tx_hash;
    this.tx_sig = f.tx_sig;
    this.tx_hash = f.tx_hash;
  }

  // Rebuild from a stored/parsed JSON record.
  static from(f: AnchorFields): Anchor {
    return new Anchor(f);
  }

  // The signed-over header (excludes tx_sig / tx_hash).
  header(): AnchorHeader {
    return {
      merkle_root: this.merkle_root,
      cid: this.cid,
      batch_id: this.batch_id,
      session_id: this.session_id,
      round_id: this.round_id,
      timestamp: this.timestamp,
      submitter_id: this.submitter_id,
      previous_tx_hash: this.previous_tx_hash,
    };
  }

  // Content hash of the signed transaction (mirror of the off-chain CID format).
  static txHash(header: AnchorHeader, tx_sig: string): string {
    return "tx:sha256:" + sha256hex(canonicalize({ ...header, tx_sig })).slice(0, 46);
  }

  // Recompute the tx_hash from the stored content and check it matches — detects any
  // tampering of a header field or the signature.
  isIntact(): boolean {
    return Anchor.txHash(this.header(), this.tx_sig) === this.tx_hash;
  }
}
