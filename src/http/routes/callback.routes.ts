import { Router } from "express";
import { registry } from "../openapi/registry.js";
import { ErrorResponseSchema } from "../schemas/common.schemas.js";
import { RegistryCallbackRequestSchema, RegistryCallbackResponseSchema } from "../schemas/callback.schemas.js";
import { recordCallbackAndTransition } from "../../db/repositories/callbacks.repository.js";

export const callbackRouter = Router();

registry.registerPath({
  method: "post",
  path: "/callbacks/registry",
  tags: ["Callbacks"],
  summary: "Registry partner delivers a verification result. Idempotent, unauthenticated per the brief.",
  request: { body: { content: { "application/json": { schema: RegistryCallbackRequestSchema } } } },
  responses: {
    200: {
      description: "Processed — or ignored as a duplicate delivery of a callback_id already recorded.",
      content: { "application/json": { schema: RegistryCallbackResponseSchema } },
    },
    404: {
      description: "No parcel with that registry_reference_id.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "A different, non-duplicate callback conflicts with the parcel's current state.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
// Deliberately NOT behind apiKeyAuth — the brief requires this endpoint be
// callable by the partner over the public internet with no auth. Real
// risk, called out in the README "What I'd push back on": anyone who
// finds this URL can flip a parcel to verified. Building it exactly as
// specified rather than silently adding a shared secret is a deliberate
// choice, not an oversight.
callbackRouter.post("/callbacks/registry", async (req, res) => {
  const input = RegistryCallbackRequestSchema.parse(req.body);

  const result = await recordCallbackAndTransition({
    registryReferenceId: input.registry_reference_id,
    callbackId: input.callback_id,
    result: input.result,
    remarks: input.remarks ?? null,
    rawPayload: input,
  });

  res.status(200).json({ status: result.status, parcel_id: result.parcelId });
});
