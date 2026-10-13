# Interview Questions: Real-Time Event Aggregation (Ad Click Aggregation / Telemetry Pipeline)

> Attempt all questions before reading [answers.md](./answers.md). Work level-by-level. Speak answers aloud.
> This topic doubles as **"design a real-time telemetry system"** — ad clicks, player events (play/pause/buffer/error), or any other high-volume event a product emits. The shape is identical.

---

## Level 1 — Fundamentals
*Goal: get the vocabulary right before scale enters the room.*

**Q1.** What is "telemetry" here, and how is it different from a business event like "user placed an order"?
**Q2.** Why can't you answer "how many clicks did ad X get today" with `SELECT COUNT(*)` once volume passes a few million rows a day?
**Q3.** What is a tumbling window? What is a sliding window? Give one use case for each.
**Q4.** What does "exactly-once" mean, and why is "exactly-once delivery" a misleading phrase?
**Q5.** *(Misconception)* A candidate says "Kafka guarantees exactly-once." What's wrong with that claim, and what's actually true?

## Level 2 — Requirements & Scale
*Goal: clarify requirements and size the system before drawing a single box.*

**Q6.** Design a real-time telemetry system for a streaming platform's ad clicks (or player events), shared across four apps/brands. What do you ask the interviewer before writing anything?
**Q7.** Given 50M DAU across four apps, each emitting roughly 20 events per session, what's the average and peak events/sec you plan for?
**Q8.** Which SLAs matter here, and which don't? Rank latency, durability, consistency, and cost.
**Q9.** What's the acceptable staleness for a "live viewers" dashboard versus a "daily ad revenue" report? Why does that one answer split the whole architecture?
**Q10.** *(Failure mode)* The business says "we need exact counts for billing AND sub-second dashboards." Why are those two different systems, not one?

## Level 3 — Ingestion API Design
*Goal: design the door before the house.*

**Q11.** Design the ingestion endpoint. What does `POST /events` look like — fields, batching, response codes?
**Q12.** How do you make ingestion idempotent when a mobile client retries a POST after a timeout?
**Q13.** What happens when the downstream Kafka cluster is unavailable — does the ingestion API block, buffer, or fail?
**Q14.** How do you apply backpressure to a producer sending faster than you can durably accept?
**Q15.** *(Failure mode)* A client bug sends the same batch of 10,000 events three times in a row. Where do you catch it, and how expensive is each layer where you could?

## Level 4 — Partitioning & Delivery Semantics
*Goal: the mechanics underneath the log.*

**Q16.** What key do you partition the Kafka topic on, and why does that choice matter more than the partition count?
**Q17.** How many partitions do you start with, and what ceiling does that number actually set?
**Q18.** What causes a consumer group rebalance, and what happens to in-flight processing when one fires?
**Q19.** At-least-once vs exactly-once — which do you pick for the hot path, and how do you get an exactly-once *effect* on top of at-least-once delivery?
**Q20.** *(Failure mode)* One partition's consumer is stuck on a poison message. What happens to the other partitions? What do you do about the stuck one?

## Level 5 — High-Level Architecture
*Goal: hot path vs cold path, and where each store earns its place.*

**Q21.** Draw the high-level architecture: clients → ??? → dashboards, and clients → ??? → billing reports.
**Q22.** What is the Lambda architecture? What problem does it solve, and what does it cost you operationally?
**Q23.** What is the Kappa architecture, and when would you pick it over Lambda?
**Q24.** Where does OpenSearch/Elasticsearch fit in this picture, and where does it explicitly not belong?
**Q25.** Where does ElastiCache (Redis) fit, and what is it serving that Kafka and OpenSearch can't serve directly?

## Level 6 — Deep Dive: Counting at Scale
*Goal: the hard middle — exactness traded for speed, on purpose.*

**Q26.** Why is a single atomic counter in DynamoDB or Redis the wrong answer for "clicks per ad, globally, per minute"?
**Q27.** What is a Count-Min Sketch, and what specific question does it answer cheaply that an exact counter can't?
**Q28.** What is HyperLogLog, and why is "unique viewers per stream" a different counting problem than "total events per stream"?
**Q29.** A mobile client was offline for 40 minutes. Its events land after the window that should contain them has already closed and reported. What do you do?
**Q30.** *(Failure mode)* Your hot-path aggregate says 2.1M clicks for the last hour. The cold-path batch job says 2.4M for the same hour. Which one is right, and how do you reconcile without re-running everything?

## Level 7 — Reliability & Scaling
*Goal: what breaks at 10x, and what you do about it before it pages you.*

**Q31.** The stream processor goes down for 20 minutes. What happens to the data while it's down, and what happens when it comes back?
**Q32.** Where do you put a circuit breaker in this system, and what does it actually protect?
**Q33.** Where do you rate-limit, and against whom — the client, the tenant, or the whole ingestion tier?
**Q34.** This pipeline is shared across four brands. One brand has a traffic spike (a live sports final). How do you stop it from starving telemetry for the other three?
**Q35.** Design for multi-region: writes happen in two regions. How do you avoid double-counting the same session across regions?
**Q36.** *(Failure mode)* The primary Kafka cluster's region goes down mid-event. What's your failover story, and what do you lose?

## Level 8 — Observability & Architect Trade-offs
*Goal: staff-level judgment — the questions a JD writes when it says "define system health."*

**Q37.** Define "system health" for this pipeline. What are your five metrics, and why those five?
**Q38.** What's the difference between alerting on consumer lag as a count versus lag as an age, and why does the second one matter more?
**Q39.** How do you detect silent data loss — the case where nothing errors, but events simply stop arriving from one client type?
**Q40.** Walk through the cost trade-off between a Kafka retention window of 3 days, 7 days, and 30 days. What does each buy you, and what does it cost?
**Q41.** *(Trade-off)* A VP asks: "why not just ingest straight into OpenSearch and skip Kafka?" What's your answer?

---

## Bonus — Questions a Senior Raises Unprompted

**QB1.** How would click fraud or bot traffic change this design?
**QB2.** If this data also drives ad billing, what changes about your consistency guarantees?
**QB3.** How do you test this system — specifically, how do you test for exactly-once *effect*, not just an exactly-once claim?
**QB4.** If you had to cut this to an MVP for a two-week spike (a single live event), what's the smallest version that's still correct?
