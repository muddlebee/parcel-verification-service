import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redisConnection.js";
import type { CallbackDeliveryJobData } from "./registryQueue.js";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

// Plays the part of the partner's own outbound webhook call — a genuine
// HTTP POST back into this same service's public callback route, not an
// in-process shortcut. That means the callback handler's idempotency
// check, auth-free routing, and error handling all get exercised by real
// traffic, including the deliberate double-delivery for "duplicate".
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
  { connection: redisConnection },
);

callbackDeliveryWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, data: job?.data, err }, "callback delivery failed");
});
