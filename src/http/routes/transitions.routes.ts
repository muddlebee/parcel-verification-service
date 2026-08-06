import { Router } from "express";
import { registry } from "../openapi/registry.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { ApiError } from "../middleware/errorHandler.js";
import { ErrorResponseSchema, ParcelIdParamSchema } from "../schemas/common.schemas.js";
import { ManualTransitionRequestSchema } from "../schemas/transition.schemas.js";
import { ParcelDetailSchema } from "../schemas/parcel.schemas.js";
import { db } from "../../db/kysely.js";
import { applyTransition } from "../../db/repositories/transitions.repository.js";
import { getParcelDetail } from "../../db/repositories/parcels.repository.js";
import { toParcelDetail } from "../mappers/parcel.mapper.js";

export const transitionsRouter = Router();
transitionsRouter.use(apiKeyAuth);

registry.registerPath({
  method: "post",
  path: "/parcels/{id}/transitions",
  tags: ["Parcels"],
  summary: "Manually transition a parcel (ops-triggered). Only verified<->disputed is reachable this way.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: ParcelIdParamSchema,
    body: { content: { "application/json": { schema: ManualTransitionRequestSchema } } },
  },
  responses: {
    200: { description: "Transition applied.", content: { "application/json": { schema: ParcelDetailSchema } } },
    404: { description: "No parcel with that id.", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: {
      description: "Not a transition this endpoint (or the state machine) allows from the current state.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
// The `to` field accepts any parcel status at the schema level — the
// state machine itself (assertValidTransition, inside applyTransition) is
// the real guard. Only verified->disputed and disputed->verified are ever
// reachable this way, since every other edge is system/callback-driven;
// anything else 409s regardless of what's requested here.
transitionsRouter.post("/parcels/:id/transitions", async (req, res) => {
  const { id } = ParcelIdParamSchema.parse(req.params);
  const { to, actor, reason } = ManualTransitionRequestSchema.parse(req.body);

  await db.transaction().execute(async (trx) => {
    const parcel = await trx.selectFrom("parcels").select("status").where("id", "=", id).executeTakeFirst();
    if (!parcel) {
      throw new ApiError(404, "PARCEL_NOT_FOUND", `No parcel with id '${id}'.`);
    }
    await applyTransition(trx, { parcelId: id, from: parcel.status, to, actor, reason });
  });

  req.log.info({ parcelId: id, to, actor }, "manual transition applied");

  const result = await getParcelDetail(id);
  res.status(200).json(toParcelDetail(result!));
});
