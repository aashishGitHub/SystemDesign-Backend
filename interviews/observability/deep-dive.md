# Deep Dive: Observability (Metrics, Logs, Traces, SLOs)

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive analogies, no jargon
> - 🟡 **Senior** — implementation mechanics, code/config, tradeoff tables
> - 🔴 **Architect** — failure modes, capacity/cost math, production decisions

---

## Table of Contents

1. [Monitoring vs Observability](#1-monitoring-vs-observability)
2. [The Three Pillars and Their Limits](#2-the-three-pillars-and-their-limits)
3. [Metrics and the Prometheus Model](#3-metrics-and-the-prometheus-model)
4. [The Cardinality Problem](#4-the-cardinality-problem)
5. [Logs: Structured, Centralized, Correlated](#5-logs-structured-centralized-correlated)
6. [Distributed Tracing: Spans and Context Propagation](#6-distributed-tracing-spans-and-context-propagation)
7. [Sampling: Head-Based vs Tail-Based](#7-sampling-head-based-vs-tail-based)
8. [SLIs, SLOs, SLAs and Error Budgets](#8-slis-slos-slas-and-error-budgets)
9. [Multi-Window Multi-Burn-Rate Alerting](#9-multi-window-multi-burn-rate-alerting)
10. [Alerting Philosophy: Golden Signals, RED, USE](#10-alerting-philosophy-golden-signals-red-use)
11. [Dashboards, On-Call and Incident Response](#11-dashboards-on-call-and-incident-response)
12. [Push vs Pull and the Collection Architecture](#12-push-vs-pull-and-the-collection-architecture)
13. [The Cost of Observability at Scale](#13-the-cost-of-observability-at-scale)
14. [Failure Modes and Chaos Engineering](#14-failure-modes-and-chaos-engineering)
15. [Real-World Implementations and Production Incidents](#15-real-world-implementations-and-production-incidents)
16. [Pattern Recognition — Interview Signals](#16-pattern-recognition--interview-signals)
17. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Monitoring vs Observability

### 🟢 Beginner — The Car Dashboard vs the Mechanic's Bay

Your car's dashboard has a fixed set of lights: fuel, temperature, check-engine. Someone decided in advance which things are worth showing you. That's **monitoring** — a curated set of pre-chosen warnings.

But when the check-engine light comes on, the dashboard can't tell you *why*. The mechanic plugs in a diagnostic tool and reads hundreds of signals the car emits, asking new questions until they find the cause — even a cause the carmaker never anticipated. That's **observability** — the ability to interrogate the system for problems nobody pre-planned for.

You need both. The dashboard warns you *something* is wrong; the diagnostic bay tells you what.

---

### 🟡 Senior — Known-Unknowns vs Unknown-Unknowns

The formal distinction is about the *questions you can ask*:

```
Monitoring:    You enumerate failure modes in advance and write a check for each.
               "Alert if disk > 90%." "Alert if 5xx rate > 1%."
               Great for KNOWN-UNKNOWNS: problems you can predict.

Observability: You retain enough high-context, high-cardinality data that you can
               invent a NEW query at incident time and get an answer.
               "Show me p99 for Android clients, on carrier X, hitting shard 7,
                for premium users, in the last 10 minutes" — a question you never
                pre-built a dashboard for.
               Great for UNKNOWN-UNKNOWNS: problems you couldn't predict.
```

| | Monitoring | Observability |
|---|---|---|
| Questions | Fixed, pre-defined | Arbitrary, ad hoc |
| Data shape | Aggregated, low-cardinality | Rich, high-cardinality context |
| Fails when | The failure is novel | Data too coarse to slice by the key dimension |
| Relationship | A subset of observability | The superset |

The litmus test: **can you answer a brand-new production question right now without deploying new instrumentation?** If you must add a log line and redeploy, you had monitoring, not observability.

---

### 🔴 Architect — Why This Distinction Became Urgent

Observability as a term (borrowed from control theory — inferring internal state from external outputs) was popularized in software by teams like Honeycomb (Charity Majors) precisely because distributed systems produce failures no one predicts.

```
Design implication: instrument for questions you HAVEN'T thought of yet.

Anti-pattern:  pre-aggregate everything into a handful of low-cardinality metrics.
               → cheap, but the moment the outage doesn't match a pre-built dashboard,
                 you're blind and have to ship code mid-incident.

Better:        emit wide, structured events with many high-cardinality attributes
               (user_tier, region, shard, client_version, feature_flag, build_id).
               → you can pivot on ANY dimension after the fact.

The cost tension (see §13): high-cardinality context is exactly what's expensive to
store. The architect's job is to keep it where it's affordable (traces/events, often
sampled) rather than forcing it into metrics (where cardinality is fatal — see §4).
```

**Design-review test:** for any new service, ask "when this breaks in a way we didn't foresee, what question will we need to ask, and will the data be there?" If the answer is "we'd add logging and redeploy," the design isn't observable yet.

---

## 2. The Three Pillars and Their Limits

### 🟢 Beginner — Three Ways to Understand a Restaurant

Imagine understanding how a busy restaurant is doing:

- **Metrics** = the tallies on a clipboard: covers served per hour, average wait time, dishes returned. Cheap to keep, great for spotting a bad night — but they don't tell you *which* table had a problem.
- **Logs** = the detailed notes for each table: "Table 12 sent back the soup, cold." Full detail, but reading every note is slow and there are thousands.
- **Traces** = following one specific order from the door, to the kitchen, to the pass, to the table — seeing exactly where it got stuck.

No single view is enough. The clipboard says tonight is slow; the trace shows orders pile up at the grill; the notes explain the grill cook called in sick.

---

### 🟡 Senior — What Each Pillar Is Bad At

```
Metrics:  numeric time series, aggregated.
          GOOD: cheap, fast, aggregatable, ideal for alerting & trends.
          BAD:  no per-request detail; high cardinality is fatal (§4).

Logs:     discrete, timestamped event records.
          GOOD: maximum per-event detail; high cardinality is fine.
          BAD:  expensive to store/index; hard to aggregate; noisy at volume.

Traces:   causal tree of spans for one request across services.
          GOOD: shows WHERE time/errors occur across service boundaries.
          BAD:  usually sampled → the one trace you want may be gone;
                only shows the work you instrumented (gaps = blind spots).
```

| Pillar | Answers | Cost | Cardinality tolerance | Alert on it? |
|---|---|---|---|---|
| Metrics | "Is a trend abnormal?" | Low | Low (must be bounded) | Yes — primary |
| Traces | "Where across services?" | Medium | High | Rarely (derive metrics from them) |
| Logs | "What exactly happened?" | High | High | No (too expensive) — derive metrics instead |

The three converge through **shared identifiers**: the same `trace_id` appears in the trace, in every correlated log line, and (via **exemplars**) can be attached to a metric bucket — letting you jump metric → trace → log.

---

### 🔴 Architect — The Pillars Are Converging into Wide Events

The "three pillars" framing is increasingly seen as three *views* of the same underlying data rather than three separate systems.

```
The modern position (Honeycomb-style "observability 2.0" / wide structured events):
  Emit one wide event per unit of work with dozens of high-cardinality fields.
  - Aggregate the events → you get METRICS.
  - Read individual events → you get LOGS.
  - Link events by trace_id/parent_id → you get TRACES.

Benefit: no "which pillar do I check?" context-switching; pivot freely by any field.
Tension: wide events are high-cardinality → storage/query engines must be built for it
         (columnar, sampling-aware). This is why specialized backends (Honeycomb,
         and columnar trace stores) exist rather than shoving everything into Prometheus.

OpenTelemetry is the unifying substrate: one SDK emits all three signal types with a
shared context, so the correlation (trace_id everywhere) is built in, not bolted on.
```

**Design-review guidance:** don't buy three disconnected tools that can't cross-reference. The single most valuable property is **correlation** — being able to go from "error rate spiked" (metric) to "this trace" (exemplar) to "this log line" (trace_id join) in three clicks. If your stack can't do that, you have three data silos, not observability.

---

## 3. Metrics and the Prometheus Model

### 🟢 Beginner — The Utility Meter on Your House

A metric is like the electricity meter on your house: a number that ticks upward. On its own, "473,912 kWh total since installation" is useless. What you care about is the *rate*: "how much am I using per day this week vs last?" You subtract readings over time to get a rate — and that rate is what tells you the AC is running too hard.

Prometheus is a service that walks around and reads all your meters every few seconds, remembers the readings, and lets you compute rates and trends from them.

---

### 🟡 Senior — Metric Types, Pull, and PromQL

```yaml
# Prometheus PULLS: it scrapes each target's /metrics endpoint on an interval.
scrape_configs:
  - job_name: 'checkout'
    scrape_interval: 15s
    kubernetes_sd_configs: [{ role: pod }]   # auto-discover pods
```
```
# What the target exposes at GET /metrics (text exposition format):
# TYPE http_requests_total counter
http_requests_total{method="POST",status="200",route="/checkout"} 91234
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{route="/checkout",le="0.1"} 88000
http_request_duration_seconds_bucket{route="/checkout",le="0.5"} 90900
http_request_duration_seconds_bucket{route="/checkout",le="+Inf"} 91234
http_request_duration_seconds_sum{route="/checkout"} 12750.4
http_request_duration_seconds_count{route="/checkout"} 91234
```

| Type | Goes up/down? | Aggregatable quantiles? | Typical use |
|---|---|---|---|
| Counter | Up only (resets on restart) | — | counts of events |
| Gauge | Both | — | current value (queue depth) |
| Histogram | (buckets up-only) | ✅ yes (sum buckets) | latency/size distributions |
| Summary | — | ❌ no (per-instance) | single-instance quantiles |

```promql
# The four queries you must be able to write cold:
sum(rate(http_requests_total[5m]))                                    # traffic
sum(rate(http_requests_total{status=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m]))                               # error ratio
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le))       # p99 latency
sum by (route) (rate(http_requests_total[5m]))                       # traffic per route
```

**Tradeoff — `rate()` vs `irate()`:** `rate()` fits a line across the whole window (smooth → alerts); `irate()` uses the last two points (spiky → volatile graphs). Use `rate()` for alerting.

---

### 🔴 Architect — Recording Rules, Downsampling, and Long-Term Storage

Vanilla Prometheus is a single node with local storage — it does not scale horizontally or retain data forever. At scale you add layers:

```
Problem 1: expensive dashboard queries recomputed on every refresh.
  Fix: RECORDING RULES pre-compute and store the result as a new series.
    groups:
      - name: slo
        rules:
          - record: job:http_request_errors:ratio5m
            expr: sum(rate(http_requests_total{status=~"5.."}[5m]))
                  / sum(rate(http_requests_total[5m]))
  → dashboards/alerts read the cheap pre-aggregated series.

Problem 2: one Prometheus can't hold months of high-resolution data or survive.
  Fix: Thanos / Cortex / Mimir / VictoriaMetrics — add object-storage backends,
       global query view across many Prometheis, and DOWNSAMPLING
       (raw 15s → 5m → 1h resolution as data ages) to cut storage cost.

Capacity math (rough — verify for your setup):
  active_series × bytes_per_series ≈ RAM working set.
  If ~a few KB/series and you run ~2M series → several GB of head RAM, plus WAL/disk.
  Doubling label cardinality doubles this. This is why §4 matters so much.
```

**Design-review guidance:** decide retention *tiers* up front (e.g., 15 s for 15 days, 5 m for 90 days, 1 h for 1 year). Full-resolution-forever is a cost trap; downsampling preserves trend visibility at a fraction of the storage.

---

## 4. The Cardinality Problem

### 🟢 Beginner — One Folder per Combination

Imagine you file paperwork by creating a physical folder for every unique combination of attributes. Filing by {department, month} gives 12 departments × 12 months = 144 folders — manageable. Now someone says "also file by employee." With 10,000 employees, that's 144 × 10,000 = 1.44 million folders. The filing cabinet (your memory/storage) overflows and the whole office grinds to a halt.

That's cardinality: every new attribute *multiplies* the number of folders. Some attributes (like a unique employee or customer ID) have so many values they explode the count.

---

### 🟡 Senior — Cardinality Is a Product, Not a Sum

Prometheus stores **one time series per unique combination of metric name + all label values.** Total series = the *product* of each label's distinct-value count.

```
http_requests_total{method, status, route}
  method: 5, status: 8, route: 25   →  5 × 8 × 25 = 1,000 series.  Fine.

Add region (4):    × 4  = 4,000.        Still fine (bounded label).
Add user_id (1e6): × 1e6 = 4,000,000,000 series.  DEAD.
```

```
Safe labels (BOUNDED, small, stable set of values):
  method, status_code, route TEMPLATE (/users/:id not /users/42), region, env, service.

POISON labels (UNBOUNDED / high-cardinality):
  user_id, request_id, trace_id, session_id, email, full URL, timestamp, raw error string.
```

The insidious part: cardinality is often introduced *accidentally* — a route label that includes the raw path (with IDs), an error label containing the exception message, or a `pod` label on a cluster that churns thousands of pods a day. Each looks harmless in a code review.

---

### 🔴 Architect — Governing Cardinality, and the Incident When You Don't

```
INCIDENT PATTERN (extremely common in the wild):
  A deploy adds a high-cardinality label to a hot metric. Series count jumps from
  ~10k to tens of millions within minutes. Prometheus head RAM balloons → OOM-kill
  → restart → replay WAL → OOM again. Ingestion stalls, dashboards go blank during
  the exact window you need them.

DETECTION:
  # Which metric names have the most series?
  topk(10, count by (__name__)({__name__=~".+"}))
  # Watch head series growth as a leading indicator:
  prometheus_tsdb_head_series
  # /status/tsdb in the Prometheus UI lists top label cardinalities.

IMMEDIATE MITIGATION (no app redeploy — drop at scrape time):
  metric_relabel_configs:
    - source_labels: [user_id]     # nuke the offending label
      action: labeldrop
    - source_labels: [__name__]    # or drop the whole runaway metric
      regex: 'runaway_metric_.*'
      action: drop

LONG-TERM GOVERNANCE:
  - Cardinality budget per team; alert on prometheus_tsdb_head_series growth.
  - CI lint on metric definitions to reject unbounded labels.
  - Move per-user/per-request needs to TRACES/EVENTS/EXEMPLARS (§6, §16).
  - Use route TEMPLATES; strip IDs from label values at instrumentation time.
```

**Tradeoff — dimensionality vs stability.** Every label is a multiplier. Treat labels as a scarce, governed resource: the richest debugging dimension (per-user, per-request) is exactly the one that must *not* live in a metric. That's what traces and exemplars are for.

---

## 5. Logs: Structured, Centralized, Correlated

### 🟢 Beginner — A Diary vs a Filing System

Free-text logs are like a diary written in prose: "Had trouble with the payment thing around lunch, seemed slow." To find anything you re-read the whole diary. Structured logs are like a form filled out identically every time — date, category, severity, duration — so you can instantly pull "all payment entries over 1 second, last Tuesday." When ten people keep diaries (ten microservices), you also need a shared reference number on each entry so you can trace one customer's visit across all ten diaries. That number is the correlation ID.

---

### 🟡 Senior — Structure, Correlation, Aggregation

```jsonc
// Structured JSON log line — every field is queryable and joinable:
{"ts":"2026-07-06T10:30:00.123Z","level":"error","service":"payments",
 "trace_id":"0af7651916cd43dd8448eb211c80319c","span_id":"b7ad6b7169203331",
 "route":"/checkout","user_tier":"premium","latency_ms":1830,
 "err":"gateway_timeout","upstream":"card-processor"}
```

```
Levels (route by severity):  TRACE < DEBUG < INFO < WARN < ERROR < FATAL
  Prod default: INFO+. DEBUG behind a flag or dynamic per-service toggle.

Centralized aggregation pipeline:
  app → (stdout/agent: Fluent Bit / Vector / Filebeat) → buffer/broker (Kafka)
      → store+index (Elasticsearch or Loki) → query UI (Kibana / Grafana)
```

| | ELK / Elasticsearch | Grafana Loki |
|---|---|---|
| Indexes | Full text of every log | Labels only; body stored compressed |
| Query | Rich full-text + aggregations | Label-select, then linear scan |
| Cost | High (index everything) | Low (cheap object storage) |
| Sweet spot | Ad-hoc full-text search | Filter by labels + trace_id, then read |

The **correlation ID is the keystone**: generated at the edge, propagated with the trace context (§6), and stamped on every log line. Debugging a microservice failure becomes `{trace_id="..."}` — one query returns the full cross-service story of one request in order.

---

### 🔴 Architect — Cost Control and the "Log Everything" Trap

Logs are the pillar most likely to bankrupt you, because volume scales with traffic *and* verbosity, and full-text indexing is expensive.

```
Cost levers (each trades away some fidelity):
  1. Levels:      INFO+ in prod; DEBUG dynamic. (Lose verbose detail unless toggled.)
  2. Sampling:    keep 100% ERROR/WARN; sample INFO/success at 1–10%.
                  RULE: NEVER sample errors — that's the log you'll need.
  3. Retention:   hot/searchable 7–14d → cold object store (S3) 90d → delete.
  4. Field drops: strip large payloads/stack-on-success before ingest.
  5. Demote:      high-frequency counters belong in METRICS, not log lines.

Capacity math (illustrative — plug in your own numbers):
  50k req/s × 1 log/req × 1 KB/log = 50 MB/s ≈ 4.3 TB/day RAW.
  With full-text indexing overhead (index can rival or exceed raw size) and
  replication, provisioned storage can be several × that. At retention of weeks,
  this is often a seven-figure annual line item — hence sampling + tiering.

FAILURE MODE — logging as a self-inflicted outage:
  Synchronous logging to a slow/backed-up sink can BLOCK request threads →
  the logging system takes down the app it was meant to observe.
  Fix: async, bounded buffers that DROP (with a dropped-count metric) rather than
  block; never let telemetry backpressure the serving path.
```

**Design-review guidance:** budget log volume like a capacity plan. Decide sampling and retention *per log category* (audit/compliance = long; debug = short), and make the serving path resilient to a slow logging backend. "Log everything forever" is not a strategy; it's a future incident.

---

## 6. Distributed Tracing: Spans and Context Propagation

### 🟢 Beginner — Following One Suitcase Through the Airport

A trace is like tracking one suitcase through an airport. The bag gets a tag at check-in (the trace ID). At every stop — check-in, security scan, transfer, loading — a scan records how long that step took and links back to the previous step. At the end you can see the whole journey and exactly where the bag sat waiting. If your bag is late, you don't inspect the whole airport; you look at the one step where it got stuck.

Each scan is a **span**; the bag tag carried between stops is the **context propagation**.

---

### 🟡 Senior — Spans, Trees, and Propagation

```
Trace  trace_id = 0af7651916cd43dd8448eb211c80319c
└─ span "API GW POST /checkout"        [0 ─────────────────────── 2000ms]
   ├─ span "auth.verify"               [10 ─ 40ms]        parent = API GW
   ├─ span "cart.get"                  [45 ─ 90ms]        parent = API GW
   └─ span "payments.charge"           [95 ────────── 1900ms]  parent = API GW  ← hot
      └─ span "db.INSERT charge"       [120 ─ 180ms]      parent = payments
```

Each span has: `trace_id` (shared), `span_id` (unique), `parent_span_id` (the causer), name, start, duration, and attributes.

```http
# Propagation across an HTTP boundary — W3C Trace Context:
GET /charge HTTP/1.1
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
             │  └ trace-id (32 hex)                └ parent span (16 hex)  └ flags(01=sampled)
tracestate: vendorA=xyz,vendorB=abc
```

```python
# Conceptual OpenTelemetry usage (verify exact API in current OTel docs):
with tracer.start_as_current_span("payments.charge") as span:
    span.set_attribute("user_tier", "premium")     # bounded/attribute OK on spans
    span.set_attribute("customer_id", customer_id)  # HIGH cardinality is FINE on a span
    resp = http.post(url)   # OTel auto-injects traceparent into outbound headers
```

| Legacy header | Origin | W3C replacement |
|---|---|---|
| `X-B3-TraceId` etc. | Zipkin (B3) | `traceparent` |
| `uber-trace-id` | Jaeger | `traceparent` |

Before W3C standardization, a service using Jaeger headers couldn't propagate context to one expecting B3 — traces broke at the boundary. **W3C Trace Context is the interoperability fix**, and OTel uses it by default.

---

### 🔴 Architect — Coverage, Gaps, and Deriving Metrics from Traces

```
FAILURE MODE — the "invisible" latency (see answers A20):
  Total 2000ms, but no span > 200ms. The time is in the GAPS: thread-pool queueing,
  connection-pool waits, GC pauses, DNS, or un-instrumented libraries — none wrapped
  in a span. A trace only shows the work you instrumented.
  Fix: add spans around queue/pool waits; instrument serialization & external calls;
       treat waterfall GAPS as first-class evidence, not empty space.

FAILURE MODE — broken traces:
  A service that doesn't propagate context starts a NEW trace → the request appears
  as two disconnected traces. One un-instrumented hop severs the whole chain.
  Fix: enforce context propagation in shared middleware/mesh; test it in CI.

Deriving metrics from spans (span metrics / RED-from-traces):
  Rather than double-instrument, generate RED metrics from spans in the OTel Collector
  (spanmetrics connector): rate, error rate, and duration per service/operation come
  "for free" from the trace stream — one instrumentation source, both pillars.

Context also flows through async boundaries:
  Message queues carry traceparent in message headers; the consumer continues the
  trace. Without it, producer and consumer look unrelated — a common blind spot in
  event-driven systems.
```

**Design-review guidance:** trace completeness is a property you must *enforce*, not assume. Mandate context propagation in the service template/mesh, and validate in integration tests that a request produces one connected trace across every hop, including queues.

---

## 7. Sampling: Head-Based vs Tail-Based

### 🟢 Beginner — Which Security Footage to Keep

A store can't keep every second of camera footage forever. **Head-based sampling** is deciding at the door "we'll record every 100th customer" — cheap, but you decide *before* knowing if that customer shoplifts, so you often fail to record the incident. **Tail-based sampling** is keeping a rolling buffer of everyone, and *after* each visit deciding "did anything interesting happen? if so, save it" — you keep exactly the shoplifting incidents, but you need a big buffer to hold everyone until they leave.

---

### 🟡 Senior — Where the Decision Is Made

```
HEAD-BASED (decide at trace START, in the SDK):
  if rand() < 0.01: sample = true   # keep 1%
  Propagated via the traceparent "sampled" flag so the whole trace agrees.
  + Cheap, simple, low data movement.
  - Blind: decides before knowing outcome → drops most errors/slow traces.

TAIL-BASED (decide AFTER the full trace is assembled, in a stateful collector):
  buffer all spans by trace_id; when the trace completes, apply policy:
    keep 100% of traces with any error span
    keep 100% of traces with duration > 1s
    keep 1% of the rest
  + Keeps the valuable traces (errors, tail latency).
  - Must BUFFER every span until the trace finishes → memory + a routing tier that
    guarantees all spans of a trace reach the same collector instance.
```

| | Head-based | Tail-based |
|---|---|---|
| Decision time | Trace start | Trace end |
| Keeps rare errors/slow? | No | Yes |
| Buffering | None | All spans, until complete |
| Cost/complexity | Low | High (stateful, sharded by trace_id) |
| Where | SDK / instrumentation | Collector tier (`tail_sampling` processor) |

---

### 🔴 Architect — The Cost/Fidelity Curve and a Hybrid

```
Capacity reality:
  50k req/s, avg 20 spans/trace = 1M spans/s. Storing 100% is usually infeasible.
  Head @1%   → 10k traces/s stored, but ~99% of ERROR traces also dropped. Bad for
               debugging exactly the failures you care about.
  Tail-based → keep ~100% of errors + slow + 1% baseline. Far better signal, but the
               collector must buffer ~all spans for the trace lifetime (seconds) and
               shard by trace_id so every span lands on the same instance.

Hybrid pattern used in practice:
  1. Head-based at low base rate to bound raw volume.
  2. Tail-based policies on top to RESCUE errors/high-latency/specific-customer traces.
  3. Exemplars link metrics → the sampled traces you DID keep, so even at 1% you can
     jump from "the p99 bucket" to a concrete example.

Tradeoff — cost vs fidelity: head is cheap/low-fidelity for rare events; tail is
expensive/high-fidelity where it matters. Start head-based; graduate to tail-based
in the OTel Collector once losing error traces starts costing you MTTR.
```

**Design-review guidance:** the number that matters is not "what % do we sample?" but "**what fraction of error/slow traces do we retain?**" Optimize sampling to keep the interesting tail, not a uniform percentage of the boring middle.

---

## 8. SLIs, SLOs, SLAs and Error Budgets

### 🟢 Beginner — Restaurant Service Promises

- **SLI** (indicator) — the *measurement*: "97% of meals came out within 15 minutes last month."
- **SLO** (objective) — your *goal*: "we aim for 95% of meals within 15 minutes."
- **SLA** (agreement) — a *promise with consequences*: "if your meal takes over 30 minutes, it's free."

You measure the SLI, aim for the SLO, and only put in the SLA (with the free-meal penalty) a looser promise you're confident you can keep. The gap between your internal goal (95%) and your customer promise (free after 30 min) is your safety margin.

---

### 🟡 Senior — Definitions, Good SLIs, and the Budget

```
SLI  = a measured ratio of good events to valid events.
       Availability SLI = non-5xx / all valid requests.
       Latency SLI      = requests under threshold / all valid requests.
SLO  = target for the SLI over a window: "99.9% over rolling 30 days."
SLA  = external contract: "99.9% or we credit you." SLA is looser than SLO.

Error budget = 1 − SLO = allowed unreliability.
```

```
Good SLI properties:
  - Measured close to the USER (LB / edge / client), not deep internals.
  - A RATIO or PERCENTILE, never an average (§ answers A25, QB4).
  - "valid" excludes non-service faults (4xx client errors, health checks).
```

| SLO | Budget / 30 days (43,200 min) | Budget / year (525,600 min) |
|---|---|---|
| 99% | 432 min (7.2 h) | 3.65 days |
| 99.9% | 43.2 min | 8.76 h |
| 99.95% | 21.6 min | 4.38 h |
| 99.99% | 4.32 min | 52.6 min |
| 99.999% | 25.9 s | 5.26 min |

```
Arithmetic (checkable): budget_minutes = (1 − SLO) × window_minutes.
  99.9%, 30d:  0.001 × 43,200 = 43.2 min.
  99.99%, 30d: 0.0001 × 43,200 = 4.32 min.
Better unit for request services: budget_bad_events = (1 − SLO) × total_requests.
```

---

### 🔴 Architect — Error Budgets as a Release Gate

```
The error budget policy (agreed by dev + SRE BEFORE incidents):

  budget_remaining > 0  → ship features, run experiments, take risks. Spending the
                          budget is the POINT; an unspent budget = you shipped too slowly.
  budget_exhausted      → automatic freeze on risky changes; engineering effort
                          redirects to reliability until the rolling window recovers.

Why this is powerful in a design review:
  - It converts the endless dev-vs-ops fight ("ship faster" vs "stop breaking prod")
    into a single agreed number. No opinions — just budget math.
  - It sets the RIGHT number of nines: derive the SLO from what users actually notice
    and what the business needs, NOT "as reliable as possible" (see §8 100%-is-wrong).

Why 100% is the wrong target:
  - Unachievable: your dependencies (DNS, cloud, ISP, client network) are < 100%.
  - Each added nine roughly multiplies cost (redundancy, review, slower release).
  - Zero budget = zero room to ship or experiment. Progress stalls.

Multi-DC / composite SLOs:
  A user journey (checkout) spans many services; its SLO is a product of dependencies'
  reliabilities. If checkout needs 5 services each at 99.9%, naive serial dependency
  gives ~0.999^5 ≈ 99.5% — worse than any single component. Redundancy/retries/graceful
  degradation are how you claw the composite back up.
```

**Design-review guidance:** set the SLO from user-perceived need, keep the internal SLO stricter than any external SLA, and write the error-budget policy *before* the first incident so the freeze isn't a negotiation under fire.

---

## 9. Multi-Window Multi-Burn-Rate Alerting

### 🟢 Beginner — A Smoke Alarm With Two Settings

A good smoke alarm shouldn't shriek because you made toast, but must scream instantly for a real fire. Imagine an alarm with two brains: one checks "is there a *lot* of smoke *right now*?" (fast fire → sound immediately) and another checks "has there been a *little* smoke for a *long* time?" (a slow smolder → send a quieter warning, not a 3 a.m. siren). And it only triggers when it's *sure* — smoke seen over a longer window *and* still present in the last minute — so a puff of toast steam that already cleared doesn't wake the house.

---

### 🟡 Senior — Burn Rate Defined

**Burn rate** = how fast you're spending the error budget, relative to the rate that would exactly exhaust it over the SLO window. Burn rate 1 → budget gone exactly at window end. Burn rate 14.4 → gone 14.4× faster.

```
budget_consumed(T) = burn_rate × (T / window)

For a 99.9% SLO over a 30-day (720h) window, the SRE Workbook's recommended tiers:
┌────────────┬─────────────┬──────────────┬──────────────────┬─────────┐
│ Burn rate  │ Long window │ Short window │ Budget burned    │ Action  │
├────────────┼─────────────┼──────────────┼──────────────────┼─────────┤
│ 14.4       │ 1 hour      │ 5 min        │ 14.4×(1/720)=2%  │ PAGE    │
│ 6          │ 6 hours     │ 30 min       │ 6×(6/720)=5%     │ PAGE    │
│ 3          │ 1 day       │ 2 hours      │ 3×(24/720)=10%   │ TICKET  │
│ 1          │ 3 days      │ 6 hours      │ 1×(72/720)=10%   │ TICKET  │
└────────────┴─────────────┴──────────────┴──────────────────┴─────────┘
(Values are the Workbook's illustrative recommendations — verify against current text.)
```

```yaml
# Prometheus alert: fast burn (page) — long AND short window must both exceed threshold.
- alert: CheckoutErrorBudgetFastBurn
  expr: |
    (job:http_errors:ratio_rate1h > (14.4 * 0.001))
    and
    (job:http_errors:ratio_rate5m > (14.4 * 0.001))
  for: 2m
  labels: { severity: page }
  annotations: { runbook_url: "https://runbooks/checkout-error-budget" }
```

---

### 🔴 Architect — What Each "Multi" Actually Buys You

```
MULTI-BURN-RATE fixes SEVERITY (a single threshold can't tell these apart):
  - Fast burn (14.4×): budget gone in ~50 hours → the site is effectively on fire → PAGE.
  - Slow burn (1–3×):  a low-grade leak that would take days to matter → TICKET.
  One static "error rate > 1%" either pages on trivial blips or misses slow bleeds.

MULTI-WINDOW fixes DETECTION QUALITY:
  - LONG window (1h/6h): high signal, low noise — confirms the problem is REAL and
    sustained (a 30-second blip won't trip a 1h window).
  - SHORT window (5m/30m): confirms it's STILL happening NOW, so you stop alerting
    on an incident that already self-resolved (fast RESET, avoids stale pages).
  - Require BOTH → you page only on real, ongoing budget burn. This is the key
    improvement over "static threshold for N minutes," which is slow to fire AND
    slow to reset.

Comparison to naive alerting:
┌───────────────────────────┬───────────────┬────────────────┬─────────────┐
│ Approach                  │ False alarms  │ Detection speed│ Reset speed │
├───────────────────────────┼───────────────┼────────────────┼─────────────┤
│ Static threshold          │ High          │ Slow           │ Slow        │
│ Single burn-rate          │ Medium        │ Medium         │ Medium      │
│ Multi-window multi-burn   │ Low           │ Fast for fires │ Fast        │
└───────────────────────────┴───────────────┴────────────────┴─────────────┘
```

**Design-review guidance:** alert on **budget burn**, not raw error rate. Tie severity to burn rate (page vs ticket) and require long+short window agreement to get both fast detection of real fires and fast reset when they clear. This is the single highest-leverage change most teams can make to reduce alert fatigue (§11).

---

## 10. Alerting Philosophy: Golden Signals, RED, USE

### 🟢 Beginner — Warning Lights That Mean Something

A good warning light means "you, the driver, have a problem *right now*" — low fuel, open door. A bad warning light means "an internal part is at 70% of some limit" — technically true, but it makes you anxious for no reason and you learn to ignore it. Alert design is choosing lights that map to real trouble (the customer is hurting) instead of lights that just describe internal conditions.

---

### 🟡 Senior — Three Curated Signal Sets

```
FOUR GOLDEN SIGNALS (Google SRE book) — for any user-facing system:
  Latency    — time to serve a request (split SUCCESS vs ERROR latency!)
  Traffic    — demand (req/s)
  Errors     — rate of failed requests
  Saturation — how "full" the system is (queue depth, memory/CPU headroom)

RED (Tom Wilkie, Weaveworks) — for REQUEST-DRIVEN services:
  Rate, Errors, Duration.

USE (Brendan Gregg) — for RESOURCES (CPU, disk, memory, NIC, pools):
  Utilization, Saturation, Errors.
```

| Method | Author | Target | Signals |
|---|---|---|---|
| Golden Signals | Google SRE book | User-facing systems | Latency, Traffic, Errors, Saturation |
| RED | Tom Wilkie | Request-driven services | Rate, Errors, Duration |
| USE | Brendan Gregg | Resources | Utilization, Saturation, Errors |

```
"Alert on symptoms, not causes":
  SYMPTOM (page): checkout error ratio > 2% for 5m — users ARE hurt, always actionable.
  CAUSE (don't page, dashboard only): node CPU > 90% — may have zero user impact.
Use RED at the service layer to detect user pain; use USE at the resource layer to
diagnose WHICH resource caused it once a symptom fires.
```

---

### 🔴 Architect — Composing the Methods and Avoiding Anti-Patterns

```
Layered strategy in a real design:
  PAGE on:   SLO burn (§9) + golden-signal symptoms (RED errors/duration at the edge).
  DASHBOARD: USE per resource + per-dependency RED, for DIAGNOSIS after a page fires.
  Never page on a cause alone — a full disk with no user impact is a ticket, not a page.

Subtle golden-signal trap (from the SRE book):
  Measure SUCCESS and ERROR latency SEPARATELY. A total outage that returns instant
  500s makes an aggregate latency graph look FASTER — masking the incident. Split them.

Anti-patterns to name in a review:
┌────────────────────────────────┬───────────────────────────────────────────────┐
│ Anti-pattern                   │ Fix                                            │
├────────────────────────────────┼───────────────────────────────────────────────┤
│ Paging on CPU/mem/disk         │ Page on SLO/RED symptoms; keep USE for diagnosis│
│ Aggregate latency only         │ Split success vs error latency; use percentiles │
│ One static threshold           │ Multi-window multi-burn-rate (§9)              │
│ Alert with no runbook          │ Every page links a runbook + is actionable     │
│ No severity tiers              │ SEV1 page vs SEV3 ticket vs FYI dashboard      │
└────────────────────────────────┴───────────────────────────────────────────────┘
```

**Design-review guidance:** the golden signals define *what to measure*; RED/USE tell you *where* to apply them (service vs resource); symptom-based paging + burn-rate alerting decide *what wakes a human*. Get all three layers right and the pager becomes trustworthy again.

---

## 11. Dashboards, On-Call and Incident Response

### 🟢 Beginner — The Hospital Triage Board

A hospital's main board shows the few things that matter at a glance: how many patients, how many critical, average wait. It does NOT show every patient's full chart — that's a click away when a nurse needs it. And every alarm at a bedside has a clear protocol taped to the wall so any nurse, not just the specialist, knows the first three steps. Good on-call is the same: a clear top-level view, drill-down on demand, and a written protocol (runbook) for every alarm.

---

### 🟡 Senior — Dashboard Layout, Runbooks, Incident Roles

```
Top-level service dashboard — ONE screen, symptoms first:
  Row 1 (SYMPTOMS / golden signals + SLO):
    Traffic (req/s) | Error ratio | Latency p50/p95/p99 | Saturation | SLO & budget left
  Row 2+ (CAUSES / for diagnosis after a symptom fires):
    Per-dependency latency/errors (DB, cache, downstreams) | USE resource panels

Runbook per alert (linked from the alert annotation):
  1. What it means + how to confirm real user impact.
  2. Diagnosis steps (which dashboards/traces to open).
  3. Mitigation (exact commands: rollback, failover, scale).
  4. Escalation path + timeout.

Incident roles (larger incidents):
  Incident Commander (coordinates, decides) | Ops lead (hands on keyboard) |
  Comms lead (updates stakeholders/status page) | Scribe (timeline for the postmortem).
```

| Severity | Example | Response |
|---|---|---|
| SEV1 | Checkout down, revenue impact | Page immediately, all-hands, status page |
| SEV2 | Major feature degraded, workaround exists | Page on-call, urgent |
| SEV3 | Minor/partial, no user-visible impact yet | Ticket, next business day |

---

### 🔴 Architect — MTTD/MTTR, Postmortems, and the Feedback Loop

```
The recovery timeline and what each stage costs:
  failure → [MTTD] → detected → [MTTA] → acknowledged → [MTTR] → recovered
                                                          └ MTBF = gap to next failure

  Observability most directly shrinks MTTD (good symptom alerts catch it fast, often
  before customers report it) and MTTR (traces localize, logs explain → diagnose
  WITHOUT shipping new instrumentation). It does NOT directly improve MTBF — that's a
  function of better design/testing, which the POSTMORTEM feeds back into.

Blameless postmortem (Etsy/Allspaw popularized; Google SRE codified):
  - Focus on SYSTEMIC/process causes, never on punishing an individual.
  - Blameful culture → people hide mistakes, delay disclosure → repeat incidents.
  - Contents: timeline, impact (users/revenue/duration), contributing causes,
    what went well, and ACTION ITEMS with owners + due dates.
  - The action items are the point: they raise MTBF and lower MTTR next time.

FAILURE MODE — postmortems with no follow-through:
  Action items filed and never done → the same incident recurs. Track completion;
  an unactioned postmortem is theater.
```

**Design-review guidance:** treat the postmortem loop as the mechanism that converts incidents (which lower reliability) into design improvements (which raise it). Observability shortens the incident; the blameless postmortem prevents the next one. Without the loop, you just get faster at recovering from the *same* outage forever.

---

## 12. Push vs Pull and the Collection Architecture

### 🟢 Beginner — Roll Call vs Punch Clock

Two ways to know who's at work. **Pull (roll call):** the manager reads a list and calls each name — instantly obvious who's absent (no answer = absent). **Push (punch clock):** each employee clocks in themselves — perfect for someone who pops in for five minutes and leaves before any roll call, but if someone simply never clocks in, you can't tell if they're absent or just forgot. Metrics collection has the same two shapes, with the same tradeoff around detecting "missing."

---

### 🟡 Senior — The Two Models and the OTel Collector

```
PULL (Prometheus): the server scrapes each target's /metrics on an interval.
  + A failed scrape IS the down signal (`up == 0`). Central scrape config + discovery.
  - Short-lived jobs may exit before being scraped → use the Pushgateway for those.

PUSH (StatsD, Datadog agent, OTLP push, CloudWatch): clients send to a collector.
  + Natural for batch/serverless/ephemeral and clients behind NAT/firewalls (outbound).
  - "Silence" is ambiguous (down? or just idle?). Each client must know where to send.
```

| Dimension | Pull | Push |
|---|---|---|
| Down-target detection | Easy (`up==0`) | Hard (silence is ambiguous) |
| Ephemeral/batch jobs | Awkward (Pushgateway) | Natural |
| Network posture | Monitor must reach targets | Clients need only outbound |
| Config location | Central | Per-client |

```
OpenTelemetry Collector — the vendor-neutral pipeline (supports BOTH models):
  receivers → processors → exporters
  receivers:  otlp, prometheus (scrape), jaeger, zipkin, hostmetrics ...
  processors: batch, memory_limiter, tail_sampling, attributes (redact PII),
              filter (drop high-cardinality), resource detection ...
  exporters:  prometheus/otlp/jaeger/loki/vendor-X ...
  Deploy as an AGENT (per node/pod, close to the app) and/or a GATEWAY (central tier
  for tail sampling + aggregation before shipping to the backend).
```

---

### 🔴 Architect — Why the Collector Tier Matters

```
Putting an OTel Collector between apps and backends buys you:
  1. VENDOR DECOUPLING: switch backend by changing an exporter, not re-instrumenting
     hundreds of services (the core OTel value prop).
  2. TAIL SAMPLING: only a central, stateful gateway can see whole traces to keep
     errors/slow ones (§7). Can't do this in each app.
  3. COST CONTROL AT THE EDGE: drop high-cardinality labels, redact PII, batch, and
     aggregate BEFORE data hits the (metered) backend — cutting egress + ingest cost.
  4. RESILIENCE: buffering/retry so a backend blip doesn't drop telemetry or backpressure
     the app.

FAILURE MODE — collector as a single point of failure / bottleneck:
  A central gateway that OOMs or falls behind blinds the whole fleet at once. Mitigate:
  run agents (local, cheap, resilient) feeding a horizontally scaled gateway; set
  memory_limiter; shard tail-sampling by trace_id so scaling out is possible.

Capacity note: tail sampling requires all spans of a trace to reach the same gateway
instance → you need consistent routing by trace_id (load-balancing exporter), or you
lose spans and produce partial traces.
```

**Design-review guidance:** put a Collector in the path from day one even if you only use one backend today — it's the seam that gives you sampling, cost control, PII redaction, and vendor portability without touching application code later.

---

## 13. The Cost of Observability at Scale

### 🟢 Beginner — The Security-Camera Budget

You *could* record every camera in 4K forever, but the storage bill would dwarf the value of the store itself. So you make choices: keep entrances in high detail, hallways in low, delete last month's footage, and always keep any clip where the alarm went off. Observability is the same budgeting exercise — keep the valuable signals in full detail, thin out the boring bulk, and never delete the footage of the incident.

---

### 🟡 Senior — Where the Money Goes, and the Levers

```
Cost drivers by pillar:
  Metrics: number of active SERIES (cardinality × scrape frequency × retention).
  Logs:    raw volume × indexing overhead × retention × replication.
  Traces:  spans/sec × attributes/span × retention (before sampling).

Levers (each trades money for some fidelity):
  Metrics: cap cardinality (§4) · drop unused series · longer scrape interval ·
           recording rules · downsample old data (Thanos/Mimir tiers).
  Logs:    sample non-errors (NEVER errors) · retention tiers hot→cold→delete ·
           drop verbose fields · index labels only (Loki) · demote counters to metrics.
  Traces:  head-based to bound volume + tail-based to keep the interesting ·
           trim span attributes · shorter retention.
  Cross:   aggregate/redact at the Collector edge · route by value (audit long, debug short).
```

| Lever | Saves | Sacrifices |
|---|---|---|
| Cardinality cap | Metric RAM/storage | Some slice-able dimensions |
| Downsampling | Long-term metric storage | High-res history |
| Log sampling (non-error) | Log storage/index | A specific success log |
| Retention tiering | Storage $ | Fast access to old data |
| Trace sampling | Trace storage | Some traces (keep errors!) |

---

### 🔴 Architect — Treating Telemetry as a First-Class Cost Line

```
The uncomfortable pattern: at scale the observability bill can reach a large fraction
of — occasionally rival — the infrastructure it monitors. Publicly reported cases of
very large SaaS-observability bills exist; treat specific dollar figures as "verify
before quoting," but the phenomenon is real and common.

Illustrative math (plug in your own numbers):
  Logs: 50k req/s × 1KB/log = 50MB/s ≈ 4.3 TB/day raw; ×(index + replication) →
        provisioned storage several× that; over weeks of retention → a major line item.
  Metrics: 2M active series × ~a few KB working set → multi-GB RAM per Prometheus,
        ×(HA pairs + long-term store). Doubling cardinality doubles it.

Governance an architect puts in place:
  - Per-team cardinality + log-volume budgets, with dashboards on their own usage.
  - Value-based routing: SLO-relevant metrics = full resolution; bulk debug data =
    sampled + short retention.
  - "Never sample errors" as a hard rule; sample the boring middle aggressively.
  - Review telemetry cost in capacity planning, not as an afterthought line item.

The core tradeoff — cost vs fidelity/retention: every lever raises the chance the exact
signal you need during the NEXT incident was dropped or downsampled. Spend fidelity
where it pays back (errors, SLO metrics, tail latency); starve it everywhere else.
```

**Design-review guidance:** budget telemetry like compute. The failure mode isn't just a big bill — it's a big bill that *also* deleted the one trace you needed. Optimize for "keep the signal that shortens MTTR," not for a flat sampling percentage.

---

## 14. Failure Modes and Chaos Engineering

### 🟢 Beginner — Testing the Smoke Alarm

You don't wait for a real fire to find out the smoke alarm's battery is dead. You press the test button on purpose, in daylight, while everyone's calm. Chaos engineering is pressing the test button on your production system — deliberately causing small, controlled failures during a planned window to prove that both the system *and* your alarms actually work before a real emergency.

---

### 🟡 Senior — Common Observability Failure Modes

```
Failure 1 — Cardinality explosion (§4):
  Cause: high-cardinality label added to a hot metric.
  Symptom: Prometheus RAM climbs → OOM loop → dashboards blank.
  Detect: prometheus_tsdb_head_series growth; topk(count by(__name__)).
  Fix: labeldrop at scrape; revert; cardinality governance.

Failure 2 — Alert fatigue:
  Cause: too many cause-based/non-actionable alerts.
  Symptom: pager ignored; real incidents missed.
  Detect: alerts/week, % acknowledged, % actioned.
  Fix: page on symptoms/burn only; runbooks; severity tiers; delete noisy alerts.

Failure 3 — Silent failure (no signal):
  Cause: service returns 200 with wrong/empty body; or an un-instrumented path.
  Symptom: dashboards green while users suffer.
  Detect: outcome-based SLIs (validate responses), not just exception counts.
  Fix: instrument OUTCOMES; add synthetic/black-box probes of real user journeys.

Failure 4 — Broken traces:
  Cause: one hop doesn't propagate context (or a queue drops it).
  Symptom: one request appears as two disconnected traces.
  Detect: orphan-span rate; CI test that a request = one connected trace.
  Fix: enforce propagation in shared middleware/mesh.

Failure 5 — Telemetry takes down the app:
  Cause: synchronous logging to a slow sink blocks request threads.
  Symptom: app latency tracks the logging backend's health.
  Detect: correlation between log-sink lag and request latency.
  Fix: async bounded buffers that DROP (+count) rather than block.
```

---

### 🔴 Architect — A Game Day That Tests the Observability Itself

```
Goal: prove the telemetry can DETECT, LOCALIZE, and EXPLAIN failures — not just
      that the service survives them. Run announced, in a controlled slice.

Inject (one per run):
  - Latency:  +500ms on one dependency (tc netem / mesh fault injection).
  - Errors:   force 5% 5xx from a downstream.
  - Saturation: throttle a connection pool / fill a queue.
  - Silent:   return 200 with empty body (nastiest — no error signal).
  - Blind spot: kill the metrics endpoint on some pods; does `up==0` fire?

Assertions your telemetry MUST pass:
  1. DETECT:   a SYMPTOM/burn-rate alert fires within the MTTD target. (If not → gap.)
  2. LOCALIZE: a trace waterfall points to the injected service quickly.
  3. EXPLAIN:  logs joined by trace_id show the true cause.
  4. NO BLIND SPOT: the silent-failure case still trips an OUTCOME-based SLI.
  5. RESILIENCE: telemetry loss/backpressure does NOT degrade the serving path.

Pass criteria: detection within target MTTD, correct service from a trace, cause in
correlated logs, and zero need to ship new instrumentation mid-incident.
```

**Design-review guidance:** an observability stack you've never failure-tested is a hypothesis, not a capability. Game days convert "we think we'd see it" into "we proved we see it," and they most often reveal the *silent failure* and *broken trace* gaps that pure uptime testing never touches.

---

## 15. Real-World Implementations and Production Incidents

### 🟢 Beginner — Everyone Uses the Same Building Blocks

Almost every large system is built from the same observability parts — Prometheus/Grafana for metrics, OpenTelemetry for instrumentation, Jaeger/Zipkin for traces, ELK/Loki for logs, and Google's SRE ideas (SLOs, error budgets, golden signals) for how to use them. The *parts* are standard; what differs is the *policies* — how much to sample, what to alert on, how strict the SLOs are.

---

### 🟡 Senior — The Standard Stack and Its Lineage

```
Metrics:   Prometheus (CNCF; originated at SoundCloud, inspired by Google's internal
           "Borgmon") + Grafana for dashboards. PromQL is the de-facto query language.
Traces:    OpenTelemetry (CNCF; merger of OpenTracing + OpenCensus, ~2019) for
           instrumentation; Jaeger (originated at Uber) and Zipkin (originated at
           Twitter, based on Google's "Dapper" tracing paper, 2010) as backends;
           Grafana Tempo as a newer store.
Logs:      ELK / Elastic Stack (Elasticsearch + Logstash + Kibana, + Beats) for
           full-text; Grafana Loki for label-indexed, cheap logs.
SaaS:      Datadog, New Relic, Honeycomb (high-cardinality, event-based; Charity Majors
           championed the "observability" framing around unknown-unknowns).
Doctrine:  Google's SRE book (Four Golden Signals, SLO/error budget) and SRE Workbook
           (multi-window multi-burn-rate alerting) are the canonical references.
```

| Concern | Open-source default | Common SaaS |
|---|---|---|
| Metrics | Prometheus + Grafana | Datadog, Chronosphere |
| Traces | OTel + Jaeger/Tempo | Datadog APM, Honeycomb |
| Logs | Loki or ELK | Datadog Logs, Splunk |
| Instrumentation | OpenTelemetry (vendor-neutral) | (all consume OTLP) |

*(Historical attributions above — Borgmon/Dapper origins, project lineages — are widely documented, but confirm exact dates against primary sources if precision matters.)*

---

### 🔴 Architect — Representative Production Incidents (Patterns, Not Attributions)

> These are common, widely-seen *patterns* framed as scenarios. Specific company/number attributions are omitted deliberately unless independently verifiable.

```
INCIDENT 1 — Cardinality explosion OOMs the metrics tier.
  A deploy added `user_id` (and a raw-URL `path`) to a hot counter. Series went from
  ~10k to tens of millions in minutes. Prometheus OOM-looped; dashboards blanked during
  a concurrent latency incident — the team was blind exactly when they needed sight.
  Mitigation: labeldrop at scrape + revert. Fix: cardinality budgets + CI lint.
  Lesson: the debugging dimension you most want (per-user) is the one that must live in
          traces/exemplars, never in a metric label.

INCIDENT 2 — Alert fatigue hides a real outage.
  Hundreds of cause-based alerts (CPU, disk, per-node) trained the team to ignore the
  pager. A genuine checkout outage's page sat unacknowledged among the noise.
  Fix: delete/downgrade non-actionable alerts; page only on SLO burn + golden-signal
       symptoms; add runbooks + severity tiers.
  Lesson: alert quality, not quantity. Every page must be urgent, actionable, rare.

INCIDENT 3 — Silent failure with green dashboards.
  A change made an endpoint return HTTP 200 with an empty body. Error-rate and latency
  graphs stayed green; only customer complaints surfaced it. The SLI counted "non-5xx"
  as success and never validated the payload.
  Fix: outcome-based SLIs (validate response correctness) + black-box synthetic probes
       of real user journeys.
  Lesson: instrument OUTCOMES users care about, not just thrown exceptions.

INCIDENT 4 — The observability bill outpaces the product.
  Log volume grew with a debug-heavy feature; unsampled INFO logs + full-text indexing
  drove the telemetry bill toward the infra bill. A blunt "cut logs" then dropped error
  logs too, hurting MTTR.
  Fix: sample non-errors only, tier retention, demote counters to metrics, keep 100%
       of errors. Lesson: cost-cut fidelity where it's cheap, never on error signal.

INCIDENT 5 — Broken trace across a message queue.
  Producers didn't propagate trace context into queue message headers, so consumer
  spans started new traces. An async latency problem was invisible end-to-end.
  Fix: propagate traceparent through message headers; CI assert one connected trace.
  Lesson: event-driven paths are the most common trace blind spot.
```

**Design-review guidance:** these five patterns (cardinality, alert fatigue, silent failure, cost blowout, broken async traces) cover the large majority of real observability incidents. Designing explicitly against each — cardinality governance, symptom-based paging, outcome SLIs, value-based cost tiers, enforced propagation — is what separates a stack that *looks* observable from one that *is*.

---

## 16. Pattern Recognition — Interview Signals

### 🟢 Beginner — What to Say When You Hear...

| Interview signal | Observability response |
|---|---|
| "how do you know it's healthy?" | SLIs/SLOs + golden signals, not raw CPU |
| "microservices, request is slow" | Distributed tracing + correlation IDs |
| "which node/service is the problem?" | Trace waterfall to localize; USE to find the resource |
| "too many alerts / pager ignored" | Symptom-based paging + multi-burn-rate + runbooks |
| "per-user / per-customer analysis" | Traces / wide events / exemplars — NOT metric labels |
| "our monitoring bill is huge" | Cardinality caps, sampling, retention tiering |
| "average latency looks fine but users complain" | Percentiles (p99/p99.9), split success vs error |
| "when can we ship?" | Error budget: budget left → ship; exhausted → freeze |

---

### 🟡 Senior — Decision Map

```
Choosing an SLI:
  request-driven service → good/valid ratio (availability) + latency-threshold ratio,
  measured at the edge, percentile-based, "valid" excludes 4xx/health checks.

Choosing metric vs trace vs log for a need:
  aggregate trend / alert        → metric (bounded labels).
  where across services          → trace.
  why for one specific event     → log (joined by trace_id).
  high-cardinality slicing       → trace / wide event / exemplar.

Choosing sampling:
  cost-sensitive, low volume     → head-based.
  must keep errors/slow          → tail-based (Collector gateway).
  logs                           → keep 100% errors, sample success.

Choosing push vs pull:
  long-running services in your network → pull (Prometheus).
  batch/serverless/behind NAT          → push (Pushgateway/OTLP/StatsD).

Choosing alert style:
  page → SLO burn (multi-window multi-burn-rate) + golden-signal symptoms.
  ticket/dashboard → causes (USE, per-node resources).
```

---

### 🔴 Architect — The Differentiating Follow-Ups

```
Questions that separate a senior answer in a design review:

1. "What's your SLI, measured where?"
   → good/valid ratio + latency threshold, at the edge/LB, percentile-based.

2. "What are your metric labels — and their cardinality?"
   → bounded set (method/status/route-template/region); per-user goes to traces.

3. "What do you PAGE on vs dashboard?"
   → page on SLO burn + symptoms; dashboard causes/USE for diagnosis.

4. "Head or tail sampling, and what do you retain?"
   → keep ~100% of error/slow traces; sample the boring middle; exemplars to bridge.

5. "Where's the OTel Collector, and why?"
   → in-path for vendor decoupling, tail sampling, PII redaction, edge cost control.

6. "What's your error-budget policy when it's exhausted?"
   → automatic freeze on risky change; effort → reliability until the window recovers.

7. "How would you debug a failure you didn't predict, right now, no redeploy?"
   → the observability test: high-cardinality events/traces you can query ad hoc.
```

**The one-sentence thesis for the interview:** *metrics tell you something is wrong (page on SLO burn, not causes), traces tell you where (keep the error traces via tail sampling), logs tell you why (correlated by trace_id) — and cardinality, sampling, and retention are the levers that keep it all affordable without going blind.*

---

## Quick Recall Cheat Sheet

> Close this file. Answer from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| Monitoring vs observability | Monitoring = known-unknowns (pre-set checks); observability = unknown-unknowns (ask new questions of prod, no redeploy) |
| Three pillars | Metrics = *something* wrong; traces = *where*; logs = *why*; correlate by trace_id |
| Why microservices broke it | One request fans across many processes → need cross-process causal context (tracing) |
| Metric types | Counter (up-only), gauge (up/down), histogram (aggregatable quantiles), summary (per-instance quantiles) |
| Graph rate not counter | `rate(counter[5m])`; counter-reset-aware; `irate` for volatile graphs, `rate` for alerts |
| p99 PromQL | `histogram_quantile(0.99, sum(rate(..._bucket[5m])) by (le))` |
| Cardinality | Series = product of label values; never user_id/request_id as a label → OOM |
| Histogram vs summary | Cross-instance p99 → histogram (buckets add); summary quantiles don't aggregate |
| Structured logs | JSON key/values → queryable + joinable by trace_id; free-text = grep only |
| Correlation ID | One id (= trace_id) through every service = the join key for microservice logs |
| ELK vs Loki | ELK indexes full text (rich, costly); Loki indexes labels only (cheap, scans body) |
| Span/trace | Span = one unit of work; trace = tree of spans sharing trace_id via parent_span_id |
| W3C Trace Context | `traceparent`: version-traceid(32hex)-spanid(16hex)-flags; inject/extract at boundaries |
| OpenTelemetry | Vendor-neutral API/SDK/OTLP; merges OpenTracing+OpenCensus; instrument once, swap backends |
| Head vs tail sampling | Head = cheap, decides blind; tail = keeps errors/slow but buffers all spans (Collector) |
| SLI/SLO/SLA | SLI measured, SLO internal target, SLA external contract w/ penalties; SLO stricter than SLA |
| Error budget | 1 − SLO; 99.9%/30d = 43.2 min, 99.99%/30d = 4.32 min; spend on velocity, freeze when gone |
| Good SLI | good events / valid events, near the user, percentile/ratio — never an average |
| 100% SLO is wrong | Unachievable (deps < 100%), cost explodes per nine, zero budget = can't ship |
| Symptoms not causes | Page on user pain (SLO burn, RED errors); CPU/USE for diagnosis only |
| Four Golden Signals | Latency, Traffic, Errors, Saturation (Google SRE book); split success vs error latency |
| RED vs USE | RED (Wilkie) services: Rate/Errors/Duration; USE (Gregg) resources: Utilization/Saturation/Errors |
| Multi-window multi-burn | Fast burn → page, slow burn → ticket; long+short windows → fast fire, fast reset |
| Burn rate | budget% = burn × (T/window); 14.4×1h=2%, 6×6h=5%, 3×1d=10%, 1×3d=10% (99.9% SLO) |
| Alert fatigue fix | Page only actionable symptoms; runbook links; severity tiers; `for:` durations |
| Dashboard order | Symptoms (golden signals/SLO) on top; causes/USE below; one screen |
| MTTD/MTTR/MTBF | Observability cuts MTTD + MTTR; MTBF comes from design/postmortem follow-through |
| Blameless postmortem | Fix system not person; blame → cover-ups → repeats; action items with owners |
| Runbook | Step-by-step per alert; linked in annotation; cuts MTTR & MTTA |
| Push vs pull | Pull (Prometheus) easy down-detection + long-running; push for batch/serverless/behind-NAT |
| OTel Collector | In-path seam: vendor decoupling, tail sampling, PII redaction, edge cost control |
| Cost levers | Cardinality caps, sampling, retention tiers, downsampling; NEVER sample errors |
| Percentiles > averages | Average hides the long tail; use p50/p95/p99/p99.9; split success vs error |
| Per-customer w/o label | Traces / wide events / exemplars, not a high-cardinality metric label |
| Silent failure | 200 with bad body / un-instrumented path → green dashboards; use outcome-based SLIs + probes |
| Observability-driven dev | Design instrumentation up front (SLI, RED, spans, log fields) so first incident is debuggable |
