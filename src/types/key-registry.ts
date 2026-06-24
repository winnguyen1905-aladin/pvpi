import { Ed25519Key } from "./ed25519-key.ts";
import type { PublicKeyLookup } from "./verify.ts";

// In-memory allowlist of trusted peers (pubKeyRef -> public key). Each party keeps
// its own; over HTTP it is populated from peers' exported PEMs during handshake.
export class KeyRegistry implements PublicKeyLookup {
  private keys = new Map<string, Ed25519Key>();

  register(key: Ed25519Key): void {
    this.keys.set(key.pubKeyRef, key);
  }

  key(ref: string): Ed25519Key | undefined {
    return this.keys.get(ref);
  }
}
