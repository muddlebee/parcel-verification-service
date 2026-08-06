# Parcel Verification Service

BhoomiPe's Parcel Verification Service — accepts a land parcel for verification,
moves it through a multi-stage pipeline involving an external land-registry
partner, and keeps a defensible record of every state change.

Built for the BhoomiPe Backend Engineer take-home assignment. See
[`docs/architecture.md`](docs/architecture.md) for diagrams (system overview,
ERD, state machine, sequence flow) and
[`docs/IMPLEMENTATION_LOG.md`](docs/IMPLEMENTATION_LOG.md) for a chronological,
commit-by-commit build narrative including the bugs found and fixed along the
way.

## 1. How to run it

Requires Docker and Docker Compose. Nothing else.

```bash
docker compose up --build
```

That's it. This brings up Postgres, Redis, and the API; runs migrations
automatically before the server starts; and the service is ready at
`http://localhost:3000`.

```bash
# liveness/readiness (checks Postgres + Redis)
curl http://localhost:3000/healthz

# interactive API docs (Swagger UI, generated from the same zod schemas
# the handlers validate against — can't drift)
open http://localhost:3000/docs

# every authenticated route needs this header (static key, per the brief)
# default in docker-compose.yml is dev-local-api-key
curl -H "X-API-Key: dev-local-api-key" http://localhost:3000/api/v1/parcels
```

### Running it locally without Docker (for development)

```bash
npm install
docker compose up -d postgres redis   # still need real Postgres/Redis
cp .env.example .env
npm run migrate:up
npm run dev                            # tsx watch, restarts on save
```

### Tests

```bash
docker compose up -d postgres redis    # tests run against the real DB/queue, not mocks
npm test
```

32 tests (1 file unit, 6 files integration), ~9 seconds. `vitest.config.ts` sets
faster retry/backoff timing for the test run specifically (150ms base vs the
already-scaled-down 2s dev default) so the retry-exhaustion tests don't take
30+ seconds each, and binds a real listener on a dedicated port (3999) because
one test file's callback-delivery worker makes a genuine HTTP loopback call —
see the comment in `test/integration/registryRetry.test.ts` for why supertest's
default in-memory app can't satisfy that on its own.

## 2. API design

Versioned from the start (`/api/v1/...`) even with only one version —
retrofitting versioning after real clients exist is far more painful than
starting with it.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | none | Container-orchestrator liveness/readiness |
| `GET` | `/docs`, `/openapi.json` | none | Swagger UI / generated OpenAPI spec |
| `POST` | `/api/v1/parcels` | API key | Submit a parcel for verification |
| `GET` | `/api/v1/parcels/:id` | API key | Parcel + owner + documents + full transition history |
| `GET` | `/api/v1/parcels` | API key | List, filter by `status`/`district`, paginated |
| `POST` | `/api/v1/parcels/:id/documents` | API key | Attach a document (multipart, disk storage) |
| `POST` | `/api/v1/parcels/:id/verify` | API key | Mark ready for verification — triggers the async registry call |
| `POST` | `/api/v1/parcels/:id/transitions` | API key | Manual ops transition — the only way in/out of `disputed` |
| `POST` | `/api/v1/callbacks/registry` | **none** | Registry partner delivers a result — see §3 and §6 |

### What I deliberately didn't expose

- **No `PATCH`/`PUT /parcels/:id`.** Once submitted, khata/plot/owner fields
  aren't editable through a generic update endpoint. This data anchors a title
  chain — silently rewriting it outside the audit trail is exactly the kind of
  thing this service exists to prevent. A real correction workflow would need
  its own audited process, which wasn't asked for here.
- **No `DELETE /parcels/:id`, no "unsubmit."** The state machine has no path
  back to a prior state for a reason — this is meant to be a defensible record,
  and hard deletion contradicts that on its face.
- **No document-download endpoint.** The brief asks for attaching documents,
  not serving them back. Building a download route opens its own security
  surface (content-type sniffing, path handling) that wasn't asked for; ops has
  direct volume access to `./uploads` for now.
