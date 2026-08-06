import type { Selectable } from "kysely";
import { db } from "../kysely.js";
import type { DocumentsTable } from "../types.js";

export async function parcelExists(parcelId: string): Promise<boolean> {
  const row = await db.selectFrom("parcels").select("id").where("id", "=", parcelId).executeTakeFirst();
  return row !== undefined;
}

export interface CreateDocumentInput {
  parcelId: string;
  documentType: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  storagePath: string;
}

export async function createDocument(input: CreateDocumentInput): Promise<Selectable<DocumentsTable>> {
  return db
    .insertInto("documents")
    .values({
      parcel_id: input.parcelId,
      document_type: input.documentType,
      original_file_name: input.originalFileName,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      storage_path: input.storagePath,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
