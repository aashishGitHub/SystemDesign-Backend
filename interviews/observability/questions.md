# Interview Questions: Observability (Metrics, Logs, Traces, SLOs)

> Attempt every question before reading [answers.md](./answers.md).
> Work level-by-level — later questions build directly on earlier concepts.

---

## Level 1 — Monitoring vs Observability
*No prior distributed-systems knowledge required. Think about what breaks first.*

**Q1.** Explain the difference between monitoring and observability to a non-engineer, in two sentences, without using the word "telemetry."

**Q2.** What are "known-unknowns" and "unknown-unknowns," and how do they map onto monitoring vs observability?

**Q3.** Why did the move from monoliths to microservices make observability much harder? Name the specific thing that broke.

**Q4.** Name the three pillars of observability, the one question each answers best, and what goes wrong if you rely on only one of them.

---

## Level 2 — Metrics
*Metrics are the cheapest pillar — and the easiest to blow up.*

**Q5.** Name the four Prometheus metric types and give a one-line use case for each.

**Q6.** What is the difference between a counter and a gauge? Why should you almost never graph a raw counter value directly?

**Q7.** Explain the Prometheus pull model. What is an exporter, and give two concrete examples.

**Q8.** Write a PromQL query for the per-second request rate over the last 5 minutes, and one for p99 latency computed from a histogram.

**Q9.** What is cardinality? Why does putting `user_id` or `request_id` into a metric label blow up Prometheus? Show the math. *(This is a classic interview trap.)*

**Q10.** You need p99 latency aggregated across 10 instances of a service. What goes wrong if each instance exports a Prometheus **summary** instead of a **histogram**?

---

## Level 3 — Logs
*The most detailed pillar and the most expensive one.*

**Q11.** What is structured logging, and why is line-delimited JSON preferred over free-text log lines?

**Q12.** What is a correlation ID (a.k.a. request ID / trace ID), and why is it non-negotiable in a microservices architecture?

**Q13.** Compare logs vs metrics. Give one scenario where you must use logs and one where metrics are the right tool.

**Q14.** Your logging bill is growing faster than traffic. Name four levers to cut log cost without going blind during an incident.

**Q15.** How do ELK/Elasticsearch and Grafana Loki differ in *what they index*, and what tradeoff does that difference create?

---

## Level 4 — Distributed Tracing
*Following one request across dozens of services.*

**Q16.** Define span, trace, and parent span, and describe how they compose into a trace.

**Q17.** How is trace context propagated across a service boundary (e.g., service A calls service B over HTTP)? Name the W3C standard and the header(s) involved.

**Q18.** What is OpenTelemetry, and what problem did it solve that OpenTracing and OpenCensus each only half-solved?

**Q19.** Compare head-based vs tail-based sampling. What does each get right, and what does each get wrong?

**Q20.** A trace shows a 2-second total request time, but no single span is longer than 200 ms. Give two distinct explanations for where the time went.

---

## Level 5 — SLI / SLO / SLA & Error Budgets
*Reliability as an engineering target, not a vibe.*

**Q21.** Define SLI, SLO, and SLA precisely, and state the key difference between an SLO and an SLA.

**Q22.** What is an error budget, and how do you derive it from an SLO? For a 99.9% availability SLO over a 30-day window, how much downtime is that? Show the arithmetic.

**Q23.** How does an error budget drive release decisions? What concretely happens when the budget is exhausted?

**Q24.** Why is a stated SLO of 100% a red flag, not an ambitious goal?

**Q25.** What makes a *good* SLI for a request-driven API, and why is "good events / valid events" a better formulation than "average latency"?

---

## Level 6 — Alerting Philosophy
*Pages should be rare, urgent, and actionable.*

**Q26.** What does "alert on symptoms, not causes" mean? Give an example of a symptom alert and a cause alert for the same failure.

**Q27.** What are the Four Golden Signals, and where do they come from?

**Q28.** Explain the RED method and the USE method. Who defined each, and when do you reach for one vs the other?

**Q29.** What is multi-window, multi-burn-rate alerting? What does the "multi-window" part fix, and what does the "multi-burn-rate" part fix?

**Q30.** Your team has 200 alert rules and everyone has started ignoring the pager. Diagnose the failure and describe how you fix it.

---

## Level 7 — Dashboards, On-Call & Incident Response
*Turning telemetry into fast recovery.*

**Q31.** What belongs on a top-level service dashboard, and what is the ordering principle for the panels?

**Q32.** Define MTTD, MTTR, MTTA, and MTBF. Which one does *good observability* most directly reduce, and why?

**Q33.** What is a blameless postmortem, why the word "blameless," and what is the anti-pattern it exists to prevent?

**Q34.** What is a runbook, and why should the alert link directly to one? What goes wrong when it doesn't?

---

## Level 8 — Architect-Level Tradeoffs
*Show design-review depth beyond the textbook answer.*

**Q35.** Walk through a cardinality-explosion incident end to end: symptom, root cause, immediate mitigation, and long-term fix.

**Q36.** Push vs pull for metrics collection: name the primary tradeoff and give one scenario where each is clearly the better choice.

**Q37.** At scale, observability can cost more than the system it watches. Name the cost levers you can pull across all three pillars, and the fidelity you sacrifice with each.

**Q38.** What is observability-driven development, and how does treating observability as a design input (not an afterthought) change the way you build a service?

---

## Bonus — Senior Questions You Should Raise Unprompted

**QB1.** You must debug latency *per enterprise customer*, but you already know you can't put `customer_id` in a Prometheus label. What do you do instead?

**QB2.** Design a chaos-engineering game day that validates your observability stack itself — not just the service. What would you inject, and what must your telemetry prove?

**QB3.** Checkout is broken right now and you're on call. Metrics, logs, and traces are all available. In what order do you use them, and why that order?

**QB4.** Your dashboard shows average latency is 40 ms and leadership is happy, but customers are complaining. Explain how both can be true and what you put on the dashboard instead.
