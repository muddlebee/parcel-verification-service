export const PARCEL_STATUSES = [
  "submitted",
  "documents_pending",
  "under_verification",
  "verified",
  "rejected",
  "disputed",
] as const;

export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

export const REGISTRY_SYNC_STATUSES = [
  "idle",
  "queued",
  "retrying",
  "exhausted",
  "done",
] as const;

export type RegistrySyncStatus = (typeof REGISTRY_SYNC_STATUSES)[number];
