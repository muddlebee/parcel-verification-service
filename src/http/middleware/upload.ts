import multer from "multer";
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  DOCUMENT_TYPES,
  DOCUMENTS_BATCH_MAX,
  MAX_DOCUMENT_SIZE_BYTES,
} from "../schemas/document.schemas.js";
import { ApiError } from "./errorHandler.js";

// Memory storage, not disk storage: the file only gets written to disk
// once the route handler has confirmed the parcel exists and the fields
// are valid. Disk-storage multer writes the file before the handler runs
// at all, which would leave orphaned files behind on every 404/400.
// Documents here are small (10MB cap) so buffering in memory is fine.
export const upload = multer({
  storage: multer.memoryStorage(),
  // `files` caps the *total* parts across every field, which is what bounds
  // batch memory — per-field maxCount alone would allow 5 types x 10 files.
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES, files: DOCUMENTS_BATCH_MAX },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number])) {
      cb(new ApiError(400, "UNSUPPORTED_MEDIA_TYPE", `Unsupported content type '${file.mimetype}'.`));
      return;
    }
    cb(null, true);
  },
});

/** Single-document attach: optional field name `file`. */
export const uploadSingleDocument = upload.single("file");

// Batch attach: one field *per document type*, so the field name carries the
// classification. The alternative — a `files` array paired by index with a
// parallel `document_types` array — silently mis-files documents whenever the
// browser's multi-file picker hands over parts in a different order than the
// operator typed the types, and nothing in the request can detect it.
// An unknown field name fails fast here as LIMIT_UNEXPECTED_FILE.
export const uploadBatchDocuments = upload.fields(
  DOCUMENT_TYPES.map((documentType) => ({ name: documentType, maxCount: DOCUMENTS_BATCH_MAX })),
);
