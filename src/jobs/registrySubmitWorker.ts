import { Worker, type Job } from "bullmq";
import { randomUUID } from "crypto";
import { redisConnection } from "./redisConnection.js";
import { registryCallbackDeliveryQueue, type RegistrySubmitJobData } from "./registryQueue.js";
import { submitToRegistry } from "../registry/stubPartnerClient.js";
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

    if (scenario === "verified" || scenario === "rejected") {
      await registryCallbackDeliveryQueue.add(
        "deliver",
        { parcelId, registryReferenceId, result: scenario, callbackId: randomUUID(), requestId },
        { delay: Math.round(randomBetween(1000, 3000)) },
      );
    } else if (scenario === "duplicate") {
      // Same callback_id delivered twice, a few seconds apart — exactly
      // the "partner redelivers the same result" case the brief calls out.
      const payload = {
        parcelId,
        registryReferenceId,
        result: "verified" as const,
        callbackId: randomUUID(),
        requestId,
      };
      await registryCallbackDeliveryQueue.add("deliver", payload, { delay: 1500 });
      await registryCallbackDeliveryQueue.add("deliver", payload, { delay: 3500 });
    }
  },
  { connection: redisConnection },
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
