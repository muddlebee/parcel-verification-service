import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

// BullMQ requires this on the underlying ioredis connection — it manages
// its own retry/blocking-command semantics and will misbehave if ioredis
// also tries to retry commands independently.
export const redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

redisConnection.on("error", (err: Error) => {
  logger.error({ err }, "redis connection error");
});
