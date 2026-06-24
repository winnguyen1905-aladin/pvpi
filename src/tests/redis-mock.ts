import RedisMock from "ioredis-mock";
import type { RedisLike } from "../infra/redis.ts";

// An in-memory, API-compatible Redis client for tests (no server needed). The
// running app uses the real ioredis client (infra/redis.ts createRedis).
export function mockRedis(): RedisLike {
  return new RedisMock() as unknown as RedisLike;
}