// Verification + proof shapes. Kept independent of the model: the key lookup is
// expressed via a minimal `Verifier` interface (Ed25519Key satisfies it), so this
// type layer does not depend on the model classes.
import type { LogType } from "./log.ts";

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

// What a verifier expects a leaf to be bound to (anti-replay / session isolation).
export interface ExpectedContext {
  session_id?: string;
  round_id?: number;
  type?: LogType;
  actors?: string[];
}

// The minimal capability a leaf needs from a public key: verify a signature.
export interface Verifier {
  verify(hashHex: string, signatureHex: string): boolean;
}

// Look up the verifier for an actor's pubKeyRef. KeyRegistry satisfies this.
export interface PublicKeyLookup {
  key(ref: string): Verifier | undefined;
}

// One level of a Merkle inclusion proof.
export interface ProofStep {
  sibling: string;
  position: "left" | "right";
}
