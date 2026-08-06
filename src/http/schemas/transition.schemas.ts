import { z } from "zod";
import { registry } from "../openapi/registry.js";
import { PARCEL_STATUSES } from "../../domain/parcelStatus.js";

// Manual, ops-triggered transitions only. Right now that's just the
// verified<->disputed pair — a competing claim surfacing later, or that
// dispute getting resolved. Everything else is system/callback-driven and
// doesn't go through this endpoint (see docs/architecture.md for the full
// transition table once it exists).
export const ManualTransitionRequestSchema = registry.register(
  "ManualTransitionRequest",
  z.object({
    to: z.enum(PARCEL_STATUSES).openapi({ example: "disputed" }),
    reason: z.string().min(1).max(1000).openapi({ example: "Competing ownership claim filed by third party." }),
    actor: z.string().min(1).max(256).openapi({ example: "ops:vineet" }),
  }),
);
export type ManualTransitionRequest = z.infer<typeof ManualTransitionRequestSchema>;
