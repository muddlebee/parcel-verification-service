# Implementation Log

A chronological walkthrough of how this service was built, commit by commit — what
each step added, why, and the real bugs found and fixed along the way. This is a
build narrative, not a reference (that's `docs/architecture.md`, coming once the
remaining pieces land). Commit hashes are given so you can `git show <hash>` for
the exact diff.

## 1. Project scaffold (`2ba6f5e`)

TypeScript + Express, `npm init`, dependencies installed but not yet wired together.
Every dependency was chosen for a specific job, not because it's popular:

| Dependency | Job |
|---|---|
| `zod` + `@asteasolutions/zod-to-openapi` | One schema drives both request validation and the generated OpenAPI spec — the docs literally cannot drift from what the handlers accept. |
| `kysely` + `pg` | Typed SQL queries, no ORM auto-create. The schema lives in migrations, not in application code. |
| `bullmq` + `ioredis` | The retry-with-backoff queue for the outbound partner call — this is Redis's actual job in this stack. |
| `pino` + `pino-http` | Structured JSON logs with request correlation. |
| `multer` | Multipart document upload, written to local disk. |

No lint/format tooling was added — strict TypeScript is the quality gate, and the
time budget went to the graded mechanics instead.

## 2. API contract + app skeleton (`08c5ad8`)

Before writing any real route, the full request/response contract was defined as
zod schemas — submit-parcel payload, parcel detail/summary, transition record,
document metadata, manual transition request, registry callback shape. These
generate the OpenAPI document served at `/openapi.json` and `/docs` (Swagger UI).

At this point only `GET /healthz` was a real, working route (liveness-only — no
DB existed yet to check). Everything else was schema-only, filled in over the
following commits.

Also landed here: request-ID middleware (honors an inbound `X-Request-Id`,
generates one otherwise, feeds it into `pino-http` for correlated logs), a static
`X-API-Key` auth middleware (not yet applied to anything), and a central error
handler mapping `ZodError` → 400.

**Bug fix:** TypeScript 7 removed `moduleResolution: "node"` (what it used to
alias to). Switched to `Node16`/`Node16`.

## 3. Docker Compose stack (`84afde6`)

Multi-stage `Dockerfile` — build stage compiles TS, runtime stage installs only
production deps and copies the compiled output. `postgres` and `redis` both gate
the `api` service's startup on a real healthcheck rather than a fixed sleep, so
`docker compose up` is reliable on a cold machine. `uploads` is a named volume so
documents survive a container restart, matching the brief's "local disk, no real
object storage."

Verified end-to-end at this stage: `docker compose up --build` → all three
services healthy → `GET /healthz` returns 200 through the container.

## 4. Postgres schema + Kysely wiring (`2c850fe`)

Five migrations via `node-pg-migrate`, one table per file:

