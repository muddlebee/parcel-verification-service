// Workers run in-process with the HTTP server — the simplest thing that
// works given the brief's "no Kubernetes" scope. Each worker is a
// standalone BullMQ Worker instance already, so splitting this into its
// own process/container later is a matter of importing this file from a
// separate entrypoint, not a redesign.
import "./registrySubmitWorker.js";
import "./callbackDeliveryWorker.js";
import { logger } from "../logger.js";

logger.info("background workers started (registry-submit, registry-callback-delivery)");
