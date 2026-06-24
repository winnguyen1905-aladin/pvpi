import { redis } from "../infra/redis.ts";
import type { RedisLike } from "../infra/redis.ts";
import { Anchor } from "../model/anchor.model.ts";

const HEAD = "onchain:head";

// On-chain ledger: each anchor is a signed transaction stored key-value as
// onchain:<tx_hash> (mirror of the off-chain offchain:<cid>). Blocks chain via
// previous_tx_hash; onchain:head points at the latest tx_hash.
export class OnchainRepo {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  private key(txHash: string): string {
    return `onchain:${txHash}`;
  }

  async append(anchor: Anchor): Promise<void> {
    await this.redis.set(this.key(anchor.tx_hash), JSON.stringify(anchor));
    await this.redis.set(HEAD, anchor.tx_hash);
  }

  // The latest tx_hash (the next block links to it via previous_tx_hash). null if empty.
  async head(): Promise<string | null> {
    return await this.redis.get(HEAD);
  }

  // Look up a single transaction by its tx_hash.
  async get(txHash: string): Promise<Anchor | undefined> {
    const raw = await this.redis.get(this.key(txHash));
    if (!raw) return undefined;
    return Anchor.from(JSON.parse(raw));
  }

  // Walk head -> genesis via previous_tx_hash, returned in chronological order.
  async all(): Promise<Anchor[]> {
    const out: Anchor[] = [];
    let cur = await this.head();
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const a = await this.get(cur);
      if (!a) break;
      out.push(a);
      cur = a.previous_tx_hash;
    }
    return out.reverse();
  }

  // Walk the chain from head and check it is intact and unbroken: every referenced
  // block exists, its content matches its tx_hash, no cycle, ending at genesis.
  async verifyChain(): Promise<{ ok: boolean; reason?: string }> {
    const seen = new Set<string>();
    let cur = await this.head();
    while (cur) {
      if (seen.has(cur)) return { ok: false, reason: `cycle at ${cur}` };
      seen.add(cur);
      const a = await this.get(cur);
      if (!a) return { ok: false, reason: `missing block ${cur} (broken link)` };
      if (a.tx_hash !== cur || !a.isIntact()) return { ok: false, reason: `tampered block ${cur}` };
      cur = a.previous_tx_hash;
    }
    return { ok: true }; // reached genesis (previous_tx_hash === null)
  }
}

export const onchainRepo = new OnchainRepo(redis);
