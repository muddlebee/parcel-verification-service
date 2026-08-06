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
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast and loud — a misconfigured env is a boot-time bug, not a
  // runtime one, and should never surface as a confusing 500 later.
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
