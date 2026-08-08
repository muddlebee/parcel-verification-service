import { Router } from "express";
import { z } from "zod";
import { registry } from "../openapi/registry.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { uploadBatchDocuments, uploadSingleDocument } from "../middleware/upload.js";
import { ApiError } from "../middleware/errorHandler.js";
import { ErrorResponseSchema, ParcelIdParamSchema } from "../schemas/common.schemas.js";
import {
  AttachDocumentFieldsSchema,
  BatchDocumentsResponseSchema,
  DOCUMENT_TYPES,
  DOCUMENTS_BATCH_MAX,
  type DocumentType,
} from "../schemas/document.schemas.js";
import { DocumentSchema } from "../schemas/parcel.schemas.js";
import { parcelExists } from "../../db/repositories/documents.repository.js";
import { toDocument } from "../mappers/parcel.mapper.js";
import { persistDocuments, prepareDocumentItem } from "../services/attachDocument.js";

export const documentsRouter = Router();

// file is optional: brief allows metadata-only attach; Swagger "send empty
// value" and clients that omit the binary both hit that path.
const AttachDocumentMultipartSchema = z.object({
  file: z.any().optional().openapi({
    type: "string",
    format: "binary",
    description: "Optional PDF/PNG/JPEG (max 10MB). Omit or empty for metadata-only.",
  }),
  document_type: z
    .enum(DOCUMENT_TYPES)
    .openapi({ description: "Document classification.", example: "sale_deed" }),
});

// One multipart field per document type rather than a `files` array paired by
// index with a parallel `document_types` array. Swagger UI renders this as one
// labelled file picker per type, so the classification is structural — there is
// no ordering for the operator (or the browser) to get wrong.
const batchFileField = (documentType: DocumentType) =>
  z
    .array(z.any().openapi({ type: "string", format: "binary" }))
    .max(DOCUMENTS_BATCH_MAX)
    .optional()
    .openapi({ description: `Files to file as '${documentType}'. PDF/PNG/JPEG, max 10MB each.` });

const BatchDocumentsMultipartSchema = z.object(
  Object.fromEntries(DOCUMENT_TYPES.map((t) => [t, batchFileField(t)])) as Record<
    DocumentType,
    ReturnType<typeof batchFileField>
  >,
);

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

// Register /batch before the collection POST is not required by Express path
// matching (different paths), but keeps the batch surface obvious in the file.
registry.registerPath({
  method: "post",
  path: "/parcels/{id}/documents/batch",
  tags: ["Documents"],
  summary:
    "Attach multiple documents in one request (all-or-nothing). Upload each file under the field named " +
    "after its document type; max " +
    String(DOCUMENTS_BATCH_MAX) +
    " files total. For a metadata-only record, use the single attach endpoint.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: ParcelIdParamSchema,
    body: { content: { "multipart/form-data": { schema: BatchDocumentsMultipartSchema } } },
  },
  responses: {
    201: {
      description: "All documents attached.",
      content: { "application/json": { schema: BatchDocumentsResponseSchema } },
    },
    400: {
      description:
        "No files attached, more than " +
        String(DOCUMENTS_BATCH_MAX) +
        " files, unknown field name, or a file whose content doesn't match its declared mime type.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: { description: "No parcel with that id.", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// Not restricted to a particular parcel status — ops may attach a document
// supporting a dispute after a parcel is already verified, for example.
// Attaching a document is not itself a state-machine transition.
documentsRouter.post("/parcels/:id/documents/batch", apiKeyAuth, uploadBatchDocuments, async (req, res) => {
  const { id } = ParcelIdParamSchema.parse(req.params);
  const filesByType = (req.files ?? {}) as Partial<Record<DocumentType, Express.Multer.File[]>>;

  // Walk DOCUMENT_TYPES rather than the request's field order so the response
  // ordering is stable regardless of how the client laid out the multipart body.
  // Over-max and unknown field names never reach here — multer rejects both.
  const items = DOCUMENT_TYPES.flatMap((documentType) =>
    (filesByType[documentType] ?? []).map((file) => ({ documentType, file })),
  );

  if (items.length === 0) {
    throw new ApiError(
      400,
      "BATCH_EMPTY",
      `Attach at least one file under a document-type field (${DOCUMENT_TYPES.join(", ")}).`,
    );
  }

  if (!(await parcelExists(id))) {
    throw new ApiError(404, "PARCEL_NOT_FOUND", `No parcel with id '${id}'.`);
  }

  // Validate all items first (prepare throws on bad mime) — no disk/DB yet.
  const prepared = items.map(({ file, documentType }) => prepareDocumentItem(file, documentType));

  const rows = await persistDocuments(id, prepared);

  req.log.info(
    { parcelId: id, count: rows.length, documentIds: rows.map((r) => r.id) },
    "documents batch attached",
  );

  res.status(201).json({
    data: rows.map(toDocument),
    count: rows.length,
  });
});

documentsRouter.post("/parcels/:id/documents", apiKeyAuth, uploadSingleDocument, async (req, res) => {
  const { id } = ParcelIdParamSchema.parse(req.params);
  const { document_type } = AttachDocumentFieldsSchema.parse(req.body);

  if (!(await parcelExists(id))) {
    throw new ApiError(404, "PARCEL_NOT_FOUND", `No parcel with id '${id}'.`);
  }

  const prepared = prepareDocumentItem(req.file, document_type);
  const [document] = await persistDocuments(id, [prepared]);

  req.log.info(
    {
      parcelId: id,
      documentId: document!.id,
      documentType: document_type,
      sizeBytes: document!.size_bytes,
      metadataOnly: document!.storage_path === null,
    },
    "document attached",
  );

  res.status(201).json(toDocument(document!));
});
