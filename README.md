# Parcel Verification Service

Accepts a land parcel for verification, moves it through a multi-stage
pipeline involving an external land-registry partner, and keeps a defensible
record of every state change.

Diagrams: [`docs/architecture.md`](docs/architecture.md). Commit-by-commit
build narrative: [`docs/IMPLEMENTATION_LOG.md`](docs/IMPLEMENTATION_LOG.md).
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
docker compose up -d postgres redis
cp .env.example .env
npm run migrate:up
npm run dev
```

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
| `POST` | `/api/v1/parcels/:id/documents` | API key | Attach a document |
| `POST` | `/api/v1/parcels/:id/verify` | API key | Trigger the async registry call |
| `POST` | `/api/v1/parcels/:id/transitions` | API key | Manual ops transition (`verified`↔`disputed`) |
| `POST` | `/api/v1/callbacks/registry` | **none** | Partner delivers a result — see §3, §6 |

**Deliberately not exposed:** `PATCH`/`DELETE /parcels/:id` (owner/khata data
anchors a title chain — no silent rewrites outside the audit trail; no
"unsubmit," the record is meant to be permanent); a document-download route
(out of scope, ops has direct volume access); a raw override for a stuck
`registry_sync_status` (should be a domain action, not a field editor — see
§4); bulk endpoints (each item needs its own audit semantics, not asked for).

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

**The stub partner** (`src/registry/stubPartnerClient.ts`) is the one file a
real integration would replace. Two-job design — submit, then a *genuine HTTP
POST* back into this service's own callback route on a delay — so the
callback handler's idempotency and auth-free routing get exercised by real
traffic, including deliberate double-delivery for `"duplicate"`. `scenario`
is an explicit debug-only field on `/verify`, not part of a real partner's
API — flagged again in §6.

## 4. Another week / left unfinished

- Split the workers into their own process — already standalone `BullMQ.Worker`s, a one-file entrypoint change.
- A reconciliation sweep for parcels stuck mid-retry after a crash.
- `POST /parcels/:id/retry-verification` so ops can recover an `exhausted` parcel.
- Filter `GET /parcels` by `registry_sync_status` (find every stuck parcel at once).
- Column-level encryption for `aadhaar_number`/`pan_number`/`bank_account_number` — see §6.
- A canonical district lookup instead of free text.
- CI (typecheck/test/build on push) — didn't set it up, most obvious gap past this stage.
- Rate limiting, especially on the unauthenticated callback — see §6.
- No ESLint/Prettier (deliberate — strict TS as the gate, time went to core mechanics).
- No owner dedup across parcels (no signal for how to resolve identity; guessing felt like scope creep).
- OpenAPI examples cover request bodies, not every response variant.

## 5. AI assistance

Built with **Claude Code** (Sonnet 5) — architecture discussion, all code,
migrations, tests, docs. I directed the architecture calls (Redis's role,
Kysely over an ORM, the two-job stub design, the state-machine resolution)
and reviewed/tested every commit; nothing here is unreviewed output.

It found and fixed six real bugs during manual verification, not just review:
an unhandled `pg.Pool` error crashing the process on a Postgres restart, a
missing Kysely `Generated<>` annotation, `pg`'s `DATE` parser silently
shifting timezones, a CJS/ESM interop issue (twice), an Express
router-mounting-order bug that broke the unauthenticated callback route, and
a test-only bug where a worker's real HTTP loopback had nothing to connect
to. Full detail in `docs/IMPLEMENTATION_LOG.md`. I pushed back on it at a few
points (why migrations over ORM auto-create, why Kysely, whether hosting the
backend on Vercel made sense — rejected as a bad architectural fit and never
built) rather than taking output at face value.

## 6. What I'd push back on

**The unauthenticated callback endpoint is a real risk, not a formality.**
`POST /api/v1/callbacks/registry` can flip a parcel to `verified` — the exact
signal this platform exists to establish before money moves — sitting behind
a payload with Aadhaar/PAN/bank details on `GET /parcels/:id`. Built exactly
as specified (no auth), but a real integration needs at minimum an HMAC
signature the partner signs and we verify — standard for webhooks, cheap to
add. Didn't add it unilaterally since the no-auth requirement is explicit;
flagging beats silently deviating.

**Storing full Aadhaar numbers unmasked is a compliance question, not just a
security one.** The Aadhaar Act restricts storage/display of full numbers by
private entities without authorization — standard practice is masking to the
last 4 digits with an audited reveal path, plus encryption at rest (also true
for `pan_number`/`bank_account_number`, currently plain `TEXT`). Built to
match the payload literally; this is the first thing I'd raise with
legal/compliance before a real ops screen.

**The `scenario` debug field must not survive contact with a real partner.**
Documented as debug-only, but "documented" isn't "impossible to call in
production" — needs a build-time gate or removal.

**Free-text `district` filtering produces silent false negatives.** A typo
(`Khorda` vs `Khordha`) returns an empty list, indistinguishable from "no
parcels here." A canonical lookup beats client-side validation for this.
