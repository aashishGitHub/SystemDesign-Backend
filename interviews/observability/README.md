# System Design: Observability (Metrics, Logs, Traces, SLOs)

> **Target:** Senior / Staff engineers (Google, Meta, Amazon, Uber, Datadog, Stripe, Netflix).
> **Style:** Interview-grill format — question first, then defended design choices.

---

## How to Use This Guide

1. Attempt every question in `questions.md` cold before reading answers.
2. Check `answers.md` — compare your reasoning, note what you missed.
3. Use `deep-dive.md` for senior/architect depth, real tooling, cost math, and failure modes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Monitoring vs Observability | Known-unknowns vs unknown-unknowns; why microservices broke monitoring; the three pillars |
| 2 | Metrics | Counter/gauge/histogram/summary; Prometheus pull + exporters; PromQL; the cardinality trap |
| 3 | Logs | Structured JSON logging; ELK/Loki aggregation; correlation IDs; sampling, retention, cost |
| 4 | Distributed Tracing | Spans, trace/parent IDs, W3C Trace Context, OpenTelemetry, Jaeger/Zipkin, head vs tail sampling |
| 5 | SLI / SLO / SLA & Error Budgets | Precise definitions; error-budget math; how an SLO gates releases |
| 6 | Alerting Philosophy | Symptoms over causes; Four Golden Signals; RED; USE; multi-window multi-burn-rate |
| 7 | Dashboards & Incident Response | Golden-signal dashboards; runbooks; MTTD/MTTR; blameless postmortems; severity levels |
| 8 | Architect Tradeoffs | Cardinality-explosion incidents; sampling fidelity vs cost; push vs pull; cost at scale; chaos |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 38 structured questions (8 levels + bonus QB). Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code/config or a comparison table, named tradeoffs, real tools, cheat sheet. |
| [deep-dive.md](./deep-dive.md) | Beginner → Architect depth, real-world implementations, incident patterns, chaos, cheat sheet. |

---

## Problem Statement

> You own the observability platform for a payments company running ~200 microservices on Kubernetes: 50k requests/sec at peak, a hard revenue impact per minute of downtime, and a compliance requirement to explain *any* customer-visible failure within minutes.
>
> Design how the platform emits, collects, stores, and alerts on telemetry so that:
> - An on-call engineer can answer "is the checkout flow healthy right now?" in one dashboard.
> - When checkout breaks, they can find the offending service and root cause without shipping new code.
> - The platform pages a human **only** when customers are actually being hurt.
>
> **Key Constraints:**
> - Debug failures you did not anticipate (unknown-unknowns), not just pre-defined checks.
> - Correlate a single failed request across all services it touched.
> - Alerts must be actionable — every page maps to user pain and a runbook.
> - SLOs drive release decisions; an exhausted error budget freezes risky deploys.
> - Telemetry cost must scale sub-linearly with traffic — you cannot store everything forever.

---

## How a Senior Engineer Thinks About This

A strong answer opens by separating **monitoring** (watching for failure modes you predicted — the known-unknowns) from **observability** (being able to ask new questions of a running system to explain failures you *didn't* predict — the unknown-unknowns). Microservices made this urgent: a single user request now fans out across dozens of services, so "the app is slow" has no single owner. The three pillars — metrics, logs, traces — each answer a different question, and a senior candidate states what each is *bad* at, not just good at.

Next, they anchor the design in **SLIs and SLOs** rather than raw resource metrics. The question is never "is CPU high?" but "are users getting fast, correct responses?" The error budget (1 − SLO) turns reliability into a currency: spend it on release velocity until it runs out, then stop. This reframes alerting — you page on **symptoms** (SLO burn, golden signals) not **causes** (a single node's CPU), using RED for request-driven services and USE for resources.

Finally, an architect is explicit about the tradeoffs that bite at scale: **cardinality** silently blows up metric storage, **sampling** trades trace fidelity for cost, and the observability bill can rival the infrastructure it watches. They name push vs pull, head vs tail sampling, and retention tiering as the levers — and they design instrumentation up front (observability-driven development) rather than bolting it on after the first outage.
