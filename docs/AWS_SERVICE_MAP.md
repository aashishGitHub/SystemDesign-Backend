# AWS Service Map — Naming Cloud Services Without Losing the Primitive

> **Purpose:** for every building block in a system design, know (a) the **primitive** you're actually reaching for, (b) the **AWS managed service** that implements it, (c) the **native / open-source** equivalent, and (d) **when AWS is the wrong answer**.
> **Companions:** [`RADIO_FRAMEWORK.md`](./RADIO_FRAMEWORK.md) (how to perform in the room) · [`instructions.md`](./instructions.md) (how to author a topic folder) · [`../key-technologies-notes.md`](../key-technologies-notes.md) (the provider-neutral concept notes) · [`../patterns/README.md`](../patterns/README.md) (the reusable moves).

---

## 0. The one rule that matters most

**Say the primitive first, the service second, and the swap third.** A service name on its own is not an answer — it's a noun. The interviewer is scoring whether you know *what property you need*, and the AWS name is evidence you've shipped it.

```
❌ "I'd use SQS."
✅ "I need an at-least-once work queue with a visibility timeout and a dead-letter
    queue, so the transcode job survives a worker crash. On AWS that's SQS;
    self-hosted it's RabbitMQ, or Kafka if I also need replay."
    └ primitive ──────────────────┘  └ why ──┘  └ AWS ┘  └ swap ┘
```

Three reasons this ordering wins:

1. **It's provider-portable.** Google and Meta interviewers do not want an AWS catalog; they want the property. Lead with the primitive and the same sentence works in every room.
2. **It survives the follow-up.** "Why not Kinesis?" is answerable only if you named the property (at-least-once + per-message retry, not ordered replay).
3. **It reads as experience, not study.** Naming *the gotcha* alongside the service ("SQS FIFO caps throughput per message-group, so I'd group by `order_id`, not by tenant") is the single highest-signal move in this whole document.

> ⚠️ **Honesty rule for every number below.** AWS quotas, limits, and even service names change, and several are adjustable per-account. Every figure here is an **order-of-magnitude planning number to verify against current AWS docs**, not a hard fact to assert in an interview. Where I'm unsure whether something is still current, it's marked **`⚠️ verify`**. Say "approximately, and I'd check the current quota" — an owned estimate beats a confidently wrong limit.

---

## 1. The One-Screen Map

Read the **Primitive** column out loud; use the **AWS** column as the name-drop; keep the **When AWS is wrong** column for the follow-up.

### 1.1 Edge & network

| Building block | Primitive (say this first) | AWS managed | Native / OSS | When AWS is wrong |
|---|---|---|---|---|
| Static + media delivery | Edge cache close to the user; TTL by object type | **CloudFront** | Nginx/Varnish + Fastly/Akamai | Need programmable edge logic beyond CloudFront Functions/Lambda@Edge → Fastly VCL / Cloudflare Workers |
| DNS + traffic steering | Weighted / latency / geo / failover routing | **Route 53** | CoreDNS, PowerDNS + GSLB | Multi-CDN steering with real-user metrics → dedicated traffic manager |
| L7 load balancing | Path/host routing, TLS termination, health checks | **ALB** | Nginx, Envoy, HAProxy | Need per-request mTLS mesh policy → Envoy/Istio |
| L4 load balancing | Flow-level, preserves source IP, ultra-low latency | **NLB** | HAProxy (TCP mode), IPVS | — (NLB is usually the right call for WS/TCP at scale) |
| Anycast entry point | Single global IP, AWS backbone from first hop | **Global Accelerator** | BGP anycast (you run the ASN) | Only worth it for global TCP/UDP, not typical HTTP (CloudFront already terminates at edge) |
| API front door | Auth, throttling, request validation, routing | **API Gateway** (REST/HTTP/WebSocket) or **AppSync** (GraphQL) | Kong, Envoy Gateway, Apollo Router | Very high QPS + tight p99 → ALB straight to service; API Gateway adds hops and per-request cost |
| DDoS / L7 filtering | Rate limits, managed rulesets, bot control | **Shield + WAF** | Cloudflare, ModSecurity | — |

### 1.2 Compute

