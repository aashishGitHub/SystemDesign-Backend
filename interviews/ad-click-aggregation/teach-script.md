# Teach Script: Real-Time Event Aggregation (Ad Click Aggregation)

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: written so you can read it once and actually understand the system, not just recognize the vocabulary.
> **Not a replacement for:** [`answers.md`](./answers.md) (the full Q&A grill) or [`deep-dive.md`](./deep-dive.md) (production depth). This is the narrated version — read this first if the topic feels like a pile of unconnected AWS logos; go to the others for interview-grade completeness.
> **Every number and fact below is pulled from this repo's own [`answers.md`](./answers.md)** — nothing here is a new claim. Where the source material flags `⚠️ verify`, this script keeps that flag rather than smoothing it away.

---

## 1. The symptom

Two dashboards, same ad, same day, same metric — "total clicks on ad 442, yesterday." The live ops dashboard says **2.1 million**. The billing report that goes out to the advertiser says **2.4 million**. Nobody touched any code between the two reads. Nobody deployed anything. Two systems just... disagree, by 300,000 clicks, and someone has to explain that gap to a customer who is about to be invoiced based on one of these two numbers.

Here's the part that should bother you: **both numbers can be correct.** Not "one is a bug" — both are doing exactly what they were built to do, and they still don't match. If that sounds impossible, good — that confusion is the whole lesson of this topic.

## 2. Why you should care

This isn't a toy problem. Any product that counts high-volume events — ad clicks, video-player heartbeats, IoT sensor pings, API request telemetry — hits this exact fork the moment volume crosses a few million events a day. It's usually a backend or data-platform engineer who ends up owning the pipeline, and when the two numbers disagree, it's usually a senior engineer who gets pulled into the room to explain *why*, because "the dashboard was wrong" is not an acceptable answer when real money is attached to the report number.

## 3. What / Why / How

Three questions, in this order, because the middle one is the one that actually explains the other two:

1. **What is this system?** A pipeline that turns a firehose of individually-worthless events into two different kinds of trustworthy numbers.
2. **Why does it split into two paths instead of one?** Because no single system can be both *fast* and *exact* — and I mean that as a hard constraint, not a design preference.
3. **How do you actually build it?** One durable log, two independent readers, one deliberate rule for what happens when they disagree.

## 4. Umbrella words — kill them before using them

Three words are going to come up constantly in this topic, and every one of them is doing the vague-buzzword thing where it *sounds* like an answer but isn't one yet.

**"Real-time."** Real-time to what precision? It has to decompose into at least four concrete, measurable things or it's marketing copy: the ingestion **ack latency** (how fast does `POST /v1/events` return `202`), the **end-to-end ingestion-to-dashboard latency** at p50 and p99, the **watermark** — how many extra seconds or minutes a window stays open waiting for a late event before it closes — and **consumer lag measured as age**, not as a raw message count, because a lag of 10,000 messages means something completely different at 1M events/sec than it does at 100 events/sec. "Real-time" without these four numbers attached is a word, not a spec.

**"Exactly-once."** This one is worse than vague — it's actively misleading, and it's worth saying that out loud before explaining it. Exactly-once *delivery* over an unreliable network is provably impossible: a sender can never tell "my message got lost" apart from "my message arrived but the acknowledgment got lost," so it must always be willing to retry, which means duplicates are always possible. What you can actually get is exactly-once *effect* — at-least-once delivery, plus a receiver that makes a duplicate a no-op. And when someone says "Kafka gives you exactly-once," decompose that too: Kafka's exactly-once semantics guarantee no duplication *inside Kafka* — producer to topic, or a consume-then-produce chain — and stop dead at Kafka's boundary. The moment you increment a Redis counter or call a billing API as a side effect of consuming a message, that side effect needs its own idempotency, because Kafka's guarantee doesn't reach it.

