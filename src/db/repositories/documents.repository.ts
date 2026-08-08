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
  /** Null when recording metadata only (no file bytes written to disk). */
  storagePath: string | null;
}

function toInsertValues(input: CreateDocumentInput) {
  return {
    parcel_id: input.parcelId,
    document_type: input.documentType,
    original_file_name: input.originalFileName,
    content_type: input.contentType,
    size_bytes: input.sizeBytes,
    storage_path: input.storagePath,
  };
}

export async function createDocument(input: CreateDocumentInput): Promise<Selectable<DocumentsTable>> {
  return db
    .insertInto("documents")
    .values(toInsertValues(input))
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Insert one or more document rows in a single transaction (batch attach). */
export async function createDocuments(inputs: CreateDocumentInput[]): Promise<Selectable<DocumentsTable>[]> {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) {
    return [await createDocument(inputs[0]!)];
  }

  return db.transaction().execute(async (trx) => {
    const rows: Selectable<DocumentsTable>[] = [];
    for (const input of inputs) {
      const row = await trx
        .insertInto("documents")
        .values(toInsertValues(input))
        .returningAll()
        .executeTakeFirstOrThrow();
      rows.push(row);
    }
    return rows;
  });
}
