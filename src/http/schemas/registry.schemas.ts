import { z } from "zod";
import { registry } from "../openapi/registry.js";
import { REGISTRY_SCENARIOS } from "../../registry/stubPartnerClient.js";

// `scenario` is a debug-only hook, not something a real partner
// integration would expose on this endpoint — it exists purely because
// there's no real partner to test against, and the brief explicitly asks
// to demonstrate success/failure/timeout/duplicate behavior. Called out
// here and in the README as something to strip before this ever fronted
// a real integration.
export const VerifyParcelRequestSchema = registry.register(
  "VerifyParcelRequest",
  z.object({
    scenario: z
      .enum(REGISTRY_SCENARIOS)
      .optional()
      .openapi({
        description:
          "Debug-only: force the stub partner's outcome. Omit for a weighted-random outcome " +
          "(mostly verified, sometimes rejected/timeout/failure). Not part of a real partner's API.",
        example: "timeout",
      }),
  }),
);
export type VerifyParcelRequest = z.infer<typeof VerifyParcelRequestSchema>;

export const VerifyParcelResponseSchema = registry.register(
  "VerifyParcelResponse",
  z.object({
    registry_reference_id: z.string().uuid(),
  }),
);