| Building block | Primitive | AWS managed | Native / OSS | When AWS is wrong |
|---|---|---|---|---|
| Long-lived stateful servers | Pinned connections, local state, warm caches | **EC2** (+ Auto Scaling) | bare metal / any VM | — |
| Containers | Scheduling, rollout, service discovery | **ECS** (simpler) / **EKS** (portable) / **Fargate** (no nodes) | Kubernetes, Nomad | Team already fluent in K8s → EKS; avoid ECS lock-in for portable platforms |
| Event-driven functions | Scale-to-zero, per-event billing, no server | **Lambda** | Knative, OpenFaaS | **Sustained** high throughput (cost crossover vs a container), needs >15 min **`⚠️ verify`** runtime, needs a persistent socket, or p99 can't absorb a cold start |
| Batch / fleet jobs | Queue of jobs → pool of workers | **AWS Batch** | Slurm, K8s Jobs | — |
| Big-data processing | Distributed compute over object storage | **EMR** (Spark/Hadoop) / **Glue** (serverless ETL) | Spark, Trino on K8s | — |
| Stream processing | Windowed, stateful compute over an unbounded stream | **Managed Service for Apache Flink** | Flink, Kafka Streams, Spark Structured Streaming | — |

### 1.3 Sync request paths

| Building block | Primitive | AWS managed | Native / OSS | When AWS is wrong |
|---|---|---|---|---|
| Service-to-service RPC | Typed contract, binary framing, streaming | run **gRPC** yourself on ALB/NLB | gRPC, Thrift | AWS has no managed gRPC broker — this is a "run it yourself" box |
| Service discovery | Register → resolve healthy instances | **Cloud Map** (or ECS/EKS built-in) | Consul, etcd, K8s DNS | — |
| Service mesh | mTLS, retries, per-route policy out of app code | **App Mesh** **`⚠️ verify`** current positioning | Istio, Linkerd, Consul Connect | Mesh is a big operational tax — justify it or skip it |
| Push to browser | Server→client stream over one connection | **API Gateway WebSocket API** / **AppSync Subscriptions** / **IVS** for media | raw WS on NLB, SSE on ALB, Centrifugo | Millions of long-lived sockets → self-managed WS on NLB is usually cheaper than per-message API Gateway pricing |

### 1.4 Async backbone — the four choices people conflate

This table is worth memorizing verbatim; picking wrongly here is the most common AWS mistake in interviews.

| Service | It really is | Ordering | Retry/failure unit | Replay | Reach for it when |
|---|---|---|---|---|---|
| **SQS Standard** | at-least-once work queue | none | **per message** (visibility timeout → DLQ) | no (consumed = gone; ≤14 days retention **`⚠️ verify`**) | independent jobs, one poison message must not block others |
| **SQS FIFO** | ordered work queue per group | per **message-group-id** | per message | no | strict per-entity ordering *and* dedupe; accept the per-group throughput ceiling **`⚠️ verify`** |
| **SNS** | pub/sub fan-out | none | per subscription | no | one event → N independent consumers; classic **SNS → many SQS** fan-out |
| **EventBridge** | event **bus** with content routing | none | per target | yes, via **archive + replay** | routing on event *content*, schema registry, cross-account, SaaS events, scheduled rules |
| **Kinesis Data Streams** | partitioned, replayable log | per **partition key** | per **shard** (head-of-line blocking is real) | yes (retention up to 365 days **`⚠️ verify`**) | high-volume telemetry, multiple independent readers, ordered per-entity replay |
| **MSK** (managed Kafka) | the same, but Kafka | per partition | per partition | yes | you need Kafka semantics/ecosystem (Connect, Streams, compaction) or portability off AWS |
| **Kinesis Data Firehose** | managed delivery to a sink | n/a | batch | n/a | "just land this in S3/OpenSearch/Redshift" with no consumer code |

**The decision sentence:** *"Do I need per-message retry, or per-entity ordering and replay?"* Per-message retry → SQS. Ordering + replay → Kinesis/MSK. Fan-out → SNS or EventBridge. Content-based routing → EventBridge.

### 1.5 Storage

| Building block | Primitive | AWS managed | Native / OSS | When AWS is wrong |
|---|---|---|---|---|
| Object / blob store | Immutable-ish bytes, HTTP range reads, cheap tiers | **S3** | MinIO, Ceph | — (S3 is the reference implementation; even the OSS options copy its API) |
| Direct client upload | **Bytes never through your API** — presigned URL + multipart | **S3 presigned URL + Multipart Upload** | MinIO presigned | — |
| Upload → pipeline trigger | Event from the authoritative system, don't poll | **S3 Event Notifications** → SNS/SQS/Lambda/EventBridge | bucket notification hooks | — |
| Cold archive | Retrieval latency traded for $/GB | **S3 Glacier Instant / Flexible / Deep Archive** | tape, Ceph cold pools | Need ms reads on old data → Glacier Instant, not Flexible/Deep |
| Block storage | Attached disk, low latency, snapshot | **EBS** (gp3/io2) | LVM on local NVMe | Highest IOPS/lowest latency → instance-store NVMe, accepting ephemerality |
| Shared filesystem | POSIX semantics across nodes | **EFS** / **FSx** | NFS, Lustre, CephFS | — |

### 1.6 Databases

