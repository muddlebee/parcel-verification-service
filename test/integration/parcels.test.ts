import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/kysely.js";

// Runs against the real Postgres from docker-compose (`docker compose up -d
// postgres redis` before `npm test`) rather than mocks — the brief cares
// about idempotency/state-machine correctness under a real DB, which a
// mocked query builder can't actually prove. Every test seeds its own
// unique district (a random suffix) so assertions on list counts/pagination
// don't depend on the table being empty or on test execution order.
const app = buildApp();

function validPayload(overrides?: { district?: string; khata_no?: string }) {
  return {
    parcel: {
      khata_no: overrides?.khata_no ?? "412/3",
      plot_no: "1187",
      district: overrides?.district ?? `TestDistrict-${randomUUID()}`,
      tehsil: "Bhubaneswar",
      village: "Patia",
      area_sqft: 12000,
      claimed_ownership_since: "2011-04-18",
    },
    owner: {
      full_name: "Anita Behera",
      mobile: "+919876543210",
      aadhaar_number: "123412341234",
      pan_number: "ABCDE1234F",
      bank_account_number: "50100123456789",
      ifsc: "HDFC0001234",
    },
  };
}

const authHeader = { "X-API-Key": env.API_KEY };

afterAll(async () => {
  await db.destroy();
});

describe("POST /api/v1/parcels", () => {
  it("creates a parcel, auto-advances to documents_pending, and records both transitions", async () => {
    const payload = validPayload();

    const createRes = await request(app).post("/api/v1/parcels").set(authHeader).send(payload);
    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toBeTypeOf("string");

    const getRes = await request(app).get(`/api/v1/parcels/${createRes.body.id}`).set(authHeader);
    expect(getRes.status).toBe(200);
    expect(getRes.body.status).toBe("documents_pending");
    expect(getRes.body.claimed_ownership_since).toBe("2011-04-18");
    expect(getRes.body.owner).toMatchObject(payload.owner);
    expect(getRes.body.documents).toEqual([]);
    expect(getRes.body.history).toHaveLength(2);
    expect(getRes.body.history[0]).toMatchObject({ from_state: null, to_state: "submitted", actor: "api-client" });
    expect(getRes.body.history[1]).toMatchObject({
      from_state: "submitted",
      to_state: "documents_pending",
      actor: "system",
    });
  });

  it("rejects a malformed PAN with 400 before touching the database", async () => {
    const payload = validPayload();
    payload.owner.pan_number = "NOT-A-PAN";

    const res = await request(app).post("/api/v1/parcels").set(authHeader).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects requests without a valid X-API-Key", async () => {
    const res = await request(app).post("/api/v1/parcels").send(validPayload());
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/parcels/:id", () => {
  it("returns 404 for an id that doesn't exist", async () => {
    const res = await request(app).get(`/api/v1/parcels/${randomUUID()}`).set(authHeader);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PARCEL_NOT_FOUND");
  });
});

describe("GET /api/v1/parcels", () => {
  it("filters by status and district, and paginates", async () => {
    const district = `TestDistrict-${randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/v1/parcels")
        .set(authHeader)
        .send(validPayload({ district, khata_no: `khata-${i}` }));
      expect(res.status).toBe(201);
    }

    const page1 = await request(app)
      .get("/api/v1/parcels")
      .query({ district, status: "documents_pending", page: 1, limit: 2 })
      .set(authHeader);
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.pagination).toEqual({ page: 1, limit: 2, total: 3, total_pages: 2 });
    expect(page1.body.data.every((p: { district: string }) => p.district === district)).toBe(true);

    const page2 = await request(app)
      .get("/api/v1/parcels")
      .query({ district, status: "documents_pending", page: 2, limit: 2 })
      .set(authHeader);
    expect(page2.body.data).toHaveLength(1);

    const wrongStatus = await request(app)
      .get("/api/v1/parcels")
      .query({ district, status: "verified" })
      .set(authHeader);
    expect(wrongStatus.body.data).toHaveLength(0);
    expect(wrongStatus.body.pagination.total).toBe(0);
  });
});