- **No raw admin override for a stuck `registry_sync_status`.** An operator
  should re-trigger through a domain-meaningful action, not be handed a field
  editor. (I'd add a dedicated `POST /parcels/:id/retry-verification` endpoint
  for this with another week — see §4.)
- **No bulk endpoints.** Not asked for, and bulk state-changing operations need
  their own per-item audit semantics — real complexity with no signal it was
  wanted.

## 3. Design decisions

### Schema

Five tables, shipped as versioned `node-pg-migrate` migrations
(`src/db/migrations/`), not an ORM `synchronize`/`db push`. `parcels`,
`owners` (1:1), `documents`, `parcel_transitions` (the audit log — append-only,
`from_state` nullable only on the creation row), `registry_callbacks` (the
idempotency ledger). Full reasoning and the ERD are in
[`docs/architecture.md`](docs/architecture.md).

`parcels` carries two independent status fields: `status` (the brief's 5-state
machine) and `registry_sync_status` (`idle → queued → retrying → exhausted/done`).
The latter tracks the outbound partner call without inventing a 6th business
state — a stuck call is operator-visible through this field while the parcel
stays in a perfectly valid `under_verification`.

**Kysely, not an ORM.** A typed SQL query builder — real SQL-shaped queries,
type-checked against a hand-written `Database` interface
(`src/db/types.ts`) that mirrors the migrations. No code generation, no
active-record magic, and critically: it doesn't own the schema. A full ORM
(Prisma/TypeORM) wants to own migrations in its own format, which would mean
either two competing migration systems or handing "ship your schema as SQL" to
generated files that are harder to review as a diff.

### The state-machine ambiguity I resolved

