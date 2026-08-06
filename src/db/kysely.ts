import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { env } from "../config/env.js";
import { logger } from "../logger.js";
import type { Database } from "./types.js";

// pg's default DATE parser returns a JS Date object, which is a
// well-known footgun: it gets constructed relative to the process's local
// timezone, so a stored '2011-04-18' can read back as the 17th or 19th
// depending on where the server runs. claimed_ownership_since is a plain
// date with no time component — keep it a plain string end to end so it
// round-trips exactly as stored.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

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