| Building block | Primitive | AWS managed | Native / OSS | When AWS is wrong |
|---|---|---|---|---|
| Transactional relational | ACID, joins, unique constraints (your idempotency key!) | **Aurora** (MySQL/Postgres-compatible) / **RDS** | Postgres, MySQL | Extreme write scale on one table → shard it yourself or move to a KV |
| Distributed KV | Partition key routing, predictable p99, elastic | **DynamoDB** | Cassandra, ScyllaDB, Couchbase | Rich queries, ad-hoc joins, or you need secondary-index consistency → relational |
| KV read accelerator | Cache in front of the KV, same API | **DAX** (DynamoDB only) | Redis in front of Cassandra | — |
| Cache / ephemeral state | In-memory structures, TTL, atomic ops | **ElastiCache (Redis / Valkey / Memcached)** | Redis, Valkey, Memcached | — |
| Durable Redis | Redis API but replicated log, not best-effort | **MemoryDB** | Redis + AOF (weaker) | Only when you need Redis semantics *as a database of record* |
| Multi-region active-active KV | Write anywhere, converge later | **DynamoDB Global Tables** (last-writer-wins) | Cassandra multi-DC, Couchbase XDCR | You cannot tolerate LWW conflict loss → app-level CRDTs or single-writer-per-region partitioning |
| Distributed SQL | Horizontal scale + SQL + strong consistency | **Aurora DSQL** **`⚠️ verify`** (newer; check GA + limits) | CockroachDB, YugabyteDB, Spanner (GCP) | — |
| Time series | Time-partitioned, downsampled, retention tiers | **Timestream** | InfluxDB, Prometheus, TimescaleDB | — |
| Graph | Traversals, adjacency | **Neptune** | Neo4j, JanusGraph | — |
| Wide-column (Cassandra API) | Cassandra semantics, managed | **Keyspaces** | Cassandra, ScyllaDB | — |
| Document | JSON documents, flexible schema | **DocumentDB** (Mongo-compatible **`⚠️ verify`** coverage) | MongoDB, Couchbase | Need full modern Mongo feature set → self-managed/Atlas |
| Ledger / append-only audit | Immutable, verifiable history | **QLDB** **`⚠️ verify`** — I believe AWS has announced end-of-support; do not lead with it. Use Aurora/Postgres with an append-only double-entry schema | Postgres append-only + hash chain | — |
| Data warehouse (OLAP) | Columnar, MPP, analytical scans | **Redshift** | ClickHouse, Trino, DuckDB | Ad-hoc over S3 without a cluster → Athena |
| Query-over-S3 | Serverless SQL on object storage | **Athena** | Trino, DuckDB, Spark SQL | — |
| Search / inverted index | Tokenized full-text + faceting + geo + k-NN vectors | **OpenSearch Service** | Elasticsearch, OpenSearch, Solr, Typesense | Autocomplete-only → a trie in Redis/ElastiCache is far cheaper than a cluster |

### 1.7 Coordination, config & security

| Building block | Primitive | AWS managed | Native / OSS | When AWS is wrong |
|---|---|---|---|---|
| Distributed lock | Compare-and-set on a shared store + **fencing token** | **DynamoDB conditional write** (`ConditionExpression`) | ZooKeeper, etcd, Consul, Redis Redlock (caveats) | Need ephemeral-node liveness / watch semantics → ZooKeeper/etcd. AWS has no general managed ZK. See [`../patterns/zookeeper.md`](../patterns/zookeeper.md) |
| Leader election | Lease with a TTL + fencing | DynamoDB lease row, or ECS/EKS-native election | ZooKeeper, etcd, K8s Lease | — |
| Config / feature flags | Versioned, gradual rollout, fast read | **AppConfig** / **SSM Parameter Store** | Consul KV, etcd, LaunchDarkly | — |
| Secrets | Rotation, audit, encryption at rest | **Secrets Manager** | Vault | — |
| Key management | KMS-backed envelope encryption | **KMS** (+ **CloudHSM**) | Vault Transit, HSM | — |
| End-user identity | OIDC/SAML, tokens, MFA | **Cognito** | Keycloak, Auth0 | Complex enterprise IdP federation → dedicated IdP |
| Service identity / authz | Short-lived creds, least privilege | **IAM + STS** | SPIFFE/SPIRE | — |

### 1.8 Orchestration & scheduling

