import { z } from "zod";
import { registry } from "../openapi/registry.js";

export const ErrorResponseSchema = registry.register(
  "ErrorResponse",
  z.object({
    error: z.object({
      code: z.string().openapi({ example: "INVALID_TRANSITION" }),
      message: z.string().openapi({ example: "Cannot move from 'verified' to 'under_verification'." }),
      request_id: z.string().openapi({ example: "9c1f2e3a-..." }),
    }),
  }),
);

export const ParcelIdParamSchema = z.object({
  id: z.string().uuid().openapi({ example: "b3f1c2a4-1234-4a9b-8b1e-000000000001" }),
});

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ example: 20 }),
});

export const PaginationMetaSchema = registry.register(
  "PaginationMeta",
  z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    total_pages: z.number().int(),
  }),
);