**"Scale."** Also needs numbers under it: **events per second, average vs. peak** (a 5–8x peak-to-average ratio is a defensible planning assumption for a live-event-driven product — state it, don't hide it); **partition count**, which isn't just a throughput dial, it's a hard ceiling on how many consumers can ever work the topic in parallel at once; and **cardinality of what you're counting** — counting a global total is one problem, counting per-ad totals across a huge number of distinct ads is a much bigger memory problem, and counting *unique viewers* (not just events) is a different problem again.

Make sense so far? Those three words are going to reappear constantly below — now they mean something specific instead of sounding impressive.

## 5. The boxes — built one need at a time

Don't start with "we'll use Kafka, Redis, S3, and Spark." Start with the first thing you actually need, and let each subsequent box show up as the answer to a gap the previous box left open.

**You have clients generating events** — every ad click, every player heartbeat. At roughly 50 million daily active users and about 20 events per session, that's close to a billion events a day. Divide by 86,400 seconds and that's **~12,000 events/sec on average** — but real traffic spikes 5–8x during a big live event, so you actually have to design for something like **60,000–90,000 events/sec at peak**, not the average. State that ratio out loud; designing only for the average is how a launch-day spike takes the system down.

**First gap: where do these events land?** They can't call your counting logic directly — at 90K events/sec that logic falls over before it counts anything. You need a door that can durably absorb a firehose without losing events and without making the client wait. That's the **ingestion API**.

```
[ Client ] ──POST /v1/events──▶ [ Ingestion API ]
```

What does that door actually do? Every batch carries a client-generated `Idempotency-Key` header, because a mobile client on a flaky connection *will* retry a batch it thinks failed, even when it actually landed — and you need a cheap way to tell "this is the same batch again" apart from "these are three genuinely new clicks." The API checks that key with an atomic `SETNX` (set-if-not-exists) against a fast store, before anything else happens. New key → forward the batch. Already-seen key → just return `202 Accepted` again and do nothing.

**Second gap: where does that atomic check actually run?** You need something that can do a `SETNX` in under a millisecond, thousands of times a second, and doesn't need to survive forever — a short TTL is fine. That's exactly the job of **ElastiCache (Redis)**.

```
[ Client ] ──▶ [ Ingestion API ] ──SETNX(idempotency key)──▶ [ Redis ]
```

**Third gap: the batch passed the check — where does it actually go?** Not straight into a counter, because (spoiler for the next box) two completely different consumers are about to need to read these same events independently, at their own pace, without either one blocking the other. What lets many independent readers replay the same ordered sequence of events, each at its own speed? A durable, partitioned log. That's **Kafka**.

And Kafka needs a partition key — which field decides how millions of events get spread across machines? You partition by `session_id`, not `event_type` and not randomly. The key decides two things at once: which events stay *ordered* relative to each other, and which events land on the *same* machine so a consumer can hold per-session state without cross-machine coordination. Partition by `event_type` instead and you get one enormous "ad_click" partition taking almost all the traffic — the classic hot-partition mistake.

```
[ Client ] ──▶ [ Ingestion API ] ──▶ [ Kafka, partitioned by session_id ]
                     │
                  SETNX
                     ▼
                 [ Redis ]
```

**Now the fork, and this is the load-bearing idea of the whole topic.** Once events sit durably in Kafka, who reads them? A live "clicks right now" dashboard can be 10–30 seconds stale and nobody notices — making it wait for a perfectly exact number would make it not live anymore. A monthly billing report has to be *exact*, because someone gets paid real money from that figure, and being 0.5% off is a real dollar dispute at scale. **One system genuinely cannot cheaply be both.** So you build two independent readers of the same log, and neither is a dependency of the other in real time:

```
                              ┌──────────────────────────┐
                              │   HOT PATH (fast, ~est.)  │
                    ┌────────▶│ stream processor (windowed)│──▶ [Redis counters]──▶ [Dashboard]
                    │         └──────────────────────────┘
[ Kafka log ] ──────┤
                    │         ┌──────────────────────────┐
                    └────────▶│  COLD PATH (slow, exact)  │
                              │ S3 raw archive → batch job │──▶ [Reporting store]
                              └──────────────────────────┘
```

The hot path is a stream processor keeping windowed, approximate aggregates, feeding Redis counters the dashboard reads. The cold path archives the raw, unwindowed events to S3 and later runs an exact batch recompute over the complete data, with no watermark cutoff, feeding the number that actually gets billed.

**Last gap: they will disagree — so what happens when they do?** This is exactly the 2.1M vs. 2.4M opening. The rule has to be decided in advance, not improvised during a dispute: **the cold path's number always wins**, because it's computed from the complete, replayed log with no lateness cutoff, while the hot number is, by design, a windowed estimate that excluded whatever arrived late. Reconciliation means the batch job overwrites the reporting-store figure for that period — and if the dashboard should reflect it, it pushes a correction into the same Redis key, tagged so the UI can show "recomputed." You never replay the *stream processor* retroactively. The batch layer's output simply supersedes it for anything already closed.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **every event lands once in Kafka; the hot path reads it fast and approximately into Redis for the dashboard; the cold path reads the same log slowly and exactly into a batch recompute; and when the two disagree, the cold number always wins.**

## 6. What to ignore — where your attention should and shouldn't go

Sort everything above into three buckets, because spending equal attention on all of it is how a topic like this feels overwhelming instead of learnable.

**Copy it, never think about it:** the exact HTTP status-code table (`202`/`400`/`409`/`429`/`503`), the exact JSON shape of a batch, and which specific AWS service you picked for the ingestion tier (Fargate vs. Lambda). These follow mechanically once you understand *why* they exist — memorizing them adds nothing.

**Understand once, then trust it:** Kafka consumer-group rebalance mechanics — know that a rebalance pauses the group and causes some reprocessing from the last committed offset, but you don't need to hand-roll that logic, Kafka does it. Same for Redis's `SETNX` semantics, and for planning numbers like "one partition sustains roughly 5–10 MB/s" — that figure is explicitly `⚠️ verify` against current Kafka/MSK guidance in the source material, so treat it as a starting estimate to confirm, not a constant to memorize.

**This is the actual idea — think hard here:** (1) *why* hot and cold have to be two separate systems, never merged into one; (2) idempotency keyed on `event_id` as the actual mechanism behind "exactly-once effect" — this is not a Kafka feature, it's something *you* build; (3) the fact that a single global counter key becomes a hot-partition bottleneck no matter how big your cluster is, and the fix is sharding the *key*, not the system; (4) the reconciliation rule — cold always wins, corrects the served number in place, never triggers a hot-path replay. Everything else in this topic is scaffolding around these four ideas.

## 7. The build — the smallest thing that actually shows the mechanism

I'm not going to pretend you can spin up MSK, a managed Flink cluster, ElastiCache, and an EMR batch job in a paste-and-run demo — that's real infrastructure with real setup cost, and faking a `docker compose` file just to have something to type would only teach you the YAML, not the idea. But the single load-bearing mechanism from bucket 3 above — idempotent counting — fits in fifteen lines of Python you can run right now, no dependencies, no setup:

```python
# save as idempotent_counter_demo.py, run with: python3 idempotent_counter_demo.py

def naive_counter(events):
    """Counts every event it sees. This is what a counter looks like
    before anyone thinks about duplicates."""
    return len(events)

def idempotent_counter(events):
    """Counts every DISTINCT event_id exactly once, no matter how many
    times that same event shows up in the input."""
    seen = set()
    count = 0
    for e in events:
        if e["event_id"] in seen:
            continue          # already counted this one — a no-op, not an error
        seen.add(e["event_id"])
        count += 1
    return count

# Three genuine clicks on the same ad.
real_events = [
    {"event_id": "evt-1", "ad_id": "ad_442"},
    {"event_id": "evt-2", "ad_id": "ad_442"},
    {"event_id": "evt-3", "ad_id": "ad_442"},
]

# Simulate a client that retried the whole batch because it never
# received the 202 ack — the events actually landed the first time.
duplicated_events = real_events + real_events   # same 3 events, sent twice

print("Real clicks:                   ", len(real_events))
print("Naive counter after the retry: ", naive_counter(duplicated_events))
print("Idempotent counter after retry:", idempotent_counter(duplicated_events))
```

Run it. The naive counter and the idempotent counter will disagree — and that disagreement, at 90,000 events a second instead of 6, is a real dollar amount on someone's ad bill.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** Open the file, change the line to `duplicated_events = real_events + real_events + real_events` — simulate the client retrying *twice*, sending the batch three times total — and rerun it. Watch the naive counter climb to 9 while the idempotent counter stays locked at 3, no matter how many times you resend the exact same events. That's the entire idempotency argument, made visible in one variable change: **the fix isn't "stop the client from retrying" — you can't control that — the fix is making the receiver immune to however many times the same thing arrives.**

**Sabotage 2 (walk it in your head, no code needed).** Now imagine you "simplify" the architecture by deleting the hot/cold split and building one pipeline that serves both the live dashboard and the billing report. Walk what happens: either you make the dashboard wait for every last late-arriving event before showing a number — and now it's not a live dashboard anymore, it's a slow one wearing a live dashboard's UI — or you close the window early to keep it fast, and now the number you eventually bill the advertiser from was closed before all the real clicks arrived, and it's wrong in the advertiser's favor or against them, silently. There is no third option inside a single system. That's *why* the fork in section 5 exists — not because it's a fashionable pattern, but because the alternative provably breaks one of the two promises.

## 9. One-sentence recap

Same words as before, on purpose: **every event lands once in Kafka; the hot path reads it fast and approximately into Redis for the dashboard; the cold path reads the same log slowly and exactly into a batch recompute; and when the two disagree, the cold number always wins.**

## 10. What transfers

If you swap Kafka for Kinesis, Redis for Memcached, S3 for HDFS, and Spark for Flink's batch mode, this entire lesson is unchanged — those are the incidental, swappable names. What actually transfers to *every* system shaped like this one (video-view counting, IoT telemetry, API-request analytics, any high-volume event pipeline) is: the speed-layer/batch-layer split itself (this is what "Lambda architecture" names, once you've built it — the name is not the idea, the idea is the fork you already understand); idempotent-by-ID dedup as the real mechanism behind "exactly-once"; sharding a hot counting *key* rather than the system around it; a watermark as the deliberate, named boundary for how long you wait for late data; and the one-sentence principle underneath all of it — **durability of the write always beats freshness of the read**, because you can always recompute a stale aggregate, but you can never recompute an event you never durably accepted in the first place.

---

## Recall check — answer these without scrolling up

1. **Describe the data flow in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5 — not section 9.)*
2. **What is each box's job, and what breaks if you delete it?** Specifically: what breaks if you delete the `Idempotency-Key` check at the ingestion API? What breaks if you delete the watermark? What breaks if you delete the cold path entirely and only ever ship the hot path?
   - *Model answers:* delete the idempotency check → a client retry double-counts every click it resends, and now your dashboard *and* your billing are both wrong, not just approximate. Delete the watermark → windows never close, so the dashboard never shows a "final" number for anything, ever. Delete the cold path → you have a fast, approximate system with no exact backstop — fine for a dashboard, indefensible for a billing report.
3. **What would you look at first if this got slow, or wrong, in production?** *(Model answer: consumer lag measured as **age**, not count — then the hot-vs-cold count delta per hour, because that's the metric that catches drift before it becomes a billing dispute, per `answers.md` A37–A38.)*

If you answered all three without opening `answers.md`, go read `answers.md` anyway — this script deliberately left out the harder Level 6–8 material (Count-Min Sketch, HyperLogLog, multi-region failover, the observability metrics) because piling every idea into one narrative would have buried the four that actually matter. Those are the natural next read.
