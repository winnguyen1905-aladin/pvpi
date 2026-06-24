import { redis } from "../infra/redis.ts";
import type { RedisLike } from "../infra/redis.ts";

export interface SessionMember {
  session_id: string;
  party_id: string;
  role: "aggregator" | "trainer";
}

// Join table (many-to-many) between sessions and parties: which parties belong to a
// session and with what role. A is in both A+B+C and A+D+E; B/C only in the first,
// D/E only in the second. Stored two-way so both lookups are cheap:
//   forward  session:<sid>:members  hash  party_id -> role
//   reverse  party:<pid>:sessions   set   session ids
export class SessionMemberRepo {
  private redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  private membersKey(sid: string): string {
    return `session:${sid}:members`;
  }

  private sessionsKey(pid: string): string {
    return `party:${pid}:sessions`;
  }

  async add(session_id: string, party_id: string, role: SessionMember["role"]): Promise<void> {
    await this.redis.hset(this.membersKey(session_id), { [party_id]: role });
    await this.redis.sadd(this.sessionsKey(party_id), session_id);
  }

  async remove(session_id: string, party_id: string): Promise<void> {
    await this.redis.hdel(this.membersKey(session_id), party_id);
    await this.redis.srem(this.sessionsKey(party_id), session_id);
  }

  // Parties in a session (with their role).
  async members(session_id: string): Promise<SessionMember[]> {
    const h = (await this.redis.hgetall(this.membersKey(session_id))) ?? {};
    return Object.entries(h).map(([party_id, role]) => ({
      session_id,
      party_id,
      role: role as SessionMember["role"],
    }));
  }

  // Sessions a party belongs to.
  async sessionsOf(party_id: string): Promise<string[]> {
    return await this.redis.smembers(this.sessionsKey(party_id));
  }

  async isMember(session_id: string, party_id: string): Promise<boolean> {
    const h = (await this.redis.hgetall(this.membersKey(session_id))) ?? {};
    return party_id in h;
  }
}

export const sessionMemberRepo = new SessionMemberRepo(redis);
