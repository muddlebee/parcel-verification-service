import type { ColumnType, Generated } from "kysely";
import type { ParcelStatus, RegistrySyncStatus } from "../domain/parcelStatus.js";

type CreatedAt = ColumnType<Date, string | undefined, never>;

export interface ParcelsTable {
  id: Generated<string>;
  khata_no: string;
  plot_no: string;
  district: string;
  tehsil: string;
  village: string;
  // pg returns NUMERIC as string by default (avoids float precision loss).
  // Converted to number at the API boundary, not here.
  area_sqft: string;
  claimed_ownership_since: string;
  status: Generated<ParcelStatus>;
  registry_sync_status: Generated<RegistrySyncStatus>;
  registry_reference_id: string | null;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, string | undefined, string>;
}

export interface OwnersTable {
  id: Generated<string>;
  parcel_id: string;
  full_name: string;
  mobile: string;
  aadhaar_number: string;
  pan_number: string;
  bank_account_number: string;
  ifsc: string;
  created_at: CreatedAt;
}

export interface DocumentsTable {
  id: Generated<string>;
  parcel_id: string;
  document_type: string;
  original_file_name: string;
  content_type: string;
  size_bytes: number;
  storage_path: string;
  uploaded_at: CreatedAt;
}

export interface ParcelTransitionsTable {
  id: Generated<string>;
  parcel_id: string;
  from_state: ParcelStatus | null;
  to_state: ParcelStatus;
  actor: string;
  reason: string | null;
  created_at: CreatedAt;
}

export interface RegistryCallbacksTable {
  id: Generated<string>;
  parcel_id: string;
  external_callback_id: string;
  result: "verified" | "rejected";
  raw_payload: unknown;
  received_at: CreatedAt;
}

export interface Database {
  parcels: ParcelsTable;
  owners: OwnersTable;
  documents: DocumentsTable;
  parcel_transitions: ParcelTransitionsTable;
  registry_callbacks: RegistryCallbacksTable;
}
