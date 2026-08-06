// Importing these for their module-level side effects: each one calls
// registry.register()/registerPath() against the shared registry singleton.
// Must be imported before document.ts generates the spec, and before any
// route file that also registers a path. New route/schema files just need
// an import added here.
import "../schemas/common.schemas";
import "../schemas/parcel.schemas";
import "../schemas/transition.schemas";
import "../schemas/callback.schemas";
import "../routes/health.routes";
