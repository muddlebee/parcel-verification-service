import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { buildApp } from "./http/app.js";
import "./jobs/bootstrap.js";

const app = buildApp();

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "parcel-verification-service listening");
});
