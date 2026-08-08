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

// file is optional: brief allows metadata-only attach; Swagger "send empty
// value" and clients that omit the binary both hit that path.
const AttachDocumentMultipartSchema = z.object({
  file: z.any().optional().openapi({ type: "string", format: "binary" }),
  document_type: z.enum(DOCUMENT_TYPES),
});

registry.registerPath({
  method: "post",
  path: "/parcels/{id}/documents",
  tags: ["Documents"],
  summary:
    "Attach a document to a parcel. File is optional — omit or send empty to record metadata only (local disk when bytes are present).",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: ParcelIdParamSchema,
    body: { content: { "multipart/form-data": { schema: AttachDocumentMultipartSchema } } },
  },
  responses: {
    201: { description: "Attached.", content: { "application/json": { schema: DocumentSchema } } },
    400: {
      description: "Bad document_type, or file content doesn't match declared mime type.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: { description: "No parcel with that id.", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
// Not restricted to a particular parcel status — ops may attach a document
// supporting a dispute after a parcel is already verified, for example.
// Attaching a document is not itself a state-machine transition.
documentsRouter.post("/parcels/:id/documents", apiKeyAuth, upload.single("file"), async (req, res) => {
  const { id } = ParcelIdParamSchema.parse(req.params);
  const { document_type } = AttachDocumentFieldsSchema.parse(req.body);

  // Swagger "send empty value" may omit the part or send a 0-byte upload.
  const file = req.file && req.file.size > 0 ? req.file : undefined;

  if (file && !matchesDeclaredMimeType(file.buffer, file.mimetype)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_MEDIA_TYPE",
      `File content doesn't match declared type '${file.mimetype}'.`,
    );
  }

  if (!(await parcelExists(id))) {
    throw new ApiError(404, "PARCEL_NOT_FOUND", `No parcel with id '${id}'.`);
  }

  let storagePath: string | null = null;
  if (file) {
    const extension = MIME_TYPE_EXTENSIONS[file.mimetype as keyof typeof MIME_TYPE_EXTENSIONS] ?? "";
    // Generated server-side, never derived from the client-supplied file
    // name — that name is only ever stored as a display string, never used
    // to build a filesystem path (path traversal / collision prevention).
    storagePath = path.join(env.UPLOAD_DIR, id, `${randomUUID()}${extension}`);
    await mkdir(path.dirname(storagePath), { recursive: true });
    await writeFile(storagePath, file.buffer);
  }

  const document = await createDocument({
    parcelId: id,
    documentType: document_type,
    originalFileName: file?.originalname ?? "",
    contentType: file?.mimetype ?? "application/octet-stream",
    sizeBytes: file?.size ?? 0,
    storagePath,
  });

  req.log.info(
    {
      parcelId: id,
      documentId: document.id,
      documentType: document_type,
      sizeBytes: document.size_bytes,
      metadataOnly: storagePath === null,
    },
    "document attached",
  );

  res.status(201).json(toDocument(document));
});
