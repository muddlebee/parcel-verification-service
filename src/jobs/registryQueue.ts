import { Queue } from "bullmq";
import { redisConnection } from "./redisConnection.js";
import type { RegistryScenario } from "../registry/stubPartnerClient.js";

export interface RegistrySubmitJobData {
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

// The outbound leg: "call the partner and tell them about this parcel."
// Retry/backoff is configured per-job at enqueue time (see verify.routes.ts)
// so it can be tuned without touching this file.
export const registrySubmitQueue = new Queue<RegistrySubmitJobData>("registry-submit", {
  connection: redisConnection,
});

export interface CallbackDeliveryJobData {
  parcelId: string;
  registryReferenceId: string;
  result: "verified" | "rejected";
  callbackId: string;
  requestId: string;
}

// The inbound leg: "the partner is now telling us the result." Modeled as
// its own delayed queue rather than a raw setTimeout inside the submit
// worker specifically so it survives a process restart — a real partner's
// callback doesn't care whether our process was up when it decided to
// call, and a durable queue is the only way that's still true here.
export const registryCallbackDeliveryQueue = new Queue<CallbackDeliveryJobData>("registry-callback-delivery", {
  connection: redisConnection,
});
