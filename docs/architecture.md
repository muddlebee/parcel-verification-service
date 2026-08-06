# Architecture Reference

Diagrams render natively on GitHub. This is a reference — for the "what was built,
in what order, and why" narrative, see `docs/IMPLEMENTATION_LOG.md`. For the
API-design and tradeoff reasoning, see the root `README.md`.

## System overview

```mermaid
flowchart LR
    Client["API client\n(ops UI / curl / partner)"]

    subgraph Service["parcel-verification-service (one Node process)"]
        API["Express API\n/api/v1/*"]
        SubmitWorker["registry-submit worker"]
        DeliveryWorker["registry-callback-delivery worker"]
        Stub["stubPartnerClient\n(the fake partner)"]
    end

    PG[("PostgreSQL\nsource of truth")]
    Redis[("Redis\nBullMQ queues")]
    Disk[("local disk\n./uploads")]

    Client -->|"REST + X-API-Key"| API
    API --> PG
    API -->|"write"| Disk
    API -->|"enqueue"| Redis
    Redis -->|"consume"| SubmitWorker
    SubmitWorker --> Stub
    SubmitWorker -->|"enqueue delivery"| Redis
    Redis -->|"consume"| DeliveryWorker
    DeliveryWorker -->|"genuine HTTP POST\n/api/v1/callbacks/registry\n(loopback, unauthenticated)"| API
    SubmitWorker --> PG
    DeliveryWorker -.->|"no direct DB access"| PG
```

Everything runs in one process (API + both workers) — the brief rules out
Kubernetes and the time budget didn't call for the added complexity of splitting
them. Each worker is already a standalone `BullMQ.Worker` instance, so moving one
to its own process/container later is an entrypoint change, not a redesign.

## Schema (ERD)

```mermaid
erDiagram
    PARCELS ||--|| OWNERS : "has one"
    PARCELS ||--o{ DOCUMENTS : "has many"
    PARCELS ||--o{ PARCEL_TRANSITIONS : "audit log"
    PARCELS ||--o{ REGISTRY_CALLBACKS : "idempotency ledger"

    PARCELS {
        uuid id PK
        text khata_no
        text plot_no
        text district
        text tehsil
        text village
        numeric area_sqft
        date claimed_ownership_since
        text status "5-state machine"
        text registry_sync_status "idle/queued/retrying/exhausted/done"
        uuid registry_reference_id "unique, nullable"
        timestamptz created_at
        timestamptz updated_at
    }
    OWNERS {
        uuid id PK
        uuid parcel_id FK "unique"
        text full_name
        text mobile
        text aadhaar_number
        text pan_number
        text bank_account_number
        text ifsc
    }
    DOCUMENTS {
        uuid id PK
        uuid parcel_id FK
        text document_type
        text original_file_name
        text content_type
        int size_bytes
        text storage_path "server-generated, never client input"
    }
    PARCEL_TRANSITIONS {
        uuid id PK
        uuid parcel_id FK
        text from_state "nullable, only for the creation row"
        text to_state
        text actor
        text reason
        timestamptz created_at
    }
    REGISTRY_CALLBACKS {
        uuid id PK
        uuid parcel_id FK
        text external_callback_id "UNIQUE with parcel_id"
        text result
        jsonb raw_payload
        timestamptz received_at
    }
```

`registry_sync_status` is not part of the brief's 5-state machine — it tracks the
outbound partner call independently, so a stuck call surfaces to an operator
without inventing a 6th business state. See `PARCELS.status` vs
`PARCELS.registry_sync_status` in the state diagram below.

## State machine

```mermaid
stateDiagram-v2
    [*] --> submitted: POST /parcels
    submitted --> documents_pending: system, auto (nothing attached yet)
    documents_pending --> under_verification: POST /parcels/:id/verify
    under_verification --> verified: registry callback (result=verified)
    under_verification --> rejected: registry callback (result=rejected)
    verified --> disputed: POST /parcels/:id/transitions (manual, ops)
    disputed --> verified: POST /parcels/:id/transitions (manual, ops — reversal)
    rejected --> [*]: terminal, no path back
```

Every edge not drawn is a `409 INVALID_TRANSITION` — enforced by
`assertValidTransition` (`src/domain/stateMachine.ts`), the single source of
truth every transition path calls through `applyTransition`
(`src/db/repositories/transitions.repository.ts`).

## Registry verification sequence

The path from "mark ready for verification" through a successful outcome,
showing where retry/backoff and idempotency actually live:

```mermaid
sequenceDiagram
    participant C as Client
    participant API as Express API
    participant DB as Postgres
    participant Q1 as registry-submit queue
    participant W1 as submit worker
    participant Stub as stub partner
    participant Q2 as callback-delivery queue
    participant W2 as delivery worker
    participant CB as /callbacks/registry

    C->>API: POST /parcels/:id/verify
    API->>DB: applyTransition(documents_pending -> under_verification)
    API->>DB: set registry_reference_id, registry_sync_status=queued
    API->>Q1: enqueue {parcelId, registryReferenceId, scenario, requestId}
    API-->>C: 202 {registry_reference_id}

    loop up to REGISTRY_MAX_ATTEMPTS, exponential backoff
        Q1->>W1: deliver job
        W1->>Stub: submitToRegistry() [timeout-guarded]
        alt ack
            Stub-->>W1: acknowledged
            W1->>DB: registry_sync_status=done
            W1->>Q2: enqueue {parcelId, result, callbackId, requestId} (delayed)
        else timeout or partner failure
            Stub-->>W1: (times out) / throws
            W1->>DB: registry_sync_status=retrying (or exhausted on final attempt)
        end
    end

    Q2->>W2: deliver job (after delay)
    W2->>CB: POST (genuine HTTP, unauthenticated,\nx-debug-origin-request-id header)
    CB->>DB: INSERT registry_callbacks ON CONFLICT DO NOTHING
    alt first delivery of this callback_id
        CB->>DB: applyTransition(under_verification -> verified/rejected)
        CB-->>W2: 200 {status: "applied"}
    else duplicate callback_id (redelivery)
        CB-->>W2: 200 {status: "duplicate_ignored"}
    end
```

Two details worth calling out from the diagram:

- **The idempotency check runs before the transition is attempted**, in the same
  transaction, keyed on the database's own unique constraint — not an
  application-level `if` check. A duplicate is caught and short-circuited before
  parcel state is touched at all.
- **`registry_sync_status` and `parcel.status` are updated by different actors
  at different times.** The submit worker only ever touches `registry_sync_status`
  (it never knows the actual verification result). The callback handler only
  ever touches `parcel.status` via `applyTransition`. Neither can corrupt the
  other's field.