| Building block | Primitive | AWS managed | Native / OSS | When AWS is wrong |
|---|---|---|---|---|
| Multi-step workflow / saga | Durable state machine, retries, compensation | **Step Functions** (Standard for durability, Express for high-volume short flows) | Temporal, Cadence, Camunda, Airflow | Need code-first durable execution with long-lived entities → Temporal |
| Cron / recurring jobs | A scheduler that survives restarts | **EventBridge Scheduler** (or EventBridge scheduled rules) | Kubernetes CronJob, Quartz, Airflow | — |
| Per-entity timers at scale | "Do X for entity E at time T", millions of live timers | **EventBridge Scheduler** one-time schedules; or a **timer table + sweeper** (partition by due-minute) | Temporal timers, Redis sorted-set + sweeper | ⚠️ **`SQS DelaySeconds` caps at 15 min** **`⚠️ verify`**, and **DynamoDB TTL is not a scheduler** — deletion is best-effort within ~48 h **`⚠️ verify`**. Never claim TTL gives you a precise timer |
| DAG / data pipelines | Dependency graph, backfills | **MWAA** (managed Airflow) / Step Functions | Airflow, Dagster, Prefect | — |
| CDC (DB → stream) | Read the log, don't dual-write | **DynamoDB Streams**, **DMS**, **MSK Connect + Debezium** | Debezium | — |

### 1.9 Observability & resilience

| Building block | Primitive | AWS managed | Native / OSS | When AWS is wrong |
|---|---|---|---|---|
| Metrics + alarms | Cheap aggregates, bounded cardinality | **CloudWatch Metrics / Alarms** | Prometheus + Grafana | High-cardinality exploration → Prometheus/Mimir; CloudWatch custom-metric cost climbs fast |
| Logs | One event, fully | **CloudWatch Logs** (+ Logs Insights) | ELK, Loki | Heavy log analytics → OpenSearch/Loki |
| Traces | Where did the time go across services | **X-Ray** / **ADOT** (OpenTelemetry) | Jaeger, Tempo | Vendor-neutral instrumentation → emit OTel, choose the backend later |
| Audit trail | Who called what, immutably | **CloudTrail** | — | — |
| Chaos / failure injection | Break it on purpose, in business hours | **Fault Injection Service** | Chaos Mesh, Litmus, Gremlin | See [`../fundamentals/chaos-monkey.md`](../fundamentals/chaos-monkey.md) |
| Circuit breaking / retries | Fail fast, don't amplify | **in your code or the mesh** (SDK adaptive retry helps) | Resilience4j, Envoy outlier detection | AWS gives you *no* managed circuit breaker — this is your box. See [`../fundamentals/circuit-breaker.md`](../fundamentals/circuit-breaker.md) |
| Multi-region failover | Health-checked routing + a promotion plan | **Route 53 health checks + failover**, **Application Recovery Controller** | GSLB | — |

### 1.10 ML & media

| Building block | Primitive | AWS managed | Native / OSS | When AWS is wrong |
|---|---|---|---|---|
| Recommendations | Candidate generation → ranking | **Personalize**, or **SageMaker** for custom | your own two-stage pipeline | Custom features/ranking → SageMaker or self-hosted; Personalize is a black box |
| Vector / ANN search | Approximate nearest neighbour over embeddings | **OpenSearch k-NN** / **Aurora pgvector** / **S3 Vectors** **`⚠️ verify`** | FAISS, Milvus, Qdrant, pgvector | — |
| Model hosting | Endpoint, autoscaling, A/B | **SageMaker Endpoints** / **Bedrock** for foundation models | KServe, Triton, vLLM | — |
| Feature store | Online (low-latency) + offline (training) views | **SageMaker Feature Store** | Feast | — |
| VOD transcoding | Ladder of renditions, segmented output | **Elemental MediaConvert** | FFmpeg fleet | Cost at huge scale → own FFmpeg fleet on Spot |
| Live streaming | Ingest → package → deliver | **MediaLive + MediaPackage**, or **IVS** (batteries-included) | FFmpeg + nginx-rtmp + Shaka packager | — |
| Content moderation | Frame/text classification | **Rekognition** / **Comprehend** | own models | — |

---

## 2. Patterns → AWS Realization

Each row is a [`patterns/`](../patterns/README.md) file. This is the table to reach for when the interviewer says "how would you actually build that on AWS?" — the pattern gives you the ladder, this gives you the nouns.

