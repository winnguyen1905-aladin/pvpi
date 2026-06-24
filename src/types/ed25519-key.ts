import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { sha256hex } from "../utils/crypto.ts";

// OOP wrapper around an Ed25519 key. A full key (with private part) can sign; a
// public-only key (imported from a peer's PEM) can only verify. pubKeyRef is a
// SHA-256 fingerprint of the SPKI public key, used as the `actor` ref in logs.
export class Ed25519Key {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject | null;
  readonly pubKeyRef: string;

  private constructor(publicKey: KeyObject, privateKey: KeyObject | null) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.pubKeyRef = Ed25519Key.fingerprint(publicKey);
  }

  static generate(): Ed25519Key {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return new Ed25519Key(publicKey, privateKey);
  }

  // Reconstruct a verify-only key from a peer's exported SPKI PEM (received over HTTP).
  static fromPublicPem(pem: string): Ed25519Key {
    return new Ed25519Key(createPublicKey(pem), null);
  }

  // Load a full (signing) key from a stored PKCS8 private-key PEM (the config keys).
  static fromPrivatePem(pem: string): Ed25519Key {
    const privateKey = createPrivateKey(pem);
    return new Ed25519Key(createPublicKey(privateKey), privateKey);
  }

  static fingerprint(publicKey: KeyObject): string {
    const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    return "key:" + sha256hex(der).slice(0, 32);
  }

  exportPublic(): string {
    return this.publicKey.export({ type: "spki", format: "pem" }) as string;
  }

  // Address-style id derived from the public key (used by the wallet).
  address(): string {
    const der = this.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    return "0x" + sha256hex(der).slice(-40);
  }

  sign(hashHex: string): string {
    if (!this.privateKey) throw new Error("Ed25519Key: cannot sign with a public-only key");
    return sign(null, Buffer.from(hashHex, "hex"), this.privateKey).toString("hex");
  }

  verify(hashHex: string, signatureHex: string): boolean {
    try {
      return verify(null, Buffer.from(hashHex, "hex"), this.publicKey, Buffer.from(signatureHex, "hex"));
    } catch {
      return false;
    }
  }
}
