import express from "express";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { logger } from "../logger.js";
import { genRequestId, setRequestIdHeader } from "./middleware/requestId.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.routes.js";
import { parcelsRouter } from "./routes/parcels.routes.js";
import { documentsRouter } from "./routes/documents.routes.js";
import { verifyRouter } from "./routes/verify.routes.js";
import { callbackRouter } from "./routes/callback.routes.js";
import { transitionsRouter } from "./routes/transitions.routes.js";
import { buildOpenApiDocument } from "./openapi/document.js";

export function buildApp() {
  const app = express();

  app.use(
    pinoHttp({
      logger,
      genReqId: genRequestId,
      customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
    }),
  );
  app.use((req, res, next) => {
    setRequestIdHeader(res, req.id as string);
    next();
  });
  app.use(express.json());

  // Unauthenticated: liveness probe and API docs.
  app.use(healthRouter);
  const openApiDocument = buildOpenApiDocument();
  app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  // callbackRouter MUST be mounted before the authenticated routers.
  // Express applies a router's own `router.use(middleware)` to every
  // request forwarded into it by app.use(prefix, router) — not just
  // requests matching that router's own routes. parcelsRouter's blanket
  // apiKeyAuth would otherwise intercept /api/v1/callbacks/registry too
  // (it's also under /api/v1) and 401 it before Express ever tries
  // callbackRouter. callbackRouter itself has no such blanket middleware,
  // so it correctly falls through via next() for paths it doesn't own —
  // mounting order only matters in this one direction.
  app.use("/api/v1", callbackRouter);
  app.use("/api/v1", parcelsRouter);
  app.use("/api/v1", documentsRouter);
  app.use("/api/v1", verifyRouter);
  app.use("/api/v1", transitionsRouter);

  app.use(errorHandler);

  return app;
}
