import { z } from "zod";

export const DOCUMENT_TYPES = [
  "sale_deed",
  "record_of_rights",
  "encumbrance_certificate",
  "owner_id_proof",
  "other",
] as const;

// Multer parses the multipart body into req.file (binary) + req.body (text
// fields). Only the text field is zod's job — the file itself is validated
// separately (size/mimetype) in multer's own config.
export const AttachDocumentFieldsSchema = z.object({
  document_type: z.enum(DOCUMENT_TYPES),
});

export const ALLOWED_DOCUMENT_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
