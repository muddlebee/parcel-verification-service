import type { Server } from "http";
import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/kysely.js";
import { registryCallbackDeliveryQueue, registrySubmitQueue } from "../../src/jobs/registryQueue.js";
import { registrySubmitWorker } from "../../src/jobs/registrySubmitWorker.js";
import { callbackDeliveryWorker } from "../../src/jobs/callbackDeliveryWorker.js";
import { redisConnection } from "../../src/jobs/redisConnection.js";

// Unlike the other integration test files, this one imports the actual
// workers — retry/backoff/exhaustion is meaningless to test without
// something consuming the queue and re-attempting. Vitest isolates each
// test file into its own module context by default, so starting these
// workers here doesn't affect the other integration test files. Timing
// comes from vitest.config.ts (150ms backoff base, 250ms call timeout, 3
// attempts) so the whole suite stays fast.
//
// This file also needs a *real* listening server, unlike the others: the
// callback-delivery worker does a genuine HTTP fetch to
// http://localhost:${env.PORT}, and supertest's in-memory app (no real
// socket) has nothing for that fetch to connect to.
const app = buildApp();
const authHeader = { "X-API-Key": env.API_KEY };
let server: Server;

beforeAll(() => {
  return new Promise<void>((resolve) => {
    server = app.listen(env.PORT, () => resolve());
  });
});

async function createParcelAndVerify(scenario: string): Promise<string> {
  const createRes = await request(app)
    .post("/api/v1/parcels")
    .set(authHeader)
    .send({
      parcel: {
        khata_no: "retry-test",
        plot_no: "1",
        district: `TestDistrict-${randomUUID()}`,
        tehsil: "T",
        village: "V",
        area_sqft: 100,
        claimed_ownership_since: "2020-01-01",
      },
      owner: {
        full_name: "X",
        mobile: "+919876543210",
        aadhaar_number: "123412341234",
        pan_number: "ABCDE1234F",
        bank_account_number: "501001234",
        ifsc: "HDFC0001234",
      },
    });
  const parcelId = createRes.body.id as string;
  await request(app).post(`/api/v1/parcels/${parcelId}/verify`).set(authHeader).send({ scenario });
  return parcelId;
}

async function pollParcel(
  parcelId: string,
  predicate: (body: { status: string; registry_sync_status: string }) => boolean,
  timeoutMs: number,
): Promise<{ status: string; registry_sync_status: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    if (predicate(res.body)) return res.body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for condition on parcel ${parcelId}`);
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await registrySubmitWorker.close();
  await callbackDeliveryWorker.close();
  await registrySubmitQueue.close();
  await registryCallbackDeliveryQueue.close();
  await redisConnection.quit();
  await db.destroy();
});

describe("registry retry, backoff, and exhaustion", () => {
  it("exhausts retries on a persistent timeout, leaving the parcel validly in under_verification", async () => {
    const parcelId = await createParcelAndVerify("timeout");

    const final = await pollParcel(parcelId, (b) => b.registry_sync_status === "exhausted", 10_000);

    // The retry mechanism never touches the 5-state machine — a stuck
    // partner call is an operator-actionable signal, not a business state.
    expect(final.status).toBe("under_verification");
  }, 15_000);

  it("exhausts retries on a persistent partner failure the same way", async () => {
    const parcelId = await createParcelAndVerify("failure");

    const final = await pollParcel(parcelId, (b) => b.registry_sync_status === "exhausted", 10_000);
    expect(final.status).toBe("under_verification");
  }, 15_000);

  it("reaches registry_sync_status 'done' then parcel.status 'verified' on a successful ack + callback", async () => {
    const parcelId = await createParcelAndVerify("verified");

    await pollParcel(parcelId, (b) => b.registry_sync_status === "done", 5_000);
    const final = await pollParcel(parcelId, (b) => b.status === "verified", 10_000);
    expect(final.status).toBe("verified");
  }, 15_000);

  it("applies a duplicate-delivered callback exactly once", async () => {
    const parcelId = await createParcelAndVerify("duplicate");

    await pollParcel(parcelId, (b) => b.status === "verified", 10_000);

    const detail = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    const verifiedTransitions = detail.body.history.filter((h: { to_state: string }) => h.to_state === "verified");
    expect(verifiedTransitions).toHaveLength(1);
  }, 15_000);
});
