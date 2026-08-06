# Patterns — The Reusable Moves Behind Every System Design Question

Eight in-depth pattern write-ups, plus [four identified gaps](#gaps--recurring-sub-problems-not-yet-written-up). A **pattern** is a recurring sub-problem that shows up across many different system design questions — real-time updates appear in chat, Uber, Google Docs, and live comments; contention appears in Ticketmaster, e-commerce, and ride matching. Learn the eight patterns and you can assemble most interview answers from parts you already understand.

This folder is the **middle layer** of the repo:

```
fundamentals/     one concept, 2 minutes        (Bloom filter, quorum, WAL, lease…)
      ↓
patterns/         one recurring sub-problem     ← YOU ARE HERE
      ↓
interviews/       one whole system, end to end  (chat, Uber, Ticketmaster…)
```

Each pattern file has the same shape: the problem → the solution ladder with real depth → a decision framework → **where it shows up in this repo** (linked to the exact section of the relevant `interviews/` topic) → real-world cases → 10–13 interview questions with full answers → a cheat-sheet table for last-minute revision.

> **On sources.** The pattern list and section taxonomy follow [Hello Interview's patterns series](https://www.hellointerview.com/learn/system-design/patterns/realtime-updates) (plus their ZooKeeper deep dive), which is where these eight were named as a set. Their prose is behind a paywall, so only the outlines were visible — **all depth, code, tables, diagrams, questions, and answers here are this repo's own**, written against the outlines and cross-linked to existing `interviews/` content. Where a fact is version-specific or a company internal, it's flagged as needing verification rather than stated flatly.

---

## The Eight Patterns

| Pattern | The one-line version | Interviewer says |
|---|---|---|
| [Real-Time Updates](./realtime-updates.md) | It's **two** problems: client⇄server transport, *and* getting the event to the one server holding that client's connection | "live", "immediately", "without refreshing", "presence" |
| [Dealing with Contention](./dealing-with-contention.md) | A ladder from *design the race away* → conditional write → OCC → locks → distributed locks. Start at the bottom | "the last ticket", "don't oversell", "two users at once" |
| [Multi-Step Processes](./multi-step-processes.md) | No transaction spans services, so make forward progress durable and failure recoverable — saga, state machine, durable execution | "if step 3 fails, what happens to 1 and 2?" |
| [Scaling Reads](./scaling-reads.md) | Diagnose first, then: index → vertical → cache → CDN → replicas → precompute. Sharding is *last* for reads | "read-heavy", "100M users browse", "feed in 100ms" |
| [Scaling Writes](./scaling-writes.md) | Write **fewer** times, then spread across owners, then absorb bursts. Same key ⇒ sharding won't help | "1M events/sec", "every GPS ping", "click aggregator" |
| [Handling Large Blobs](./large-blobs.md) | Metadata through your API; **bytes never through your API**. Presigned URLs, multipart, and the state-sync bug everyone ships | "users upload video", "resume the upload", "attachments" |
| [Managing Long-Running Tasks](./long-running-tasks.md) | Accept → enqueue → `202` + status URL → worker. Then: visibility timeouts, poison messages, DLQs, head-of-line blocking | "generate a report", "transcode", "send to 10M users" |
| [ZooKeeper & coordination](./zookeeper.md) | Not a pattern — the *primitive* the others bottom out in. Ephemeral+sequential znodes, ZAB, and why reads aren't linearizable | "who's the leader?", "how do nodes find each other?" |

---

## Reverse Index: Which Patterns Does This Interview Question Need?

The way to use this folder under time pressure. **●** = central to the problem, **○** = shows up.

| Interview topic | Real-time | Contention | Multi-step | Reads | Writes | Blobs | Long tasks | Coord |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| [Chat (WhatsApp/Slack)](../interviews/chat-system/README.md) | ● | | | ○ | ○ | ○ | ○ | |
| [Ride sharing (Uber)](../interviews/ride-sharing/README.md) | ● | ○ | ● | | ● | | ○ | |
| [Seat reservation (Ticketmaster)](../interviews/seat-reservation/README.md) | ○ | ● | ● | ○ | | | | ○ |
| [E-commerce](../interviews/e-commerce/README.md) | | ● | ● | ● | ○ | | ○ | |
| [Payment system](../interviews/payment-system/README.md) | | ● | ● | | | | ○ | |
| [Food delivery](../interviews/food-delivery/README.md) | ● | ○ | ● | ○ | | | ○ | |
| [Collaborative editing (Docs)](../interviews/collaborative-editing/README.md) | ● | ● | | | ○ | | | ○ |
| [Social feed (Twitter/X)](../interviews/social-feed/README.md) | ● | | | ● | ● | | ○ | |
| [URL shortener](../interviews/url-shortener/README.md) | | ○ | | ● | ● | | ○ | |
| [Search autocomplete](../interviews/search-autocomplete/README.md) | | | | ● | ● | | ● | |
| [Recommendation system](../interviews/recommendation-system/README.md) | | | | ● | ● | | ● | |
| [File storage (Dropbox)](../interviews/file-storage/README.md) | ● | ○ | ○ | ○ | | ● | ● | |
| [Video streaming (YouTube)](../interviews/video-streaming/README.md) | | | ● | ● | | ● | ● | |
| [Notification system](../interviews/notification-system/README.md) | ○ | | ● | | ● | | ● | |
| [Web crawler](../interviews/web-crawler/README.md) | | | | | ● | ● | ● | ○ |
| [Rate limiting](../interviews/rate-limiting/README.md) | | ● | | ○ | ● | | | ○ |
| [Distributed caching](../interviews/distributed-caching/README.md) | | ○ | | ● | | | | |
| [CDN & edge](../interviews/cdn-edge/README.md) | | | | ● | | ● | | |
| [Sharding & replication](../interviews/sharding-replication/README.md) | | ○ | ○ | ● | ● | | | ○ |
| [Storage engines](../interviews/storage-engines/README.md) | | ● | | ● | ● | | | |
| [KV store (Dynamo)](../interviews/kv-store/README.md) | | ○ | | ● | ● | | | ● |
| [Consensus](../interviews/consensus/README.md) | | ● | ○ | | | | ○ | ● |
| [Consistent hashing](../interviews/consistent-hashing/README.md) | ● | | | ○ | ● | | | ○ |
| [Distributed transactions](../interviews/distributed-transactions/README.md) | | ● | ● | | | | | ○ |
| [Message queues](../interviews/message-queues/README.md) | | | ● | | ● | | ● | |
| [API design](../interviews/api-design/README.md) | ○ | ○ | ● | ● | | ○ | ● |
| [Communication protocols](../interviews/communication-protocols/README.md) | ● | | ○ | | ○ | | ○ | |
| [Observability](../interviews/observability/README.md) | | | | ○ | ● | | ● | |
| [SSE](../interviews/sse/sse-deep-dive-qa.md) | ● | | | | | | ○ | |

**How to read a new problem with this table:** ask what the *dominant* pattern is (usually one or two), name it explicitly to the interviewer, then work the ladder inside that pattern. "This is fundamentally a contention problem with a multi-step process hanging off it" is a much stronger opening than jumping to components.

---

## Gaps — Recurring Sub-Problems Not Yet Written Up

The eight above are the *written* patterns. Auditing the [`interviews/`](../interviews/) folders surfaced **four more recurring sub-problems** that meet the same bar — they appear in three or more topics, and each has a real ladder — but do **not** yet have a pattern file. They're listed here so the taxonomy is honest about its boundary, and so the reasoning isn't silently buried inside a single topic folder.

**Status: identified, outline only. Not yet written to the depth of the eight.** Until they are, the linked topic sections are the authoritative depth.

| Gap pattern | The one-line version | The ladder (cheapest rung first) | Interviewer says |
|---|---|---|---|
| **Proximity / geospatial search** | You cannot index a 2-D plane with a B-tree, so **reduce location to a sortable 1-D key** and query the cell + its neighbours | bounding box in SQL → geohash prefix → quadtree/S2/H3 cells → cell-sharded in-memory index → dedicated geo engine | "find drivers near me", "restaurants within 5 km", "nearby friends" |
| **Counting & top-K at scale** | Exact counting is a write-contention problem in disguise; **ask what error is acceptable** before you build it | read-time `COUNT(*)` → incremental counter → sharded counters → stream aggregation (windowed) → probabilistic (HLL / Count-Min) → Redis sorted set for top-K | "trending", "leaderboard", "how many views", "ad click counts" |
| **Scheduled & delayed execution** | "Do X for entity E at time T" for millions of live timers — a scheduler is a **durable priority queue plus a sweeper**, not a `sleep()` | in-process timer → queue delay (short only) → timer table partitioned by due-minute + sweeper → managed scheduler → workflow-engine timers | "remind them in 24 h", "expire the hold", "run nightly", "retry in an hour" |
| **Search & ranked retrieval** | The index is a **derived** store, never the source of truth — so the design is really about the *pipeline that keeps it fresh* and the *ranking* | `LIKE` → DB full-text → inverted index (tokenize/analyze) → CDC pipeline to keep it fresh → two-stage retrieve-then-rank → vector/hybrid retrieval | "search products", "autocomplete", "relevance", "semantic search" |

### Where each gap pattern already has depth in this repo

| Gap pattern | Existing authoritative depth | Partially covered by |
|---|---|---|
| Proximity / geospatial | [ride-sharing](../interviews/ride-sharing/deep-dive.md) (geohash/S2/H3, cell-size tradeoff), [food-delivery](../interviews/food-delivery/deep-dive.md) | — this is the **largest true gap**; no pattern file covers it at all |
| Counting & top-K | [social-feed](../interviews/social-feed/deep-dive.md) (feed counts), [rate-limiting](../interviews/rate-limiting/deep-dive.md) (windowed counters), [observability](../interviews/observability/deep-dive.md) (cardinality) | [scaling-writes.md](./scaling-writes.md) covers *aggregate before you write*, but not top-K or probabilistic structures |
| Scheduled & delayed execution | [notification-system](../interviews/notification-system/deep-dive.md) (reminders), [seat-reservation](../interviews/seat-reservation/deep-dive.md) (hold expiry) | [long-running-tasks.md](./long-running-tasks.md) covers async *work*, not *time-triggered* work |
| Search & ranked retrieval | [search-autocomplete](../interviews/search-autocomplete/deep-dive.md), [recommendation-system](../interviews/recommendation-system/deep-dive.md) (two-stage ranking) | [scaling-reads.md](./scaling-reads.md) covers precomputation and derived stores generically |

### Reverse index for the gaps

**●** = central, **○** = shows up.

| Interview topic | Proximity | Counting/top-K | Scheduling | Search |
|---|:--:|:--:|:--:|:--:|
| [Ride sharing](../interviews/ride-sharing/README.md) | ● | ○ | ○ | |
| [Food delivery](../interviews/food-delivery/README.md) | ● | | ○ | ○ |
| [Maps / location services](../interviews/ROADMAP.md) *(not built)* | ● | | | ○ |
| [Search autocomplete](../interviews/search-autocomplete/README.md) | | ● | | ● |
| [Recommendation system](../interviews/recommendation-system/README.md) | | ○ | ○ | ● |
| [E-commerce](../interviews/e-commerce/README.md) | ○ | ○ | ○ | ● |
| [Social feed](../interviews/social-feed/README.md) | | ● | | ○ |
| [Notification system](../interviews/notification-system/README.md) | | | ● | |
| [Seat reservation](../interviews/seat-reservation/README.md) | | | ● | |
| [Rate limiting](../interviews/rate-limiting/README.md) | | ● | ○ | |
| [Observability](../interviews/observability/README.md) | | ● | ○ | ○ |
| Ad click aggregation *(not built)* | | ● | | |
| Leaderboard / top-K *(not built)* | | ● | | |
| Job scheduler *(not built)* | | | ● | |
| Search engine *(not built)* | | ○ | | ● |

Note how strongly the gaps cluster on the **unbuilt** topics (ad-click aggregation, leaderboard, job scheduler, maps, search engine). That's not a coincidence — those topics are unbuilt *because* their central pattern was never written down. Building any of them should start by writing its pattern file.

### AWS realization

The primitive→AWS→native mapping for all four gaps is already filled in at [`docs/AWS_SERVICE_MAP.md` §2](../docs/AWS_SERVICE_MAP.md#2-patterns--aws-realization) — including the traps (DynamoDB TTL is *not* a scheduler; a single atomic counter is a hot partition; the index is never the source of truth).

### Deliberately *not* patterns

For completeness, four things that get called patterns but don't belong in this folder:

| Not a pattern | Why | Where it lives |
|---|---|---|
| Idempotency | It's a **cross-pattern tax**, not a sub-problem — every pattern here needs it | [Cross-Pattern Truth #1](#the-cross-pattern-truths) |
| Multi-region / global | An **architecture posture** (a whole-system decision), not a recurring sub-problem | [`AWS_SERVICE_MAP.md` §5](../docs/AWS_SERVICE_MAP.md#5-multi-region-on-aws--the-four-postures) |
| Caching | Too broad to be one pattern; it's a *rung* on several ladders | [scaling-reads.md](./scaling-reads.md), [distributed-caching](../interviews/distributed-caching/README.md) |
| Observability | A discipline applied to all of them | [observability](../interviews/observability/README.md) |

---

## The Cross-Pattern Truths

Six ideas that recur in almost every file — worth knowing as ideas rather than as per-pattern trivia:

1. **Idempotency is the universal tax.** At-least-once delivery, retried writes, redelivered queue messages, replayed workflow steps, duplicate uploads — every pattern here eventually requires that doing something twice has the same effect as once. Exactly-once *delivery* doesn't exist; exactly-once *effect* does. → [multi-step §9](./multi-step-processes.md#9-idempotency-why-exactly-once-is-a-lie) · [long-tasks §8](./long-running-tasks.md#8-preventing-duplicate-work) · [contention](./dealing-with-contention.md#4-rung-1-conditional--atomic-writes)

2. **The dual-write problem is everywhere.** Any time you write to two systems without a shared transaction — DB + queue, DB + object store, DB + cache — there's a crash window that leaves them inconsistent. The answers are always the same family: outbox, event notification from the authoritative system, and a reconciler. → [multi-step §8](./multi-step-processes.md#8-the-dual-write-problem-and-the-outbox) · [blobs §4](./large-blobs.md#4-state-synchronization-the-bug-everyone-ships) · [long-tasks §4](./long-running-tasks.md#4-the-job-table-and-the-queue-are-different-things)

3. **Every async design needs a sweeper.** A background job that finds things stuck in a non-terminal state and re-drives, compensates, or escalates. It's the component candidates forget and interviewers look for, because without it your happy path works and your failures are silent and permanent.

4. **A lock can never be safe against a paused holder.** Redis, ZooKeeper, etcd — all the same. The holder can't detect that its lease expired, so mutual exclusion requires the *resource* to check a monotonic fencing token. → [contention §8](./dealing-with-contention.md#8-rung-5-distributed-locks-and-why-theyre-last) · [zookeeper §7](./zookeeper.md#7-sessions-where-ephemeral-nodes-get-their-power)

5. **Alert on age, not count.** Backlog age beats queue depth; age of the oldest stuck workflow beats error rate; replication lag beats replica count. The failures that hurt most are the *silent* ones — a dead worker pool produces zero errors — and age-based signals are the only ones that are non-zero in every failure mode.

6. **Ask what's allowed to be stale, lost, or approximate.** Almost every ladder in this folder is unlocked by a product answer: how stale can this read be, which writes may I lose, is 2% error acceptable, is overselling cheaper than coordination. Candidates who assume the strictest requirement build the most expensive system and don't get credit for it.

---

## Suggested Reading Order

**If you're prepping breadth-first (recommended):**

1. [Scaling Reads](./scaling-reads.md) and [Scaling Writes](./scaling-writes.md) — they're the substrate under everything else, and the read/write asymmetry is the most reused idea in system design.
2. [Real-Time Updates](./realtime-updates.md) — the most commonly asked, and hop 2 is where seniority shows.
3. [Dealing with Contention](./dealing-with-contention.md) — small surface area, extremely high hit rate.
4. [Multi-Step Processes](./multi-step-processes.md) — the hardest, and it subsumes idempotency, outbox, and sagas.
5. [Long-Running Tasks](./long-running-tasks.md) and [Handling Large Blobs](./large-blobs.md) — mechanical, quick wins, lots of concrete detail to cite.
6. [ZooKeeper](./zookeeper.md) — read after the others, since it's the primitive they delegate to.

**If you have an interview tomorrow:** read only the **Decision Framework** and **Quick Recall Cheat Sheet** sections of all eight. That's roughly 20 minutes and covers the reusable moves.

---

## Related Folders

- [`fundamentals/`](../fundamentals/README.md) — 20 single-concept primers (quorum, lease, fencing, WAL, Bloom filter, CAP/PACELC, vector clocks…). The patterns link down into these for anything that needs a two-minute refresher.
- [`interviews/`](../interviews/) — 29 full system topics, each with `questions.md`, `answers.md`, and a long `deep-dive.md`. The patterns link *into specific sections* of these rather than duplicating them.
- [`docs/AWS_SERVICE_MAP.md`](../docs/AWS_SERVICE_MAP.md) — the primitive→AWS→native mapping, including a [patterns→AWS realization table](../docs/AWS_SERVICE_MAP.md#2-patterns--aws-realization) with the AWS-specific trap for each pattern here.
- [`docs/RADIO_FRAMEWORK.md`](../docs/RADIO_FRAMEWORK.md) — how to perform in the room; step **A** is where you name the dominant pattern, step **O** is where you work its ladder.
- [`docs/instructions.md`](../docs/instructions.md) — the topic authoring spec; Rule 2 requires every topic to declare the patterns it assembles.
- [`interviews/ROADMAP.md`](../interviews/ROADMAP.md) — the study plan across topics.
- Root [`README.md`](../README.md) — repo map, conventions, and the runnable long-polling/SSE demos.

Convention, per the root README: **cross-link, don't duplicate.** These files summarize and route; the depth for any *specific system* lives in `interviews/`, and the depth for any *single concept* lives in `fundamentals/`.
