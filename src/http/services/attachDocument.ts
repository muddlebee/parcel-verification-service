import { randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import type { Selectable } from "kysely";
import { env } from "../../config/env.js";
import type { DocumentsTable } from "../../db/types.js";
import { createDocuments, type CreateDocumentInput } from "../../db/repositories/documents.repository.js";
import { ApiError } from "../middleware/errorHandler.js";
import {
  matchesDeclaredMimeType,
  MIME_TYPE_EXTENSIONS,
} from "../schemas/document.schemas.js";
import { logger } from "../../logger.js";

/** Validated item ready to write (disk optional) + insert. */
export interface PreparedDocument {
  documentType: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  /** Null when metadata-only (no bytes / empty upload). */
  buffer: Buffer | null;
  mimetype: string | null;
}

type MulterFile = {
  buffer: Buffer;
  size: number;
  mimetype: string;
  originalname: string;
};

// Shared by single and batch routes: mime/magic checks and normalising
// empty uploads to metadata-only. Does not touch disk or DB.
export function prepareDocumentItem(
  file: MulterFile | undefined,
  documentType: string,
): PreparedDocument {
  const hasBytes = Boolean(file && file.size > 0);

  if (hasBytes && file && !matchesDeclaredMimeType(file.buffer, file.mimetype)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_MEDIA_TYPE",
      `File content doesn't match declared type '${file.mimetype}'.`,
    );
  }

  if (hasBytes && file) {
    return {
      documentType,
      originalFileName: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      buffer: file.buffer,
      mimetype: file.mimetype,
    };
  }

  return {
    documentType,
    originalFileName: "",
    contentType: "application/octet-stream",
    sizeBytes: 0,
    buffer: null,
    mimetype: null,
  };
}

// Write all files first, then insert all rows in one transaction. On DB
// failure, best-effort unlink so we don't leave orphaned bytes on disk.
export async function persistDocuments(
  parcelId: string,
  items: PreparedDocument[],
): Promise<Selectable<DocumentsTable>[]> {
  const writtenPaths: string[] = [];
  const inputs: CreateDocumentInput[] = [];

  try {
    for (const item of items) {
      let storagePath: string | null = null;

      if (item.buffer && item.mimetype) {
        const extension =
          MIME_TYPE_EXTENSIONS[item.mimetype as keyof typeof MIME_TYPE_EXTENSIONS] ?? "";
        // Generated server-side — client original name is display-only.
        storagePath = path.join(env.UPLOAD_DIR, parcelId, `${randomUUID()}${extension}`);
        await mkdir(path.dirname(storagePath), { recursive: true });
        await writeFile(storagePath, item.buffer);
        writtenPaths.push(storagePath);
      }

      inputs.push({
        parcelId,
        documentType: item.documentType,
        originalFileName: item.originalFileName,
        contentType: item.contentType,
        sizeBytes: item.sizeBytes,
        storagePath,
      });
    }

    return await createDocuments(inputs);
  } catch (err) {
    for (const p of writtenPaths) {
      try {
        await unlink(p);
      } catch (unlinkErr) {
        logger.warn({ err: unlinkErr, path: p }, "failed to clean up document file after insert error");
      }
    }
    throw err;
  }
}
