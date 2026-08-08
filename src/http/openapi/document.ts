import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import "./loadRegistrations.js";
import { registry } from "./registry.js";

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Parcel Verification Service",
      version: "1.0.0",
      description:
        "BhoomiPe Parcel Verification Service — accepts a land parcel for verification, " +
        "moves it through a state machine involving an external registry partner, and " +
        "keeps a full audit trail of every state change.\n\n" +
        "**Documents:** single attach takes a file picker plus a `document_type` dropdown, " +
        "and the file is optional (omit it to record metadata only). Batch attach has one " +
        "file picker per document type — upload each file under the field named after its " +
        "type, in any combination; the field name is what classifies the document.",
    },
    servers: [{ url: "/api/v1", description: "Current version" }],
  });
}
