import { z } from "zod";
import { registry } from "../openapi/registry";

// Shape the (stubbed) partner uses to report a verification outcome.
// `callback_id` is the partner's delivery identifier — the brief is explicit
// that the same result gets delivered more than once, so this is the field
// the idempotency check is keyed on (unique with registry_reference_id).
// `registry_reference_id` is the correlation token we handed the partner
// when we submitted the parcel; it's how we find our way back to a parcel
// row without trusting the partner to know our internal IDs.
export const RegistryCallbackRequestSchema = registry.register(
  "RegistryCallbackRequest",
  z.object({
    registry_reference_id: z.string().uuid().openapi({ example: "7a1e0c3b-aaaa-4bbb-8ccc-000000000002" }),
    callback_id: z.string().min(1).openapi({ example: "partner-cb-99213" }),
    result: z.enum(["verified", "rejected"]).openapi({ example: "verified" }),
    remarks: z.string().max(2000).nullable().optional().openapi({ example: "Title clear, no encumbrance found." }),
    delivered_at: z.iso.datetime().openapi({ example: "2026-08-06T12:00:00Z" }),
  }),
);
export type RegistryCallbackRequest = z.infer<typeof RegistryCallbackRequestSchema>;

export const RegistryCallbackResponseSchema = registry.register(
  "RegistryCallbackResponse",
  z.object({
    status: z.enum(["applied", "duplicate_ignored"]),
    parcel_id: z.string().uuid(),
  }),
);