- **`parcels`** — carries both `status` (the brief's 5-state machine) and a
  separate `registry_sync_status` (`idle → queued → retrying → exhausted/done`)
  that tracks the outbound partner call *without* inventing a 6th business state.
- **`owners`** — 1:1 with parcel.
- **`documents`** — metadata + local disk path.
- **`parcel_transitions`** — the audit log. Append-only; `from_state` is only
  ever null on the very first row.
- **`registry_callbacks`** — the idempotency ledger.
  `UNIQUE(parcel_id, external_callback_id)` is the actual dedup mechanism, not an
  application-level check.

A hand-written `Database` type (`src/db/types.ts`) matches the migrations —
Kysely gives compile-time-checked queries without an ORM owning the schema.

**Two things forced a project-wide change here:** Kysely ships ESM-only, so the
whole project switched to `"type": "module"` with `NodeNext` resolution
(every relative import now carries an explicit `.js` extension — a NodeNext ESM
requirement, even though the source files are `.ts`). Switching resolution
modes also surfaced a latent issue in code that predates this commit:
`pino-http`'s type declarations use ESM `export default` syntax over an
actually-CommonJS runtime module, which NodeNext's stricter interop rejected —
`import pinoHttp from "pino-http"` (working fine under the previous CommonJS
resolution) started failing to typecheck. Fixed by switching to the named
export, `import { pinoHttp } from "pino-http"`. The same class of issue hit
`ioredis` two commits later (see step 8) and was fixed the same way.

**Bug found and fixed:** `pg.Pool` emits `'error'` when an idle client's
connection drops (e.g. a Postgres restart). With no listener, Node's default
behavior is to **throw and crash the process** — so a Postgres restart was
taking the whole service down instead of degrading to a 503. Fixed with a
`pool.on('error', ...)` handler that logs instead. Verified manually: stopped and
restarted the `postgres` container against a running server, watched `/healthz`
go `200 → 503 → 200` with the process never exiting.

## 5. State machine module (`8e612d9`)

Pure domain logic, zero DB/HTTP dependency, fully unit tested — `src/domain/stateMachine.ts`.
Encodes the transition table:

```
submitted → documents_pending → under_verification → verified
                                                     → rejected
verified ↔ disputed
```

This resolves an ambiguity in the brief's own diagram (documented in the module
and in `README.md`): `disputed` is only reachable from `verified`, not directly
from `under_verification`, and `rejected` is terminal (no path back — the brief
doesn't describe one).

`isValidTransition` / `assertValidTransition` are the only two entry points.
`InvalidTransitionError` carries the offending states and wires straight into the
central error handler as a 409 — route handlers never write their own 409 logic.

The unit test is **exhaustive over all 36 `(from, to)` state pairs**, not just
the happy-path list, so an accidental new edge added later fails the test even
without anyone writing a negative case for it.

## 6. Parcels API (`d3a5d90`)

`POST /api/v1/parcels`, `GET /api/v1/parcels/:id`, `GET /api/v1/parcels`
(status + district filters, paginated). First real business endpoints —
everything before this was infrastructure.

Two repository-layer decisions that everything downstream reuses:

- **`applyTransition()`** (`src/db/repositories/transitions.repository.ts`) is the
  single choke point for *every* state change in the system. Besides calling
  `assertValidTransition`, the `UPDATE` carries a `WHERE status = from` guard —
  an optimistic concurrency check. Two requests racing to move the same parcel
  can't both succeed; the loser's `UPDATE` matches zero rows and gets a 409
  instead of silently clobbering the audit trail.
- **`createParcel()`** runs in one transaction: parcel + owner + initial
  `submitted` transition + auto-advance to `documents_pending` (via
  `applyTransition`, not a special case). A crash mid-request can't leave a
  parcel without an owner or a gap in its history.

**Two bugs found and fixed while testing manually:**
1. Kysely requires columns with DB-side defaults to be marked `Generated<>` in
   the table type, or inserts omitting them fail to typecheck.
   `status`/`registry_sync_status` weren't marked — fixed.
2. `pg`'s default `DATE` parser returns a JS `Date` anchored to the process's
   local timezone, which can silently shift a stored date by a day. Disabled it
   for the `DATE` oid so `claimed_ownership_since` round-trips as the exact
   string stored. Verified: `'2011-04-18'` in, `'2011-04-18'` out.

Also split `tsconfig.json` (includes `test/`, used for typecheck) from
`tsconfig.build.json` (`src/` only, used by `npm run build`) — test files had
been silently excluded from typechecking entirely up to this point.

## 7. Documents API (`a4ebbea`)

`POST /api/v1/parcels/:id/documents`. Not gated by parcel status — a document
can be attached in support of a dispute after a parcel is already verified, for
example, and attaching a document isn't itself a state-machine transition.

Multer runs with **memory storage, not disk storage**: the file only touches
disk after the handler confirms the parcel exists and the fields are valid.
Disk-storage multer writes before the handler runs at all, which would leave
orphaned files behind on every 404/400.

Storage path is always server-generated
(`uploads/<parcelId>/<uuid>.<ext>`) — the client's filename is kept only as a
display string, never used to build a filesystem path.

**Gap closed, not just documented:** validating the multipart `Content-Type`
header alone isn't enough — a client can declare any mimetype it wants
regardless of actual content. Added a magic-byte check
(`matchesDeclaredMimeType`) against real PDF/PNG/JPEG signatures, on top of the
mimetype allowlist and the 10MB size cap.

## 8. Registry stub + BullMQ queue/worker + verify endpoint (`b56e235`)

`POST /api/v1/parcels/:id/verify` moves `documents_pending → under_verification`
and enqueues the async partner call. This is where Redis earns its place in the
stack — BullMQ backs the outbound-call retry queue, giving delayed exponential
backoff and a real "exhausted after N attempts" state without a hand-rolled poll
loop.

The design models the real async partner honestly rather than faking it
in-process — **two separate jobs**:

- **`registry-submit`** calls the stub partner
  (`src/registry/stubPartnerClient.ts` — the one file that would be deleted for
  a real integration). BullMQ's `attempts` + exponential `backoff` are
  configured at enqueue time.
- **`registry-callback-delivery`**, on ack, schedules a *genuine HTTP POST* back
  into this same service's callback route after a delay — exactly like a real
  partner's webhook, not an in-process shortcut. The `"duplicate"` scenario
  enqueues the same `callback_id` twice.

`registry_sync_status` tracks only the outbound leg, separate from
`parcel.status` — a timeout or failure never touches the 5-state machine, it's
surfaced to an operator through this field instead.

`scenario` is an explicit, documented debug-only field on the verify request —
not something a real partner's API would expose, but the honest way to
demonstrate success/failure/timeout/duplicate deterministically without access
to a real partner (which the brief explicitly calls out as the point of the
exercise).

**Verified manually:** forced `scenario: "timeout"` on a real parcel and watched
`registry_sync_status` progress `queued → retrying` (×4, ~2s/4s/8s/16s backoff)
`→ exhausted` after 5 attempts, with the parcel correctly staying in
`under_verification` throughout.

**Bug fix:** same CJS/ESM default-export interop issue as `pino-http` earlier,
this time in `ioredis` — `import { Redis } from "ioredis"` (named export)
sidesteps it.

## 9. Registry callback handler (`aa32747`)

`POST /api/v1/callbacks/registry` — closes the loop opened in step 8.

Idempotency is the unique constraint on `(parcel_id, external_callback_id)` via
`INSERT ... ON CONFLICT DO NOTHING`, checked **before** the transition is
attempted, in the same transaction. A duplicate is short-circuited before
touching parcel state at all — there's no window where it could partially apply.

A *different*, non-duplicate `callback_id` arriving for an already-resolved
parcel falls straight through to `applyTransition`'s own
`InvalidTransitionError → 409`, with zero special-casing needed — the
choke-point design from step 6 paying off directly.

**Real bug found via manual end-to-end testing, not a unit test:** Express
applies a router's `router.use(middleware)` to *every* request forwarded into
that router by its mount prefix — not just requests matching that router's own
routes. `parcelsRouter`'s blanket `apiKeyAuth` was mounted before
`callbackRouter`, so it 401'd `/api/v1/callbacks/registry` (also under
`/api/v1`) before Express ever tried `callbackRouter`. Caught because the stub's
callback-delivery worker makes a genuine unauthenticated HTTP call, exactly like
a real partner would — and it failed with 401 in the logs. Fixed by mounting
`callbackRouter` first, with the reasoning documented in `app.ts` so it doesn't
regress.

**Verified manually end-to-end, through the real dev server and then the real
container:** submit → verify(`scenario: "verified"`) → stub acks → stub delivers
a genuine HTTP callback → parcel reaches `verified` with all 4 transitions
recorded. Also verified `scenario: "duplicate"` (same `callback_id`, ~2s apart)
results in exactly one applied transition.

---

## Where things stand

22 tests passing (unit: state machine; integration: parcels, documents, verify,
callbacks — all against the real Postgres/Redis from `docker compose`, not
mocks). Every commit above was verified manually against a running server (and
periodically the full container) before being committed, not just against the
test suite.

**Not yet built** (tracked as the remaining commits):
- Manual transition endpoint (`verified ↔ disputed`, ops-triggered)
- Dedicated retry/exhaustion scenario test coverage (the mechanism is built and
  manually verified — see step 8 — but doesn't yet have integration tests
  driving it end-to-end)
- Logging/correlation pass across queue jobs specifically
- `docs/architecture.md` (ERD, state diagram, sequence diagram)
- `README.md`
