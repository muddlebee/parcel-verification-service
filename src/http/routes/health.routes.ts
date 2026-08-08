import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { registry } from "../openapi/registry.js";
import { db } from "../../db/kysely.js";
import { redisConnection } from "../../jobs/redisConnection.js";

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
  // Overrides the document-level `/api/v1` server. The probe is mounted at
  // the app root on purpose — an orchestrator's healthcheck shouldn't have to
  // track API versions — so without this Swagger UI would resolve it to
  // /api/v1/healthz, which isn't a real route.
  servers: [{ url: "/" }],
  responses: {
    200: {
      description: "Service is up and can reach Postgres and Redis.",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
    503: {
      description: "Service is up but a dependency (Postgres or Redis) is unreachable.",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

healthRouter.get("/healthz", async (_req, res) => {
  const [dbCheck, redisCheck] = await Promise.allSettled([sql`select 1`.execute(db), redisConnection.ping()]);
  const ok = dbCheck.status === "fulfilled" && redisCheck.status === "fulfilled";
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "error", uptime_seconds: process.uptime() });
});
