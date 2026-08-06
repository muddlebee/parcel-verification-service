import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { registry } from "../openapi/registry.js";
import { db } from "../../db/kysely.js";

export const healthRouter = Router();

const HealthResponseSchema = registry.register(
  "HealthResponse",
  z.object({
    status: z.enum(["ok", "error"]),
    uptime_seconds: z.number(),
  }),
);

registry.registerPath({
  method: "get",
  path: "/healthz",
  tags: ["Health"],
  summary: "Liveness/readiness probe for a container orchestrator.",
  responses: {
    200: {
      description: "Service is up and can reach Postgres.",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
    503: {
      description: "Service is up but a dependency (Postgres) is unreachable.",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

// Redis check joins this once the BullMQ client exists (registry-integration
// commit) — checking DB reachability only still beats a pure liveness check,
// since "process is up" and "process can actually do its job" are different
// questions for an orchestrator.
healthRouter.get("/healthz", async (_req, res) => {
  try {
    await sql`select 1`.execute(db);
    res.status(200).json({ status: "ok", uptime_seconds: process.uptime() });
  } catch {
    res.status(503).json({ status: "error", uptime_seconds: process.uptime() });
  }
});
