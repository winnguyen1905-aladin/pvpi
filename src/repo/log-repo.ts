import { redis } from "../infra/redis.ts";
import type { RedisLike } from "../infra/redis.ts";
import { MerkleLeaf } from "../model/merkle-leaf.model.ts";
import type { WireLeaf } from "../types/log.ts";

// App data: every log the aggregator anchors, stored as the full merkle leaf
// (WireLeaf { id, fields, signature }) — the leaf's `fields` IS the log object, and
// `fields.party_id` is the user who created it. The leaf's `id` (UUID) is the primary
// key: the row lives at log:<id>, and per-round / global indexes hold ids that point
// back to it. Saving is idempotent — re-saving the same id overwrites the row without
// duplicating an index entry.
export class LogRepo {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  private rowKey(id: string): string {
    return `log:${id}`;
  }

  async save(leaf: MerkleLeaf): Promise<void> {
    const key = this.rowKey(leaf.id);
    const isNew = (await this.redis.get(key)) === null;
    await this.redis.set(key, JSON.stringify(leaf.toWire())); // PK row; overwrite => idempotent
    if (isNew) {
      await this.redis.rpush(`log:${leaf.fields.session_id}:${leaf.fields.round_id}`, leaf.id);
      await this.redis.rpush("log:all", leaf.id);
    }
  }

  // Primary-key lookup: fetch a single log by its id.
  async get(id: string): Promise<MerkleLeaf | undefined> {
    const raw = await this.redis.get(this.rowKey(id));
    return raw ? MerkleLeaf.fromWire(JSON.parse(raw) as WireLeaf) : undefined;
  }

  async byRound(session: string, round: number): Promise<MerkleLeaf[]> {
    const ids = await this.redis.lrange(`log:${session}:${round}`, 0, -1);
    const out: MerkleLeaf[] = [];
    for (const id of ids) {
      const leaf = await this.get(id);
      if (leaf) out.push(leaf);
    }
    return out;
  }

  async count(): Promise<number> {
    const ids = await this.redis.lrange("log:all", 0, -1);
    return ids.length;
  }
}

export const logRepo = new LogRepo(redis);