| Pattern | AWS realization (the default answer) | The AWS-specific trap to name |
|---|---|---|
| [Real-Time Updates](../patterns/realtime-updates.md) | **Hop 1:** API Gateway WebSocket API / AppSync subscriptions, or self-managed WS on NLB. **Hop 2** (get the event to the server holding the socket): fan out via SNS/EventBridge to all servers, or keep a connection registry in DynamoDB/ElastiCache and route | Hop 2 is the whole problem, and API Gateway WebSocket hides it — that's *why* it's per-message priced. At millions of sockets, self-managed WS on NLB + a Redis/DynamoDB connection registry is usually cheaper |
| [Dealing with Contention](../patterns/dealing-with-contention.md) | Rung 1: **DynamoDB conditional write** or `UPDATE … WHERE qty > 0` in Aurora. Rung 2: version column (OCC). Rung 3: `SELECT … FOR UPDATE`. Rung 4: DynamoDB lease row + **fencing token** | There is no managed lock service. Redlock on ElastiCache is not safe against a paused holder — the *resource* must check the fencing token |
| [Multi-Step Processes](../patterns/multi-step-processes.md) | **Step Functions** for orchestration; **outbox** = write row + event in one Aurora txn then relay, or use **DynamoDB Streams** as the outbox for free | DynamoDB Streams *is* the outbox (log-based, no dual write) — the strongest AWS-native answer here, worth saying explicitly |
| [Scaling Reads](../patterns/scaling-reads.md) | Index → bigger instance → **ElastiCache/DAX** → **CloudFront** → **Aurora read replicas** → precompute into DynamoDB | Aurora replica lag breaks read-your-own-writes: route the writer's own reads to the primary, or use a session token. Replicas are usually low-lag but **not zero** **`⚠️ verify`** |
| [Scaling Writes](../patterns/scaling-writes.md) | Batch/aggregate in **Kinesis + Flink** → spread across **DynamoDB** partitions → absorb bursts in **SQS/Kinesis** | Same partition key ⇒ sharding won't help. DynamoDB single-partition ceilings (~1,000 WCU / ~3,000 RCU **`⚠️ verify`**) mean a hot key needs a **write-sharded suffix**, and Kinesis is per-shard capped too |
| [Handling Large Blobs](../patterns/large-blobs.md) | **S3 presigned URL + Multipart Upload**; **S3 Event Notification** → SQS/Lambda for post-processing; CloudFront + signed URLs for delivery | The state-sync bug: your DB says `UPLOADED` but S3 has nothing (or vice versa). Fix = trust the **S3 event**, not the client's "I'm done" call, plus a sweeper for orphans |
| [Managing Long-Running Tasks](../patterns/long-running-tasks.md) | `202 Accepted` + job row → **SQS** → ECS/Fargate or Lambda workers → status via polling or WS | Visibility timeout must exceed p99 job duration or the job runs twice; set `maxReceiveCount` → **DLQ**; Lambda's runtime ceiling **`⚠️ verify`** rules it out for long transcodes |
| [ZooKeeper & coordination](../patterns/zookeeper.md) | **No managed ZooKeeper for app use.** Substitute DynamoDB conditional writes + lease/TTL rows, or run etcd/ZK yourself on EKS | Saying "I'd use ZooKeeper on AWS" invites "which service?" — the honest answer is "self-managed, or I redesign to a DynamoDB lease, because a managed ZK isn't on offer" |

