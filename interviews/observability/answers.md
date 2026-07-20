# Answers: Observability (Metrics, Logs, Traces, SLOs)

> Keyed to [questions.md](./questions.md). Read questions first — attempt each before coming here.
> Every answer contains code/config or a comparison table, plus named tradeoffs on decisions that matter.

---

## Level 1 — Monitoring vs Observability

### A1. Monitoring vs observability in plain language

**Monitoring** is watching a fixed set of gauges you decided to watch in advance — like a car dashboard: speed, fuel, engine temperature. **Observability** is being able to pop the hood and diagnose *any* new problem from the signals the car already emits, including problems you never anticipated.

| | Monitoring | Observability |
|---|---|---|
| Question it answers | "Is *this specific thing* I predicted broken?" | "Why is the system behaving this way?" (even unforeseen) |
| Set up | Pre-defined dashboards & alerts | Rich, high-context telemetry you can query ad hoc |
| Analogy | Car dashboard warning lights | A mechanic's full diagnostic bay |
| Fails when | The failure is one you didn't predict | Telemetry is too coarse to slice by the dimension that matters |

Monitoring is a *subset* of observability. You still need pre-built dashboards and alerts; observability is what lets you go beyond them.

---

### A2. Known-unknowns vs unknown-unknowns

- **Known-unknowns**: failure modes you can anticipate — "the disk might fill up," "the DB might get slow." You write a specific check/alert for each. This is **monitoring's** domain.
- **Unknown-unknowns**: failures you could not have predicted — "requests from Android clients on one carrier, hitting one shard, during cache warm-up, fail only for premium users." You cannot pre-write a dashboard for a combination you never imagined. This is **observability's** domain.

```
Monitoring:      you enumerate the questions in advance → alerts fire on those.
Observability:   you keep enough high-cardinality context that you can invent
                 a new question at 3 a.m. and get an answer without shipping code.
```

The practical test: *"Can I answer a brand-new question about production right now, without deploying new instrumentation?"* If yes, you have observability. If you have to add a log line and redeploy, you only had monitoring.

---

### A3. Why microservices broke monitoring

In a monolith, one process handled a request end to end. A single stack trace and one set of host metrics told the whole story. When you split into microservices, **a single user request now fans out across dozens of independently deployed processes**, so:

```
Monolith:     [Request] → one process → one log file, one stack trace. Root cause is local.

Microservices: [Request] → API GW → auth → cart → pricing → inventory → payments → ...
               "Checkout is slow" — but WHICH of the 12 hops? No single process knows.
               Each service only sees its own slice; nobody sees the whole request.
```

The specific thing that broke: **causal, cross-process context**. Per-host CPU/memory monitoring still works, but it no longer answers "why is this request slow" because the answer spans many hosts. This is exactly why **distributed tracing** (following one request across all hops) became mandatory, and why correlation IDs stitch logs together.

---

### A4. The three pillars and their limits

