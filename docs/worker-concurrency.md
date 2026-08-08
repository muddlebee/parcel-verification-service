# Worker concurrency

How BullMQ `concurrency` affects the registry workers, with a worked scenario.

Related code:

- `REGISTRY_SUBMIT_CONCURRENCY` / `REGISTRY_DELIVERY_CONCURRENCY` in `src/config/env.ts` (default **5**)
- `src/registry/submitWorker.ts`
- `src/registry/callbackDeliveryWorker.ts`
- Queues: `src/registry/queues.ts`

For the two-queue design overall, see [`architecture.md`](./architecture.md).

## Mental model

Workers here are **I/O-bound** (await partner / loopback HTTP), not CPU-bound.
Raising concurrency does **not** make a single partner call faster. It lets
several jobs be **in flight at once** so their wait time overlaps.

```
concurrency: 1          concurrency: 5

Worker holds 1 job      Worker may hold up to 5 jobs
at a time               at once; each runs its async
                        processor independently
```

This is still **one Node process** (event-loop parallelism), not five OS
processes. When one job `await`s the partner, others can progress.

| Layer | Behavior |
| --- | --- |
| `submitWorker` (`registry-submit` queue) | Up to `REGISTRY_SUBMIT_CONCURRENCY` partner calls in flight |
| `callbackDeliveryWorker` (`registry-callback-delivery` queue) | Up to `REGISTRY_DELIVERY_CONCURRENCY` loopback POSTs in flight |
| The two workers vs each other | Independent — can run at the same time |
| API / enqueue | Parallel — many `/verify` calls queue work in Redis |

```
API (parallel) ──► Redis queues
                      │
                      ▼
              submit worker:   up to N jobs overlapping on partner I/O
              delivery worker: up to M jobs overlapping on HTTP POST
                      ▲______________▲
                      can overlap with each other
```

## Worked scenario: five parcels verify at once

Assumptions:

- Five clients hit `POST /parcels/:id/verify` in the same second
- Each partner call takes **~2s** (stub sleeps a fraction of `REGISTRY_CALL_TIMEOUT_MS`)
- DB write + enqueue of the delivery job is negligible (~ms)
- No retries; all scenarios succeed

### Sequential (`concurrency: 1`, the old default)

```
time →
0s     job1: call partner ████████████ 2s
2s     job2: call partner ████████████ 2s
4s     job3: call partner ████████████ 2s
6s     job4: call partner ████████████ 2s
8s     job5: call partner ████████████ 2s
10s    all five outbound legs done
```

**Wall clock ≈ 5 × 2s = 10s.**

Queue shape over time:

```
t=0  [running:1] [waiting:2,3,4,5]
t=2  [running:2] [waiting:3,4,5]
t=4  [running:3] [waiting:4,5]
...
```

### Parallel (`concurrency: 5`, current default)

```
time →
0s     job1: ████████████ 2s
0s     job2: ████████████ 2s
0s     job3: ████████████ 2s
0s     job4: ████████████ 2s
0s     job5: ████████████ 2s
2s     all five outbound legs done
```

**Wall clock ≈ 2s** — about **5×** less time for this batch, because five
partner waits run together.

```
t=0  [running:1,2,3,4,5]
t=2  each sets registry_sync_status=done and enqueues a delayed delivery job
```

### Six parcels (shows the “slot free” case)

Partner ~2s each, `concurrency: 5`:

```
t=0–2s   jobs 1–5 run together
t=2s     job 6 starts (a slot free)
t=2–4s   job 6 runs
t=4s     all outbound work done
```

| Concurrency | Ideal wall clock for 6 equal 2s jobs |
| --- | --- |
| 1 | ~12s |
| 5 | ~4s |

Ideal formula (equal job duration):

```
wall_clock ≈ ceil(N / concurrency) × avg_job_duration
```

## What a single parcel feels

**Parcel P behind four others, concurrency 1:**

```
t=0     /verify → 202, registry_sync_status=queued
t=0–8   four jobs ahead, 2s each (P waits in Redis)
t=8     P’s partner call starts
t=10    P → done
```

**Same P with four peers, concurrency 5:**

```
t=0     /verify → 202
t=0     all five start
t=2     P → done
```

Partner latency is still ~2s; **queue wait** drops. Throughput and lag under
load improve; a lonely single job does not get faster.

## Delivery queue is separate

Raising **submit** concurrency does not auto-parallelize callbacks.

```
submit worker concurrency 5
    → five submits can finish ~together
    → five delayed delivery jobs enqueued

delivery worker concurrency 1
    → those webhooks still serialize after their delays

delivery worker concurrency 5
    → loopback POSTs can overlap when delays fire together
```

Submit is usually the bottleneck (external partner). Delivery is local HTTP
and cheaper; both knobs exist so each can be tuned.

## What concurrency does *not* fix

| Situation | Why |
| --- | --- |
| A single parcel | Still one partner call |
| Partner rate limits | Parallel calls may 429 — use a BullMQ `limiter` if needed |
| Partner outage | Failures just happen in parallel; retries can amplify load |
| CPU-heavy work | Node is single-threaded; concurrency helps I/O wait |
| Crash before first enqueue | Still need outbox / reconciliation (see README “left unfinished”) |
| Double-submit on retry after partial success | Needs idempotent submit, not more concurrency |

## Config

```bash
# .env / .env.example
REGISTRY_SUBMIT_CONCURRENCY=5
REGISTRY_DELIVERY_CONCURRENCY=5
```

Set either to `1` to force sequential processing per queue.

Submit worker also sets `lockDuration` above `REGISTRY_CALL_TIMEOUT_MS` so a
job waiting on the partner is not marked stalled and reprocessed while still
running.

## Interview one-liner

> Concurrency 5 means up to five registry submits can await the partner at
> once, so five ~2s calls finish in ~2s instead of ~10s — throughput goes up
> because we overlap I/O wait, not because each call gets faster.
