// Workers run in-process with the HTTP server — the simplest thing that
// works given the brief's "no Kubernetes" scope. Each worker is a
// standalone BullMQ Worker instance already, so splitting this into its
// own process/container later is a matter of importing this file from a
// separate entrypoint, not a redesign.
//
// Registry integration (partner stub, queues, workers) lives under
// src/registry/ — this file only boots them. Generic Redis plumbing stays
// in src/jobs/redisConnection.ts.
import "../registry/submitWorker.js";
import "../registry/callbackDeliveryWorker.js";
import { logger } from "../logger.js";

logger.info("background workers started (registry-submit, registry-callback-delivery)");
