import { Ed25519Key } from "../types/ed25519-key.ts";
import { redis } from "../infra/redis.ts";
import type { RedisLike } from "../infra/redis.ts";
import { PARTIES } from "../infra/parties.ts";

export interface PartyMeta {
  id: string; // stable user-id (A/B/C/D/E) — the join key for session_members
  name: string; // maps back to config PARTIES[name]
  role: "aggregator" | "trainer";
  pubKeyRef: string; // cryptographic identity derived from the public key
  publicKey: string; // SPKI PEM — public material only, never the private key
}

// App data: the parties known to the system, keyed by their stable id. Identity
// registry only — PUBLIC material (id/name/role/pubKeyRef/public PEM). Private keys,
// trainer secrets and wallet keys stay in config (infra/parties.ts), never in Redis.
export class PartyRepo {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  private key(id: string): string {
    return `party:${id}`;
  }

  async save(meta: PartyMeta): Promise<void> {
    await this.redis.hset(this.key(meta.id), {
      id: meta.id,
      name: meta.name,
      role: meta.role,
      pubKeyRef: meta.pubKeyRef,
      publicKey: meta.publicKey,
    });
    await this.redis.sadd("party:all", meta.id);
  }

  async get(id: string): Promise<PartyMeta | undefined> {
    const h = await this.redis.hgetall(this.key(id));
    return h && h.id ? (h as unknown as PartyMeta) : undefined;
  }

  async all(): Promise<PartyMeta[]> {
    const ids = await this.redis.smembers("party:all");
    const out: PartyMeta[] = [];
    for (const id of ids) {
      const m = await this.get(id);
      if (m) out.push(m);
    }
    return out;
  }

  // Look up a party by its cryptographic ref (used on the verify path, where only the
  // signer's pubKeyRef is known).
  async byRef(pubKeyRef: string): Promise<PartyMeta | undefined> {
    for (const m of await this.all()) {
      if (m.pubKeyRef === pubKeyRef) return m;
    }
    return undefined;
  }
}

// Register every configured party from PARTIES (public fields only). pubKeyRef is
// derived from the public PEM — no private key is read.
export async function seedParties(repo: PartyRepo): Promise<void> {
  for (const p of Object.values(PARTIES)) {
    await repo.save({
      id: p.id,
      name: p.name,
      role: p.role,
      pubKeyRef: Ed25519Key.fromPublicPem(p.publicKeyPem).pubKeyRef,
      publicKey: p.publicKeyPem,
    });
  }
}

export const partyRepo = new PartyRepo(redis);
