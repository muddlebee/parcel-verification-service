import { z } from "zod";
import { registry } from "../openapi/registry";
import { PARCEL_STATUSES, REGISTRY_SYNC_STATUSES } from "../../domain/parcelStatus";

// Mirrors the submission payload in the brief. Validated strictly (not just
// "is a string") because this data ends up on an ops screen next to physical
// documents — a malformed IFSC/PAN should fail at the door, not at review time.
const ParcelInputSchema = z.object({
  khata_no: z.string().min(1).max(64).openapi({ example: "412/3" }),
  plot_no: z.string().min(1).max(64).openapi({ example: "1187" }),
  district: z.string().min(1).max(128).openapi({ example: "Khordha" }),
  tehsil: z.string().min(1).max(128).openapi({ example: "Bhubaneswar" }),
  village: z.string().min(1).max(128).openapi({ example: "Patia" }),
  area_sqft: z.number().positive().openapi({ example: 12000 }),
  claimed_ownership_since: z.iso.date().openapi({ example: "2011-04-18" }),
});

const OwnerInputSchema = z.object({
  full_name: z.string().min(1).max(256).openapi({ example: "Anita Behera" }),
  mobile: z
    .string()
    .regex(/^\+91[6-9]\d{9}$/, "Expected an Indian mobile number in +91XXXXXXXXXX form")
    .openapi({ example: "+919876543210" }),
  aadhaar_number: z
    .string()
    .regex(/^\d{12}$/, "Aadhaar number must be exactly 12 digits")
    .openapi({ example: "123412341234" }),
  pan_number: z
    .string()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN must match AAAAA9999A")
    .openapi({ example: "ABCDE1234F" }),
  bank_account_number: z
    .string()
    .regex(/^[0-9]{6,20}$/, "Bank account number must be 6-20 digits")
    .openapi({ example: "50100123456789" }),
  ifsc: z
    .string()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC must match AAAA0XXXXXX")
    .openapi({ example: "HDFC0001234" }),
});

export const SubmitParcelRequestSchema = registry.register(
  "SubmitParcelRequest",
  z.object({
    parcel: ParcelInputSchema,
    owner: OwnerInputSchema,
  }),
);
export type SubmitParcelRequest = z.infer<typeof SubmitParcelRequestSchema>;

export const TransitionRecordSchema = registry.register(
  "TransitionRecord",
  z.object({
    id: z.string().uuid(),
    from_state: z.enum(PARCEL_STATUSES).nullable(),
    to_state: z.enum(PARCEL_STATUSES),
    actor: z.string(),
    reason: z.string().nullable(),
    created_at: z.iso.datetime(),
  }),
);

export const DocumentSchema = registry.register(
  "Document",
  z.object({
    id: z.string().uuid(),
    document_type: z.string(),
    original_file_name: z.string(),
    content_type: z.string(),
    size_bytes: z.number().int(),
    uploaded_at: z.iso.datetime(),
  }),
);

export const ParcelSummarySchema = registry.register(
  "ParcelSummary",
  z.object({
    id: z.string().uuid(),
    khata_no: z.string(),
    plot_no: z.string(),
    district: z.string(),
    tehsil: z.string(),
    village: z.string(),
    area_sqft: z.number(),
    claimed_ownership_since: z.iso.date(),
    status: z.enum(PARCEL_STATUSES),
    registry_sync_status: z.enum(REGISTRY_SYNC_STATUSES),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  }),
);

export const ParcelDetailSchema = registry.register(
  "ParcelDetail",
  ParcelSummarySchema.extend({
    owner: OwnerInputSchema.extend({ id: z.string().uuid() }),
    documents: z.array(DocumentSchema),
    history: z.array(TransitionRecordSchema),
  }),
);

export const ListParcelsQuerySchema = z.object({
  status: z.enum(PARCEL_STATUSES).optional(),
  district: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const ListParcelsResponseSchema = registry.register(
  "ListParcelsResponse",
  z.object({
    data: z.array(ParcelSummarySchema),
    pagination: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      total: z.number().int(),
      total_pages: z.number().int(),
    }),
  }),
);
