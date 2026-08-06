import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { Router } from "express";
import { z } from "zod";
import { registry } from "../openapi/registry.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { upload } from "../middleware/upload.js";
import { ApiError } from "../middleware/errorHandler.js";
import { ErrorResponseSchema, ParcelIdParamSchema } from "../schemas/common.schemas.js";
import {
  AttachDocumentFieldsSchema,
  DOCUMENT_TYPES,
  matchesDeclaredMimeType,
  MIME_TYPE_EXTENSIONS,
} from "../schemas/document.schemas.js";
import { DocumentSchema } from "../schemas/parcel.schemas.js";
import { createDocument, parcelExists } from "../../db/repositories/documents.repository.js";
import { toDocument } from "../mappers/parcel.mapper.js";
import { env } from "../../config/env.js";

export const documentsRouter = Router();
documentsRouter.use(apiKeyAuth);

const AttachDocumentMultipartSchema = z.object({
  file: z.any().openapi({ type: "string", format: "binary" }),
  document_type: z.enum(DOCUMENT_TYPES),
});

registry.registerPath({
  method: "post",
  path: "/parcels/{id}/documents",
  tags: ["Documents"],
  summary: "Attach a document to a parcel (metadata + local disk storage, no real object store).",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: ParcelIdParamSchema,
    body: { content: { "multipart/form-data": { schema: AttachDocumentMultipartSchema } } },
  },
  responses: {
    201: { description: "Attached.", content: { "application/json": { schema: DocumentSchema } } },
    400: {
      description: "Missing file, bad document_type, or unsupported content type.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: { description: "No parcel with that id.", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
// Not restricted to a particular parcel status — ops may attach a document
// supporting a dispute after a parcel is already verified, for example.
// Attaching a document is not itself a state-machine transition.
documentsRouter.post("/parcels/:id/documents", upload.single("file"), async (req, res) => {
  const { id } = ParcelIdParamSchema.parse(req.params);
  const { document_type } = AttachDocumentFieldsSchema.parse(req.body);

  if (!req.file) {
    throw new ApiError(400, "FILE_REQUIRED", "A 'file' field with the document is required.");
  }

  if (!matchesDeclaredMimeType(req.file.buffer, req.file.mimetype)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_MEDIA_TYPE",
      `File content doesn't match declared type '${req.file.mimetype}'.`,
    );
  }

  if (!(await parcelExists(id))) {
    throw new ApiError(404, "PARCEL_NOT_FOUND", `No parcel with id '${id}'.`);
  }

  const extension = MIME_TYPE_EXTENSIONS[req.file.mimetype as keyof typeof MIME_TYPE_EXTENSIONS] ?? "";
  // Generated server-side, never derived from the client-supplied file
  // name — that name is only ever stored as a display string, never used
  // to build a filesystem path (path traversal / collision prevention).
  const storagePath = path.join(env.UPLOAD_DIR, id, `${randomUUID()}${extension}`);
  await mkdir(path.dirname(storagePath), { recursive: true });
  await writeFile(storagePath, req.file.buffer);

  const document = await createDocument({
    parcelId: id,
    documentType: document_type,
    originalFileName: req.file.originalname,
    contentType: req.file.mimetype,
    sizeBytes: req.file.size,
    storagePath,
  });

  res.status(201).json(toDocument(document));
});
