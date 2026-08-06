import { randomUUID } from "crypto";
import { Router } from "express";
import { registry } from "../openapi/registry.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { ApiError } from "../middleware/errorHandler.js";
import { ErrorResponseSchema, ParcelIdParamSchema } from "../schemas/common.schemas.js";
import { VerifyParcelRequestSchema, VerifyParcelResponseSchema } from "../schemas/registry.schemas.js";
import { db } from "../../db/kysely.js";
import { applyTransition } from "../../db/repositories/transitions.repository.js";
import { registrySubmitQueue } from "../../jobs/registryQueue.js";
import { pickRandomScenario } from "../../registry/stubPartnerClient.js";
import { env } from "../../config/env.js";

export const verifyRouter = Router();
verifyRouter.use(apiKeyAuth);

registry.registerPath({
  method: "post",
  path: "/parcels/{id}/verify",
  tags: ["Parcels"],
  summary: "Mark a parcel ready for verification — triggers the async registry-partner call.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: ParcelIdParamSchema,
    body: { content: { "application/json": { schema: VerifyParcelRequestSchema } } },
  },
  responses: {
    202: {
      description: "Accepted — moved to under_verification, registry call enqueued.",
      content: { "application/json": { schema: VerifyParcelResponseSchema } },
    },
    404: { description: "No parcel with that id.", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: {
      description: "Parcel isn't in a state this can be called from (must be documents_pending).",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
verifyRouter.post("/parcels/:id/verify", async (req, res) => {
  const { id } = ParcelIdParamSchema.parse(req.params);
  const { scenario } = VerifyParcelRequestSchema.parse(req.body ?? {});

  const registryReferenceId = randomUUID();

  await db.transaction().execute(async (trx) => {
    const parcel = await trx.selectFrom("parcels").select("status").where("id", "=", id).executeTakeFirst();
    if (!parcel) {
      throw new ApiError(404, "PARCEL_NOT_FOUND", `No parcel with id '${id}'.`);
    }

    // assertValidTransition inside applyTransition throws a 409 here if
    // the parcel isn't in documents_pending — e.g. calling /verify twice.
    await applyTransition(trx, {
      parcelId: id,
      from: parcel.status,
      to: "under_verification",
      actor: "api-client",
      reason: "Marked ready for verification.",
    });

    await trx
      .updateTable("parcels")
      .set({ registry_reference_id: registryReferenceId, registry_sync_status: "queued" })
      .where("id", "=", id)
      .execute();
  });

  const resolvedScenario = scenario ?? pickRandomScenario();
  await registrySubmitQueue.add(
    "submit",
    { parcelId: id, registryReferenceId, scenario: resolvedScenario, requestId: req.id as string },
    {
      attempts: env.REGISTRY_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: env.REGISTRY_RETRY_BASE_MS },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  // req.log (not the bare logger import) is pino-http's request-scoped
  // child logger — this line carries X-Request-Id automatically, and
  // parcelId/registryReferenceId here is the thread an on-call engineer
  // picks up to follow the rest of the story in the worker logs.
  req.log.info({ parcelId: id, registryReferenceId, scenario: resolvedScenario }, "parcel marked for verification");

  res.status(202).json({ registry_reference_id: registryReferenceId });
});
