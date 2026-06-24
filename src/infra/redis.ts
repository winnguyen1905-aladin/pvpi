import { createRequire } from "node:module";
import { Redis } from "ioredis";

// The slice of the Redis API the repos use. Both ioredis (real server) and
// ioredis-mock (tests / REDIS_MOCK=1) satisfy this structurally, so repos depend
// on the shape, not the concrete client.
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  setnx(key: string, value: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  hset(key: string, obj: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  flushall(): Promise<unknown>;
  quit(): Promise<unknown>;
}

// Connect to a real Redis server (default localhost:6379, override via REDIS_URL).
// Set REDIS_MOCK=1 to use the in-memory ioredis-mock instead (no server needed) —
// a dev/demo convenience; production uses the real server.
export function createRedis(url: string = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"): RedisLike {
  if (process.env.REDIS_MOCK === "1") {
    const require = createRequire(import.meta.url);
    const RedisMock = require("ioredis-mock");
    return new RedisMock() as unknown as RedisLike;
  }
  return new Redis(url) as unknown as RedisLike;
}

// Singleton client shared by every repo (one connection per process).
export const redis: RedisLike = createRedis();
