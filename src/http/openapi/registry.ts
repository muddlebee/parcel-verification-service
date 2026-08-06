import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

// Single registry every schema/route file registers against.
// The generated spec (src/http/openapi/document.ts) walks this at boot,
// so the contract can't drift from what the handlers actually validate.
export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "ApiKeyAuth", {
  type: "apiKey",
  in: "header",
  name: "X-API-Key",
});
