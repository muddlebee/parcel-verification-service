import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { env } from "../config/env.js";
import { logger } from "../logger.js";
import type { Database } from "./types.js";

const pool = new Pool({ connectionString: env.DATABASE_URL });

// pg emits 'error' on the pool when an *idle* client's connection drops
// (e.g. Postgres restarts, network blip). Without a listener, Node's
// default EventEmitter behavior is to throw and crash the process — a
// DB hiccup should degrade to failing health checks, not take the whole
// service down.
pool.on("error", (err) => {
  logger.error({ err }, "postgres pool error");
});

const dialect = new PostgresDialect({ pool });

export const db = new Kysely<Database>({ dialect });
