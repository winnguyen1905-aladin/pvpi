import { Ed25519Key } from "./ed25519-key.ts";

// The on-chain account that submits the anchor transaction. Only the aggregator
// holds one (separate from its identity/signing key).
export class Wallet {
  readonly key: Ed25519Key;
  readonly address: string;

  constructor(key: Ed25519Key) {
    this.key = key;
    this.address = key.address();
  }

  sign(txHashHex: string): string {
    return this.key.sign(txHashHex);
  }
}