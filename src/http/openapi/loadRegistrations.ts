// Importing these for their module-level side effects: each one calls
// registry.register()/registerPath() against the shared registry singleton.
// Must be imported before document.ts generates the spec, and before any
// route file that also registers a path. New route/schema files just need
// an import added here.
import "../schemas/common.schemas.js";
import "../schemas/parcel.schemas.js";
import "../schemas/transition.schemas.js";
import "../schemas/callback.schemas.js";
import "../routes/health.routes.js";
