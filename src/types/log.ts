// Plain data shapes for log content + transient objects used to build/transport
// leaves. No behaviour, no I/O — just the field definitions.

export type LogType = "SEND" | "UPDATE_GRADIENT" | "UPDATE_MODEL";

export type Payload = number | number[] | number[][] | string;

// Table 1: the content fields of a log (the signed bytes). The signed, hashed
// wrapper around these is the MerkleLeaf model.
export interface LogFields {
  actor: string; // pubKeyRef (cryptographic identity of the author)
  party_id: string; // the author party's logical id (A/B/C) — signed with the rest
  type: LogType;
  session_id: string;
  round_id: number;
  seq: number;
  idempotency_key: string;
  payload: Payload;
  input_refs?: string[]; // ONLY UPDATE_MODEL
  version: string;
  timestamp: number;
}

// Wire form of a leaf: the JSON shape sent over HTTP and stored off-chain. `id` is
// the leaf's own unique id (not part of `fields`, so not signed).
export interface WireLeaf {
  id: string;
  fields: LogFields;
  signature: string;
}

// Temporary object passed to Party.createLeaf to author a new leaf.
export interface CreateLeafArgs {
  type: LogType;
  session_id: string;
  round_id: number;
  payload: Payload;
  version: string;
  timestamp: number;
  input_refs?: string[];
  idempotency_key?: string;
}
