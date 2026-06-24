import { canonicalize, sha256hex } from "../utils/crypto.ts";
import { redis } from "../infra/redis.ts";
import type { RedisLike } from "../infra/redis.ts";
import { MerkleLeaf } from "../model/merkle-leaf.model.ts";
import type { WireLeaf } from "../types/log.ts";

// Off-chain store: content-addressed leaf batches in Redis. The CID is derived
// from the leaves, so any edit changes the CID (and the anchored root catches it).
export class OffchainRepo {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  private key(cid: string): string {
    return `offchain:${cid}`;
  }

  async put(leaves: MerkleLeaf[]): Promise<string> {
    const wire: WireLeaf[] = leaves.map((l) => l.toWire());
    const cid = "cid:sha256:" + sha256hex(canonicalize(wire)).slice(0, 46);
    await this.redis.set(this.key(cid), JSON.stringify(wire));
    return cid;
  }

  async get(cid: string): Promise<MerkleLeaf[] | undefined> {
    const raw = await this.redis.get(this.key(cid));
    if (!raw) return undefined;
    const wire = JSON.parse(raw) as WireLeaf[];
    return wire.map((w) => MerkleLeaf.fromWire(w));
  }
}

export const offchainRepo = new OffchainRepo(redis);
