import { redis } from "../infra/redis.ts";
import type { RedisLike } from "../infra/redis.ts";
import { MerkleLeaf } from "../model/merkle-leaf.model.ts";
import type { WireLeaf } from "../types/log.ts";
import type { RoundResult } from "../types/sim.ts";

export interface OpenRound {
  round_id: number;
  session_id: string;
  send: WireLeaf; // A's signed SEND leaf for this round (carries x)
}

// Coordination state for the in-flight round, kept in Redis so the AggregatorService
// stays stateless and survives a restart. Round is a child of its session: counter/
// model/open round/gradients all live under session:<session_id>:round:* so two groups
// (A+B+C and A+D+E) never collide. Every method takes an explicit session id — there is
// no global "active session"; the caller always says which session it means. The
// anchored ledger lives in the offchain/onchain/log repos; this only holds open rounds.
export class RoundRepo {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  private counterKey(sid: string): string {
    return `session:${sid}:round:counter`;
  }
  private modelKey(sid: string): string {
    return `session:${sid}:round:model`;
  }
  private openKey(sid: string): string {
    return `session:${sid}:round:open`;
  }
  private gradsKey(sid: string): string {
    return `session:${sid}:round:open:grads`;
  }

  async nextRoundId(sid: string): Promise<number> {
    const key = this.counterKey(sid);
    const next = Number((await this.redis.get(key)) ?? "0") + 1;
    await this.redis.set(key, String(next));
    return next;
  }

  async model(sid: string): Promise<number | null> {
    const v = await this.redis.get(this.modelKey(sid));
    return v === null ? null : Number(v);
  }

  async setModel(x: number, sid: string): Promise<void> {
    await this.redis.set(this.modelKey(sid), String(x));
  }

  // Open a round; the scope comes from the round's own session_id.
  async openRound(r: OpenRound): Promise<void> {
    await this.redis.set(this.openKey(r.session_id), JSON.stringify(r));
    await this.redis.del(this.gradsKey(r.session_id));
  }

  async current(sid: string): Promise<OpenRound | null> {
    const raw = await this.redis.get(this.openKey(sid));
    return raw ? (JSON.parse(raw) as OpenRound) : null;
  }

  async addGradient(sender: string, leaf: WireLeaf, sid: string): Promise<void> {
    await this.redis.hset(this.gradsKey(sid), { [sender]: JSON.stringify(leaf) });
  }

  async hasGradient(sender: string, sid: string): Promise<boolean> {
    const all = await this.redis.hgetall(this.gradsKey(sid));
    return !!all && sender in all;
  }

  // Collected gradients for the open round, keyed by sender (B/C).
  async gradients(sid: string): Promise<Record<string, MerkleLeaf>> {
    const all = (await this.redis.hgetall(this.gradsKey(sid))) ?? {};
    const out: Record<string, MerkleLeaf> = {};
    for (const [sender, raw] of Object.entries(all)) {
      out[sender] = MerkleLeaf.fromWire(JSON.parse(raw) as WireLeaf);
    }
    return out;
  }

  async closeRound(sid: string): Promise<void> {
    await this.redis.del(this.openKey(sid));
    await this.redis.del(this.gradsKey(sid));
  }

  // Claim the right to finalize (session_id, round_id) exactly once. SETNX returns 1 to
  // the first caller, 0 to the rest — so when B and C deposit near-simultaneously and
  // both see a complete set, only one of them runs aggregate + anchor.
  async claimFinalize(session_id: string, round_id: number): Promise<boolean> {
    const got = await this.redis.setnx(`session:${session_id}:round:${round_id}:finalizing`, "1");
    return got === 1;
  }

  // The finalized round outcome, stashed by the finalizing deposit so runRound (which
  // only broadcast) can read it back once the synchronous gradient push settles.
  async setResult(session_id: string, round_id: number, result: RoundResult): Promise<void> {
    await this.redis.set(`session:${session_id}:round:${round_id}:result`, JSON.stringify(result));
  }

  async result(session_id: string, round_id: number): Promise<RoundResult | null> {
    const raw = await this.redis.get(`session:${session_id}:round:${round_id}:result`);
    return raw ? (JSON.parse(raw) as RoundResult) : null;
  }
}

export const roundRepo = new RoundRepo(redis);
