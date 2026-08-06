import { env } from "./config/env";
import { logger } from "./logger";
import { buildApp } from "./http/app";

const app = buildApp();

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "parcel-verification-service listening");
});
