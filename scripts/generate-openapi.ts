import { writeFileSync } from "fs";
import { buildOpenApiDocument } from "../src/http/openapi/document.js";

// Dumps the same spec /openapi.json serves at runtime to a static file, for
// the static Swagger UI page in docs-site/ (deployed separately, e.g. to
// Vercel, purely as browsable documentation — not a substitute for
// `docker compose up`, which is how the actual service is meant to be run
// and evaluated).
const doc = buildOpenApiDocument();
writeFileSync("docs-site/openapi.json", JSON.stringify(doc, null, 2));
console.log("Wrote docs-site/openapi.json");

// buildOpenApiDocument() transitively imports the route files, which
// construct the pg.Pool / ioredis clients as module-level singletons —
// those keep open handles alive even though this script never queries
// either. Exiting explicitly rather than leaving the process hanging.
process.exit(0);
