// Configuration + round-context shapes (transient/config types, no behaviour).

export type Operation = "+" | "-" | "*" | "/";
export type InputType = "scalar" | "vector" | "matrix" | "string";
export type AnchorPolicy = "per-round" | "batch-rounds";

export interface SimConfig {
  input_type: InputType;
  operation: Operation;
  parties: { aggregator: string; trainers: string[] };
  rounds: number;
  anchor_policy: AnchorPolicy;
  version: string;
  y_max: number;
}

// Round identity + config shared by every step. now() is an injectable clock.
export interface RoundMeta {
  config: SimConfig;
  session_id: string;
  round_id: number;
  now: () => number;
}

// The outcome of a finalized round: the new model x and where it was anchored. Stashed
// in Redis by the finalizing deposit so runRound can read it back after the broadcast.
export interface RoundResult {
  round_id: number;
  x_new: number;
  cid: string;
  tx_hash: string;
}

// The signed-over part of an on-chain transaction (Table 3): the block header. The
// chain is linked by previous_tx_hash (the prior transaction's hash), so editing any
// header field changes the tx_hash and breaks the next block's link.
export interface AnchorHeader {
  merkle_root: string;
  cid: string;
  batch_id: string;
  session_id: string; // the session (training group) this block belongs to
  round_id: number | { round_start: number; round_end: number };
  timestamp: number;
  submitter_id: string; // user id of the party that anchored this block (the aggregator)
  previous_tx_hash: string | null; // null on the first (genesis) block
}

// The full on-chain transaction record: header + wallet signature + its content hash
// (tx_hash), stored key-value as onchain:<tx_hash> (mirror of offchain:<cid>).
export interface AnchorFields extends AnchorHeader {
  tx_sig: string; // aggregator wallet signature over the header
  tx_hash: string; // content hash of the signed transaction
}
