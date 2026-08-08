import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/kysely.js";
import { callbackDeliveryQueue, submitQueue } from "../../src/registry/queues.js";
import { redisConnection } from "../../src/jobs/redisConnection.js";

// The verify endpoint sets registry_reference_id and moves the parcel to
// under_verification synchronously, before the async worker/stub ever
// runs — so these tests call /verify to get a real reference_id, then
// hit /callbacks/registry directly with a controlled payload, rather than
// waiting on the real BullMQ timing. The full async loop (worker calls
// stub, stub schedules a genuine HTTP callback) was verified manually;
// this file is about the callback endpoint's own contract in isolation.
const app = buildApp();
const authHeader = { "X-API-Key": env.API_KEY };

async function createVerifiableParcel(): Promise<{ parcelId: string; registryReferenceId: string }> {
  const createRes = await request(app)
    .post("/api/v1/parcels")
    .set(authHeader)
    .send({
      parcel: {
        khata_no: "callback-test",
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

  // Force "failure" so the background worker doesn't itself race to
  // schedule a real callback delivery job while the test is driving the
  // callback endpoint manually — keeps these tests deterministic.
  const verifyRes = await request(app)
    .post(`/api/v1/parcels/${parcelId}/verify`)
    .set(authHeader)
    .send({ scenario: "failure" });

  return { parcelId, registryReferenceId: verifyRes.body.registry_reference_id as string };
}

afterAll(async () => {
  await submitQueue.close();
  await callbackDeliveryQueue.close();
  await redisConnection.quit();
  await db.destroy();
});

describe("POST /api/v1/callbacks/registry", () => {
  it("requires no authentication", async () => {
    const { registryReferenceId } = await createVerifiableParcel();

    const res = await request(app).post("/api/v1/callbacks/registry").send({
      registry_reference_id: registryReferenceId,
      callback_id: randomUUID(),
      result: "verified",
      delivered_at: new Date().toISOString(),
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("applied");
  });

  it("applies the transition and is idempotent on a repeated callback_id", async () => {
    const { parcelId, registryReferenceId } = await createVerifiableParcel();
    const callbackId = randomUUID();
    const payload = {
      registry_reference_id: registryReferenceId,
      callback_id: callbackId,
      result: "verified" as const,
      delivered_at: new Date().toISOString(),
    };

    const first = await request(app).post("/api/v1/callbacks/registry").send(payload);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: "applied", parcel_id: parcelId });

    const second = await request(app).post("/api/v1/callbacks/registry").send(payload);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: "duplicate_ignored", parcel_id: parcelId });

    const detail = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    expect(detail.body.status).toBe("verified");
    const verifiedTransitions = detail.body.history.filter((h: { to_state: string }) => h.to_state === "verified");
    expect(verifiedTransitions).toHaveLength(1);
  });

  it("returns 404 for an unknown registry_reference_id", async () => {
    const res = await request(app)
      .post("/api/v1/callbacks/registry")
      .send({
        registry_reference_id: randomUUID(),
        callback_id: randomUUID(),
        result: "verified",
        delivered_at: new Date().toISOString(),
      });
    expect(res.status).toBe(404);
  });

  it("returns 409 for a different callback_id that conflicts with the parcel's resolved state", async () => {
    const { parcelId, registryReferenceId } = await createVerifiableParcel();

    const applied = await request(app)
      .post("/api/v1/callbacks/registry")
      .send({
        registry_reference_id: registryReferenceId,
        callback_id: randomUUID(),
        result: "verified",
        delivered_at: new Date().toISOString(),
      });
    expect(applied.status).toBe(200);

    // A genuinely different callback_id, not a redelivery — this is not
    // the idempotency case, it's a conflicting second result.
    const conflicting = await request(app)
      .post("/api/v1/callbacks/registry")
      .send({
        registry_reference_id: registryReferenceId,
        callback_id: randomUUID(),
        result: "rejected",
        delivered_at: new Date().toISOString(),
      });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error.code).toBe("INVALID_TRANSITION");

    const detail = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    expect(detail.body.status).toBe("verified"); // unchanged by the conflicting callback
  });
});
