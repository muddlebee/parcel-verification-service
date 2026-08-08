import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_KEY: z.string().min(1),
  UPLOAD_DIR: z.string().default("./uploads"),
  REGISTRY_RETRY_BASE_MS: z.coerce.number().int().positive().default(30_000),
  REGISTRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // How long we wait for the (stubbed) partner to acknowledge before
  // treating the call as timed out. Real partner: tens of seconds.
  // Scaled way down here so a reviewer sees a timeout/retry cycle in
  // seconds, not minutes.
  REGISTRY_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  // How many jobs each BullMQ worker may process in parallel (default was
  // effectively 1). Submit is I/O-bound on the partner call — raising this
  // overlaps wait time. Delivery is loopback HTTP and usually cheap.
  REGISTRY_SUBMIT_CONCURRENCY: z.coerce.number().int().positive().default(5),
  REGISTRY_DELIVERY_CONCURRENCY: z.coerce.number().int().positive().default(5),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast and loud — a misconfigured env is a boot-time bug, not a
  // runtime one, and should never surface as a confusing 500 later.
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