The brief's own diagram is ambiguous about whether `rejected`/`disputed` branch
directly off `under_verification`, or only `disputed` branches off `verified`.
I resolved it as: `submitted → documents_pending → under_verification`, which
then splits to either `verified` or `rejected`; `verified` and `disputed` form
a reversible pair on their own (see the state diagram in
[`docs/architecture.md`](docs/architecture.md#state-machine) for the full
picture).

`disputed` is only reachable from `verified` (a competing claim surfacing
*after* a parcel is already verified), never directly from `under_verification`.
`rejected` is terminal — the brief describes no path back. This is enforced
server-side by `src/domain/stateMachine.ts`, unit-tested exhaustively over all
36 `(from, to)` state pairs, not just the happy-path list.

Per the brief's own framing ("asking a sharp question counts in your favour"),
I'd genuinely have preferred to confirm this with a PM rather than assume it —
documented the assumption instead of blocking on an email round trip, given the
24-hour window.

### Idempotency

The unique constraint `UNIQUE(parcel_id, external_callback_id)` on
`registry_callbacks` is the actual dedup mechanism — not an in-memory cache, not
a Redis `SETNX`. `INSERT ... ON CONFLICT DO NOTHING`, checked in the same
transaction as (and *before*) the state transition it gates. A duplicate
delivery is caught and short-circuited before parcel state is touched at all —
there's no window where a duplicate could partially apply. Verified against
real duplicate HTTP deliveries (the stub genuinely re-POSTs the same
`callback_id`, not a synthetic test shortcut) — see
`test/integration/registryRetry.test.ts`.

**Tradeoff rejected:** a Redis-based idempotency key (`SET NX` with a TTL) would
work and would be faster to check. Rejected because Redis is volatile and this
is meant to be a defensible record — an idempotency guarantee that can silently
evaporate on a Redis restart doesn't belong in an audit-trail service.

### Retry strategy

BullMQ on Redis. `attempts` + exponential `backoff` configured at enqueue time
(`src/http/routes/verify.routes.ts`), scaled down via env vars
(`REGISTRY_RETRY_BASE_MS`, `REGISTRY_MAX_ATTEMPTS`, `REGISTRY_CALL_TIMEOUT_MS`)
so a reviewer sees a full retry-to-exhaustion cycle in under a minute instead of
the brief's realistic 5–30s-per-call timing. On final failure,
`registry_sync_status` flips to `exhausted` — the operator-actionable signal the
brief asks for, surfaced on `GET /parcels/:id` without polling logs.

**This is the one sentence justifying Redis in the stack**, per the brief's own
requirement to justify it: BullMQ backs the outbound-call retry queue, which is
something Redis is genuinely the right tool for — delayed jobs, atomic
attempt-counting, a real dead-letter state — not something added to check a box.

**Tradeoff rejected:** a simple setTimeout-based retry loop in the request
handler. Rejected because it doesn't survive a process restart mid-retry, and
the brief explicitly requires "a partner outage must not corrupt parcel state
or lose a submission" — a durable queue is the only way that claim holds.

### The stub partner, and why it's designed the way it is

`src/registry/stubPartnerClient.ts` is the one file that would be deleted for a
real integration. Everything downstream is written against "a slow async call
that sometimes doesn't come back," not against this stub specifically.

Two-job design (`registry-submit` then `registry-callback-delivery`) instead of
faking the whole thing in one function: the delivery job makes a **genuine HTTP
POST** back into this same service's own callback route, after a delay, exactly
like a real partner's webhook would. This means the callback handler's
idempotency check, its unauthenticated routing, and its error handling all get
exercised by real traffic — including the deliberate double-delivery for the
`"duplicate"` scenario — not a shortcut that only proves the code compiles.

`scenario` is an explicit, documented debug-only field on the verify request —
not something a real partner's API would expose. It's the honest way to
demonstrate success/failure/timeout/duplicate deterministically without access
to a real partner, which is exactly what the brief asks the stub design to
solve for. Flagged again in §6 as something to strip before this ever fronted a
real integration.

## 4. What I'd do with another week

- **Split the workers into their own process/container.** Both are already
  standalone `BullMQ.Worker` instances (`src/jobs/`) — running them in-process
  with the API was the simplest thing that satisfies "no Kubernetes" and the
  time budget, but it's a one-file entrypoint change to split them, not a
  redesign.
- **A reconciliation sweep.** A periodic job requeuing parcels that have sat in
  `under_verification` with `registry_sync_status` stuck at something other
  than `done`/`exhausted` for too long (e.g. the process crashed mid-job before
  BullMQ's own retry accounting caught up).
- **A dedicated `POST /parcels/:id/retry-verification`** so ops can re-trigger a
  parcel that hit `exhausted`, instead of it being a dead end.
- **Filter `GET /parcels` by `registry_sync_status`.** Right now "show me every
  stuck parcel" requires listing everything and checking each one — the brief
  only asked for status/district filters, but this is the natural next filter
  for the exact on-call workflow the logging pass was built for.
- **Column-level encryption for `aadhaar_number`/`pan_number`/`bank_account_number`.**
  Currently plain `TEXT`. See §6 — this is closer to a "should have shipped"
  than a nice-to-have.
- **A canonical district lookup** instead of free-text — Odisha has a fixed set
  of districts; right now `district=Khorda` (typo for `Khordha`) silently
  returns zero results instead of erroring.
- **CI** (GitHub Actions: typecheck, lint if added, test, build the Docker
  image on every push). Didn't set this up given the time budget, but it's the
  most obviously-missing piece for anything past a take-home.
- **Rate limiting**, especially on the unauthenticated callback endpoint — see §6.

### What I knowingly left unfinished

- No ESLint/Prettier — a deliberate scope call (strict TypeScript as the
  quality gate; time went to the graded mechanics instead), not an oversight.
- No owner reuse across parcels — each submission creates its own `owners` row
  even if the same person owns multiple parcels. The brief's payload doesn't
  ask for owner-level identity resolution, and guessing at dedup logic (fuzzy
  name matching? Aadhaar as the join key?) felt like exactly the kind of
  unrequested scope the brief warns against.
- OpenAPI response examples exist for request bodies but not for every response
  variant (e.g. the exact shape of a 409 body isn't shown in Swagger, just its
  schema).

## 5. AI assistance

Built with **Claude Code** (Claude Sonnet 5), used for essentially the entire
implementation — architecture discussion, all application code, migrations,
tests, and this documentation. I directed the architecture decisions (Redis's
role, Kysely over an ORM, the two-job stub-partner design, the state-machine
ambiguity resolution, the ops-manual-transition endpoint) and reviewed/tested
every commit before it landed — nothing here is unreviewed generated output.

Concretely, in this session Claude:
- Implemented every file, migration, and test.
- Found and fixed six real bugs during manual verification (not just
  hypothesized in review): an unhandled `pg.Pool` error crashing the process on
  a Postgres restart; a missing Kysely `Generated<>` annotation breaking
  inserts; `pg`'s default `DATE` parser silently shifting dates by timezone; a
  CJS/ESM default-export interop issue (twice — `pino-http`, then `ioredis`);
  an Express router-mounting-order bug that 401'd the unauthenticated callback
  route; and a test-only bug where the callback-delivery worker's real HTTP
  loopback had nothing to connect to under supertest's default in-memory app.
- Ran the actual server and `docker compose up --build` after every commit, not
  just the test suite — several of the bugs above only surfaced that way.

I asked it to stop and explain reasoning at several points (why migrations
over ORM auto-create, why Kysely specifically, whether Vercel hosting made
sense here) rather than accepting output silently — those exchanges are in the
session history and shaped some of the calls above (e.g., Vercel hosting was
proposed and explicitly rejected as incompatible with the brief's own
constraints, not built and then removed).

## 6. What I'd push back on

**The unauthenticated callback endpoint is a real risk, not a formality.**
`POST /api/v1/callbacks/registry` can flip a parcel to `verified` — the signal
this whole platform exists to establish before money moves — and it sits
directly behind a payload containing Aadhaar, PAN, and bank account numbers on
`GET /parcels/:id`. I built it exactly as specified (no auth, per the brief),
but if this were handed to me as a real integration task I'd push hard for at
minimum an HMAC signature header the partner signs with a shared secret and we
verify — standard practice for webhooks (Stripe, GitHub, every payment
processor does this), and cheap to add. I did not add it unilaterally because
the brief is explicit that this endpoint should be unauthenticated, and
deviating silently would be worse than flagging it here.

**Storing full Aadhaar numbers is a compliance question, not just a security
one.** The brief's payload includes `aadhaar_number` verbatim, and the ops
requirement ("check them against physical documents on screen") implies it
needs to be human-readable, not hashed. But the Aadhaar Act restricts
storage/display of full Aadhaar numbers by private entities without UIDAI
authorization — the standard pattern is masking to the last 4 digits for
display and encrypting the full value at rest with an audited reveal path. I
stored it as plain `TEXT` and displayed it in full, matching the brief's
payload literally, but this is the first thing I'd raise with legal/compliance
before this got anywhere near a real ops screen.

**No encryption at rest for the financial fields either.**
`bank_account_number`, `pan_number` — plain `TEXT` columns, same story. Fine
for a take-home; I would not sign off on this schema for production without at
minimum column-level encryption.

**The `scenario` debug field on `/verify` must not survive contact with a real
partner.** It's documented as debug-only in the OpenAPI schema and in this
README, but "documented as debug-only" is not the same as "impossible to call
in production." A real rollout needs this gated behind a non-production build
flag or removed entirely, not just labeled.

**Free-text `district` filtering will produce silent false negatives.** Odisha
has a fixed, known set of districts. `district=Khorda` (missing an `h`) returns
an empty list, not an error — indistinguishable from "no parcels in this
district" to whoever's querying. I'd push for a canonical lookup/enum before
this API had real callers, not just better client-side validation.
