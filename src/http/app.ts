import express from "express";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import { logger } from "../logger";
import { genRequestId, setRequestIdHeader } from "./middleware/requestId";
import { errorHandler } from "./middleware/errorHandler";
import { healthRouter } from "./routes/health.routes";
import { buildOpenApiDocument } from "./openapi/document";

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

  // Versioned API routes (parcels, documents, callbacks) mount here in
  // subsequent commits, behind apiKeyAuth except for /api/v1/callbacks.

  app.use(errorHandler);

  return app;
}
