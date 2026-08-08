import express from "express";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { logger } from "../logger.js";
import { env } from "../config/env.js";
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
  // Pre-fills the ApiKeyAuth scheme so the manual Authorize step isn't
  // needed for "Try it out". Must be plain data, not a function:
  // swagger-ui-express serialises these options into a browser script via
  // Function.prototype.toString(), so a callback referencing anything from
  // this module's scope (e.g. `env`) becomes a ReferenceError in the page.
  // Safe here specifically because this service has no real production
  // deployment (out of scope per the brief) and the key is already a
  // plaintext dev default checked into docker-compose.yml/.env.example —
  // this is convenience, not a new exposure. Would need to be gated or
  // removed if this pattern were ever reused for a service that actually
  // goes to production.
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      swaggerOptions: {
        preauthorizeApiKey: { authDefinitionKey: "ApiKeyAuth", apiKeyValue: env.API_KEY },
      },
    }),
  );

  // apiKeyAuth is attached per-route rather than via router.use(), because
  // Express runs a router's own `use()` middleware for every request
  // forwarded into it by app.use(prefix, router) — not just the paths that
  // router actually owns. A blanket apiKeyAuth on any one of these would
  // 401 every unmatched /api/v1/* path (including the deliberately
  // unauthenticated registry callback, and any genuine 404) before Express
  // could try the next router. Per-route attachment makes these mounts
  // order-independent.
  app.use("/api/v1", callbackRouter);
  app.use("/api/v1", parcelsRouter);
  app.use("/api/v1", documentsRouter);
  app.use("/api/v1", verifyRouter);
  app.use("/api/v1", transitionsRouter);

  app.use(errorHandler);

  return app;
}
