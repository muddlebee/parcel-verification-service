# Backend Production Interview Guide

Concrete production-readiness discussions for the Parcel Verification Service.
Each section starts with the failure or scale question, then gives the design
and a concise interview answer.

## 1. Efficiently fetching encrypted data at scale

The number of encrypted rows is not itself the main problem. The important
question is: **which field is used to locate the rows?**

### Fetch by parcel ID

Keep non-sensitive identifiers such as `parcel_id` queryable and indexed. The
database uses that index to find one owner, and the application decrypts only
the sensitive fields in that result.

```text
indexed parcel_id lookup
        -> one owner row
        -> decrypt Aadhaar/PAN/bank details if authorized
```

One million encrypted owner rows do not require one million decryptions for
this request.

### Exact lookup by a sensitive value

Randomized authenticated encryption, such as AES-GCM, is appropriate for the
recoverable value but cannot support a direct equality lookup. If exact
Aadhaar or PAN search is a genuine requirement, store:

```text
aadhaar_ciphertext = AES-GCM(data_key, normalized_aadhaar)
aadhaar_lookup     = HMAC(search_key, normalized_aadhaar)
```

Index `aadhaar_lookup`. For a search, calculate the HMAC from the supplied
value, locate the small candidate set through the index, then decrypt only
those candidates. A keyed HMAC is preferred over a plain hash because Aadhaar,
PAN and phone values are predictable enough to guess offline.

This lookup column leaks equality (matching values have matching lookup
tokens), so add it only when exact search is required. Prefix, substring,
sorting and range queries over encrypted values should normally be redesigned
rather than supported through weaker encryption.

### Bulk processing

An export or key migration that genuinely needs all rows should be an
asynchronous, authorized and audited job. Read bounded batches using a cursor,
decrypt with bounded concurrency, stream the result, and checkpoint progress.

```sql
SELECT id, aadhaar_ciphertext, encryption_key_version
FROM owners
WHERE id > $last_processed_id
ORDER BY id
LIMIT 1000;
```

Do not load or decrypt one million rows in a normal API request. Use envelope
encryption and a short-lived cached data-encryption key so there is not one KMS
network call per row.

> **Interview answer:** Search through an indexed non-sensitive identifier and
> decrypt only the returned rows. If exact lookup by sensitive data is
> required, use randomized ciphertext plus a separately keyed and indexed HMAC
> lookup. Process genuine bulk work asynchronously in resumable batches.

## 2. PostgreSQL commit succeeds but BullMQ enqueue fails

The parcel update is stored in PostgreSQL while BullMQ stores jobs in Redis.
These two systems cannot participate in a normal single transaction.

Putting `submitQueue.add()` inside a PostgreSQL transaction is not atomic:

```text
Redis accepts job -> process crashes -> PostgreSQL rolls back
```

Putting it after the transaction has the opposite gap:

```text
PostgreSQL commits -> process crashes -> Redis never receives job
```

### Transactional outbox

In one PostgreSQL transaction:

1. Transition the parcel to `under_verification`.
2. Set the registry reference and sync status.
3. Insert an `outbox_events` row describing the requested work.

Those database changes all commit or all roll back. A separate publisher reads
unpublished outbox rows and adds them to BullMQ.

```text
API transaction                         Publisher
---------------                         ---------
update parcel                           read unpublished event
insert transition                       add BullMQ job
insert outbox event                     mark event published
commit
```

Use the outbox event ID as the stable BullMQ job ID, and make the worker
idempotent. This produces **at-least-once delivery**: work should not be lost,
but it can be delivered more than once.

### Concrete publisher failures

| Failure | Outcome and recovery |
|---|---|
| Redis is unavailable | Event remains unpublished and is retried later. |
| Network timeout/failover | Treat outcome as unknown and retry with the same event ID. |
| Publisher crashes before enqueue | Event remains unpublished and is retried. |
| Publisher crashes after enqueue but before marking published | Event may be published again; stable IDs and an idempotent worker make this safe. |
| Invalid payload | Record attempts/error, stop after a limit, alert an operator. |
| Redis loses an already-published job | Use Redis persistence/HA plus reconciliation for parcels stuck beyond an expected age. |

> **Interview answer:** The business-state change and the intent to enqueue are
> atomic in PostgreSQL, not across PostgreSQL and Redis. An outbox publisher
> eventually sends the work to BullMQ. Stable event IDs, idempotent workers and
> reconciliation handle the unavoidable duplicate and uncertain-outcome cases.

## 3. Production cloud hosting

