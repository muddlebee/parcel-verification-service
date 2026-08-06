import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/kysely.js";

const app = buildApp();
const authHeader = { "X-API-Key": env.API_KEY };

async function createVerifiedParcel(): Promise<string> {
  const createRes = await request(app)
    .post("/api/v1/parcels")
    .set(authHeader)
    .send({
      parcel: {
        khata_no: "dispute-test",
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

  const verifyRes = await request(app).post(`/api/v1/parcels/${parcelId}/verify`).set(authHeader).send({});
  const registryReferenceId = verifyRes.body.registry_reference_id as string;

  // Drive straight to 'verified' via the callback endpoint directly,
  // bypassing the async worker/stub timing — this file is testing the
  // manual-transition endpoint, not the registry pipeline.
  await request(app).post("/api/v1/callbacks/registry").send({
    registry_reference_id: registryReferenceId,
    callback_id: randomUUID(),
    result: "verified",
    delivered_at: new Date().toISOString(),
  });

  return parcelId;
}

afterAll(async () => {
  await db.destroy();
});

describe("POST /api/v1/parcels/:id/transitions", () => {
  it("moves verified -> disputed with actor and reason recorded", async () => {
    const parcelId = await createVerifiedParcel();

    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/transitions`)
      .set(authHeader)
      .send({ to: "disputed", actor: "ops:priya", reason: "Competing ownership claim filed by third party." });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("disputed");
    const last = res.body.history.at(-1);
    expect(last).toMatchObject({
      from_state: "verified",
      to_state: "disputed",
      actor: "ops:priya",
      reason: "Competing ownership claim filed by third party.",
    });
  });

  it("is reversible: disputed -> verified", async () => {
    const parcelId = await createVerifiedParcel();

    await request(app)
      .post(`/api/v1/parcels/${parcelId}/transitions`)
      .set(authHeader)
      .send({ to: "disputed", actor: "ops:priya", reason: "Competing claim." });

    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/transitions`)
      .set(authHeader)
      .send({ to: "verified", actor: "ops:priya", reason: "Competing claim resolved in original owner's favor." });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("verified");
    expect(res.body.history.filter((h: { to_state: string }) => h.to_state === "disputed")).toHaveLength(1);
    expect(res.body.history.filter((h: { to_state: string }) => h.to_state === "verified")).toHaveLength(2);
  });

  it("rejects a transition that isn't verified<->disputed with 409", async () => {
    const parcelId = await createVerifiedParcel();

    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/transitions`)
      .set(authHeader)
      .send({ to: "rejected", actor: "ops:priya", reason: "Attempting an unsupported edge." });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("returns 404 for a parcel that doesn't exist", async () => {
    const res = await request(app)
      .post(`/api/v1/parcels/${randomUUID()}/transitions`)
      .set(authHeader)
      .send({ to: "disputed", actor: "ops:priya", reason: "N/A" });

    expect(res.status).toBe(404);
  });

  it("rejects requests without a valid X-API-Key", async () => {
    const parcelId = await createVerifiedParcel();

    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/transitions`)
      .send({ to: "disputed", actor: "ops:priya", reason: "N/A" });

    expect(res.status).toBe(401);
  });

  it("rejects a request missing reason or actor with 400", async () => {
    const parcelId = await createVerifiedParcel();

    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/transitions`)
      .set(authHeader)
      .send({ to: "disputed" });

    expect(res.status).toBe(400);
  });
});
