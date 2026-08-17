# The RADIO Framework — How to Run a System Design Interview

> **Purpose:** a repeatable structure for *answering* a system-design question out loud, so you never freeze on "where do I start?" and never run out of time in the wrong place.
> **Origin:** RADIO is [GreatFrontEnd's](https://www.greatfrontend.com/) **front-end** system-design framework. The five steps generalize cleanly to backend HLD — this guide is written **backend-HLD-first**, with the front-end mapping called out at each step so you can use it in either interview.
> **Companions:** [`docs/instructions.md`](./instructions.md) tells you how to *author a topic folder*. This file tells you how to *perform in the room*. [`docs/AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md) is the primitive→AWS→native vocabulary you'll pull from in steps A and D. [`patterns/README.md`](../patterns/README.md) is the set of reusable moves you name in step A.
> **Worked examples:** [`interviews/food-delivery/radio-walkthrough.md`](../interviews/food-delivery/radio-walkthrough.md) and [`interviews/e-commerce/radio-walkthrough.md`](../interviews/e-commerce/radio-walkthrough.md).

---

## 0. The one rule that matters most

**Spend your time in proportion to signal, not in proportion to comfort.** Most candidates over-spend on the parts they find easy (drawing boxes, listing tech names) and under-spend on the two parts interviewers actually score: **Requirements** (did you scope the right problem?) and **Optimizations / deep-dive** (can you go deep on the hard part?). RADIO exists to force that budget.

```
R ─ Requirements exploration      ~15%   ← scope. Skip this and everything after is wrong.
A ─ Architecture / high-level      ~20%   ← the boxes and arrows; name the central split.
D ─ Data model / core entities     ~15%   ← the nouns and their fields.
I ─ Interface / API definition     ~15%   ← the contract between components.
O ─ Optimizations & deep dive      ~35%   ← where senior/staff signal actually lives.
```

For a **45-minute** interview that's roughly: R ≈ 7 min · A ≈ 9 min · D ≈ 7 min · I ≈ 7 min · O ≈ 15 min. Announce the plan ("I'll scope, sketch the architecture, define entities and APIs, then go deep on the hard parts") — it signals structure before you've drawn a thing.

---

## 1. R — Requirements Exploration (~15%)

**Goal:** converge on a small, sharp problem *both* of you agree on. You are being tested on whether you scope before you build.

### Do
1. **Restate the problem** in one sentence and get a nod.
2. **Separate functional vs non-functional.** Functional = *what it does* (place an order). Non-functional = *how well* (p99 < 200 ms, no oversell, survive 10× peak).
3. **Ask clarifying questions and write the answers down** as the agreed scope:
   - Who are the actors? (customer, seller, courier, admin…)
   - What are the top 3–5 user journeys? Explicitly declare the rest **out of scope**.
   - Scale: users (DAU/MAU), request rate, data size, read/write ratio.
   - Consistency & correctness bars: what must *never* happen? (double-charge, oversell, lost write.)
   - Latency SLOs, availability target ("how many nines?"), durability, geography (single-region vs global).
4. **Do the capacity estimate here** (or defer to A) — see §6. Every later decision cites a number from this step.
5. **State assumptions explicitly** when the interviewer won't pin a number: *"I'll assume 20M orders/day; tell me if you want a different scale."*

### Front-end mapping
Ask about devices (mobile/desktop/low-end), network (offline/flaky?), i18n/RTL, accessibility (WCAG), SEO/SSR needs, real-time freshness, and which page/flow is in scope (the *menu* vs the *tracking screen* are different design problems).

### Signals & traps
- ✅ **Green flag:** you narrow scope and say what you're *not* building.
- 🚩 **Red flag:** you start drawing boxes in the first two minutes. That's answering before you know the question.
- 🚩 **Trap:** accepting "design Uber Eats" literally — it's five systems. Pick the 2–3 journeys that carry the signal.

---

## 2. A — Architecture / High-Level Design (~20%)

**Goal:** the boxes and arrows — components and how they relate — anchored on **one organizing insight (the "central split")**.

### Do
1. **Lead with the central split.** Every strong design hangs off one sentence (see table below). Say it first; the diagram is that sentence drawn.
2. **Name the dominant pattern out loud.** Before the boxes, classify the problem: *"this is fundamentally a contention problem with a multi-step process hanging off it."* That single sentence is a stronger opening than any component list, because it tells the interviewer you've seen the shape before. The eight patterns and the reverse index (which patterns each classic problem needs) are in [`patterns/README.md`](../patterns/README.md).
3. Draw client → edge (LB/API gateway/CDN) → services → data stores → async backbone (queue/stream).
4. For each component, say its **one job** and *why it's a separate box* (different scaling profile, different consistency need, different team).
5. Walk **one primary request end-to-end** through the boxes ("a customer places an order: gateway → order service → …"). A diagram you can't narrate is decoration.
6. Only *now* name concrete tech — **primitive → AWS → swap**, never a bare service name. See §7 for the script and the traps.

| Topic | Central split you lead with | Dominant pattern to name |
|---|---|---|
| E-commerce | The **consistency gradient**: browse (eventual) → cart (AP) → checkout (strong) → fulfillment (async) | contention + multi-step |
| Food delivery | **Three traffic paths**: browse (read-heavy, eventual) · order (strong, atomic) · track (write-heavy stream) | real-time + multi-step |
| Video streaming | **Write path** (upload→transcode→store) vs **read path** (play→CDN→viewer) | large blobs + long-running tasks |
| Ride sharing | **Three planes**: location ingest · matching · trip+tracking | scaling writes + real-time |
| Ticketmaster | **Two tiers**: ephemeral hold (Redis TTL) vs durable booking (ACID) | contention |
| Social feed | **Fan-out on write vs on read**, hybrid at the celebrity threshold | scaling reads + scaling writes |

### Front-end mapping
Architecture = the **component tree** + the **client/server boundary** + the **data layer** (server state cache vs client UI state) + the **rendering strategy** (CSR/SSR/SSG/streaming). The "central split" is usually *server-cache state vs local UI state*.

### Signals & traps
- ✅ **Green flag:** you justify *why each box exists* and can trace a request through them.
- 🚩 **Red flag:** a box labeled "microservices" with no job; naming Kafka before you've said what's async and why.

---

## 3. D — Data Model / Core Entities (~15%)

**Goal:** the nouns your system persists, their key fields, and which component owns each.

### Do
1. **List the entities** (the nouns from step R): User, Restaurant, MenuItem, Order, Courier, Payment, …
2. For each: **key fields**, **primary key**, and the **owning service/DB**.
3. Call out the **relationships and the access pattern that drives the choice** — the shard/partition key falls out of "how is this read most often?" (orders by `user_id`, inventory by `sku`, location by `courier_id`).
4. Note which entity needs which **store type** (see the decision tables in [`key-technologies-notes.md`](../key-technologies-notes.md) §"When to use what"): the ledger → RDBMS; the cart → AP KV; location pings → in-memory/TTL; search docs → inverted index.
5. Say each store as **primitive + AWS + native**: *"the ledger needs ACID and a unique constraint for the idempotency key — Aurora Postgres, or any RDBMS; the cart needs availability over consistency — DynamoDB, or Cassandra/Couchbase."* Mapping table: [`AWS_SERVICE_MAP.md` §1.6](./AWS_SERVICE_MAP.md#16-databases). Name the partition-key trap while you're there (a hot key needs a write-sharded suffix — big table capacity does not raise the per-partition ceiling).
6. Flag which stores are **derived, not authoritative** (search index, cache, materialized feed) and how they're kept fresh (CDC / Streams / outbox) — interviewers probe this because candidates casually make an index the source of truth.

### Front-end mapping
Data model = the **client-side state shape**: normalized server-cache entities (React Query/Apollo cache keyed by id) vs local UI state (form drafts, selected filters). Decide what's *server state* (fetched, cached, invalidated) vs *client state* (never leaves the browser).

### Signals & traps
- ✅ **Green flag:** you name the shard key and tie it to the dominant read.
- 🚩 **Trap:** modeling every field. Give the 4–6 that matter and move on.

---

## 4. I — Interface / API Definition (~15%)

**Goal:** the contract between components — endpoints, params, responses — enough that another engineer could build against it.

### Do
1. Define the **handful of endpoints** that cover the in-scope journeys. One line each:
   `POST /orders (Idempotency-Key) → 201 {order_id, status}`.
2. State **method, path, key params, response, and status codes** — especially the error/retry ones (409 conflict, 429 rate-limited, 402 payment).
3. Call out **the contract decisions that carry signal**: idempotency keys on writes, pagination (cursor not offset at scale), versioning, and *which calls are sync vs async* (return `202 Accepted` + poll/stream when the work is deferred).
4. Pick a **protocol per interaction** and justify it: REST for CRUD, WebSocket/SSE for live tracking, gRPC for internal service-to-service.

### Front-end mapping
Interface = the **client↔server data-fetching contract** (REST/GraphQL/RPC), the **component API/props** for reusable pieces, and the **event contract** for real-time (what the WS pushes). Decide over-fetch vs under-fetch, and the shape the UI actually needs.

### Signals & traps
- ✅ **Green flag:** every write that a client might retry carries an idempotency key; you say what each status code means for the caller.
- 🚩 **Trap:** designing 20 endpoints. Design the 5 that matter to the journeys you scoped.

---

## 5. O — Optimizations & Deep Dive (~35%)

**Goal:** this is the section that separates mid from senior/staff. Pick the **1–2 hardest parts** and go *deep* — failure modes, tradeoffs, numbers.

### Do
1. **Let the interviewer steer**, or propose: "The hard part here is X — want me to go deep there?"
2. For the chosen part, cover: **bottleneck → options → tradeoff → your pick → failure mode → how you detect/recover.**
3. **Work the ladder of the relevant pattern, cheapest rung first.** Each [`patterns/`](../patterns/README.md) file is a ladder, and the scoring move is starting at the bottom: contention starts at *design the race away* → conditional write → OCC → locks (distributed locks are **last**); reads start at *index/diagnose* → cache → CDN → replicas → precompute (sharding for reads is last); writes start at *write fewer times* → spread across owners → absorb bursts. Candidates who open with "I'd use a distributed lock" or "I'd shard" have skipped four cheaper rungs, and the interviewer notices.
4. Reach for the right tool with a *reason tied to a number from step R*:
   - **Caching** (which strategy, what TTL, how invalidated) — because reads dominate N:1.
   - **Replication / sharding** — because the dataset/QPS exceeds one node.
   - **Async / queue / outbox** — because the spike must become a backlog, not an outage.
   - **Idempotency / saga / guarded writes** — because a retry must not double-charge/oversell.
5. **Name the failure mode and the mitigation** (thundering herd → request coalescing + jittered TTL; hot partition → suffix/split; retry storm → backoff + circuit breaker).
6. **Name what the platform won't do for you** — exactly-once effect, cross-service transactions, fencing against a paused lock holder, and the sweeper that re-drives stuck work. See [`AWS_SERVICE_MAP.md` §4](./AWS_SERVICE_MAP.md#4-what-aws-does-not-give-you).
7. Close with **what you'd measure** (the SLOs / golden signals) — you can't operate what you can't see. Prefer **age-based** signals (backlog age, oldest stuck workflow, replication lag) over counts: a dead worker pool produces zero errors.

### Front-end mapping
Optimizations = **performance** (bundle splitting, lazy load, virtualization, image策略), **network** (request dedupe, optimistic UI, offline queue), **rendering** (CSR vs SSR vs streaming), **accessibility**, and **resilience** to flaky networks.

### Signals & traps
- ✅ **Green flag:** you go one level deeper than asked, quantify the tradeoff, and name the failure mode *and* how you'd detect it.
- 🚩 **Red flag:** breadth-only — listing ten optimizations one sentence each. Depth on two beats breadth on ten.

---

## 6. The estimation toolkit — how to defend a number

Interviewers don't want a *right* number; they want a **defensible derivation with stated assumptions**. Always: (1) state the assumption, (2) show the arithmetic, (3) sanity-check the result.

### Top-down vs bottom-up
- **Top-down:** start from the business — "20M orders/day" — and divide down to QPS, storage, bandwidth.
- **Bottom-up:** start from one unit — "one order row ≈ 1.5 KB" — and multiply up.
- Do both and check they meet in the middle. Divergence = a wrong assumption to surface.

### The five derivations you almost always need

| From | To | Formula | Worked example |
|---|---|---|---|
| Daily count | Average QPS | `count / 86,400` | 20M orders/day ÷ 86.4K s ≈ **231 orders/s** |
| Average QPS | Peak QPS | `avg × peak-multiplier` | dinner rush ~5× → **~1,200/s**; a flash sale can be 40×+ |
| QPS + record size | Write throughput | `QPS × bytes` | 231/s × 1.5 KB ≈ **350 KB/s** of order writes |
| Daily writes + size | Storage/year | `daily × size × 365` | 20M × 1.5 KB × 365 ≈ **~11 TB/yr** of orders |
| Arrival rate + lifetime | Concurrency (Little's Law) | `λ × avg_duration` | 1,200 orders/s × 2,400 s delivery ≈ **~2.9M live deliveries** → ~3M tracking connections |

### Constants worth memorizing
- **Seconds in a day ≈ 86,400 ≈ 10⁵.** (Handy: `X/day ÷ 10⁵ ≈ X per 1.16 s`.)
- 1 day ≈ 86.4K s · 1 month ≈ 2.6M s · 1 year ≈ 31.5M s.
- Powers of ten for bytes: KB 10³ · MB 10⁶ · GB 10⁹ · TB 10¹² · PB 10¹⁵.
- **Little's Law:** concurrent = arrival-rate × time-in-system. This is how you size connections, threads, and pool limits.
- Latency ladder (order-of-magnitude only): RAM ~100 ns · SSD read ~100 µs · same-DC RTT ~0.5 ms · cross-continent RTT ~150 ms. See [`key-technologies-notes.md`](../key-technologies-notes.md) "Latency Numbers."
- Availability: 99.9% ≈ 8.8 h/yr down; 99.99% ≈ 52 min/yr. **Services in series multiply** (three 99.9% deps ≈ 99.7%).

### How to present it (script)
> *"Let me size this. Assume 20M orders/day — tell me if that's off. That's 20M / 86,400 ≈ 230 orders/second average. Dinner rush concentrates maybe 30% of the day into a few hours and peaks around 5× average, so ~1,200/s peak. That's small — a single well-indexed Postgres can do low-thousands of writes/s — so **orders are not my scaling problem; the courier GPS firehose at ~125K writes/s is.** That tells me where to spend the design."*

The *point* of the number is the **decision it drives**, not the digit. Every number you state should end in "…therefore [architecture choice]."

> ⚠️ **Honesty rule (matches this repo's global instructions):** these are order-of-magnitude teaching figures. Say "approximately," state them as assumptions, and note they'd be verified against real telemetry. A confidently-wrong exact number is worse than an owned estimate.

---

## 7. Naming tech in the room — primitive → AWS → swap

The most common way a strong design gets marked down is **name-dropping**: a diagram covered in service logos with no property attached to any of them. The fix is a fixed sentence order.

### The 3-sentence tech-choice script

> *"I need ⟨**property**⟩ because ⟨**number from step R**⟩. On AWS that's ⟨**service**⟩ — the thing to watch is ⟨**gotcha**⟩. Off AWS it's ⟨**OSS**⟩, so this isn't a lock-in decision."*

Worked example:

> *"I need an at-least-once work queue with a visibility timeout and a dead-letter queue, because a transcode takes ~4 minutes and a worker crash must not lose the job. On AWS that's SQS — I'd set the visibility timeout above the p99 job duration or the job runs twice, and make the handler idempotent anyway. Self-hosted it's RabbitMQ, or Kafka if I also needed replay."*

That's four pieces of signal in one breath: the property, the justifying number, the managed service, and the failure mode. The full mapping table for every building block — plus the per-service gotchas — is [`docs/AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md).

### Read the room: how much AWS to use

| Interviewer type | How to name tech | Why |
|---|---|---|
| **Cloud-agnostic** (Google, Meta, most infra rounds) | Primitive first, AWS as a parenthetical: *"a partitioned replayable log — Kafka, or Kinesis if I'm on AWS"* | They score the property. An AWS catalog reads as narrow |
| **AWS-deep** (Amazon, AWS-shops) | Same script, but expect the follow-up to be a **quota or failure mode**, not another service | Depth is tested by "what breaks at scale?", not by listing more services. [`AWS_SERVICE_MAP.md` §3](./AWS_SERVICE_MAP.md#3-the-aws-gotchas-that-carry-senior-signal) is that prep |
| **Startup / pragmatic** | Add the **build-vs-buy and cost** angle: *"managed is 3× the unit cost but zero on-call — at our volume that's the right trade"* | Judgement, not just knowledge |

### The move that separates senior from mid

Name what the cloud **doesn't** give you. Exactly-once effect, cross-service transactions, global ordering, strong cross-region reads, circuit breakers, fencing against a paused lock holder, and the sweeper that finds stuck work — **none of these come from a service**; they're your design. Saying so unprompted is one of the highest-signal sentences available to you. ([`AWS_SERVICE_MAP.md` §4](./AWS_SERVICE_MAP.md#4-what-aws-does-not-give-you).)

### Traps

| Trap | Why it costs you | Fix |
|---|---|---|
| Fifteen service names, no properties | Reads as memorized | One primitive per box, then the name |
| "Lambda for everything" | Ignores cold starts, runtime ceiling, sustained-throughput cost | Lambda for event glue; containers for sustained/long/latency-sensitive work |
| Kinesis where SQS belongs (or vice versa) | Confuses ordering-unit with retry-unit | *"Do I need per-message retry, or per-entity ordering and replay?"* |
| "DynamoDB scales infinitely" | Ignores per-partition ceilings | Name the write-sharded key suffix |
| "Global Tables = multi-region strong consistency" | Factually wrong (LWW, eventual) | State the conflict-resolution semantics |
| Quoting an exact quota confidently | One wrong number undoes a good answer | *"Approximately X — I'd verify the current quota"* |

---

## 8. Revision: the one-page master diagram

Ten minutes before the interview you should be reading **one screen per topic**, not four files. Every topic folder's [`diagrams.md`](./instructions.md) ends with a **🎯 One-Page Master Diagram** — the whole system on one screen, with the central split as the layout, numbered flow, AWS service and pattern names annotated on the boxes, and the 2–3 genuinely hard parts marked in red. Each one also carries: a **60-second narration** (one ≤15-word line per numbered box) and a **3-minute walkthrough** (the same edges with the reasoning attached), the five numbers that justify the design, the patterns it assembles, the three things that break, and one "if you only remember one thing" sentence.

**The pre-interview routine:** master diagram → the five numbers → the three failure modes. If you can narrate the diagram end-to-end and name the tradeoff at each red box, you're ready; if you stall, *that* box tells you which section of `deep-dive.md` to open. Exemplars: [`payment-system/diagrams.md`](../interviews/payment-system/diagrams.md) and [`video-streaming/diagrams.md`](../interviews/video-streaming/diagrams.md).

**Going deeper — the 30-minute spoken transcript.** The 60-second narration proves you can *summarize* and the 3-minute walkthrough proves you can explain; it doesn't rehearse a full interview under time pressure. For a topic you're actively drilling before a real loop, `diagrams.md` can carry an **optional** addendum — a full spoken script, timestamped in blocks that mirror this framework's own R/A/D/I/O time budget (§0) scaled to ~30 minutes, with one first-person sentence per numbered edge of the master diagram, reusing (never re-deriving) the numbers already in `answers.md`. Read it aloud on a timer until the *structure* sticks, not the wording — that's what survives an interviewer's interruption. Spec: [`instructions.md`](./instructions.md) §2.2. Exemplar: [`food-delivery/diagrams.md`](../interviews/food-delivery/diagrams.md) — "🎤 30-Minute Interview Transcript."

---

## 9. One-screen checklist

```
R  □ Restated problem, got agreement
   □ Functional vs non-functional split
   □ Actors + top 3–5 journeys; rest declared OUT of scope
   □ Scale (DAU, QPS, data, read:write), consistency bars, SLOs, geography
   □ Capacity estimate with stated assumptions

A  □ Central split named in one sentence FIRST
   □ Dominant PATTERN named ("this is fundamentally a contention problem")
   □ Client → edge → services → stores → async backbone
   □ Each box has one job + reason to exist
   □ One request narrated end-to-end
   □ Tech named primitive → AWS → swap, defensible not gospel

D  □ Entities listed with key fields + PK
   □ Owning service/DB per entity
   □ Shard/partition key tied to dominant access pattern
   □ Store type per entity (RDBMS / KV / cache / stream / search)
   □ Store choice stated as primitive + AWS + native (Aurora/DynamoDB/ElastiCache/OpenSearch…)

I  □ ~5 endpoints for the scoped journeys
   □ Method, path, params, response, status codes
   □ Idempotency keys on retryable writes
   □ Sync vs async (202 + poll/stream) called out
   □ Protocol per interaction justified

O  □ Picked the 1–2 hardest parts
   □ Bottleneck → options → tradeoff → pick → failure mode → recovery
   □ Each tool justified by a number from R
   □ Worked the relevant pattern's LADDER (cheapest rung first), didn't jump to locks/sharding
   □ Thundering herd / hot key / retry storm addressed
   □ Named at least one thing the cloud does NOT give you (idempotency, sweeper, fencing…)
   □ SLOs / golden signals to measure
```

---

## 10. Common failure patterns (and the fix)

| Anti-pattern | Fix |
|---|---|
| Jumped straight to boxes | Force yourself through R first; announce the plan |
| Ran out of time in O | Timebox R/A/D/I hard; O is where the score is |
| Numbers with no derivation | State assumption → arithmetic → sanity check → decision |
| Breadth-only deep dive | Two parts deep > ten parts shallow |
| Tech name-dropping | Primitive → AWS → swap; every tech gets a one-line *why* (§7) |
| Didn't classify the problem | Name the dominant pattern before drawing (§2) |
| Jumped to the top of the ladder | Distributed lock / sharding are the *last* rungs — start at "design the race away" |
| One consistency model everywhere | Match consistency to each path (the gradient/three-paths idea) |
| Forgot failure modes | For each key component: how it fails + how you detect/recover |
| Assumed the managed service handles it | Exactly-once, cross-service txns, global ordering, breakers, sweepers are **yours** |
