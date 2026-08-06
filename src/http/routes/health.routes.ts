import { Router } from "express";
import { z } from "zod";
import { registry } from "../openapi/registry";

export const healthRouter = Router();

const HealthResponseSchema = registry.register(
  "HealthResponse",
  z.object({
    status: z.literal("ok"),
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
      description: "Service is up.",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

// Liveness-only for now. Once the DB/Redis clients exist (next commit),
// this expands to check both — a container orchestrator should be able to
// tell "process is up" apart from "process can actually do its job".
healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime_seconds: process.uptime() });
});