The service consists of an HTTP API, BullMQ workers, PostgreSQL, Redis and
document storage. Docker Compose is appropriate locally; production should use
managed, independently scalable components.

### Example AWS deployment

| Responsibility | Example service |
|---|---|
| DNS | Route 53 |
| TLS/load balancing | Application Load Balancer |
| API containers | ECS/Fargate service |
| Worker containers | Separate ECS/Fargate service |
| Container images | ECR |
| PostgreSQL | RDS PostgreSQL |
| BullMQ Redis | ElastiCache |
| Documents | Private S3 bucket |
| Secrets | Secrets Manager |
| Encryption keys | KMS |
| Logs, metrics and alerts | CloudWatch |

Equivalent managed services on another cloud are also valid. Kubernetes is
not required merely to make the application production-ready.

```text
Internet
   -> DNS
   -> HTTPS load balancer
   -> stateless API containers
        -> PostgreSQL
        -> outbox/BullMQ
        -> private object storage

BullMQ -> independently scaled worker containers -> registry partner
```

Only the HTTPS load balancer should be public. API containers, workers,
PostgreSQL and Redis should be placed on private networks with narrowly scoped
security rules.

### Separate API and workers

Use the same immutable image with separate entrypoints:

```text
API service:    node dist/api.js
Worker service: node dist/worker.js
```

This avoids starting additional workers every time API replicas scale. Scale
the API using request rate, latency and resource utilization. Scale workers
using queue depth and oldest-job age, while enforcing the external partner's
global rate limit.

### Document storage

Container disks are ephemeral and are not shared by replicas. Store documents
in a private object store and keep only metadata, object key, checksum and scan
status in PostgreSQL. For larger files, issue a short-lived presigned upload
URL so the client uploads directly to object storage. Quarantine and malware
scan uploads before making them available.

### Secrets and encryption

Production secrets must not be stored in source code, the image or a committed
`.env` file. Inject database, Redis, webhook and partner credentials from a
secret manager using the workload's cloud identity. Keep master encryption
keys in KMS and store ciphertext plus key-version metadata in PostgreSQL.

### CI/CD and migrations

```text
push code
 -> typecheck/test/build
 -> build and scan image
 -> push immutable image
 -> run backward-compatible migration as a one-off task
 -> rolling deployment
 -> readiness verification
```

Do not have every API replica race to run migrations at startup. During a
rolling deployment, old and new versions coexist, so schemas and queue payloads
must remain backward-compatible. Version queue payloads and gracefully stop
workers so active jobs finish or are safely released.

### Availability and recovery

Run multiple API replicas across failure zones, use managed PostgreSQL and
Redis failover, enable backups and point-in-time recovery, and test restoration.
Agree on business targets:

- **RPO:** acceptable amount of data loss.
- **RTO:** acceptable time to restore service.

> **Interview answer:** Run stateless API containers behind an HTTPS load
> balancer and workers as a separate service. Use managed PostgreSQL and Redis,
> private object storage, a secret manager and KMS. Keep data services private,
> deploy immutable images with controlled migrations, and scale API and workers
> independently using the metrics relevant to each.

## 4. Follow-up scenario bank

### Reliability and distributed systems

1. What if the partner receives a request but our call times out?
2. How do stable idempotency keys make retries safe?
3. What if a callback is delivered twice or arrives out of order?
4. What if two requests transition the same parcel concurrently?
5. How are parcels stuck after an outage detected and reconciled?
6. What happens to active BullMQ jobs during a deployment?
7. How do backoff, jitter, rate limits and a circuit breaker differ?

### Security and privacy

1. How should registry callbacks be signed and replay-protected?
2. How should Aadhaar, PAN and bank details be masked and encrypted?
3. How are encryption and webhook keys rotated?
4. How is tenant-level authorization enforced beyond authentication?
5. How are uploads validated, scanned and safely downloaded?
6. How are sensitive values prevented from entering logs?

### Database and scale

1. Why use keyset pagination instead of a deep offset?
2. Which compound indexes support status/district listing queries?
3. When do read replicas, partitioning or archival become useful?
4. How is a billion-row backfill performed without long locks?
5. How are database connections bounded as API replicas increase?

### Cloud and operations

1. What is the difference between liveness, readiness and startup probes?
2. How do rolling deployments and rollbacks work?
3. How are database migrations made compatible with two running versions?
4. What metrics should independently scale API and worker services?
5. What happens when an availability zone or a managed dependency fails?
6. How are RPO and RTO selected and tested?
7. When would Kubernetes be justified over managed container services?

For each question, structure the response as: current behavior, concrete
failure, proposed design, and trade-off.
