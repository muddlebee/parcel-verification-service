import { Queue } from "bullmq";
import { redisConnection } from "../jobs/redisConnection.js";
import type { RegistryScenario } from "./stubPartnerClient.js";

export interface SubmitJobData {
  parcelId: string;
  registryReferenceId: string;
  scenario: RegistryScenario;
  // The X-Request-Id of the /verify call that enqueued this job — lets an
  // on-call engineer trace from "the HTTP request that kicked this off"
  // through every retry attempt by grepping one ID. Threaded through to
  // the callback-delivery job too (below), but stops there: the actual
  // callback delivery crosses into "the partner calling us," which is a
  // genuinely new inbound request in reality, so it correctly gets its
  // own fresh request ID rather than inheriting this one.
  requestId: string;
}

// Outbound leg: "call the partner and tell them about this parcel."
// Retry/backoff is configured per-job at enqueue time (see verify.routes.ts).
// Redis queue name keeps a "registry-" prefix so keys stay identifiable if
// other services share the same Redis.
export const submitQueue = new Queue<SubmitJobData>("registry-submit", {
  connection: redisConnection,
});

export interface CallbackDeliveryJobData {
  parcelId: string;
  registryReferenceId: string;
  result: "verified" | "rejected";
  callbackId: string;
  requestId: string;
}

// Inbound leg: "the partner is now telling us the result."
//
// Producer: submitWorker (after partner ack) — delayed add().
// Consumer: callbackDeliveryWorker — HTTP POSTs to /callbacks/registry.
//
// Separate delayed queue (not setTimeout in the submit worker) so it
// survives process restarts. Does not touch DB — only the callback route
// does, via recordCallbackAndTransition.
export const callbackDeliveryQueue = new Queue<CallbackDeliveryJobData>("registry-callback-delivery", {
  connection: redisConnection,
});
