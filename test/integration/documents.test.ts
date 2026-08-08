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
    expect(detail.body.documents.length).toBeGreaterThanOrEqual(1);
    expect(detail.body.documents.some((d: { id: string }) => d.id === res.body.id)).toBe(true);
  });

  it("accepts metadata-only attach when file is omitted (Swagger send empty value)", async () => {
    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents`)
      .set(authHeader)
      .field("document_type", "owner_id_proof");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      document_type: "owner_id_proof",
      original_file_name: "",
      content_type: "application/octet-stream",
      size_bytes: 0,
    });
    expect(res.body.storage_path).toBeUndefined();
  });

  it("treats a 0-byte file the same as omitted (empty upload)", async () => {
    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents`)
      .set(authHeader)
      .field("document_type", "other")
      .attach("file", Buffer.alloc(0), { filename: "empty.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      document_type: "other",
      size_bytes: 0,
      original_file_name: "",
    });
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

describe("POST /api/v1/parcels/:id/documents/batch", () => {
  let parcelId: string;

  beforeAll(async () => {
    parcelId = await createParcel();
  });

  afterAll(() => {
    if (existsSync(`${env.UPLOAD_DIR}/${parcelId}`)) {
      rmSync(`${env.UPLOAD_DIR}/${parcelId}`, { recursive: true, force: true });
    }
  });

  it("files each upload under the document type named by its field", async () => {
    const before = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    const beforeCount = before.body.documents.length as number;

    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents/batch`)
      .set(authHeader)
      .attach("sale_deed", FAKE_PDF, { filename: "deed.pdf", contentType: "application/pdf" })
      .attach("owner_id_proof", FAKE_PDF, { filename: "id.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      document_type: "sale_deed",
      original_file_name: "deed.pdf",
      size_bytes: FAKE_PDF.length,
    });
    expect(res.body.data[1]).toMatchObject({
      document_type: "owner_id_proof",
      original_file_name: "id.pdf",
    });

    const detail = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    expect(detail.body.documents.length).toBe(beforeCount + 2);
  });

  it("accepts several files under the same document type", async () => {
    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents/batch`)
      .set(authHeader)
      .attach("other", FAKE_PDF, { filename: "a.pdf", contentType: "application/pdf" })
      .attach("other", FAKE_PDF, { filename: "b.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    expect(res.body.data.every((d: { document_type: string }) => d.document_type === "other")).toBe(true);
    expect(res.body.data.map((d: { original_file_name: string }) => d.original_file_name)).toEqual([
      "a.pdf",
      "b.pdf",
    ]);
  });

  // Field order in the request must not change how documents are classified —
  // that was the whole failure mode of the index-paired design.
  it("classifies by field name regardless of the order fields arrive in", async () => {
    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents/batch`)
      .set(authHeader)
      .attach("owner_id_proof", FAKE_PDF, { filename: "aadhaar.pdf", contentType: "application/pdf" })
      .attach("sale_deed", FAKE_PDF, { filename: "sale.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const byName = Object.fromEntries(
      res.body.data.map((d: { original_file_name: string; document_type: string }) => [
        d.original_file_name,
        d.document_type,
      ]),
    );
    expect(byName).toEqual({ "aadhaar.pdf": "owner_id_proof", "sale.pdf": "sale_deed" });
  });

  it("rejects a batch with no files at all", async () => {
    const res = await request(app).post(`/api/v1/parcels/${parcelId}/documents/batch`).set(authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BATCH_EMPTY");
  });

  it("rejects a field name that isn't a document type", async () => {
    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents/batch`)
      .set(authHeader)
      .attach("files", FAKE_PDF, { filename: "deed.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UPLOAD_LIMIT_UNEXPECTED_FILE");
  });

  it("rejects more than max files across all fields", async () => {
    let req = request(app).post(`/api/v1/parcels/${parcelId}/documents/batch`).set(authHeader);
    for (let i = 0; i < 11; i++) {
      req = req.attach("other", FAKE_PDF, { filename: `f${i}.pdf`, contentType: "application/pdf" });
    }

    const res = await req;
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UPLOAD_LIMIT_FILE_COUNT");
  });

  it("rejects the whole batch when one file has bad mime (no partial apply)", async () => {
    const before = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    const beforeCount = before.body.documents.length as number;

    const res = await request(app)
      .post(`/api/v1/parcels/${parcelId}/documents/batch`)
      .set(authHeader)
      .attach("sale_deed", FAKE_PDF, { filename: "ok.pdf", contentType: "application/pdf" })
      .attach("other", FAKE_TEXT, { filename: "bad.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const after = await request(app).get(`/api/v1/parcels/${parcelId}`).set(authHeader);
    expect(after.body.documents.length).toBe(beforeCount);
  });

  it("returns 404 for an unknown parcel", async () => {
    const missingId = randomUUID();
    const res = await request(app)
      .post(`/api/v1/parcels/${missingId}/documents/batch`)
      .set(authHeader)
      .attach("sale_deed", FAKE_PDF, { filename: "deed.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(404);
    expect(existsSync(`${env.UPLOAD_DIR}/${missingId}`)).toBe(false);
  });
});
