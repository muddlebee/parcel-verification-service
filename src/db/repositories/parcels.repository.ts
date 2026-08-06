import type { Selectable } from "kysely";
import { db } from "../kysely.js";
import { applyTransition } from "./transitions.repository.js";
import type { DocumentsTable, OwnersTable, ParcelsTable, ParcelTransitionsTable } from "../types.js";
import type { SubmitParcelRequest } from "../../http/schemas/parcel.schemas.js";
import type { ParcelStatus } from "../../domain/parcelStatus.js";

export async function createParcel(input: SubmitParcelRequest): Promise<{ id: string }> {
  return db.transaction().execute(async (trx) => {
    const parcel = await trx
      .insertInto("parcels")
      .values({
        khata_no: input.parcel.khata_no,
        plot_no: input.parcel.plot_no,
        district: input.parcel.district,
        tehsil: input.parcel.tehsil,
        village: input.parcel.village,
        area_sqft: String(input.parcel.area_sqft),
        claimed_ownership_since: input.parcel.claimed_ownership_since,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await trx
      .insertInto("owners")
      .values({
        parcel_id: parcel.id,
        full_name: input.owner.full_name,
        mobile: input.owner.mobile,
        aadhaar_number: input.owner.aadhaar_number,
        pan_number: input.owner.pan_number,
        bank_account_number: input.owner.bank_account_number,
        ifsc: input.owner.ifsc,
      })
      .execute();

    // Creation itself isn't a transition through the state machine — no
    // prior row to guard against — so it's recorded directly as the
    // from_state:null origin row the audit trail starts from.
    await trx
      .insertInto("parcel_transitions")
      .values({
        parcel_id: parcel.id,
        from_state: null,
        to_state: "submitted",
        actor: "api-client",
        reason: "Parcel submitted for verification.",
      })
      .execute();

    // Auto-advance: nothing's attached yet, so the parcel is immediately
    // awaiting documents. Goes through applyTransition like every other
    // state change, not a special case.
    await applyTransition(trx, {
      parcelId: parcel.id,
      from: "submitted",
      to: "documents_pending",
      actor: "system",
      reason: "Awaiting documents.",
    });

    return { id: parcel.id };
  });
}

export interface ParcelDetailRow {
  parcel: Selectable<ParcelsTable>;
  owner: Selectable<OwnersTable>;
  documents: Selectable<DocumentsTable>[];
  history: Selectable<ParcelTransitionsTable>[];
}

export async function getParcelDetail(id: string): Promise<ParcelDetailRow | null> {
  const parcel = await db.selectFrom("parcels").selectAll().where("id", "=", id).executeTakeFirst();
  if (!parcel) return null;

  const [owner, documents, history] = await Promise.all([
    db.selectFrom("owners").selectAll().where("parcel_id", "=", id).executeTakeFirstOrThrow(),
    db.selectFrom("documents").selectAll().where("parcel_id", "=", id).orderBy("uploaded_at", "asc").execute(),
    db.selectFrom("parcel_transitions").selectAll().where("parcel_id", "=", id).orderBy("created_at", "asc").execute(),
  ]);

  return { parcel, owner, documents, history };
}

export interface ListParcelsFilter {
  status?: ParcelStatus;
  district?: string;
  page: number;
  limit: number;
}

export async function listParcels(
  filter: ListParcelsFilter,
): Promise<{ rows: Selectable<ParcelsTable>[]; total: number }> {
  let query = db.selectFrom("parcels");
  if (filter.status) query = query.where("status", "=", filter.status);
  if (filter.district) query = query.where("district", "=", filter.district);

  const [totalRow, rows] = await Promise.all([
    query.select(({ fn }) => [fn.countAll<string>().as("count")]).executeTakeFirstOrThrow(),
    query
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit)
      .execute(),
  ]);

  return { rows, total: Number(totalRow.count) };
}
