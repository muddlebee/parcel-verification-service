import { Worker, type Job } from "bullmq";
import { redisConnection } from "../jobs/redisConnection.js";
import type { CallbackDeliveryJobData } from "./queues.js";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

// Consumer for callbackDeliveryQueue (BullMQ name: "registry-callback-delivery").
//
// Role: pretend to be the external registry partner calling us back.
// Jobs are enqueued by submitWorker after a successful partner ack
// (delayed 1–3s). We do NOT write parcel status ourselves — we HTTP POST
// to POST /api/v1/callbacks/registry so the real callback route owns
// idempotency + applyTransition(under_verification → verified|rejected).
//
// Why real HTTP (not an in-process function call): exercises the public
// unauthenticated webhook path, validation, and duplicate handling exactly
// as production traffic would — including the "duplicate" double-delivery.
//
// With a real partner this file goes away; they POST the public callback route.
export const callbackDeliveryWorker = new Worker<CallbackDeliveryJobData>(
  "registry-callback-delivery",
  async (job: Job<CallbackDeliveryJobData>) => {
    const { parcelId, registryReferenceId, result, callbackId, requestId } = job.data;
    const log = logger.child({ parcelId, registryReferenceId, callbackId, requestId, jobId: job.id });

    log.info({ result }, "stub partner delivering callback");

    // x-debug-origin-request-id is NOT part of the real partner's contract
    // (RegistryCallbackRequestSchema) — a header, not a body field, purely
    // so the callback handler's own log line can be tied back to the
    // originating /verify request without that debug concern leaking into
    // the payload a real partner would actually send.
    const res = await fetch(`http://localhost:${env.PORT}/api/v1/callbacks/registry`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-debug-origin-request-id": requestId },
      body: JSON.stringify({
        registry_reference_id: registryReferenceId,
        callback_id: callbackId,
        result,
        delivered_at: new Date().toISOString(),
      }),
    });

    if (!res.ok) {
      throw new Error(`Callback delivery got HTTP ${res.status}: ${await res.text()}`);
    }
  },
  {
    connection: redisConnection,
    // Parallel loopback POSTs when several delayed callbacks fire together.
    concurrency: env.REGISTRY_DELIVERY_CONCURRENCY,
  },
);

callbackDeliveryWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, data: job?.data, err }, "callback delivery failed");
});
