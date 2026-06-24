import { Ed25519Key } from "../types/ed25519-key.ts";
import { Wallet } from "../types/wallet.ts";
import { Party } from "./party.model.ts";

// Role A: signs its SEND / UPDATE_MODEL leaves with the inherited Party key, and
// holds a separate Wallet (on-chain account) for the anchor transaction.
export class Aggregator extends Party {
  readonly wallet: Wallet;

  constructor(
    name: string,
    key: Ed25519Key = Ed25519Key.generate(),
    walletKey: Ed25519Key = Ed25519Key.generate(),
    id: string = name,
  ) {
    super(name, key, id);
    this.wallet = new Wallet(walletKey);
  }
}