**Gap patterns** (identified, not yet written up — see [`patterns/README.md`](../patterns/README.md#gaps--recurring-sub-problems-not-yet-written-up)):

| Gap pattern | AWS realization | Trap |
|---|---|---|
| Proximity / geospatial search | Geohash or H3 cell as the **DynamoDB partition key** (query the cell + 8 neighbours); or **OpenSearch geo_distance**; or Redis `GEOSEARCH` on ElastiCache; **Location Service** for maps/routing | Cell size *is* the design decision: too big → scan thousands of candidates; too small → many neighbour queries. Also `GEORADIUS` is legacy vs `GEOSEARCH` **`⚠️ verify`** |
| Counting & top-K at scale | **Kinesis → Managed Flink** windowed aggregation → DynamoDB/Redis; Redis **sorted sets** for leaderboards; Athena/Redshift for the batch truth | DynamoDB atomic counters on one hot item is the classic wrong answer. Ask what error is acceptable — approximate (Count-Min/HLL) is far cheaper than exact |
| Scheduled & delayed execution | **EventBridge Scheduler** for one-time and recurring; or timer table partitioned by due-minute + sweeper | `SQS DelaySeconds` ≤15 min **`⚠️ verify`** and **DynamoDB TTL is not a scheduler** (best-effort, ~48 h window **`⚠️ verify`**) |
| Search & ranked retrieval | **OpenSearch** for the index; DynamoDB/Aurora stays the source of truth; CDC keeps the index fresh | The index is a *derived* store — never the source of truth. Name the reindex/backfill path and the staleness window |

---

## 3. The AWS Gotchas That Carry Senior Signal

Naming one of these unprompted is worth more than three extra boxes on the diagram. All numbers are **planning figures to verify**.

| # | Gotcha | Why it bites | What you say |
|---|---|---|---|
| 1 | **DynamoDB hot partition** | Per-partition ceilings (~1,000 WCU / ~3,000 RCU **`⚠️ verify`**) apply even with huge table capacity | "I'd write-shard the key with a suffix `key#0..N` and scatter-gather on read — adaptive capacity helps but doesn't remove the ceiling" |
| 2 | **DynamoDB TTL is not a timer** | Best-effort deletion (~48 h window **`⚠️ verify`**) | "For a hold expiry I need a real scheduler or a sweeper; TTL is only cleanup" |
| 3 | **SQS FIFO throughput** | Ordering is per message-group; per-group throughput is capped **`⚠️ verify`** | "I group by `order_id` so groups are numerous and small — grouping by tenant would serialize a whole tenant" |
| 4 | **SQS visibility timeout vs job duration** | Timeout < p99 duration ⇒ the same job runs twice concurrently | "Set visibility above p99, extend heartbeat-style for long jobs, and make the handler idempotent anyway" |
| 5 | **Kinesis shard head-of-line blocking** | One slow/poison record stalls the whole shard's consumer | "Per-shard retry + a side-channel DLQ, or use SQS if I need per-message failure isolation" |
| 6 | **Lambda cold start + VPC + concurrency** | Tail latency and account-level concurrency limits; and the runtime ceiling **`⚠️ verify`** | "Fine for the event-driven glue; for a p99-sensitive sync path or a long transcode I'd run Fargate/ECS" |
| 7 | **API Gateway integration timeout** | Historically a hard ~29 s ceiling **`⚠️ verify`** (adjustability has changed) | "Anything longer becomes `202` + status URL — which is the long-running-task pattern anyway" |
| 8 | **S3 request rate is per prefix** | ~3,500 PUT / ~5,500 GET per prefix per second **`⚠️ verify`** | "I'd spread keys across prefixes rather than a single date prefix that becomes the hotspot" |
| 9 | **S3 is not a filesystem** | No atomic rename, listing is paginated and eventually-ish for some ops (object reads are strongly consistent since 2020 **`⚠️ verify`**) | "I keep authoritative metadata in DynamoDB and treat S3 as content-addressed bytes" |
| 10 | **CloudFront invalidation is slow and rate-limited** | People design around invalidation and get burned | "Versioned/immutable keys with long TTLs, short TTL on manifests — invalidate almost never" |
| 11 | **Aurora replica lag** | Breaks read-your-own-writes | "Writer for the author's own reads, replicas for everyone else" |
| 12 | **Global Tables resolve conflicts LWW** | Silent write loss on concurrent multi-region writes | "If loss is unacceptable I partition write ownership by region, or model as a CRDT" |
| 13 | **ElastiCache cluster-mode resharding** | Slot migration causes redirects/latency spikes; client must handle `MOVED` | "Cluster-aware client, and I'd pre-scale before a known peak rather than resharding during it" |
| 14 | **SNS→SQS vs EventBridge** | Chosen by habit rather than need | "SNS for cheap high-volume fan-out; EventBridge when I want content-based routing, schema registry, or replay" |
| 15 | **Cross-AZ and egress cost** | Data transfer, not compute, is often the bill | "Chatty cross-AZ service calls and NAT egress dominate; I'd co-locate the hot path and keep bytes on the CDN" |
| 16 | **Provisioned vs on-demand** | Flash sales blow through provisioned capacity; on-demand costs more steady-state | "On-demand for spiky/unknown, provisioned + autoscaling once the shape is known" |

---

## 4. What AWS Does *Not* Give You

The highest-signal thing you can say about a managed cloud is where the boundary is. **None of these come from a service — they're your design.**

| You still have to build | Why no service provides it |
|---|---|
| **Exactly-once effect** | Delivery is at-least-once everywhere. You need an idempotency key + dedupe store (a DynamoDB conditional put, or a UNIQUE constraint inside the business transaction) |
| **Cross-service transactions** | DynamoDB `TransactWriteItems` is single-table/single-region; Aurora transactions are single-database. Spanning services = **saga + compensation** (Step Functions) |
| **Ordering across partitions** | Kinesis orders per partition key, SQS FIFO per message group. Global ordering is not on offer — design so you don't need it |
| **Linearizable cross-region reads** | Global Tables are eventually consistent + LWW. Strong global reads mean a single-region writer or a consensus store |
| **Circuit breakers** | Client-side concern; SDK adaptive retry is not a breaker. See [`../fundamentals/circuit-breaker.md`](../fundamentals/circuit-breaker.md) |
| **Fencing against a paused lock holder** | Any lease can expire while the holder is stopped. The **resource** must reject stale fencing tokens. See [`../fundamentals/fencing.md`](../fundamentals/fencing.md) |
| **A general managed ZooKeeper/etcd** | Not offered for application use — substitute DynamoDB conditional writes, or self-manage |
| **Precise per-entity timers** | EventBridge Scheduler goes a long way; beyond that it's a timer table + sweeper |
| **The sweeper** | Every async design needs a job that finds things stuck in non-terminal states. No service will notice for you |
| **Backpressure into your own API** | Throttling at API Gateway protects AWS's edge, not your database. Load shedding and queue-depth-driven admission control are yours |

---

## 5. Multi-Region on AWS — the four postures

Pick one and defend it; don't say "multi-region" as if it were a single choice.

| Posture | What it means | AWS shape | Cost / complexity |
|---|---|---|---|
| **Single region, multi-AZ** | Survive a datacenter, not a region | Default: ALB + ASG across 3 AZs, Aurora multi-AZ, S3 (regional, multi-AZ) | Baseline — and the right answer far more often than candidates think |
| **Active–passive (warm standby)** | Replicate, promote on failure | Aurora Global Database (fast promotion), S3 CRR, Route 53 failover | Moderate; RTO minutes, RPO seconds |
| **Active–active, partitioned writes** | Each region owns a slice of keys | Route 53 latency routing + per-region write ownership | High, but conflict-free by construction |
| **Active–active, converge later** | Write anywhere, resolve conflicts | DynamoDB Global Tables (LWW) or CRDTs | Highest; you must accept or engineer around conflict resolution |

**The sentence that scores:** *"Multi-AZ is a config change; multi-region is a data-model decision. What's the RTO/RPO, and is anyone actually paying for active-active?"*

---

## 6. Per-Topic AWS Stack — One Line Each

The fast index. Each links to the topic's own depth; the AWS names are **defensible defaults, not the only answer**.

| Topic | Defensible AWS stack |
|---|---|
| [Chat system](../interviews/chat-system/README.md) | NLB + self-managed WS (or API GW WebSocket) · connection registry in DynamoDB/ElastiCache · DynamoDB for messages (partition `channel_id`) · SNS/Kinesis for cross-server fan-out · S3 for attachments |
| [Ride sharing](../interviews/ride-sharing/README.md) | Kinesis for GPS firehose · ElastiCache/DynamoDB geohash cells for driver index · Aurora for trips · Step Functions for trip lifecycle · WS for tracking · Location Service for maps |
| [Seat reservation](../interviews/seat-reservation/README.md) | ElastiCache Redis `SETNX`+TTL holds · Aurora for bookings (ACID) · CloudFront + WAF waiting room · SQS for post-purchase · KMS-signed QR tokens |
| [E-commerce](../interviews/e-commerce/README.md) | CloudFront + OpenSearch browse · DynamoDB cart (AP) · Aurora checkout with idempotency UNIQUE · SQS/EventBridge + Step Functions fulfillment · DynamoDB Streams outbox |
| [Payment system](../interviews/payment-system/README.md) | Aurora double-entry ledger (append-only) · DynamoDB conditional put for idempotency keys · Step Functions for auth→capture→settle · SQS for webhook ingestion · Athena/Redshift for reconciliation · Secrets Manager + KMS |
| [Video streaming](../interviews/video-streaming/README.md) | S3 multipart upload · S3 Events → SNS → SQS · MediaConvert · S3 tiering · CloudFront signed URLs · Kinesis for watch progress · KMS for DRM keys |
| [File storage (Dropbox)](../interviews/file-storage/README.md) | S3 content-addressed chunks · DynamoDB metadata + versions · S3 Events for post-processing · WS/SSE for sync notifications |
| [Social feed](../interviews/social-feed/README.md) | DynamoDB posts · ElastiCache sorted-set timelines · SQS/Kinesis fan-out workers · CloudFront for media · OpenSearch for search |
| [Notification system](../interviews/notification-system/README.md) | EventBridge ingest · SQS per channel · SNS (mobile push) / SES (email) / Pinpoint or a 3P for SMS · DynamoDB for preferences + dedupe · EventBridge Scheduler for reminders |
| [Web crawler](../interviews/web-crawler/README.md) | SQS frontier (+ per-domain politeness) · Fargate fetchers · S3 for raw pages · DynamoDB for URL-seen (+ Bloom filter) · OpenSearch index |
| [Rate limiting](../interviews/rate-limiting/README.md) | ElastiCache Redis token bucket via Lua · API Gateway usage plans / WAF rate rules for the coarse tier |
| [Distributed caching](../interviews/distributed-caching/README.md) | ElastiCache (cluster mode) · DAX for DynamoDB · CloudFront as the outermost tier |
| [CDN & edge](../interviews/cdn-edge/README.md) | CloudFront + origin shield · Lambda@Edge / CloudFront Functions · versioned keys over invalidation |
| [KV store](../interviews/kv-store/README.md) | DynamoDB as the worked example (partition key, GSIs, Streams, Global Tables) · Keyspaces if Cassandra semantics are required |
| [Message queues](../interviews/message-queues/README.md) | The §1.4 table *is* this topic: SQS vs SNS vs EventBridge vs Kinesis vs MSK |
| [Distributed transactions](../interviews/distributed-transactions/README.md) | Step Functions saga · DynamoDB Streams outbox · DynamoDB conditional put for idempotency |
| [Observability](../interviews/observability/README.md) | CloudWatch metrics/alarms · Logs Insights · X-Ray or ADOT/OTel · CloudTrail audit · FIS for chaos |
| [Search autocomplete](../interviews/search-autocomplete/README.md) | Trie snapshot in ElastiCache (cheap) or OpenSearch completion suggester · CloudFront for the prefix API |
| [Recommendation system](../interviews/recommendation-system/README.md) | OpenSearch k-NN or pgvector for candidates · SageMaker for ranking · ElastiCache for precomputed recs · Personalize as the batteries-included option |
| [URL shortener](../interviews/url-shortener/README.md) | DynamoDB (key = short code) · CloudFront for redirect caching · Kinesis for click analytics |
| [Consensus](../interviews/consensus/README.md) | Mostly *not* an AWS service — self-managed etcd/ZK; note that Aurora/DynamoDB internals do this for you |

---

## 7. Interview Scripts & Traps

**The 3-sentence tech-choice script** (use it every time you name a service):
> *"I need ⟨property⟩ because ⟨number from the requirements⟩. On AWS that's ⟨service⟩ — the thing to watch is ⟨gotcha⟩. Off AWS it's ⟨OSS⟩, so this isn't a lock-in decision."*

**When the interviewer is cloud-agnostic** (Google/Meta): lead with the primitive and only mention AWS as evidence — *"a partitioned replayable log — Kafka, or Kinesis if I'm on AWS."* Then move on.

**When the interviewer is AWS-deep** (Amazon, or an AWS-shop): expect the follow-up to be a *quota* or a *failure mode*, not another service. Section 3 is the prep for that.

| Trap | Why it costs you | Fix |
|---|---|---|
| Vendor catalog answer | Reads as memorized, not built. Fifteen service names with no property named | One primitive per box, then the name |
| "I'd use Lambda for everything" | Ignores cold starts, runtime ceiling, sustained-throughput cost | Lambda for event glue; containers for sustained/long/latency-sensitive work |
| Kinesis where SQS belongs (or vice versa) | Shows you don't know retry-unit vs ordering-unit | Use the §1.4 decision sentence |
| "DynamoDB scales infinitely" | Ignores per-partition ceilings and hot keys | Name the write-sharding suffix |
| "Global Tables give me multi-region strong consistency" | Factually wrong — LWW, eventual | State the conflict-resolution semantics |
| Quoting exact quotas confidently | One wrong number undoes the good answer | "Approximately X — I'd verify the current quota" |
| Naming a deprecated service | Dates your knowledge | If unsure whether something is current (e.g. QLDB **`⚠️ verify`**), say so and give the portable alternative |

---

## Quick Recall Cheat Sheet

| Need | AWS default | Native / OSS | One-line why |
|---|---|---|---|
| Object bytes | S3 | MinIO/Ceph | Cheap, durable, presigned direct upload |
| Work queue, per-message retry | SQS | RabbitMQ | Visibility timeout + DLQ |
| Ordered replayable log | Kinesis / MSK | Kafka | Order per partition key, replay window |
| Fan-out | SNS (cheap) / EventBridge (routing+replay) | Kafka topics | One event → N consumers |
| Predictable-p99 KV | DynamoDB | Cassandra/Couchbase | Partition-key routing, elastic |
| ACID + unique constraint | Aurora / RDS | Postgres | The idempotency key lives here |
| Cache / ephemeral state | ElastiCache | Redis/Valkey | TTL + atomic ops |
| Edge cache | CloudFront | Varnish + 3P CDN | Versioned keys, long TTL |
| Search / vectors | OpenSearch | Elasticsearch/FAISS | Derived index, never source of truth |
| Saga / workflow | Step Functions | Temporal | Durable state machine + compensation |
| Scheduler / timers | EventBridge Scheduler | Quartz / K8s CronJob | TTL is *not* a scheduler |
| Distributed lock | DynamoDB conditional write | etcd / ZooKeeper | Plus a fencing token, always |
| Outbox | DynamoDB Streams | Debezium | Log-based, avoids the dual write |
| Stream aggregation | Managed Flink | Flink / Kafka Streams | Windowed counting, top-K |
| Transcoding | MediaConvert | FFmpeg fleet | Renditions + segments |
| Metrics / traces | CloudWatch / X-Ray | Prometheus / Jaeger | Emit OTel to stay portable |
| Chaos | Fault Injection Service | Chaos Mesh | Break it in business hours |
| **Not available** | exactly-once · cross-service txn · global ordering · circuit breaker · managed ZK · the sweeper | — | These are always **your** design |