| Pillar | Best question | Strength | Weakness (what it's bad at) |
|---|---|---|---|
| **Metrics** | "Is the rate/error/latency trend normal?" | Cheap, aggregatable, great for alerting & dashboards | No per-request detail; high-cardinality dimensions blow up storage |
| **Logs** | "What exactly happened for this event?" | Maximum detail per event | Expensive at scale; hard to aggregate; noisy |
| **Traces** | "Where did this request spend its time across services?" | Shows causality & latency breakdown across hops | Usually sampled → you may not have the one trace you need |

**What goes wrong relying on one pillar:**
- **Metrics only:** you see error rate spiked to 5% but have no idea *which* requests or *why*.
- **Logs only:** you can reconstruct one request, but can't see the aggregate trend, and the bill is enormous.
- **Traces only:** you see one slow request's path, but not whether it's systemic or a one-off, and sampling may have dropped the interesting ones.

The three are complementary: **metrics tell you *something* is wrong, traces tell you *where*, logs tell you *why*.** Modern practice (OpenTelemetry, Honeycomb's "wide events") is blurring the lines by attaching high-cardinality context to structured events so you can pivot between all three.

---

## Level 2 — Metrics

### A5. The four Prometheus metric types

| Type | Semantics | Use case | Example |
|---|---|---|---|
| **Counter** | Monotonically increasing; only goes up (resets to 0 on restart) | Count of events | `http_requests_total`, `errors_total` |
| **Gauge** | Arbitrary value that goes up and down | A point-in-time value | `queue_depth`, `memory_bytes`, `temperature` |
| **Histogram** | Samples observations into cumulative buckets (`_bucket`, `_sum`, `_count`) | Distributions where you aggregate quantiles server-side | `http_request_duration_seconds` |
| **Summary** | Client-computed streaming quantiles (`_sum`, `_count`, plus `quantile` labels) | Per-instance quantiles when you can't aggregate | request size per instance |

The critical pair to get right in an interview is **histogram vs summary** — see A10.

---

### A6. Counter vs gauge, and why not to graph a raw counter

- **Counter**: monotonically increasing. `http_requests_total` only ever climbs (until a process restart resets it to 0).
- **Gauge**: goes up and down. `active_connections` can be 5 now and 2 later.

You almost never graph a raw counter, because a counter's *absolute value* is meaningless (it's "total since process start") and it resets on restart. What you care about is its **rate of change**:

```promql
# WRONG — a giant, ever-climbing, meaningless line with cliffs at restarts:
http_requests_total

# RIGHT — requests per second, restart-safe (rate() handles counter resets):
rate(http_requests_total[5m])
```

`rate()` and `increase()` are counter-aware: they detect the reset-to-zero and don't report a huge negative spike. **Named tradeoff — `rate()` vs `irate()`:** `rate()` averages over the whole window (smooth, good for alerting); `irate()` uses only the last two samples (responsive, good for volatile graphs but too jumpy for alerts).

---

### A7. The Prometheus pull model and exporters

Prometheus **scrapes** (pulls) metrics: each target exposes an HTTP endpoint (conventionally `/metrics`) in a text exposition format, and the Prometheus server fetches it on an interval (e.g., every 15 s).

```yaml
# prometheus.yml — Prometheus pulls from targets it discovers
scrape_configs:
  - job_name: 'api'
    scrape_interval: 15s
    kubernetes_sd_configs:   # auto-discover pods
      - role: pod
```
```
# What a target exposes at GET /metrics:
http_requests_total{method="GET",status="200"} 48123
http_request_duration_seconds_bucket{le="0.1"} 47000
```

An **exporter** is a sidecar/agent that translates a system's native stats into the Prometheus format for things that can't expose `/metrics` themselves. Examples: **node_exporter** (Linux host CPU/mem/disk), **blackbox_exporter** (probes HTTP/TCP/ICMP from outside), **kube-state-metrics**, `mysqld_exporter`.

**Named tradeoff — pull vs push:** pull makes it trivial to detect a *down* target (a failed scrape = target is gone) and centralizes scrape config, but struggles with short-lived batch jobs (they may exit before being scraped — you use the **Pushgateway** for those). See A36.

---

### A8. PromQL: request rate and p99 latency

```promql
# Per-second request rate across all instances, averaged over 5 minutes:
sum(rate(http_requests_total[5m]))

# Error ratio (5xx / all):
sum(rate(http_requests_total{status=~"5.."}[5m]))
  /
sum(rate(http_requests_total[5m]))

# p99 latency from a histogram — aggregate buckets first, then compute the quantile:
histogram_quantile(
  0.99,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
)
```

The key idiom: for histogram quantiles you **`rate()` the `_bucket` series, `sum ... by (le)` to aggregate across instances, then `histogram_quantile()`**. Aggregating by the `le` (less-than-or-equal) label is what makes cross-instance p99 possible — and it's exactly what a summary cannot do (A10).

---

### A9. Cardinality — the trap

**Cardinality** = the number of distinct time series a metric produces. Prometheus stores **one separate time series per unique combination of metric name + label values**. Cardinality is the *product* of the distinct values of every label.

```
Metric: http_requests_total{method, status, endpoint}
  method:   5 values (GET, POST, PUT, DELETE, PATCH)
  status:  10 values
  endpoint: 20 values
  → 5 × 10 × 20 = 1,000 time series.  Fine.

Now add user_id (1,000,000 users):
  → 1,000 × 1,000,000 = 1,000,000,000 time series.  Catastrophe.
```

Each active series costs memory (roughly on the order of a few KB of RAM per series — *verify against your Prometheus version and label sizes*; it is not free). A billion series will OOM-kill the Prometheus server. **The rule: labels must be *bounded, low-cardinality* dimensions.** Good labels: `method`, `status`, `region`, `endpoint` (a fixed route template, not the raw URL with IDs). Poison labels: `user_id`, `request_id`, `email`, `session_id`, full URL paths, timestamps.

**Named tradeoff — dimensionality vs storage cost.** More labels = richer slicing but exponential series growth. When you genuinely need per-user or per-request analysis, that belongs in **traces/logs/wide events** (or exemplars), *not* metric labels (see QB1).

---

### A10. Summary vs histogram when aggregating across instances

You **cannot average or sum pre-computed quantiles**. A p99 is not additive: `avg(p99_a, p99_b) ≠ p99(a ∪ b)`.

```
Instance A p99 = 100 ms
Instance B p99 = 900 ms
"Fleet p99" ≈ avg = 500 ms   ← MATHEMATICALLY WRONG. p99 doesn't average.

Summary: each instance computes its own p99 client-side → you're stuck with
         per-instance quantiles you cannot correctly combine.

Histogram: each instance exports raw bucket COUNTS. Bucket counts ARE additive.
           You sum the buckets across instances, THEN compute the quantile.
```

| | Histogram | Summary |
|---|---|---|
| Quantile computed | Server-side, from buckets | Client-side, per instance |
| Aggregatable across instances | ✅ Yes (sum buckets by `le`) | ❌ No |
| Accuracy | Bounded by bucket boundaries | Exact per instance |
| Cost | More series (one per bucket) | Fewer series; higher client CPU |

**Rule:** if you need a fleet-wide quantile, use a **histogram**. Use a **summary** only for a single-instance quantile you'll never aggregate. This is the single most common metrics interview trap after cardinality.

---

## Level 3 — Logs

### A11. Structured logging and why JSON

**Structured logging** emits each log event as a machine-parseable object (key/value fields) instead of a human-sentence string.

```jsonc
// Structured (good) — queryable: "give me all ERROR logs for trace X with latency>1s"
{"ts":"2026-07-06T10:30:00Z","level":"error","service":"payments",
 "trace_id":"0af7651916cd43dd","user_tier":"premium","latency_ms":1830,
 "msg":"charge declined","err":"gateway_timeout"}

// Unstructured (bad) — you can only grep, and grep can't do "latency > 1s":
2026-07-06 10:30:00 ERROR payments charge declined for premium user (1830ms) gateway_timeout
```

JSON (or another structured format like logfmt/protobuf) is preferred because log aggregators can **index and query by field**: filter by `level`, group by `service`, range-filter `latency_ms`, and — critically — **join on `trace_id`**. Free-text forces brittle regex parsing and makes cross-service correlation nearly impossible.

**Named tradeoff — readability vs queryability.** JSON is harder to eyeball in a terminal (mitigate with a pretty-printer locally), but at scale you query logs in Kibana/Grafana, not `tail`, so queryability wins.

---

### A12. Correlation IDs

A **correlation ID** (request ID / trace ID) is a unique identifier generated once at the edge (API gateway) and propagated through every downstream service and log line for that request.

```
Client → API GW  (generates trace_id = abc123, injects into header)
       → auth     logs {trace_id: abc123, ...}
       → cart     logs {trace_id: abc123, ...}
       → payments logs {trace_id: abc123, ...}  ← ERROR here

Debugging: search all logs WHERE trace_id = "abc123"
           → the complete story of ONE request across ALL services, in order.
```

Without it, a failed checkout leaves you grepping 12 services' logs by rough timestamp, guessing which lines belong to the same request — impossible under load when thousands of requests interleave per second. The correlation ID is the join key that makes microservice logs usable, and it's typically the same ID as the distributed **trace ID** (A16–A17), which is what unifies logs and traces.

---

### A13. Logs vs metrics

| Dimension | Metrics | Logs |
|---|---|---|
| Granularity | Aggregated numbers over time | One record per event |
| Cost per unit | Very cheap | Expensive (storage + indexing) |
| Cardinality | Must stay low | High cardinality is fine |
| Best for | Trends, alerting, dashboards | Debugging a *specific* event |
| Retention | Long (downsampled) | Short (or sampled/tiered) |

**Use metrics when:** you want "error rate over time," "p99 latency," "requests/sec by region" — anything you alert or trend on. Cheap, fast, aggregatable.

**Use logs when:** you need the full context of one event — "what was the exact request body and error for the checkout that failed for customer 42 at 10:30?" A metric can tell you the error *rate* rose; only a log (or trace) tells you *what happened* in a specific failure.

**Rule of thumb:** alert on metrics, debug with logs and traces. If you find yourself parsing logs to compute a rate, that number should have been a metric.

---

### A14. Cutting log cost without going blind

| Lever | How it works | Fidelity cost |
|---|---|---|
| **Log levels** | Emit `INFO`+ in prod, gate `DEBUG` behind a flag or dynamic sampling | Lose verbose detail unless you dial it up during an incident |
| **Sampling** | Keep 100% of `ERROR`/`WARN`, sample `INFO`/success at e.g. 1–10% | May miss a specific successful request's log |
| **Retention tiering** | Hot (searchable) 7–14 days, then cold object storage (S3), then delete | Old logs slow/cheap to query, eventually gone |
| **Structured + drop fields** | Drop large/redundant fields (stack traces on success, verbose payloads) before ingest | Less context per line |

Additional levers: aggregate repetitive lines, move high-volume counters *out* of logs into metrics, and route by value (audit logs kept long, debug logs kept short). **Named tradeoff — cost vs incident fidelity:** the more you sample/drop, the cheaper the bill but the higher the chance the one log you need during an outage was dropped. Best practice: **never sample errors**, and keep dynamic controls to raise verbosity for a specific service during an active incident.

---

### A15. ELK vs Loki — what they index

| | ELK / Elasticsearch | Grafana Loki |
|---|---|---|
| Indexes | **Full text** of every log (inverted index on content) | **Only labels** (metadata); log body is stored compressed, not indexed |
| Query power | Rich full-text search, aggregations, fuzzy match | Label-select then brute-force scan (grep-like) over the matched streams |
| Ingest/storage cost | High (indexing every token is expensive) | Low (cheap object storage, minimal index) |
| Best when | You need arbitrary text search across everything | You mostly filter by known labels (service, level) + trace_id |

**The tradeoff — index-everything vs index-metadata.** Elasticsearch's full-text index makes any query fast but is expensive to build and store. Loki deliberately indexes *only labels* (like Prometheus does for metrics), making ingestion cheap; the price is that a content search within a stream is a linear scan. Loki wins when your access pattern is "filter by `service`/`level`/`trace_id`, then read" — which, if you have correlation IDs and good labels, is most of the time. ELK wins when you genuinely need ad-hoc full-text search over unstructured content.

---

## Level 4 — Distributed Tracing

### A16. Span, trace, parent span

- **Span** = one unit of work with a start time, duration, name, and attributes (e.g., "SQL query," "HTTP GET /cart"). It's the basic building block.
- **Trace** = the full tree of spans for a single request across all services, identified by a shared **trace ID**.
- **Parent span** = the span that caused a child span; the `parent_span_id` link is what reconstructs the tree.

```
Trace  trace_id=abc123
└─ span: API GW  /checkout            [0 ────────────────── 2000ms]
   ├─ span: auth  verify             [10 ── 40ms]      parent = API GW
   ├─ span: cart  get                [45 ── 90ms]      parent = API GW
   └─ span: payments charge          [95 ───────── 1900ms]  parent = API GW
      └─ span: db  INSERT            [120 ── 180ms]    parent = payments
```

Each span carries `trace_id` (same for the whole request), its own `span_id`, and its `parent_span_id`. Rendering these as a waterfall shows exactly where time went — here, `payments charge` dominates.

---

### A17. Context propagation and W3C Trace Context

When service A calls service B, A must pass the trace context to B so B's spans join the same trace. The standard is **W3C Trace Context**, which defines the `traceparent` HTTP header (and an optional `tracestate`):

```
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
             │  │                                │                │
          version   trace-id (16 bytes / 32 hex)  parent-id/span   trace-flags
                                                  (8 bytes/16 hex)  (01 = sampled)

tracestate: vendor-specific key=value pairs (e.g., congo=t61rcWkgMzE)
```

Flow: A's outbound HTTP client **injects** `traceparent`; B's inbound middleware **extracts** it, starts its spans with that `trace_id` and sets `parent_span_id` to A's span. This works across HTTP, gRPC (metadata), and message queues (headers). Before W3C standardized this, every vendor used its own header (Zipkin's `X-B3-*`, Jaeger's `uber-trace-id`), so A instrumented with one library couldn't propagate to B using another — **W3C Trace Context is the interop fix**, and OpenTelemetry uses it by default.

---

### A18. OpenTelemetry

**OpenTelemetry (OTel)** is a CNCF project providing a *single, vendor-neutral* set of APIs, SDKs, and a collector for generating and exporting **traces, metrics, and logs** (plus baggage). It's the **merger of OpenTracing and OpenCensus** (announced ~2019).

```
The problem it solved:
  OpenTracing  = a good tracing API standard, but NO implementation (you brought your own).
  OpenCensus   = good libraries (traces + metrics), but Google-driven, not a neutral standard.
  → Fragmentation: instrument once for vendor X, re-instrument to switch to vendor Y.

OpenTelemetry = one API + one SDK + one wire protocol (OTLP) + a Collector.
  Instrument your code ONCE against OTel; export to Jaeger, Zipkin, Prometheus,
  Datadog, Honeycomb, etc. by swapping a Collector exporter — no code change.
```

The value proposition for an architect: **instrumentation is decoupled from your observability vendor.** You avoid lock-in and avoid re-instrumenting the whole fleet when you change backends. *(Note: OTel traces and metrics are stable; logs support has matured more recently — verify the current status for your language.)*

---

### A19. Head-based vs tail-based sampling

| | Head-based sampling | Tail-based sampling |
|---|---|---|
| Decision point | At trace **start** (first span), before outcome is known | After the **entire trace** is collected |
| Can keep all errors/slow traces? | ❌ No — decides blind, may drop the interesting one | ✅ Yes — decides *because* it saw the error/latency |
| Infra cost | Cheap — drop early, little data moves | Expensive — must buffer *all* spans until the trace completes |
| Where it runs | In the SDK/client | In a stateful collector tier |

**Head-based** flips a coin at the start (e.g., "keep 1%"). Cheap, simple, but it decides *before* knowing whether the request errored or was slow — so you often lose exactly the traces you wanted. **Tail-based** waits until the whole trace is assembled, then applies rules ("keep 100% of errors, 100% of traces > 1 s, 1% of the rest"). You keep the valuable traces, but the collector must **buffer every span in memory** until the trace finishes, which is far more expensive and operationally complex at scale.

**Named tradeoff — cost vs fidelity.** Head-based = low cost, low fidelity for rare events. Tail-based = high cost, high fidelity where it matters. Many shops do head-based at low volume and graduate to tail-based (in the OTel Collector's `tailsamplingprocessor`) once losing error traces starts hurting.

---

### A20. 2s trace with no span over 200 ms

If total = 2000 ms but the longest single span is 200 ms, the time is hiding in the **gaps between spans**, not inside them. Two distinct explanations:

```
Explanation 1 — Queueing / waiting NOT captured as a span:
  The request sat in a thread-pool queue, a connection-pool wait, or a
  message-broker backlog. That wait time isn't wrapped in an instrumented span,
  so the waterfall shows idle gaps between child spans.

Explanation 2 — Serialized (sequential) short calls, or missing instrumentation:
  50 sequential 30–40 ms downstream calls = ~1.8s, none individually "slow."
  OR a chunk of work (GC pause, un-instrumented library, DNS) has no span at all.
```

The senior insight: **gaps in the waterfall are as informative as the spans.** Fixes: add spans around queue/pool waits, parallelize serialized calls, and instrument the "invisible" work (serialization, DNS, GC). This is why span *coverage* matters — a trace only shows the time you instrumented.

---

## Level 5 — SLI / SLO / SLA & Error Budgets

### A21. SLI, SLO, SLA defined

| Term | Definition | Example |
|---|---|---|
| **SLI** (Indicator) | A *measured* number: the actual quality of service | "99.95% of requests in the last 30 days returned < 300 ms and non-5xx" |
| **SLO** (Objective) | Your internal *target* for the SLI | "99.9% of requests succeed under 300 ms over 30 days" |
| **SLA** (Agreement) | A *contract* with customers, with **penalties** if breached | "99.9% uptime or we credit 10% of your bill" |

The chain: **SLI is what you measure, SLO is what you aim for, SLA is what you promise (with money attached).** Key difference between SLO and SLA: an SLO is an *internal engineering target* with no legal teeth; an SLA is an *external legal commitment* with financial penalties. **You almost always set your internal SLO stricter than your SLA** (e.g., SLA 99.9%, SLO 99.95%) so you get paged and fix things before you owe customers refunds.

---

### A22. Error budget and the math

**Error budget = 1 − SLO.** It's the amount of unreliability you're *allowed* to spend. For a 99.9% availability SLO, the budget is 0.1% of the time window.

```
Window: 30 days = 30 × 24 × 60 = 43,200 minutes.
Error budget for 99.9% = 0.1% × 43,200 = 0.001 × 43,200 = 43.2 minutes of downtime per 30 days.
```

| SLO | "nines" | Budget per 30 days | Budget per 365 days |
|---|---|---|---|
| 99% | two | 432 min (7.2 h) | 3.65 days |
| 99.9% | three | 43.2 min | 8.76 h |
| 99.95% | — | 21.6 min | 4.38 h |
| 99.99% | four | 4.32 min | 52.6 min |
| 99.999% | five | 25.9 s | 5.26 min |

*(Arithmetic: 30-day = 43,200 min, 365-day = 525,600 min; multiply by (1 − SLO). e.g. 99.99% → 0.0001 × 43,200 = 4.32 min.)*

The budget can be measured in **time** (downtime minutes) or, better for request-driven services, in **bad events**: budget = (1 − 0.999) × total_requests. At 50k req/s over 30 days ≈ 1.296e11 requests × 0.001 = ~1.3e8 allowed bad requests.

---

### A23. Error budgets drive releases

The error budget turns reliability into a **shared currency between dev and SRE**:

```
Budget remaining > 0:   ship features fast, take risks, do experiments.
                        Every failed deploy just spends budget — that's what it's for.

Budget exhausted (SLO breached this window):
                        FREEZE risky changes. All engineering effort shifts to
                        reliability (fix the regressions, add tests, harden) until
                        the budget recovers in the next window.
```

This resolves the classic dev-vs-ops tension structurally: developers *want* to ship, SREs *want* stability. Instead of arguing, both agree on the SLO up front. Feature velocity is *earned* by staying within budget. **Named tradeoff — velocity vs reliability, made explicit and self-regulating.** Spending 100% of the budget is *fine* (an unspent budget means you were too conservative and shipped too slowly); overspending triggers the freeze. This is core Google SRE practice.

---

### A24. Why 100% is the wrong SLO

A 100% SLO is a red flag for three reasons:

```
1. It's unachievable. Your dependencies (DNS, cloud provider, ISPs, the client's
   own network) already have < 100% availability. You cannot be more available
   than the chain you sit behind.

2. It's ruinously expensive. Each additional nine roughly multiplies cost
   (redundancy, review overhead, slower releases). The marginal user rarely
   perceives the difference between 99.99% and 99.999%.

3. It leaves zero error budget → zero room to ship. With no budget you can never
   take a risk, deploy, or run an experiment. Reliability and progress both stall.
```

The right target is **"reliable enough that users don't switch to a competitor,"** derived from what users actually notice — usually a small number of nines with deliberate, budgeted room to move fast. The goal is not maximum reliability; it's *appropriate* reliability at justifiable cost.

---

### A25. What makes a good SLI

A good SLI for a request-driven service is a **ratio of good events to valid events**, expressed as a percentage, measured as close to the user as possible:

```
SLI = good_events / valid_events × 100

Availability SLI = (non-5xx responses) / (all valid responses)
Latency SLI      = (requests served < 300 ms) / (all valid requests)

"valid" excludes things that aren't the service's fault (e.g., 4xx client errors,
health-check traffic) — you count what actually reflects user experience.
```

Why "good/valid" beats "average latency":

```
Average hides the tail. avg = 40 ms can coexist with p99 = 3 s.
The 1% of users hitting 3 s are the ones who churn — the average erases them.
A threshold ratio ("what % of requests were fast enough?") counts each user's
experience as pass/fail, so the unhappy tail can't be averaged away.
```

**Rule:** SLIs should be **percentile- or ratio-based, measured near the user, and reflect what users feel** (success + speed), not internal resource metrics like CPU. See QB4 on why averages lie.

---

## Level 6 — Alerting Philosophy

### A26. Alert on symptoms, not causes

**Symptom** = something the *user* experiences (high error rate, slow responses, SLO burn). **Cause** = an internal condition that *might* lead to a symptom (high CPU, a full disk, one dead node).

```
Same failure, two ways to alert:

CAUSE alert:   "Node-7 CPU > 90%"        → but users may be totally fine (headroom, LB
                                            routed around it). Fires constantly. Ignored.

SYMPTOM alert: "Checkout error rate > 2% for 5m"  → users ARE being hurt right now.
                                                     Always worth waking someone.
```

Alert on symptoms because **that's what actually maps to user pain and is always actionable.** Causes are noisy: CPU can be high with zero user impact (over-provisioned batch job) or low while users suffer (a downstream dependency is timing out — CPU is idle *waiting*). Use cause metrics for **dashboards and diagnosis** (they help you find *why* during an incident), but **page on symptoms**. The Four Golden Signals and RED are symptom-oriented for exactly this reason.

---

### A27. The Four Golden Signals

The **Four Golden Signals** come from Google's SRE book (the "Monitoring Distributed Systems" chapter). If you can only measure four things about a user-facing system:

| Signal | What it measures | Example metric |
|---|---|---|
| **Latency** | How long requests take (split success vs error latency!) | p50/p95/p99 request duration |
| **Traffic** | How much demand | requests/sec, transactions/sec |
| **Errors** | Rate of failed requests | 5xx rate, failed-transaction ratio |
| **Saturation** | How "full" the system is | queue depth, memory/CPU headroom, thread-pool utilization |

A subtle point from the book: **measure latency of successful and failed requests separately** — a fast failure (instant 500) can otherwise make your latency graph look *better* during an outage. These four are symptom-centric and are the backbone of most service dashboards (A31).

---

### A28. RED vs USE

Both are curated subsets of the golden signals, aimed at different targets:

| | RED method | USE method |
|---|---|---|
| Author | Tom Wilkie (Weaveworks) | Brendan Gregg |
| Applies to | **Request-driven services** (microservices, APIs) | **Resources** (CPU, disk, memory, NICs, queues) |
| Measures | **R**ate, **E**rrors, **D**uration | **U**tilization, **S**aturation, **E**rrors |
| Question | "Are my services serving requests well?" | "Is this resource maxed out or failing?" |

```
RED (per service):     Rate       = requests/sec
                       Errors     = failed requests/sec (or ratio)
                       Duration   = latency distribution (p50/p99)

USE (per resource):    Utilization= % time the resource was busy (e.g., CPU 70%)
                       Saturation = queued/waiting work (e.g., run-queue length)
                       Errors     = error events (e.g., disk I/O errors, ECC)
```

**When to use which:** RED for the *service* layer (what users hit), USE for the *resource* layer (what services run on). They're complementary — RED tells you a service is slow; USE tells you *which underlying resource* is the bottleneck. Both echo the golden signals (Errors appears in both; USE's Utilization/Saturation ≈ golden Saturation; RED's Rate/Duration ≈ golden Traffic/Latency).

---

### A29. Multi-window, multi-burn-rate alerting

**Burn rate** = how fast you're consuming the error budget relative to the rate that would exactly exhaust it over the SLO window. Burn rate 1 = you'll spend exactly 100% of the budget by the window's end; burn rate 14.4 = you're burning 14.4× too fast.

```
Budget consumed in time T at burn rate B  =  B × (T / window).
For a 99.9% SLO, 30-day window (720 hours):
  B=14.4 over 1h  → 14.4 × (1/720)  = 2%  of budget burned  → PAGE (fast burn)
  B=6    over 6h  → 6    × (6/720)  = 5%                     → PAGE
  B=3    over 1d  → 3    × (24/720) = 10%                    → TICKET (slow burn)
  B=1    over 3d  → 1    × (72/720) = 10%                    → TICKET
```

- **Multi-burn-rate** fixes *severity*: a fast burn (about to blow the whole budget in hours) pages immediately; a slow burn (a low-grade leak) opens a ticket instead of waking someone. One threshold can't distinguish "the site is down" from "0.2% of requests fail."
- **Multi-window** fixes *false positives and slow detection*: pairing a **long window** (say 1 h — confirms the problem is real and sustained) with a **short window** (say 5 min — confirms it's *still happening now*, so you don't page on an issue that already resolved). You alert only when **both** windows agree.

This is the recommended pattern from the Google **SRE Workbook** ("Alerting on SLOs"). *(The exact burn-rate/window values above are the Workbook's illustrative recommendations — verify against the current text.)*

---

### A30. 200 alerts, everyone ignores the pager

This is **alert fatigue** — the pager has cried wolf so often that real incidents get ignored. The diagnosis is almost always: too many alerts on **causes** and non-actionable conditions.

```
Root causes:
  - Cause-based alerts (CPU high, disk 70%) that don't map to user pain → noise.
  - Non-actionable pages ("something looks odd") with no clear response.
  - No severity tiers → everything pages at 3 a.m.
  - Flapping alerts with no "for: 5m" duration or hysteresis.

The fix:
  1. Page ONLY on symptoms tied to an SLO (error-budget burn, golden signals).
  2. Every page must be actionable AND link a runbook — if there's no action, it's
     not a page (downgrade to a ticket/dashboard).
  3. Tier severities: SEV1/page vs SEV3/ticket vs FYI/dashboard.
  4. Add "for:" durations and burn-rate windows to kill flapping.
  5. Track "alert actionability": review every page in the postmortem — if nobody
     acted on it, delete or downgrade it.
```

The target metric: **every page should be urgent, actionable, and rare.** A useful heuristic — if a page can wait until morning, it should never have been a page. Fewer, higher-quality alerts restore trust in the pager.

---

## Level 7 — Dashboards, On-Call & Incident Response

### A31. What belongs on a top-level service dashboard

A top-level dashboard should answer "is this service healthy?" in **5 seconds**, ordered from **user-facing symptoms at the top → causes/resources below**:

```
TOP (symptoms — the golden signals / RED):
  1. Traffic    — requests/sec (is demand normal?)
  2. Errors     — error rate / ratio (are we failing users?)
  3. Latency    — p50 / p95 / p99 (success vs error latency separately)
  4. Saturation — queue depth, pool utilization (how close to the edge?)
  5. SLO panel  — current SLI vs SLO, error budget remaining this window

BELOW (causes — for diagnosis once a symptom fires):
  6. Per-dependency latency/errors (DB, cache, downstream services)
  7. Resource USE metrics (CPU, memory, GC, connections)
```

**Ordering principle: symptoms first, causes second** — mirroring "alert on symptoms" (A26). The top row tells you *if* something's wrong; the lower rows help you find *why*. Keep the top-level dashboard small (one screen); link to detailed per-dependency dashboards for drill-down. Avoid the anti-pattern of a 60-panel "wall of graphs" nobody can read under stress.

---

### A32. MTTD, MTTR, MTTA, MTBF

| Metric | Meaning | What reduces it |
|---|---|---|
| **MTTD** | Mean Time To **Detect** — failure start → someone/something notices | Good alerting + SLO burn alerts |
| **MTTA** | Mean Time To **Acknowledge** — alert fires → human engages | On-call rotation, escalation policy |
| **MTTR** | Mean Time To **Recover/Repair** — detect → service restored | Runbooks, good telemetry, rollback tooling |
| **MTBF** | Mean Time **Between Failures** — reliability/frequency of incidents | Better engineering, testing, chaos |

**Observability most directly reduces MTTD and MTTR.** MTTD drops because good symptom-based alerts catch problems fast (often before customers report them). MTTR drops because rich telemetry (traces to find *where*, logs to find *why*) lets you diagnose without shipping new instrumentation — the whole point of observability (A2). Observability doesn't directly improve MTBF (that's about *preventing* failures via better design/testing), though good postmortems feed back into it.

---

### A33. Blameless postmortems

A **blameless postmortem** is a written retrospective after an incident that focuses on **systemic and process causes, never on punishing an individual**. The word "blameless" is load-bearing.

```
Blameless framing:  "The deploy tool allowed a config with no validation to reach
                     prod, and the canary stage was skipped under time pressure."
                     → Fix: add validation + enforce canary. System gets safer.

Blameful framing:   "Sarah pushed a bad config."
                     → Fix: nothing. Sarah (and everyone watching) now HIDES mistakes,
                       delays reporting, and the same trap catches the next person.
```

**Why blameless:** if people fear punishment, they conceal information, and you lose the honest timeline you need to actually fix the system. Blamelessness assumes people acted reasonably given what they knew, and asks "what about the *system* let this happen?" **Anti-pattern it prevents: the culture of blame**, which produces cover-ups, slow disclosure, and repeat incidents. (Popularized by Etsy/John Allspaw and codified in Google SRE practice.) A good postmortem also has: timeline, impact, root cause(s), and concrete action items with owners.

---

### A34. Runbooks

A **runbook** is a step-by-step operational guide for a specific alert: what it means, how to confirm impact, how to diagnose, and how to mitigate (with exact commands/dashboards).

```
Runbook: "Checkout error rate > 2%"
  1. Confirm: open the Checkout SLO dashboard, verify burn rate.
  2. Check dependencies panel: is payments/DB/cache the source?
  3. If a recent deploy (< 30m): roll back with `deploy rollback checkout`.
  4. If DB saturation: fail over read replica, page DBA.
  5. Escalation: if not mitigated in 15m, page the payments lead.
```

**Why link it from the alert:** the person paged at 3 a.m. is often not the expert on that service. A linked runbook turns a panicked "what do I even do?" into a checklist, directly cutting **MTTR** and MTTA. **What goes wrong without it:** the responder wastes precious minutes rediscovering context that someone already knew, escalations happen late, and outages last longer. The alert annotation should contain the runbook URL (`annotations: { runbook_url: ... }` in a Prometheus/Alertmanager rule).

---

## Level 8 — Architect-Level Tradeoffs

### A35. A cardinality-explosion incident end to end

```
SYMPTOM:
  Prometheus server memory climbs steadily, then OOM-kills and restarts in a loop.
  Query latency spikes; dashboards time out; Grafana shows gaps. Ingestion falls behind.

ROOT CAUSE:
  A well-meaning deploy added a high-cardinality label to a hot metric, e.g.:
    http_requests_total{..., user_id="...", session_id="..."}
  Series count exploded from ~10k to tens of millions. Each unique label combo is a
  new series consuming RAM (roughly a few KB each — verify locally). Memory blew up.

IMMEDIATE MITIGATION (stop the bleeding):
  1. Identify the offender: `topk(10, count by (__name__)({__name__=~".+"}))`
     and check `/status/tsdb` for the highest-cardinality metrics/labels.
  2. Drop the label at scrape time with metric_relabel_configs (labeldrop / drop the
     bad series) so Prometheus stops ingesting it — no app redeploy needed:
        metric_relabel_configs:
          - source_labels: [user_id]
            action: labeldrop
  3. Revert the offending deploy.

LONG-TERM FIX:
  - Move per-user/per-request analysis to traces / logs / exemplars, NOT metric labels.
  - Enforce a cardinality budget: CI lint on metric definitions, series-count limits
    per team, and alerts on `prometheus_tsdb_head_series` growth.
  - Educate: labels are for BOUNDED dimensions only (A9).
```

**Named tradeoff — dimensionality vs stability.** Every label you add is a multiplier on series count; treat metric labels as a scarce, governed resource.

---

### A36. Push vs pull for metrics

| | Pull (Prometheus scrapes `/metrics`) | Push (client sends to a gateway/agent) |
|---|---|---|
| Down-target detection | Easy — a failed scrape *is* the signal | Hard — silence is ambiguous (down? or just quiet?) |
| Short-lived / batch jobs | Awkward (may exit before scrape → Pushgateway) | Natural — job pushes before exiting |
| Service discovery | Central, in the monitoring system | Each client must know where to send |
| Firewalls / network | Monitoring must reach targets | Clients only need outbound → good across network boundaries |
| Examples | Prometheus, most exporters | StatsD, Datadog agent, OTLP push, CloudWatch |

**Named tradeoff — operational simplicity vs job lifecycle fit.** Pull is simpler to operate and makes liveness obvious (great for long-running services). Push fits ephemeral workloads (serverless, cron/batch, functions that die in seconds) and traverses restrictive networks better.

**When each wins:** long-running services in a network you control → **pull** (Prometheus). Short-lived jobs, serverless, or clients behind NAT/firewalls → **push** (Pushgateway, OTLP, StatsD). Many stacks do both: pull for services, push for batch. OpenTelemetry supports both models via the Collector.

---

### A37. Controlling observability cost across all three pillars

At scale, telemetry volume grows with traffic *and* with dimensionality, so cost can rival or exceed the monitored system. Levers per pillar, and the fidelity each sacrifices:

| Pillar | Cost lever | Fidelity sacrificed |
|---|---|---|
| **Metrics** | Cap cardinality; drop unused series; increase scrape interval; downsample old data | Coarser time resolution; fewer slice-able dimensions |
| **Metrics** | Recording rules to pre-aggregate; longer-term downsampled tier (Thanos/Cortex/Mimir) | Lose raw high-resolution history |
| **Logs** | Sample non-error logs; tier retention (hot→cold→delete); drop verbose fields; index labels only (Loki) | May miss a specific event's log; slower cold queries |
| **Traces** | Sample (head-based cheap, tail-based keep-the-interesting); reduce span attributes | Miss some traces; less per-span context |
| **All** | Route by value (keep audit/compliance long, debug short); aggregate at the edge (OTel Collector) | Less granular low-value data |

**Named tradeoff — cost vs fidelity/retention.** Every lever trades money for the chance that the exact signal you need during an incident was dropped or downsampled. The architect's job is to spend fidelity where it pays off: **never sample errors, keep SLO-relevant metrics at full resolution, and aggressively sample/expire the high-volume low-value bulk.** Public reports of companies' observability bills reaching a large fraction of their cloud spend are common — treat telemetry as a first-class cost line, not an afterthought. *(Specific dollar figures for individual companies have circulated publicly but should be verified before quoting.)*

---

### A38. Observability-driven development

**Observability-driven development (ODD)** treats "how will I understand this in production?" as a **design requirement**, considered while writing the code — not bolted on after the first outage.

```
Bolt-on (reactive):  ship feature → outage → "we're blind" → scramble to add logs →
                     redeploy → wait for it to happen again. Slow, painful, repeated.

ODD (proactive):     while designing a feature, decide up front:
                     - What SLI defines "working" for this? (define the SLO)
                     - What metrics (RED) will it emit? What are the bounded labels?
                     - What spans/attributes make its requests traceable end to end?
                     - What structured log fields will I need to debug a failure?
                     - Propagate trace context through every new call path.
```

How it changes system design:
- You **instrument before you ship**, so the *first* production incident is debuggable.
- You favor **wide, high-cardinality structured events** (attach rich context to spans/events you can pivot on) over guessing which pre-aggregated metric you'll need.
- You design for **unknown-unknowns** (A2): the goal is to answer questions you haven't thought of yet.
- SLOs and error budgets are chosen at design time, so reliability targets shape the architecture (redundancy, timeouts, retries) rather than being discovered later.

**Named tradeoff — upfront instrumentation effort vs incident debuggability.** ODD costs engineering time before launch and pays it back the first time production breaks in a way you didn't predict. It's the difference between "we can ask any question of prod" and "we have to ship a log line and wait for it to recur."

---

## Bonus — Senior Questions

### AB1. Per-customer latency without a Prometheus `customer_id` label

You want per-customer latency, but `customer_id` is high-cardinality and would blow up metrics (A9). Options, in order of preference:

```
Option 1 — Traces / wide events (BEST for arbitrary per-customer slicing):
  Put customer_id as a SPAN ATTRIBUTE (or a field on a structured "wide event").
  Traces/events tolerate high cardinality by design. In Honeycomb/Jaeger/Tempo you
  then group-by customer_id ad hoc. This is exactly what high-cardinality tools exist for.

Option 2 — Exemplars (bridge metrics → traces):
  Prometheus/OpenMetrics exemplars attach a sample trace_id to a histogram bucket.
  You keep the cheap aggregate metric, and click through from "the slow p99 bucket"
  to an actual example trace for that request — without a customer_id label.

Option 3 — Bounded label ONLY for a few VIPs:
  If it's ~20 enterprise accounts (not a million), a low-cardinality tier label is OK:
  customer_tier="enterprise" or an allow-listed set of ~20 top accounts. Bounded = safe.

Option 4 — Logs aggregated offline:
  Emit customer_id in structured logs; compute per-customer latency in a log analytics
  system (or a data warehouse) on a slower cadence, not in the real-time metrics path.
```

**Rule:** cardinality that's too high for metrics belongs in **traces/events/logs**; use **exemplars** to jump from the cheap aggregate to the expensive detail.

---

### AB2. Chaos game day to validate the observability stack itself

The goal is to prove your telemetry can **detect, localize, and explain** a failure — testing the *observability*, not just the service.

```
Inject (pick one per run, announced game day, in staging or a controlled prod slice):
  - Latency:   add 500ms to one dependency (tc netem / service mesh fault injection).
  - Errors:    force a downstream to return 5xx for 5% of calls.
  - Saturation: throttle a connection pool / fill a queue.
  - Silent failure: return 200 with wrong/empty bodies (the nastiest — no error signal).

Your telemetry MUST prove:
  1. DETECT: did a SYMPTOM alert fire (SLO burn / RED errors or duration), and how fast?
             → measures MTTD. If nothing fired, your alerting has a gap.
  2. LOCALIZE: can a trace waterfall point to the injected service in < X minutes?
             → validates trace coverage + context propagation.
  3. EXPLAIN: do structured logs (joined by trace_id) show the actual error cause?
  4. NO BLIND SPOT: the silent-failure case checks you alert on OUTCOMES (bad responses),
             not just on thrown exceptions — a classic observability hole.

Pass criteria: symptom alert within the MTTD target, correct service identified from
               a trace, root cause visible in correlated logs, zero reliance on
               shipping new instrumentation mid-incident.
```

This ties all pillars together: **metrics/SLO detect, traces localize, logs explain** — and the game day proves that chain actually works *before* a real incident tests it.

---

### AB3. Checkout is broken — order of investigation

Use the pillars in the order **metrics → traces → logs** (broad to narrow):

```
1. METRICS / dashboard first (is it real, how bad, where):
   - Check the Checkout SLO + golden-signal dashboard. Confirm the symptom
     (error rate up? latency up? traffic drop?). Scope the blast radius
     (all users or one region/tier? started when? correlates with a deploy?).
   - This answers "IS something wrong and HOW MUCH" fastest, cheaply.

2. TRACES next (WHERE in the request path):
   - Pull traces for failing checkouts (tail-based sampling should have kept the
     errors). The waterfall shows which hop is slow/failing — e.g., payments span
     is erroring or the DB span is 10× normal. Localizes to a service.

3. LOGS last (WHY, for the specific failure):
   - Filter logs by trace_id of a failed request. The structured error field/stack
     shows the exact cause: "gateway_timeout", "connection pool exhausted", etc.

Then act: if it correlates with a deploy → roll back (fastest mitigation). Follow the
runbook (A34). Mitigate first, root-cause fully in the blameless postmortem.
```

Why this order: metrics are cheap and give you scope/severity instantly; traces narrow *where* without reading millions of logs; logs give the definitive *why* once you know which service and which request. Going straight to logs first is the rookie move — you drown in volume without knowing where to look.

---

### AB4. Average latency is 40 ms but customers complain

Both are true because **the average hides the tail.**

```
1000 requests: 990 at ~30ms, 10 at ~1000ms.
  Average = (990×30 + 10×1000)/1000 = (29,700 + 10,000)/1000 ≈ 39.7 ms.  "40ms, great!"
  But 10 users (1%) waited a full second. At 50k req/s that's ~500 unhappy users/sec.

Averages are meaningless for latency because latency distributions are long-tailed and
right-skewed; a few very slow requests barely move the mean but define user pain.
```

What to put on the dashboard instead:

| Instead of | Use | Why |
|---|---|---|
| Average latency | **p50, p95, p99, p99.9** | Percentiles expose the tail where churn happens |
| A single number | **A latency heatmap / histogram** | Shows the full distribution & bimodality |
| Overall latency | **Split success vs error latency** | Fast failures otherwise flatter the graph (A27) |

Also frame it as an **SLI**: "% of requests under 300 ms" (A25) counts each slow user as a failure instead of averaging them away. **Rule: never alert or report on average latency — always percentiles.** Google SRE guidance is explicit that you care about the tail (p99/p99.9), because at scale even the 99.9th percentile is a large number of real users.

---

## Decision Guide — Quick Reference

### Which pillar / tool for the job?

| Need | Reach for | Why |
|---|---|---|
| Alert that something is wrong | Metrics (Prometheus) + SLO burn | Cheap, aggregatable, real-time |
| Find *where* in a request path | Traces (Jaeger/Zipkin/Tempo via OTel) | Cross-service causality & latency breakdown |
| Understand *why* one event failed | Logs (ELK/Loki), joined by trace_id | Full per-event detail |
| Per-user / high-cardinality slicing | Traces / wide events / exemplars | Metrics can't hold high cardinality |
| Resource bottleneck (CPU/disk/queue) | USE metrics | Utilization/Saturation/Errors per resource |
| Service health (rate/errors/latency) | RED metrics | Request-driven symptom view |

### Which sampling strategy?

| Situation | Choice | Tradeoff |
|---|---|---|
| Low trace volume, cost-sensitive | Head-based | Cheap; may drop error/slow traces |
| Must keep all errors & slow traces | Tail-based | Buffers all spans; higher cost/complexity |
| Logs: control cost, keep incidents debuggable | Sample success, keep 100% of errors | Cheaper; may miss a specific success log |

### Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Monitoring vs observability | Monitoring = known-unknowns (pre-set checks); observability = unknown-unknowns (ask new questions of prod) |
| Three pillars | Metrics = *something* wrong; traces = *where*; logs = *why* |
| Why microservices broke it | One request fans out across many processes → need cross-process causal context (tracing) |
| Metric types | Counter (up-only), gauge (up/down), histogram (aggregatable quantiles), summary (per-instance quantiles) |
| Graph rate, not raw counter | `rate(counter[5m])`; `rate` is counter-reset-aware |
| p99 PromQL | `histogram_quantile(0.99, sum(rate(..._bucket[5m])) by (le))` |
| Cardinality trap | Series = product of label values; never use user_id/request_id as a label → OOM |
| Histogram vs summary | Need cross-instance p99? Histogram (buckets are additive); summary quantiles are not |
| Correlation ID | One ID (= trace_id) through every service → join key for logs across microservices |
| ELK vs Loki | ELK indexes full text (rich, costly); Loki indexes labels only (cheap, scan body) |
| Span/trace | Span = one unit of work; trace = tree of spans sharing a trace_id via parent_span_id |
| W3C Trace Context | `traceparent` header carries version-traceid-spanid-flags; inject/extract at boundaries |
| OpenTelemetry | Vendor-neutral API/SDK/OTLP; merger of OpenTracing + OpenCensus; instrument once |
| Head vs tail sampling | Head = cheap, decides blind; tail = keeps errors/slow, buffers all spans (costly) |
| SLI/SLO/SLA | SLI measured, SLO internal target, SLA external contract w/ penalties |
| Error budget | 1 − SLO; 99.9% over 30d = 43.2 min; spend on velocity, freeze when exhausted |
| Error-budget math | budget = (1−SLO) × window; 43,200 min/30d; multiply by (1−SLO) |
| Good SLI | good events / valid events, near the user, percentile/ratio not average |
| Symptoms not causes | Page on user pain (SLO burn, errors); use CPU/etc. for diagnosis only |
| Four Golden Signals | Latency, Traffic, Errors, Saturation (Google SRE book) |
| RED vs USE | RED (Wilkie) for services: Rate/Errors/Duration; USE (Gregg) for resources: Utilization/Saturation/Errors |
| Multi-burn-rate | Fast burn → page, slow burn → ticket; long+short windows to avoid false positives |
| Alert fatigue fix | Page only on actionable symptoms, add runbook links, tier severities, add `for:` durations |
| Dashboard order | Symptoms (golden signals/SLO) on top, causes/resources below |
| MTTD/MTTR | Observability most reduces detection & recovery time; not MTBF |
| Blameless postmortem | Fix the system not the person; blame → cover-ups → repeat incidents |
| Runbook | Step-by-step per alert; cuts MTTR; link it in the alert annotation |
| Push vs pull | Pull (Prometheus) = easy down-detection, long-running; push = batch/serverless/behind-NAT |
| Cost levers | Cardinality caps, sampling, retention tiers, downsampling; never sample errors |
| Percentiles > averages | Average hides the long tail; report p50/p95/p99/p99.9 and split success vs error |
| Per-customer w/o metric label | Use traces/wide events/exemplars, not a high-cardinality metric label |
