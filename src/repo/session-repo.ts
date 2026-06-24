import { redis } from "../infra/redis.ts";
import type { RedisLike } from "../infra/redis.ts";
import type { AnchorPolicy, InputType, Operation } from "../types/sim.ts";

export type SessionStatus = "open" | "closed";

// A training group (e.g. A+B+C or A+D+E): the scalar config of a session. The list of
// participating parties is NOT here — it lives in session_members (many-to-many).
export interface SessionMeta {
  session_id: string;
  aggregator_id: string; // the party id that anchors for this session
  operation: Operation;
  input_type: InputType;
  anchor_policy: AnchorPolicy;
  y_max: number;
  version: string;
  status: SessionStatus;
  created_at?: number;
}

// App data: the catalog of sessions, keyed by session_id. Redis hashes store strings,
// so numbers (y_max / created_at) are serialized on write and parsed back on read.
export class SessionRepo {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  private key(id: string): string {
    return `session:${id}`;
  }

  async create(meta: SessionMeta): Promise<void> {
    const h: Record<string, string> = {
      session_id: meta.session_id,
      aggregator_id: meta.aggregator_id,
      operation: meta.operation,
      input_type: meta.input_type,
      anchor_policy: meta.anchor_policy,
      y_max: String(meta.y_max),
      version: meta.version,
      status: meta.status,
    };
    if (meta.created_at !== undefined) h.created_at = String(meta.created_at);
    await this.redis.hset(this.key(meta.session_id), h);
    await this.redis.sadd("session:all", meta.session_id);
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    const h = await this.redis.hgetall(this.key(id));
    if (!h || !h.session_id) return undefined;
    return {
      session_id: h.session_id,
      aggregator_id: h.aggregator_id,
      operation: h.operation as Operation,
      input_type: h.input_type as InputType,
      anchor_policy: h.anchor_policy as AnchorPolicy,
      y_max: Number(h.y_max),
      version: h.version,
      status: h.status as SessionStatus,
      ...(h.created_at !== undefined ? { created_at: Number(h.created_at) } : {}),
    };
  }

  async all(): Promise<SessionMeta[]> {
    const ids = await this.redis.smembers("session:all");
    const out: SessionMeta[] = [];
    for (const id of ids) {
      const m = await this.get(id);
      if (m) out.push(m);
    }
    return out;
  }

  async setStatus(id: string, status: SessionStatus): Promise<void> {
    await this.redis.hset(this.key(id), { status });
  }
}

export const sessionRepo = new SessionRepo(redis);
