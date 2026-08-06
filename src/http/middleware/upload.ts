import multer from "multer";
import { ALLOWED_DOCUMENT_MIME_TYPES, MAX_DOCUMENT_SIZE_BYTES } from "../schemas/document.schemas.js";
import { ApiError } from "./errorHandler.js";

// Memory storage, not disk storage: the file only gets written to disk
// once the route handler has confirmed the parcel exists and the fields
// are valid. Disk-storage multer writes the file before the handler runs
// at all, which would leave orphaned files behind on every 404/400.
// Documents here are small (10MB cap) so buffering in memory is fine.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number])) {
      cb(new ApiError(400, "UNSUPPORTED_MEDIA_TYPE", `Unsupported content type '${file.mimetype}'.`));
      return;
    }
    cb(null, true);
  },
});
