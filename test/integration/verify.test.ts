import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/kysely.js";
import { callbackDeliveryQueue, submitQueue } from "../../src/registry/queues.js";
import { redisConnection } from "../../src/jobs/redisConnection.js";

const app = buildApp();
const authHeader = { "X-API-Key": env.API_KEY };

async function createParcel(): Promise<string> {
  const res = await request(app)
    .post("/api/v1/parcels")
    .set(authHeader)
    .send({
      parcel: {
        khata_no: "verify-contract-test",
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
  return res.body.id as string;
}

afterAll(async () => {
  await submitQueue.close();
  await callbackDeliveryQueue.close();
  await redisConnection.quit();
  await db.destroy();
});

describe("POST /api/v1/parcels/:id/verify", () => {
  it("returns 404 for a parcel that doesn't exist", async () => {
    const res = await request(app).post(`/api/v1/parcels/${randomUUID()}/verify`).set(authHeader).send({});
    expect(res.status).toBe(404);
  });

  it("rejects requests without a valid X-API-Key", async () => {
    const parcelId = await createParcel();
    const res = await request(app).post(`/api/v1/parcels/${parcelId}/verify`).send({});
    expect(res.status).toBe(401);
  });

  it("moves documents_pending -> under_verification and enqueues the registry call", async () => {
    const parcelId = await createParcel();

    const res = await request(app).post(`/api/v1/parcels/${parcelId}/verify`).set(authHeader).send({});
    expect(res.status).toBe(202);
    expect(res.body.registry_reference_id).toBeTypeOf("string");

    const detail = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    expect(detail.body.status).toBe("under_verification");
    expect(detail.body.registry_sync_status).toBe("queued");
    expect(detail.body.history.at(-1)).toMatchObject({
      from_state: "documents_pending",
      to_state: "under_verification",
    });
  });

  it("returns 409 when called on a parcel that's already under_verification", async () => {
    const parcelId = await createParcel();

    const first = await request(app).post(`/api/v1/parcels/${parcelId}/verify`).set(authHeader).send({});
    expect(first.status).toBe(202);

    const second = await request(app).post(`/api/v1/parcels/${parcelId}/verify`).set(authHeader).send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("INVALID_TRANSITION");
  });
});
