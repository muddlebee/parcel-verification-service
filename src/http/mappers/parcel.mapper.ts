import type { Selectable } from "kysely";
import type { DocumentsTable, OwnersTable, ParcelsTable, ParcelTransitionsTable } from "../../db/types.js";
import type { ParcelDetailRow } from "../../db/repositories/parcels.repository.js";

export function toParcelSummary(row: Selectable<ParcelsTable>) {
  return {
    id: row.id,
    khata_no: row.khata_no,
    plot_no: row.plot_no,
    district: row.district,
    tehsil: row.tehsil,
    village: row.village,
    area_sqft: Number(row.area_sqft),
    claimed_ownership_since: row.claimed_ownership_since,
    status: row.status,
    registry_sync_status: row.registry_sync_status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toOwner(row: Selectable<OwnersTable>) {
  return {
    id: row.id,
    full_name: row.full_name,
    mobile: row.mobile,
    aadhaar_number: row.aadhaar_number,
    pan_number: row.pan_number,
    bank_account_number: row.bank_account_number,
    ifsc: row.ifsc,
  };
}

function toDocument(row: Selectable<DocumentsTable>) {
  return {
    id: row.id,
    document_type: row.document_type,
    original_file_name: row.original_file_name,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    uploaded_at: row.uploaded_at.toISOString(),
  };
}

function toTransitionRecord(row: Selectable<ParcelTransitionsTable>) {
  return {
    id: row.id,
    from_state: row.from_state,
    to_state: row.to_state,
    actor: row.actor,
    reason: row.reason,
    created_at: row.created_at.toISOString(),
  };
}

export function toParcelDetail(input: ParcelDetailRow) {
  return {
    ...toParcelSummary(input.parcel),
    owner: toOwner(input.owner),
    documents: input.documents.map(toDocument),
    history: input.history.map(toTransitionRecord),
  };
}
