# Parcel Verification Service

Accepts a land parcel for verification, moves it through a multi-stage
pipeline involving an external land-registry partner, and keeps a defensible
record of every state change.

Diagrams: [`docs/architecture.md`](docs/architecture.md). Worker concurrency
scenario: [`docs/worker-concurrency.md`](docs/worker-concurrency.md).
Production and backend interview notes:
[`docs/backend-interview-guide.md`](docs/backend-interview-guide.md).
Commit-by-commit build narrative: [`docs/IMPLEMENTATION_LOG.md`](docs/IMPLEMENTATION_LOG.md).
Static Swagger docs (no backend behind it, just for browsing):
**https://docs-site-eta-ten.vercel.app**.

## 1. How to run it

```bash
docker compose up --build
```

Brings up Postgres, Redis, and the API; runs migrations automatically. Ready
at `http://localhost:3000`.

```bash
curl http://localhost:3000/healthz          # liveness (checks Postgres + Redis)
open http://localhost:3000/docs             # Swagger UI

curl -H "X-API-Key: dev-local-api-key" http://localhost:3000/api/v1/parcels
```

**Local dev (no Docker for the app):**

```bash
npm install
cp .env.example .env   # once
npm run start:local    # postgres + redis + migrations + src/index.ts
# or, with file watching:
npm run dev:local

# later, stop deps (Ctrl+C the app first if it's still running):
npm run stop:local
```

`start:local` / `dev:local` start Postgres + Redis, **poll until both are healthy** (fail fast on port conflicts / stuck containers), run migrations, then start the app. `stop:local` (alias `docker:down`) stops those containers; data volumes are kept. Production `npm start` still runs the built `dist/index.js` only.

**Tests** (need Postgres/Redis up — runs against the real thing, not mocks):

```bash
docker compose up -d postgres redis
npm test   # 32 tests, ~9s
```

## 2. API design

`/api/v1/...` versioned from day one — retrofitting versioning later is worse
than starting with it.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | none | Liveness/readiness |
| `GET` | `/docs`, `/openapi.json` | none | Swagger UI / OpenAPI spec |
| `POST` | `/api/v1/parcels` | API key | Submit a parcel |
| `GET` | `/api/v1/parcels/:id` | API key | Parcel + owner + documents + history |
| `GET` | `/api/v1/parcels` | API key | List, filter by `status`/`district`, paginated |
| `POST` | `/api/v1/parcels/:id/documents` | API key | Attach one document (file optional) |
| `POST` | `/api/v1/parcels/:id/documents/batch` | API key | Attach up to 10 documents (all-or-nothing) |
| `POST` | `/api/v1/parcels/:id/verify` | API key | Trigger the async registry call |
| `POST` | `/api/v1/parcels/:id/transitions` | API key | Manual ops transition (`verified`↔`disputed`) |
| `POST` | `/api/v1/callbacks/registry` | **none** | Partner delivers a result — see §3, §6 |

**Documents:** single attach is the default, and its file is optional (omit it
to record metadata only). Batch is a **separate** endpoint
(`.../documents/batch`) so the single route stays simple for Swagger/clients.

Batch names each multipart field after the **document type** it holds, rather
than pairing a `files` array with a parallel `document_types` array by index:

```bash
curl -X POST .../parcels/$ID/documents/batch -H "X-API-Key: $KEY" \
  -F sale_deed=@deed.pdf \
  -F owner_id_proof=@aadhaar.png \
  -F other=@survey.pdf
```

Index pairing looked fine on the wire but had no way to *detect* a mis-pairing:
a browser's multi-file picker returns parts in its own order, so uploading the
files in a different order than the types were listed files each document under
the wrong type and still returns `201`. Naming the field after the type makes
the classification structural — there is no ordering left to get wrong — and it
renders in Swagger as one labelled picker per type instead of a free-text JSON
box. Multiple files per type are allowed; up to 10 files total; failures are
all-or-nothing (no half-applied set). Batch requires at least one file — bulk
metadata-only has no real use case, and the single endpoint already covers it.
Not required by the brief — convenience for multi-file ops upload.

**Deliberately not exposed:** `PATCH`/`DELETE /parcels/:id` (owner/khata data
anchors a title chain — no silent rewrites outside the audit trail; no
"unsubmit," the record is meant to be permanent); a document-download route
(out of scope, ops has direct volume access); a raw override for a stuck
`registry_sync_status` (should be a domain action, not a field editor — see
§4); cross-parcel bulk APIs.

## 3. Design decisions

**Schema.** Five tables as versioned `node-pg-migrate` migrations, not ORM
`sync`. `parcels`, `owners` (1:1), `documents`, `parcel_transitions`
(append-only audit log), `registry_callbacks` (idempotency ledger). ERD in
[`docs/architecture.md`](docs/architecture.md). `parcels.status` is the
5-state machine; a separate `registry_sync_status`
(`idle→queued→retrying→exhausted/done`) tracks the outbound partner call so a
stuck call is operator-visible without inventing a 6th business state.

**Kysely, not an ORM.** Typed SQL, checked against a hand-written `Database`
type that mirrors the migrations — no code generation, and it doesn't own the
schema. A full ORM would want to own migrations in its own format too, which
conflicts with shipping SQL as the reviewable artifact.

**Why a separate `/verify` endpoint** instead of firing the registry call on
`POST /parcels` directly: the state machine has `documents_pending` as a real
state and document-attachment as its own capability, which only makes sense
if verification is a distinct, later step. `POST /parcels/:id/verify` is that
explicit trigger. (An implicit trigger on first document upload was the other
option considered — rejected: too consequential an action to be a side effect.)

**State-machine ambiguity resolved:** `disputed` is reachable only from
`verified`, never directly from `under_verification`; `rejected` is terminal.
Enforced in `src/domain/stateMachine.ts`, tested exhaustively over all 36
`(from, to)` pairs. Diagram in
[`docs/architecture.md`](docs/architecture.md#state-machine). This is a
judgment call on genuinely ambiguous spec language — flagging it rather than
burying it.

**Idempotency:** `UNIQUE(parcel_id, external_callback_id)` on
`registry_callbacks`, `INSERT ... ON CONFLICT DO NOTHING`, checked *before*
the state transition in the same transaction — a duplicate never touches
parcel state. Rejected a Redis-based dedup key: faster, but volatile, and this
is meant to be a defensible record.

**Retry strategy:** BullMQ/Redis, exponential backoff, scaled via env vars so
a full retry-to-exhaustion cycle takes under a minute for review instead of a
realistic 5–30s/call. `registry_sync_status` hits `exhausted` on final
failure — the operator-actionable signal, no log-polling required. This is
also the justification for Redis in the stack: a durable retry queue is
something it's genuinely the right tool for. Rejected a plain
`setTimeout` retry: doesn't survive a process restart, and "a partner outage
must not lose a submission" requires durability.

**The stub partner** (`src/registry/stubPartnerClient.ts`) is the main file a
real integration would replace (alongside the stub callback-delivery worker
in the same `src/registry/` module). Two-job design — submit, then a *genuine HTTP
POST* back into this service's own callback route on a delay — so the
callback handler's idempotency and auth-free routing get exercised by real
traffic, including deliberate double-delivery for `"duplicate"`. `scenario`
is an explicit debug-only field on `/verify`, not part of a real partner's
API — flagged again in §6.

## 4. AI assistance

Built with **Claude Code** (Sonnet 5) — architecture discussion, all code,
migrations, tests, docs. I directed the architecture calls (Redis's role,
Kysely over an ORM, the two-job stub design, the state-machine resolution)
and reviewed/tested every commit; nothing here is unreviewed output.
