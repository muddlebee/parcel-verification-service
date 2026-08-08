import { z } from "zod";
import { registry } from "../openapi/registry.js";
import { DocumentSchema } from "./parcel.schemas.js";

export const DOCUMENT_TYPES = [
  "sale_deed",
  "record_of_rights",
  "encumbrance_certificate",
  "owner_id_proof",
  "other",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Max documents per POST .../documents/batch (ops-sized; caps memory). */
export const DOCUMENTS_BATCH_MAX = 10;

// Multer parses the multipart body into req.file (binary) + req.body (text
// fields). Only the text field is zod's job — the file itself is validated
// separately (size/mimetype) in multer's own config.
export const AttachDocumentFieldsSchema = z.object({
  document_type: z.enum(DOCUMENT_TYPES),
});

export const BatchDocumentsResponseSchema = registry.register(
  "BatchDocumentsResponse",
  z.object({
    data: z.array(DocumentSchema),
    count: z.number().int(),
  }),
);

export const ALLOWED_DOCUMENT_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export const MIME_TYPE_EXTENSIONS: Record<(typeof ALLOWED_DOCUMENT_MIME_TYPES)[number], string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

const MAGIC_BYTES: Record<(typeof ALLOWED_DOCUMENT_MIME_TYPES)[number], readonly number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46], // %PDF
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
};

// The multipart Content-Type header for a field is whatever the client
// claims it is — trusting it alone means a renamed .exe with a spoofed
// header sails through the fileFilter allowlist. Checking the actual
// leading bytes closes that gap; it's not perfect content sniffing, just
// enough to catch "this isn't actually a PDF/PNG/JPEG".
export function matchesDeclaredMimeType(buffer: Buffer, mimetype: string): boolean {
  const signature = MAGIC_BYTES[mimetype as keyof typeof MAGIC_BYTES];
  if (!signature) return false;
  return signature.every((byte, i) => buffer[i] === byte);
}
