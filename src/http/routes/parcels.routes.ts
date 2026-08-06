import { Router } from "express";
import { registry } from "../openapi/registry.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { ApiError } from "../middleware/errorHandler.js";
import { ErrorResponseSchema, ParcelIdParamSchema } from "../schemas/common.schemas.js";
import {
  CreateParcelResponseSchema,
  ListParcelsQuerySchema,
  ListParcelsResponseSchema,
  ParcelDetailSchema,
  SubmitParcelRequestSchema,
} from "../schemas/parcel.schemas.js";
import { createParcel, getParcelDetail, listParcels } from "../../db/repositories/parcels.repository.js";
import { toParcelDetail, toParcelSummary } from "../mappers/parcel.mapper.js";

export const parcelsRouter = Router();
parcelsRouter.use(apiKeyAuth);

registry.registerPath({
  method: "post",
  path: "/parcels",
  tags: ["Parcels"],
  summary: "Submit a parcel for verification.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: SubmitParcelRequestSchema } } },
  },
  responses: {
    201: {
      description: "Parcel created, status 'submitted' then immediately auto-advanced to 'documents_pending'.",
      content: { "application/json": { schema: CreateParcelResponseSchema } },
    },
    400: { description: "Validation error.", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Missing/invalid API key.", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
parcelsRouter.post("/parcels", async (req, res) => {
  const input = SubmitParcelRequestSchema.parse(req.body);
  const { id } = await createParcel(input);
  res.status(201).json({ id });
});

registry.registerPath({
  method: "get",
  path: "/parcels/{id}",
  tags: ["Parcels"],
  summary: "Retrieve a parcel with its full verification history and owner record.",
  security: [{ ApiKeyAuth: [] }],
  request: { params: ParcelIdParamSchema },
  responses: {
    200: { description: "OK.", content: { "application/json": { schema: ParcelDetailSchema } } },
    404: { description: "No parcel with that id.", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
parcelsRouter.get("/parcels/:id", async (req, res) => {
  const { id } = ParcelIdParamSchema.parse(req.params);
  const result = await getParcelDetail(id);
  if (!result) {
    throw new ApiError(404, "PARCEL_NOT_FOUND", `No parcel with id '${id}'.`);
  }
  res.status(200).json(toParcelDetail(result));
});

registry.registerPath({
  method: "get",
  path: "/parcels",
  tags: ["Parcels"],
  summary: "List parcels, filterable by status and district, paginated.",
  security: [{ ApiKeyAuth: [] }],
  request: { query: ListParcelsQuerySchema },
  responses: {
    200: { description: "OK.", content: { "application/json": { schema: ListParcelsResponseSchema } } },
  },
});
parcelsRouter.get("/parcels", async (req, res) => {
  const query = ListParcelsQuerySchema.parse(req.query);
  const { rows, total } = await listParcels(query);
  res.status(200).json({
    data: rows.map(toParcelSummary),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      total_pages: total === 0 ? 0 : Math.ceil(total / query.limit),
    },
  });
});
