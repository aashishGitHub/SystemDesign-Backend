# Pattern: Managing Long-Running Tasks

> **Interviewer signal:** "generate a report", "transcode the video", "send the newsletter to 10M users", "import this CSV", "resize the image", "the request takes 45 seconds".

Work that takes longer than a user should wait for a HTTP response. The move is always the same — **accept the request, hand back a receipt, do the work elsewhere** — and the interview is entirely about the failure modes that opens up: duplicate execution, poison messages, head-of-line blocking, unbounded backlogs, and the fact that a queue cannot answer "how's my job doing?".

📖 Source outline: [hellointerview.com — Managing Long Running Tasks](https://www.hellointerview.com/learn/system-design/patterns/long-running-tasks) (prose paywalled; depth below is this repo's own).

---

## Table of Contents

1. [The Problem: Work That Outlives a Request](#1-the-problem-work-that-outlives-a-request)
2. [The Shape of the Solution](#2-the-shape-of-the-solution)
3. [Trade-offs: What You Gain and Lose](#3-trade-offs-what-you-gain-and-lose)
4. [The Job Table and the Queue Are Different Things](#4-the-job-table-and-the-queue-are-different-things)
5. [Choosing the Queue](#5-choosing-the-queue)
6. [The Worker Loop and Visibility Timeouts](#6-the-worker-loop-and-visibility-timeouts)
7. [Handling Failures and Poison Messages](#7-handling-failures-and-poison-messages)
8. [Preventing Duplicate Work](#8-preventing-duplicate-work)
9. [Checkpointing Partial Progress](#9-checkpointing-partial-progress)
10. [Backpressure and Autoscaling on the Right Signal](#10-backpressure-and-autoscaling-on-the-right-signal)
11. [Mixed Workloads, Priority, and Fairness](#11-mixed-workloads-priority-and-fairness)
12. [Job Dependencies and Fan-Out/Fan-In](#12-job-dependencies-and-fan-outfan-in)
13. [Scheduled Jobs and the Cron Problem](#13-scheduled-jobs-and-the-cron-problem)
14. [Cancellation and Progress Reporting](#14-cancellation-and-progress-reporting)
15. [Observability](#15-observability)
16. [Decision Framework](#16-decision-framework)
17. [Where This Shows Up in This Repo](#17-where-this-shows-up-in-this-repo)
18. [Real-World Cases](#18-real-world-cases)
19. [Interview Questions](#19-interview-questions)
20. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Problem: Work That Outlives a Request

```
POST /reports  →  [45 seconds of PDF generation]  →  200 OK
```

Everything that goes wrong:

| Problem | Detail |
|---|---|
| **Timeouts** | Load balancers, gateways, and browsers give up well before you finish — often at 30–60s. The work may complete and the client still sees an error |
| **A blocked worker** | One request occupies a thread/connection for 45 seconds. 100 concurrent reports and your API is unavailable for everything else |
| **Retry amplification** | The client retries the timeout, so now the same expensive job runs twice (or five times) concurrently |
| **Deploys destroy work** | A rolling restart kills in-flight jobs with no record of how far they got |
| **No resilience** | A transient failure at second 44 wastes all 44 seconds and the user has to start over |
| **Wrong scaling axis** | Report generation is CPU-heavy; serving HTTP is not. Coupling them forces you to scale both together |
| **Terrible UX** | A 45-second spinner the user cannot navigate away from |

Rule of thumb: **anything reliably over ~1 second of work that isn't needed to construct the response should be considered for this pattern**, and anything over ~10 seconds must be.

---

## 2. The Shape of the Solution

```
1.  POST /reports {params}
        ├─ validate + authorize (fast)
        ├─ INSERT job row: status=QUEUED, id=job_123
        ├─ enqueue message {job_id: job_123}
        └─ 202 Accepted  { job_id, status_url: /jobs/job_123 }

2.  Worker pool (scaled independently)
        ├─ receive message (with a lease/visibility timeout)
        ├─ UPDATE status=RUNNING, worker_id, started_at
        ├─ do the work, checkpointing progress
        ├─ write the result to blob storage → result_key
        ├─ UPDATE status=SUCCEEDED, result_key
        └─ ACK the message   ← only now

3.  Client learns the outcome
        ├─ polls GET /jobs/job_123  → {status, progress, result_url}
        └─ or is pushed to via SSE/WebSocket  (see realtime-updates.md)
```

Two details that carry a lot of weight:

- **`202 Accepted` with a status URL**, not `200 OK`. The response must not imply the work is done — that's an honest API contract, and it's the [multi-step-processes](./multi-step-processes.md#5-choreography-vs-orchestration) discipline applied to a single async step.
- **The result goes to blob storage**, not into the job row or the response. A 40MB PDF belongs in object storage with a presigned download URL — see [Handling Large Blobs](./large-blobs.md).

---

## 3. Trade-offs: What You Gain and Lose

| Gain | Lose |
|---|---|
| Fast, predictable API responses | **Eventual consistency** — the result isn't available when the call returns |
| Failure isolation — a broken worker doesn't break the API | A status-tracking mechanism you must build and the client must consume |
| Retries for free, without the client involved | **At-least-once delivery** → duplicate execution is now possible |
| Independent scaling of API and compute | More moving parts: queue, workers, DLQ, monitoring |
| Burst absorption | Harder debugging — the work happens somewhere else, later |
| Natural batching and rate control toward third parties | New failure modes: poison messages, head-of-line blocking, unbounded backlog |
| Survives deploys (work is durable in the queue) | A queue that nobody drains is a silent data-loss mechanism |

State this trade honestly in interviews. "Async is better" is not an answer; "the response latency and isolation are worth the eventual consistency and the idempotency work, and here's how I handle the duplicates" is.

**When *not* to use it:** when the client genuinely can't proceed without the result and the work is fast (sub-second), when strict ordering across all work is required (a queue with N workers is concurrent by design), or when the added components would outweigh the benefit for a rarely-used endpoint.

---

## 4. The Job Table and the Queue Are Different Things

The most common design mistake here is trying to make the queue serve both roles.

| | Queue | Job table (DB) |
|---|---|---|
| Purpose | **Transport** — deliver work to a free worker | **State** — the queryable record of what happened |
| Can you ask "status of job 42?" | No. Queues aren't indexed or queryable by ID | Yes |
| Can you list a user's jobs? | No | Yes |
| Retains history after success? | No — messages are deleted on ack | Yes, as long as you want |
| Survives a queue migration? | No | Yes |

So the pattern needs **both**, and the queue message should carry only a **job ID** rather than the full payload — the worker loads the job row for details. That keeps messages small (many queues cap message size around 256KB), avoids stale duplicated data if the job is updated, and means a redelivered message re-reads current state instead of acting on a snapshot.

```sql
CREATE TABLE jobs (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  status        text NOT NULL,   -- QUEUED│RUNNING│SUCCEEDED│FAILED│CANCELLED│DEAD
  idempotency_key text UNIQUE,   -- dedupe at submit time
  attempts      int  DEFAULT 0,
  progress      int  DEFAULT 0,  -- for user-visible progress
  checkpoint    jsonb,           -- resume point (see §9)
  result_key    text,            -- pointer into blob storage
  error         text,
  cancel_requested boolean DEFAULT false,
  created_at    timestamptz, started_at timestamptz, finished_at timestamptz
);
```

There's a dual-write hazard here too: committing the job row and enqueueing the message aren't atomic. If enqueue fails after commit, the job sits `QUEUED` forever. Fix it the same way as always — an [outbox](./multi-step-processes.md#8-the-dual-write-problem-and-the-outbox), or a sweeper that re-enqueues `QUEUED` rows older than N minutes.

---

## 5. Choosing the Queue

| Option | Delivery | Ack model | DLQ | Ordering | Best for |
|---|---|---|---|---|---|
| **Redis list** (`LPUSH`/`BRPOP`) | At-most-once by default | Pop *is* the ack — crash loses the job | Build it yourself | FIFO-ish | Prototypes only. The lost-job risk is real |
| **Redis Streams** | At-least-once | Consumer groups + explicit `XACK`, pending-entry list | Manual | Per-stream | Redis-only stacks that need real acks |
| **SQS (standard)** | At-least-once | Visibility timeout + delete | **Built-in** | None | Default managed choice; huge scale, trivial ops |
| **SQS FIFO** | Exactly-once *processing* semantics per group | Same + dedupe ID | Built-in | Per message-group | When per-entity ordering matters; lower throughput |
| **RabbitMQ** | At-least-once | Explicit ack/nack, prefetch | Built-in (DLX) | Per queue | Complex routing, priorities, per-message TTL |
| **Kafka** | At-least-once | Offset commits | Manual (retry topics) | **Per partition** | High-throughput streams, replay, event sourcing |
| **Celery / Sidekiq / BullMQ** | Depends on broker | Framework-managed | Yes | Depends | Fast application-level job systems |

The distinction to get right in an interview: **Kafka is a log, not a task queue.** It's excellent when you want ordered, replayable streams and consumers that own offsets, and awkward for classic job semantics — per-message retry with backoff, per-message DLQ, and priority all require extra machinery (retry topics, delay topics), and a single slow message blocks its whole partition. For "resize this image", SQS/RabbitMQ/Redis Streams fit better. Saying which one you'd pick *and why the other is a worse fit* is the signal.

→ [`message-queues/deep-dive.md`](../interviews/message-queues/deep-dive.md) · [`communication-protocols §6 AMQP & RabbitMQ`](../interviews/communication-protocols/deep-dive.md#6-amqp--rabbitmq) · [`§7 Kafka`](../interviews/communication-protocols/deep-dive.md#7-kafka-event-sourcing--streaming) · [`§8 AWS Managed Messaging`](../interviews/communication-protocols/deep-dive.md#8-aws-managed-messaging)

---

## 6. The Worker Loop and Visibility Timeouts

```python
while True:
    msg = queue.receive(wait=20)              # long poll, not a busy loop
    if not msg: continue
    job = db.load(msg.job_id)

    if job.status in TERMINAL: msg.ack(); continue   # already done — duplicate delivery
    if job.cancel_requested:   msg.ack(); continue

    db.update(job, status='RUNNING', attempts=job.attempts + 1)
    try:
        with heartbeat(msg):                  # ← extend the lease while working
            result = process(job)
        db.update(job, status='SUCCEEDED', result_key=result)
        msg.ack()                             # ACK LAST. Always.
    except Retryable as e:
        db.update(job, error=str(e))
        msg.nack(delay=backoff(job.attempts))  # redelivered later
    except Fatal as e:
        db.update(job, status='FAILED', error=str(e))
        msg.ack()                             # don't retry what can't succeed
```

**Ack after success, never before.** Acking on receipt converts at-least-once into at-most-once and silently loses jobs when a worker dies mid-processing.

**The visibility timeout is the trap.** When a worker receives a message, the queue hides it for a fixed window; if no ack arrives in time, it's redelivered on the assumption the worker died. So:

```
visibility timeout = 30s        job actually takes 5 minutes
  t=30s  → queue redelivers → worker #2 starts the SAME job
  t=60s  → worker #3 …
→ N workers doing identical expensive work, and whichever finishes
  last overwrites the others' results.
```

Three fixes, and the right answer names the first: **heartbeat to extend the lease** while the job runs (`ChangeMessageVisibility` in SQS terms), so the timeout tracks liveness rather than guessing duration. Second, set the timeout above the p99 job duration — workable only if durations are predictable and bounded. Third, if a job is genuinely long and unpredictable, break it into smaller units, each of which fits comfortably inside a timeout.

This is exactly the [lease](../fundamentals/lease.md) primitive, and the pause-after-expiry hazard from [distributed locks](./dealing-with-contention.md#8-rung-5-distributed-locks-and-why-theyre-last) applies: a worker can be paused past its lease and resume believing it still owns the job. Which is why the *idempotency* in §8 is the real protection, not the lease.

---

## 7. Handling Failures and Poison Messages

**Transient failures** — retry with **exponential backoff and jitter**. Without jitter, a downstream outage produces synchronized retry waves that keep re-breaking it as it recovers. Pair with a [circuit breaker](../fundamentals/circuit-breaker.md) so a dead dependency causes fast failures instead of a queue full of workers all blocking on timeouts.

**Permanent failures** — don't retry at all. A malformed payload or a deleted source file will fail identically forever; distinguish *retryable* from *fatal* in the worker and fail fast on the latter. A validation error retried 25 times is 25× wasted compute and a delayed error message to the user.

**Poison messages** — the message that always fails and, without a cap, is redelivered forever, consuming an entire worker in a loop. Hence the two-part answer:

```
attempts > max_attempts (say 5)  →  move to DEAD-LETTER QUEUE
```

The DLQ is where the actual seniority shows. It needs:

- **An alarm on depth > 0.** A dead-letter queue nobody monitors is a data-loss mechanism with extra steps — this is the single most common gap in real systems.
- **Enough context to diagnose**: the original message, the error, the attempt count, a trace ID.
- **A replay path** — after fixing the bug, re-drive the DLQ back onto the main queue. If replay is manual and undocumented, it won't happen.
- **A retention policy** longer than your incident response time.

**Also cap total attempts in the job row, not only in the queue.** Redeliveries caused by visibility-timeout expiry don't always increment the queue's receive count the way you expect, and a job that's been attempted 40 times should stop regardless of which layer noticed.

→ [`message-queues/deep-dive.md`](../interviews/message-queues/deep-dive.md) · [`notification-system §7 Failure Modes and Provider Reliability`](../interviews/notification-system/deep-dive.md#7-failure-modes-and-provider-reliability)

---

## 8. Preventing Duplicate Work

Duplicates are guaranteed, not hypothetical: at-least-once delivery, visibility-timeout redelivery, client retries on the submit endpoint, and worker crashes after doing the work but before acking. Defences, layered:

**1. Dedupe at submission.** An idempotency key with a unique constraint means a retried `POST /reports` returns the *existing* job rather than creating a second one. Cheapest and most effective — the duplicate never enters the system. → [`api-design §4`](../interviews/api-design/deep-dive.md#4-idempotency-and-safe-retries)

**2. Check state before working.** The worker's first action is to load the job and skip if it's already terminal. Catches most redelivery duplicates for free.

**3. Make the work itself idempotent.** The durable answer:

```
✅ write output to a deterministic key:  reports/{job_id}.pdf     (overwrite, same result)
✅ UPSERT keyed by job_id
✅ conditional update: SET status='SUCCEEDED' WHERE status='RUNNING'
❌ INSERT a new row per run             → duplicate rows
❌ balance = balance - 10               → double charge
❌ send an email                        → user gets two. Needs a dedupe record
```

**4. A claim/lease on the job row** so two workers can't both run it:

```sql
UPDATE jobs SET status='RUNNING', worker_id=$me, lease_until=now()+interval '5 min'
 WHERE id=$id AND (status='QUEUED' OR lease_until < now());
-- 0 rows → someone else owns it → ack and move on
```

That's the [conditional write](./dealing-with-contention.md#4-rung-1-conditional--atomic-writes) from the contention pattern, and it's the mechanism that makes concurrent redelivery harmless.

**5. Fencing for external side effects.** If the job writes to an external system, a paused-then-resumed worker can still double-write despite all of the above. Where that's unacceptable, carry a monotonic attempt/fence token the target checks — [`fundamentals/fencing.md`](../fundamentals/fencing.md).

The framing to give: **"exactly-once delivery doesn't exist; exactly-once *effect* does, via at-least-once delivery plus idempotent handling."** → [`distributed-transactions §12`](../interviews/distributed-transactions/deep-dive.md#12-idempotency-and-exactly-once)

---

## 9. Checkpointing Partial Progress

A 1M-row CSV import that fails at row 900,000 should not restart at row 1.

```
Batch of 1M rows, committed in chunks of 1,000:
   process rows 1…1000     → commit → checkpoint = {last_row: 1000}
   process rows 1001…2000  → commit → checkpoint = {last_row: 2000}
   …
   ✗ crash at row 900,412
   retry → load checkpoint → resume from 900,000. 90% of work preserved.
```

Requirements: the checkpoint must be committed **in the same transaction** as the work it describes (otherwise you either redo or skip a chunk), and each chunk must be idempotent so the partially-completed chunk at the crash boundary can be safely reapplied. This is the same **high-water mark** idea as in log replication — [`fundamentals/high-water-mark.md`](../fundamentals/high-water-mark.md).

For expensive multi-stage jobs (video transcoding into five renditions), checkpoint **per stage** and store partial outputs, so a failure in the 4K rendition doesn't rerun 480p. Keying outputs by `(job_id, stage)` makes stages independently retryable — and once you have stages with dependencies, you're crossing into [Multi-Step Processes](./multi-step-processes.md).

→ [`video-streaming §3 Transcoding Architecture`](../interviews/video-streaming/deep-dive.md#3-transcoding-architecture)

---

## 10. Backpressure and Autoscaling on the Right Signal

**Queue depth is a lagging indicator; age of the oldest message is the leading one.** Depth of 10,000 means nothing without throughput — 10,000 messages at 5,000/sec is two seconds of backlog, while 500 messages at 0.1/sec is 83 minutes. Alert and scale on **backlog age** (or consumer lag for Kafka), because that's what the user experiences.

```
Scale worker count on:  backlog_age  or  queue_depth / throughput
NOT on:                 worker CPU
```

Scaling on CPU is a classic mistake: workers blocked on I/O show low CPU while the backlog explodes, so the autoscaler happily does nothing. Conversely a CPU-bound worker pool at 100% may be perfectly sized if the backlog is empty.

When the backlog grows despite max workers, you're in genuine overload with three options — the same three as in [Scaling Writes](./scaling-writes.md#6-rung-4-load-shedding-and-backpressure): bound the queue and reject new submissions (`429` with `Retry-After`), shed by priority, or degrade the work itself (lower-resolution output, coarser aggregation). What you must not do is let an unbounded backlog grow until messages hit the retention limit and disappear — that's silent data loss presented as "the system is still up".

Also mind **downstream** backpressure: 500 workers all calling a third-party API that allows 100 requests/second will just generate 400 failures per second and a retry storm. Concurrency limits and a rate limiter *inside* the worker pool are part of the design. → [`rate-limiting §4`](../interviews/rate-limiting/deep-dive.md#4-distributed-limiting-with-redis) · [`notification-system §6`](../interviews/notification-system/deep-dive.md#6-priority-rate-control-and-user-preferences)

---

## 11. Mixed Workloads, Priority, and Fairness

**Head-of-line blocking** is the failure everyone hits eventually:

```
One queue, 10 workers:
   [4-hour video][4-hour video]…[×10]  ← all workers busy
   [2-second thumbnail] ← waits 4 hours behind them
```

Fixes, in order of preference:

| Fix | Detail |
|---|---|
| **Separate queues by class/duration** | `fast`, `slow`, `bulk`, each with its own worker pool and its own visibility timeout. Simple, predictable, and the timeouts can actually be tuned per class |
| **Priority queues** | Broker-level priority (RabbitMQ) or multiple queues polled in priority order. Watch for **starvation** — always reserve some capacity for low priority, or a busy high-priority stream means bulk jobs never run |
| **Reserved capacity** | Dedicate N workers to interactive work so bulk can never consume the whole pool |
| **Split the big jobs** | A 4-hour job becomes 240 one-minute jobs, which also fixes visibility timeouts, enables parallelism, and makes progress reporting trivial. **Usually the best answer** |

**Multi-tenant fairness** is the related trap: one tenant submitting 1M jobs starves every other tenant even with priorities correct, because they're all the same priority. Answers: per-tenant queues with round-robin/weighted-fair polling, per-tenant concurrency caps so no tenant can hold more than K workers, or per-tenant rate limits at submission. Naming *fairness* as distinct from *priority* is a strong senior signal — priority is about job importance, fairness is about tenant isolation, and neither solves the other.

→ [`notification-system §6 Priority, Rate Control`](../interviews/notification-system/deep-dive.md#6-priority-rate-control-and-user-preferences) · politeness-as-fairness in a crawler: [`web-crawler §2 The URL Frontier: Priority Meets Politeness`](../interviews/web-crawler/deep-dive.md#2-the-url-frontier-priority-meets-politeness) · [`§5 robots.txt and Politeness`](../interviews/web-crawler/deep-dive.md#5-robotstxt-and-politeness)

---

## 12. Job Dependencies and Fan-Out/Fan-In

Simple queues handle independent jobs. Once jobs depend on each other you need explicit structure.

**Fan-out / fan-in** (the map-reduce shape) is the common case:

```
"Send newsletter to 10M users"
   coordinator job → 10,000 batch jobs of 1,000 users each   (fan-out)
                   → each completes independently, in parallel
                   → a completion counter decrements/increments atomically
                   → last one triggers the summary job         (fan-in)
```

The fan-in is the tricky half: you need an atomic counter or a completion table (not "check if all siblings are done", which races), and a timeout so a permanently-failed child doesn't leave the parent waiting forever. Partial success needs a defined policy — is 9,999/10,000 a success with a report, or a failure?

**DAGs of heterogeneous steps** — extract → transform → validate → publish, where each step needs different resources and the pipeline must be resumable — are where a hand-rolled queue stops paying off and you [graduate to a workflow engine](./multi-step-processes.md#7-durable-execution-engines). The trigger to name: when you find yourself building dependency tracking, per-step retry policies, and a scheduler on top of your queue, you're re-implementing Temporal/Step Functions/Airflow badly.

→ [`notification-system §4 Fan-out and Bulk Targeting`](../interviews/notification-system/deep-dive.md#4-fan-out-and-bulk-targeting) · [`search-autocomplete §5 Batch vs Streaming`](../interviews/search-autocomplete/deep-dive.md#5-the-update-pipeline-batch-vs-streaming-kafka--flink)

---

## 13. Scheduled Jobs and the Cron Problem

Delayed and periodic work is the same pattern with a scheduler in front:

- **Delayed jobs**: a visible-after timestamp (SQS delay seconds, a Redis sorted set scored by run time, or `WHERE run_at <= now()` polling). Retry backoff is just a delayed re-enqueue.
- **Periodic jobs**: this is where the classic bug lives. **You deploy your cron on 5 API instances and the nightly billing job runs 5 times.** The fixes:

| Fix | Detail |
|---|---|
| **Leader election** | One instance holds a lease and runs the schedule; on its death another takes over. → [`consensus §12 Recipe: Leader Election, Locks, and Leases`](../interviews/consensus/deep-dive.md#12-recipe-leader-election-locks-and-leases) · [`zookeeper.md`](./zookeeper.md) |
| **A lock keyed by (job, time-bucket)** | `SET cron:billing:2026-08-05 NX EX 3600` — whoever wins runs it. Simple and adequate for most cases |
| **Idempotent by design** | Make the job safe to run 5 times (keyed by date bucket) so the question stops mattering. **Best when possible** |
| **External scheduler** | EventBridge/Cloud Scheduler/K8s CronJob enqueues one message; workers just consume. Removes the problem from your app entirely |

A lock alone is still subject to the pause-and-resume hazard from [contention §8](./dealing-with-contention.md#8-rung-5-distributed-locks-and-why-theyre-last) — which is why "make it idempotent per time bucket" is the answer that actually holds. Also: define the missed-run policy explicitly. If the scheduler was down at 02:00, does the job run late, or skip? Silence here becomes a real incident.

---

## 14. Cancellation and Progress Reporting

**You cannot pull a message back out of a queue mid-flight**, so cancellation is cooperative:

```
DELETE /jobs/{id}
   ├─ status == QUEUED   → mark CANCELLED; the worker checks on receipt and skips
   └─ status == RUNNING  → set cancel_requested = true
                           the worker polls this flag at checkpoints and aborts,
                           cleaning up partial output
```

Two consequences: a job with no checkpoints has no cancellation points either, so granularity of checkpointing determines responsiveness of cancellation; and a hard timeout is still needed for workers that never check the flag.

**Progress reporting** is where this pattern meets [Real-Time Updates](./realtime-updates.md): the worker writes `progress` at each checkpoint, and the client either polls the status endpoint (perfectly fine — poll intervals of 1–2 seconds for an active job, backing off over time) or gets pushed updates over SSE, which is the natural fit since it's server→client only and `EventSource` reconnects and replays for free. Polling a status endpoint is *not* a weak answer here; it's simple, stateless, and cheap, and I'd only escalate to SSE when jobs are long enough that polling wastes meaningful requests.

→ [`sse/sse-deep-dive-qa.md`](../interviews/sse/sse-deep-dive-qa.md) · [`api-design §3 State Transitions and Business Operations`](../interviews/api-design/deep-dive.md#3-state-transitions-and-business-operations)

---

## 15. Observability

The metrics that matter, and the ones that catch real incidents:

| Metric | Why | Alert on |
|---|---|---|
| **Backlog age** (oldest message) | What the user actually feels | ✅ Primary alert |
| Queue depth | Capacity signal | Only with throughput context |
| Consumer/worker count | Did the pool die? | Zero healthy workers |
| Processing duration (p50/p99) | Detects work getting slower | p99 regression |
| Retry rate | Rising = a dependency degrading | ✅ Sharp increase |
| **DLQ depth** | Real failures needing humans | ✅ `> 0` |
| Success/failure by job type | One type broken vs everything | Per-type error rate |
| In-flight/leased count | Stuck workers holding leases | Leases not progressing |

Two failure shapes that only these catch: a worker pool that dies entirely shows **zero errors** (nothing is being processed, so nothing is failing) while backlog age climbs — error-rate alerting is blind to it. And a slow leak of poison messages into an unmonitored DLQ looks perfectly healthy right up until someone asks where a month of reports went.

Trace context must propagate **through** the queue — put the trace ID in the message so the async work joins the originating request's trace, otherwise every trace ends at the enqueue and you can't debug the interesting half. → [`observability §6 Distributed Tracing`](../interviews/observability/deep-dive.md#6-distributed-tracing-spans-and-context-propagation) · [`§10 Alerting Philosophy`](../interviews/observability/deep-dive.md#10-alerting-philosophy-golden-signals-red-use)

---

## 16. Decision Framework

```
How long does the work take?
├─ < ~1s and the client needs the result ──► do it synchronously
└─ longer, or not needed for the response
   │
   ├─ ALWAYS: job row (state) + queue (transport, carries only the job ID)
   │          202 Accepted + status URL. Result → blob storage.
   │          Ack AFTER success. Idempotency key at submit.
   │
   ├─ Job duration vs visibility timeout?
   │     unpredictable/long ──► HEARTBEAT to extend the lease
   │     very long          ──► SPLIT into smaller units (best: also fixes
   │                            priority, progress, and parallelism)
   │
   ├─ Work has expensive stages or huge batches?
   │     ──────────────────► CHECKPOINT (commit checkpoint WITH the work)
   │
   ├─ Mixed durations in one queue?
   │     ──────────────────► SEPARATE QUEUES per class + own worker pools
   │        multi-tenant?  ──► + per-tenant concurrency caps (fairness ≠ priority)
   │
   ├─ Jobs depend on each other?
   │     fan-out/fan-in ───► atomic completion counter + timeout + partial-success policy
   │     heterogeneous DAG ► GRADUATE to a workflow engine (multi-step-processes.md)
   │
   ├─ Periodic work?
   │     ──────────────────► external scheduler, or lock per (job, time-bucket),
   │                          and make it idempotent per bucket anyway
   │
   └─ Always: max attempts → DLQ → ALARM ON DLQ > 0 + a replay path
              scale on BACKLOG AGE, never worker CPU
              propagate trace context through the message
```

---

## 17. Where This Shows Up in This Repo

| System | How the pattern appears | Go read |
|---|---|---|
| **Message queues** | The home topic: delivery semantics, consumer groups, DLQs, lag, anti-patterns | [`message-queues/deep-dive.md`](../interviews/message-queues/deep-dive.md) · [`answers.md`](../interviews/message-queues/answers.md) |
| **Video streaming** | Transcoding: the canonical expensive, stage-checkpointed, parallelizable job | [`§3 Transcoding`](../interviews/video-streaming/deep-dive.md#3-transcoding-architecture) · [`§2 Upload Pipeline`](../interviews/video-streaming/deep-dive.md#2-the-upload-pipeline) |
| **Notification system** | Worker pools, priority tiers, bulk fan-out to 50M users, provider rate limits, idempotent dispatch | [`§3 Pipeline`](../interviews/notification-system/deep-dive.md#3-the-core-pipeline-ingestion-to-dispatch) · [`§4 Fan-out`](../interviews/notification-system/deep-dive.md#4-fan-out-and-bulk-targeting) · [`§5 Delivery Guarantees`](../interviews/notification-system/deep-dive.md#5-delivery-guarantees-and-idempotency) · [`§6 Priority`](../interviews/notification-system/deep-dive.md#6-priority-rate-control-and-user-preferences) · [`§7 Failure Modes`](../interviews/notification-system/deep-dive.md#7-failure-modes-and-provider-reliability) |
| **Web crawler** | A giant distributed worker pool with fairness (politeness) as a first-class scheduling constraint | [`§2 URL Frontier`](../interviews/web-crawler/deep-dive.md#2-the-url-frontier-priority-meets-politeness) · [`§5 Politeness`](../interviews/web-crawler/deep-dive.md#5-robotstxt-and-politeness) · [`§11 Failure Modes`](../interviews/web-crawler/deep-dive.md#11-full-architecture-and-failure-modes) |
| **SSE** | Pushing job status/progress to the browser, including fire-and-forget semantics | [`sse-deep-dive-qa.md`](../interviews/sse/sse-deep-dive-qa.md) · [`Q7 fire-and-forget`](../interviews/sse/sse-deep-dive-qa.md#q7-what-does-fire-and-forget-mean-and-why-is-it-safe) |
| **File storage** | Post-upload processing: hashing, dedup, thumbnailing, virus scanning | [`§1 Chunked Upload`](../interviews/file-storage/deep-dive.md#1-chunked-upload--content-addressable-storage) · [`§7 Ops`](../interviews/file-storage/deep-dive.md#7-production-operations) |
| **Search autocomplete** | Batch vs streaming pipelines and hot-swapping the built artifact | [`§5 Update Pipeline`](../interviews/search-autocomplete/deep-dive.md#5-the-update-pipeline-batch-vs-streaming-kafka--flink) · [`§6 Hot-Swap Deploy`](../interviews/search-autocomplete/deep-dive.md#6-hot-swap-deploy-and-trie-versioning) |
| **Recommendation system** | Kafka-backed async pipelines feeding precomputed results | [`§3 Kafka`](../interviews/recommendation-system/deep-dive.md#3-kafka-the-backbone-you-cannot-skip) |
| **E-commerce / food delivery** | Fulfilment and dispatch as queued work with timing constraints | [`e-commerce §6 Inventory & Fulfillment`](../interviews/e-commerce/deep-dive.md#6-inventory--fulfillment-at-scale) · [`food-delivery §6 Dispatch`](../interviews/food-delivery/deep-dive.md#6-courier-dispatch--prep-aware-just-in-time-assignment) |
| **Observability** | Alerting philosophy and tracing across async boundaries | [`§6 Tracing`](../interviews/observability/deep-dive.md#6-distributed-tracing-spans-and-context-propagation) · [`§10 Alerting`](../interviews/observability/deep-dive.md#10-alerting-philosophy-golden-signals-red-use) · [`§11 On-Call`](../interviews/observability/deep-dive.md#11-dashboards-on-call-and-incident-response) |
| **Consensus** | Leader election for "exactly one instance runs the schedule" | [`§12 Recipe`](../interviews/consensus/deep-dive.md#12-recipe-leader-election-locks-and-leases) |

---

## 18. Real-World Cases

| Case | What's done | Lesson |
|---|---|---|
| **Video transcoding (YouTube-class)** | One upload fans out into per-rendition, per-segment jobs; publish progressively | Splitting a huge job is the answer to five problems at once: timeouts, priority, progress, parallelism, retry cost |
| **Newsletter / bulk email** | Coordinator fans out into batches; per-provider rate limits enforced in the worker tier | Fan-out plus downstream backpressure. 500 workers hitting a 100 rps API is self-harm |
| **CSV / data import products** | Chunked commits with a resume offset and a per-row error report | Partial success is a *product feature*, not just an implementation detail |
| **CI/CD runners** | Queue of builds, pools per resource class, cancellation on new pushes, per-org concurrency caps | Fairness across tenants and cooperative cancellation, both visible to users |
| **Image/thumbnail pipelines** | Triggered by a storage event, output keyed deterministically so reruns overwrite | Deterministic output keys make idempotency almost free |
| **Sidekiq/Celery in the wild** | The most common real-world implementation, and the most common source of "why did this run twice?" | At-least-once is the default reality in every one of these frameworks |
| **The unmonitored DLQ** | Messages accumulate for months; discovered when a customer asks where their data went | The most common production failure of this pattern is not technical — it's an unwatched dead-letter queue |

---

## 19. Interview Questions

**Q1. A report takes 45 seconds. What do you change?**
Make it async. The API validates and authorizes, writes a job row with status `QUEUED`, enqueues a message carrying the job ID, and returns `202 Accepted` with a status URL — not `200`, because the work isn't done and the contract shouldn't imply it is. A separate worker pool does the generation, writes the PDF to blob storage, and updates the job row; the client polls the status endpoint or receives SSE updates. That fixes gateway timeouts, stops one report from occupying an API worker for 45 seconds, lets me scale CPU-heavy generation independently from HTTP serving, and gives me retries for free. The costs I'd acknowledge: eventual consistency, a status mechanism to build, and duplicate execution becoming possible.

**Q2. Why do you need both a queue and a database table?**
Because they do different jobs. The queue is transport — it delivers a message to a free worker — and it can't answer "what's the status of job 42?" or "list this user's jobs", since it isn't indexed or queryable by ID and messages disappear on ack. The job table is the queryable state and the history. I'd also put only the job ID in the message rather than the full payload: it keeps messages under broker size limits, avoids acting on a stale snapshot if the job was updated, and means a redelivered message re-reads current state. The gap to watch is that committing the row and enqueueing aren't atomic, so I need an outbox or a sweeper that re-enqueues rows stuck in `QUEUED`.

**Q3 (depth). Visibility timeout is 30 seconds; the job takes 5 minutes. What happens?**
The queue assumes the worker died and redelivers at 30 seconds, so a second worker starts the same job, then a third at 60 seconds, and so on — N workers doing identical expensive work, with whichever finishes last overwriting the others. The primary fix is heartbeating: the worker periodically extends the lease while it's still working, so the timeout tracks liveness instead of guessing duration. Alternatively set the timeout above p99 duration, which only works if durations are bounded and predictable. And the best structural fix is to split the job into units that comfortably fit inside a timeout. But I'd add that the lease is not the real protection — a worker can be paused past its lease and resume believing it still owns the job — so idempotent work plus a conditional claim on the job row is what actually makes concurrent delivery harmless.

**Q4 (depth). One message fails every time. Walk me through what happens without and with protection.**
Without a cap, it's a poison message: it's redelivered forever, and each redelivery burns a worker, so a single malformed payload can consume a meaningful fraction of the pool in a loop. With protection, I count attempts and after a max — say five — move it to a dead-letter queue. But the DLQ is only half an answer: it needs an alarm on depth greater than zero, because a dead-letter queue nobody watches is a data-loss mechanism with extra steps and it's the single most common gap I see; it needs enough context to diagnose, meaning the original message, error, attempt count, and trace ID; and it needs a documented replay path so that after fixing the bug I can re-drive it. I'd also distinguish retryable from fatal in the worker — a validation error should fail immediately rather than being retried five times — and cap attempts in the job row too, not just in the queue, since visibility-timeout redeliveries don't always increment the receive count as expected.

**Q5 (depth). At-least-once delivery means duplicates. How do you make the work safe?**
Layered. First, dedupe at submission with an idempotency key under a unique constraint, so a retried POST returns the existing job instead of creating a second — the cheapest defence, because the duplicate never enters the system. Second, the worker's first action is to load the job and skip if it's already terminal, which catches most redeliveries free. Third, and most durably, make the work itself idempotent: write output to a deterministic key like `reports/{job_id}.pdf` so a rerun overwrites rather than duplicating, use upserts, and use conditional updates. Fourth, a claim on the job row — `UPDATE … WHERE status='QUEUED' OR lease_until < now()` — so two workers can't both proceed. And if the job writes to an external system where a double-write is unacceptable, none of that fully protects against a paused-then-resumed worker, so I'd carry a monotonic fence token the target checks. The framing is that exactly-once delivery doesn't exist; exactly-once effect does, via at-least-once plus idempotency.

**Q6 (senior). A 1M-row CSV import fails at row 900,000. What does the retry do?**
With checkpointing, it resumes at 900,000 and preserves 90% of the work. I'd commit in chunks — say 1,000 rows — and write the checkpoint **in the same transaction** as the chunk it describes, because if they're separate transactions I either redo or skip a chunk at the boundary. Each chunk also needs to be idempotent so reapplying the partially-completed chunk at the crash point is safe. Beyond mechanics, partial success is a product decision: I'd collect per-row errors and report them rather than failing the whole import for 12 bad rows, because that's what users actually need. And this checkpoint granularity does double duty — it's also where cancellation checks happen, so a job with no checkpoints has no cancellation points either.

**Q7 (senior). Video transcoding jobs take 4 hours. Thumbnail jobs take 2 seconds. They share a queue. What's wrong?**
Head-of-line blocking: the ten workers all pick up 4-hour transcodes and a 2-second thumbnail waits four hours. The immediate fix is separate queues by work class with their own worker pools, which also lets me tune visibility timeouts per class instead of picking one value that's wrong for both. Priority queues are an alternative but introduce starvation, so I'd reserve capacity for lower priority rather than strict ordering. The better structural fix is to split the long job: a 4-hour transcode becomes per-rendition, per-segment jobs, which simultaneously fixes visibility timeouts, enables parallelism, makes progress reporting natural, and shrinks retry cost. I'd also separate *fairness* from *priority* — if one tenant submits a million jobs they starve everyone else even with priorities set correctly, so I need per-tenant concurrency caps or round-robin polling across per-tenant queues, which priority alone doesn't solve.

**Q8 (senior). How do you autoscale the worker pool?**
On backlog age, or queue depth divided by throughput — not on worker CPU. Depth alone is meaningless without throughput: 10,000 messages at 5,000/sec is two seconds of work, while 500 messages at 0.1/sec is over an hour. And CPU is actively misleading, because workers blocked on I/O look idle while the backlog explodes, so the autoscaler does nothing precisely when it should act. Backlog age is also the thing the user experiences, which makes it the right alerting signal too. When I'm at max workers and the backlog still grows, that's real overload with only three honest responses: reject new submissions with `429` and `Retry-After`, shed by priority, or degrade the work. What I must not do is let an unbounded backlog run into the retention limit, because then messages silently disappear while the system reports itself healthy. I'd also cap concurrency toward downstream dependencies, since 500 workers against a 100 rps third-party API just manufactures failures and retry storms.

**Q9 (senior). Your nightly billing job is deployed on 5 API instances. What happens, and how do you fix it?**
It runs five times, which for billing means five charges. The clean fix is to take the scheduling out of the application: an external scheduler like EventBridge, Cloud Scheduler, or a Kubernetes CronJob enqueues exactly one message and the workers just consume it. If the schedule must live in the app, a lock keyed by job and time bucket — `SET cron:billing:2026-08-05 NX EX 3600` — means whoever wins runs it, or proper leader election if I already have a coordination service. But the answer I'd lean on is making the job idempotent per time bucket, keyed by the date, so running it five times has the same effect as running it once — because a TTL-based lock is still vulnerable to a paused holder resuming and running the job anyway, and idempotency is the only thing that survives that. I'd also define the missed-run policy explicitly: if the scheduler was down at 02:00, does the job run late or skip? Leaving that undefined is how you get a surprise incident.

**Q10 (staff). A user clicks cancel on a running job. What actually happens?**
Nothing immediate, because you can't retract a message that's already been delivered — cancellation has to be cooperative. If the job is still `QUEUED` I mark it cancelled and the worker checks status on receipt and skips it. If it's `RUNNING` I set a `cancel_requested` flag, and the worker polls that flag at its checkpoints, aborts, and cleans up partial output. That means checkpoint granularity determines cancellation responsiveness — a job that checkpoints every 30 seconds can't be cancelled faster than that, and a job with no checkpoints can't be cancelled at all short of killing the worker. I'd also keep a hard timeout for workers that never check the flag, make cleanup idempotent since a cancel can race with completion, and define what the user sees when cancellation loses the race and the job finishes anyway. And partial output needs a policy: delete it, or expose it as partial results.

**Q11 (staff). The worker pool dies completely at 2am. Which alert fires?**
If I've only got error-rate alerting, none — and that's the point of the question. Zero workers processing means zero failures, so error rate is flat and clean while the backlog grows unboundedly. The alerts that catch it are backlog age crossing a threshold, healthy-worker count hitting zero, and throughput dropping to zero when the queue is non-empty. That's why I treat backlog age as the primary SLI rather than depth or error rate: it's the only one that maps directly to user impact and it's non-zero in every failure mode, whether workers are dead, slow, starved, or looping on a poison message. The related blind spot is a slow trickle of messages into an unmonitored DLQ, which looks perfectly healthy until someone asks where a month of reports went — hence alerting on DLQ depth greater than zero, not on a threshold. I'd also make sure trace context propagates through the message so the async half of the work joins the originating request's trace; otherwise every trace ends at the enqueue and debugging the interesting part is guesswork.

**Q12 (staff). When does a queue plus workers stop being enough?**
When I notice I'm building a workflow engine on top of it. Concretely: when jobs have dependencies and I'm hand-rolling a DAG scheduler and completion tracking; when I need per-step retry policies and per-step timeouts rather than one policy per queue; when processes span days and involve human approvals or waits on external webhooks, so I'm implementing durable timers and correlation; or when I need to reliably compensate earlier steps after a later failure, which is saga logic rather than job logic. At that point Temporal, Step Functions, or Airflow — depending on whether it's per-request workflows or scheduled data pipelines — gives me durable state, replay, and versioning that I'd otherwise reimplement badly. The counter-caution is that this is a real operational commitment, so I wouldn't reach for it for a three-step flow inside one service where a state column plus a retry worker plus a sweeper is genuinely less machinery. The dividing line is dependency structure and lifetime, not job count.

---

## Quick Recall Cheat Sheet

| Term | One-line answer |
|---|---|
| **The move** | Accept → enqueue → `202 Accepted` + status URL → worker does it → client polls or is pushed |
| **Threshold** | >1s of non-response work is a candidate; >10s must be async |
| **`202` not `200`** | The contract must not imply the work is done |
| **Queue vs job table** | Queue = transport (not queryable). Table = state + history. You need **both** |
| **Message carries** | The **job ID** only — small, and forces a re-read of current state on redelivery |
| **Enqueue dual-write** | Row committed but enqueue failed → stuck `QUEUED`. Outbox or a re-enqueue sweeper |
| **Result location** | Blob storage + presigned URL, never the job row or response body |
| **Ack timing** | **After** success. Acking on receipt turns at-least-once into at-most-once |
| **Visibility timeout** | Queue hides a message; no ack in time ⇒ redelivery. Job longer than timeout ⇒ duplicate work |
| **Fix for long jobs** | **Heartbeat to extend the lease**; or split the job into smaller units (better) |
| **Retryable vs fatal** | Backoff+jitter for transient; fail immediately for malformed. Don't retry the impossible |
| **Poison message** | Always fails, redelivered forever, burns a worker each time |
| **Max attempts → DLQ** | And **alarm on DLQ depth > 0** + a documented replay path |
| **The classic gap** | An unmonitored DLQ = silent data loss. Most common real-world failure of this pattern |
| **Duplicate defences** | Idempotency key at submit → terminal-state check → idempotent work → row claim → fence token |
| **Deterministic output key** | `reports/{job_id}.pdf` makes reruns overwrite instead of duplicate. Nearly-free idempotency |
| **Row claim** | `UPDATE … WHERE status='QUEUED' OR lease_until < now()` — 0 rows means someone else has it |
| **Exactly-once** | Delivery: no. Effect: yes, via at-least-once + idempotency |
| **Checkpointing** | Commit the checkpoint **in the same transaction** as the work it describes |
| **Checkpoint per stage** | Failure in the 4K rendition shouldn't rerun 480p. Key outputs by `(job, stage)` |
| **Scale on** | **Backlog age** (or consumer lag). Never worker CPU — I/O-blocked workers look idle |
| **Depth alone is useless** | 10k msgs at 5k/sec = 2s; 500 msgs at 0.1/sec = 83 min |
| **Overload options** | Reject (`429` + `Retry-After`), shed by priority, or degrade. Never an unbounded backlog |
| **Downstream backpressure** | 500 workers vs a 100 rps API = manufactured failures. Cap concurrency in the pool |
| **Head-of-line blocking** | Long jobs starve short ones. Separate queues per class + own pools + own timeouts |
| **Priority ≠ fairness** | Priority = job importance. Fairness = tenant isolation. Need per-tenant caps for the latter |
| **Split big jobs** | Fixes timeouts, priority, progress, parallelism, and retry cost simultaneously |
| **Fan-out/fan-in** | Atomic completion counter (not "check siblings"), a timeout, and a partial-success policy |
| **Cron on N instances** | Runs N times. External scheduler, or lock per (job, time-bucket) — and idempotent per bucket anyway |
| **Missed-run policy** | Decide explicitly: run late, or skip? |
| **Cancellation** | Cooperative — you can't retract a delivered message. Flag + checks at checkpoints + hard timeout |
| **Progress** | Poll the status endpoint (fine!) or SSE. Polling isn't the weak answer here |
| **Kafka ≠ task queue** | Great for ordered replayable streams; awkward for per-message retry/DLQ/priority |
| **Silent failure shape** | Dead worker pool ⇒ **zero errors** while backlog grows. Error-rate alerting is blind to it |
| **Tracing** | Put the trace ID in the message, or every trace ends at the enqueue |
| **Graduate to a workflow engine when** | Dependencies, per-step policies, multi-day lifetimes, human approvals, or compensation logic |

---

## Related

- **Patterns:** [Multi-Step Processes](./multi-step-processes.md) (when one job becomes a dependent flow) · [Handling Large Blobs](./large-blobs.md) (the input and output of most long jobs) · [Real-Time Updates](./realtime-updates.md) (pushing progress) · [Scaling Writes](./scaling-writes.md) (the queue as shock absorber) · [ZooKeeper](./zookeeper.md) (leader election for schedulers)
- **Fundamentals:** [circuit-breaker](../fundamentals/circuit-breaker.md) · [lease](../fundamentals/lease.md) · [fencing](../fundamentals/fencing.md) · [high-water-mark](../fundamentals/high-water-mark.md) · [segmented-log](../fundamentals/segmented-log.md)
- **Topics:** [`message-queues`](../interviews/message-queues/README.md) · [`notification-system`](../interviews/notification-system/README.md) · [`video-streaming`](../interviews/video-streaming/README.md) · [`web-crawler`](../interviews/web-crawler/README.md) · [`observability`](../interviews/observability/README.md)
