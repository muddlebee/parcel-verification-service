import { Worker, type Job } from "bullmq";
import { randomUUID } from "crypto";
import { redisConnection } from "../jobs/redisConnection.js";
import { registryCallbackDeliveryQueue, type RegistrySubmitJobData } from "./queues.js";
import { submitToRegistry } from "./stubPartnerClient.js";
import { db } from "../db/kysely.js";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Registry call timed out after ${ms}ms.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export const registrySubmitWorker = new Worker<RegistrySubmitJobData>(
  "registry-submit",
  async (job: Job<RegistrySubmitJobData>) => {
    const { parcelId, registryReferenceId, scenario, requestId } = job.data;
    const log = logger.child({
      parcelId,
      registryReferenceId,
      requestId,
      jobId: job.id,
      attempt: job.attemptsMade + 1,
    });

    log.info({ scenario }, "calling registry partner (stub)");
    await withTimeout(
      submitToRegistry({ registryReferenceId, scenario, timeoutMs: env.REGISTRY_CALL_TIMEOUT_MS }),
      env.REGISTRY_CALL_TIMEOUT_MS,
    );
    log.info("registry partner acknowledged submission");

    // Ack received — the outbound leg is done. The actual verified/rejected
    // transition happens later, when the callback arrives (a separate,
    // idempotent code path — see callback.routes.ts).
    await db.updateTable("parcels").set({ registry_sync_status: "done" }).where("id", "=", parcelId).execute();

    // --- registryCallbackDeliveryQueue (inbound leg) ---
    // After the partner acks our submit, a real partner would later POST a
    // webhook to us with verified/rejected. We don't have a real partner, so
    // we enqueue a delayed job onto this queue; callbackDeliveryWorker then
    // POSTs that payload to our own /callbacks/registry route over HTTP.
    // Why a durable queue (not setTimeout): survives process restarts and
    // matches "partner callback arrives whenever it wants."
    // This worker only sets registry_sync_status; parcel.status flips only
    // inside the callback handler.
    if (scenario === "verified" || scenario === "rejected") {
      await registryCallbackDeliveryQueue.add(
        "deliver",
        { parcelId, registryReferenceId, result: scenario, callbackId: randomUUID(), requestId },
        { delay: Math.round(randomBetween(1000, 3000)) }, // simulate partner thinking time
      );
    } else if (scenario === "duplicate") {
      // Same callback_id delivered twice, a few seconds apart — exactly
      // the "partner redelivers the same result" case the brief calls out.
      // First delivery applies the transition; second is ignored (idempotency).
      const payload = {
        parcelId,
        registryReferenceId,
        result: "verified" as const,
        callbackId: randomUUID(), // same id on both jobs = redelivery, not two results
        requestId,
      };
      await registryCallbackDeliveryQueue.add("deliver", payload, { delay: 1500 });
      await registryCallbackDeliveryQueue.add("deliver", payload, { delay: 3500 });
    }
  },
  {
    connection: redisConnection,
    // >1 so multiple partner calls await in parallel (I/O-bound). Tunable via
    // REGISTRY_SUBMIT_CONCURRENCY. Keep lockDuration above partner timeout.
    concurrency: env.REGISTRY_SUBMIT_CONCURRENCY,
    lockDuration: env.REGISTRY_CALL_TIMEOUT_MS + 10_000,
  },
);

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

registrySubmitWorker.on("failed", (job: Job<RegistrySubmitJobData> | undefined, err: Error) => {
  if (!job) return;
  const { parcelId, requestId } = job.data;
  const maxAttempts = job.opts.attempts ?? 1;
  const exhausted = job.attemptsMade >= maxAttempts;

  logger.warn(
    { parcelId, requestId, jobId: job.id, attempt: job.attemptsMade, maxAttempts, err, exhausted },
    exhausted ? "registry submit exhausted all retries" : "registry submit attempt failed, will retry",
  );

  const nextStatus = exhausted ? "exhausted" : "retrying";
  void db.updateTable("parcels").set({ registry_sync_status: nextStatus }).where("id", "=", parcelId).execute();
});
