import { randomUUID } from "crypto";
import { existsSync, rmSync } from "fs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/kysely.js";

const app = buildApp();
const authHeader = { "X-API-Key": env.API_KEY };

const FAKE_PDF = Buffer.from("%PDF-1.4\nnot a real pdf, just a valid header for the magic-byte check\n");
const FAKE_TEXT = Buffer.from("this is plain text, not a pdf");

async function createParcel(): Promise<string> {
  const res = await request(app)
    .post("/api/v1/parcels")
    .set(authHeader)
    .send({
      parcel: {
        khata_no: "doc-test",
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
  await db.destroy();
});

describe("POST /api/v1/parcels/:id/documents", () => {
  let parcelId: string;

  beforeAll(async () => {
    parcelId = await createParcel();
  });

  afterAll(() => {
    if (existsSync(`${env.UPLOAD_DIR}/${parcelId}`)) {
      rmSync(`${env.UPLOAD_DIR}/${parcelId}`, { recursive: true, force: true });
    }
  });

  it("accepts a valid PDF, writes it to disk, and records metadata", async () => {
    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents`)
      .set(authHeader)
      .field("document_type", "sale_deed")
      .attach("file", FAKE_PDF, { filename: "deed.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      document_type: "sale_deed",
      original_file_name: "deed.pdf",
      content_type: "application/pdf",
      size_bytes: FAKE_PDF.length,
    });
    expect(res.body.storage_path).toBeUndefined(); // never leaked to the client

    const detail = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    expect(detail.body.documents).toHaveLength(1);
    expect(detail.body.documents[0].id).toBe(res.body.id);
  });

  it("rejects a file whose content doesn't match its declared mime type", async () => {
    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents`)
      .set(authHeader)
      .field("document_type", "sale_deed")
      .attach("file", FAKE_TEXT, { filename: "deed.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects an unrecognized document_type", async () => {
    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents`)
      .set(authHeader)
      .field("document_type", "not_a_real_type")
      .attach("file", FAKE_PDF, { filename: "deed.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
  });

  it("returns 404 for a parcel that doesn't exist, without creating a file", async () => {
    const missingId = randomUUID();
    const res = await request(app)
      .post(`/api/v1/parcels/${missingId}/documents`)
      .set(authHeader)
      .field("document_type", "sale_deed")
      .attach("file", FAKE_PDF, { filename: "deed.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(404);
    expect(existsSync(`${env.UPLOAD_DIR}/${missingId}`)).toBe(false);
  });
});
