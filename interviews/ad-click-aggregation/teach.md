# Teach Script: Real-Time Event Aggregation (Ad Click / Telemetry Pipeline)

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the system; don't just recognize the vocabulary.
> **Not a replacement for:** [`radio-walkthrough.md`](./radio-walkthrough.md) (how to *perform* this in a 45-minute interview loop, R→A→D→I→O) or [`answers.md`](./answers.md) (the Q&A grill). This file uses a different lens — demo-first teaching — so it's complementary, not a duplicate.
> **Every number and fact below is pulled from this repo's own [`answers.md`](./answers.md)** — nothing here is a new claim.

---

## 1. The symptom

It's Monday morning. Engineering's live dashboard says **2.1M ad clicks** for yesterday's 8–9 PM hour — the season finale slot. Finance's invoice to the same advertiser says **2.4M**. Nobody touched the code between Sunday and Monday. Nothing crashed. No alert fired. No error appears in any log.

**Two teams, looking at two different numbers, for the same hour, from the same system.** One of them is about to have an uncomfortable call with an advertiser — and it isn't obvious yet which number is wrong, or whether either one is.

## 2. Why you should care

This is the defining problem of any team whose job title includes "real-time" and "analytics" in the same sentence — an Event Hub or telemetry team feeding live dashboards *and* billing off the same click/impression stream. It shows up at senior interviews because the tempting first answer — "just increment a counter when an event arrives" — passes every test you'd run with a handful of events, and only produces a visible discrepancy once you're at a scale where the count is approximate by construction and duplicates are a certainty, not an edge case.

## 3. What / Why / How

1. **What does "count events, in real time, and also bill exactly on them" actually require**, stripped of the marketing language around "real-time analytics"?
2. **Why does "increment a counter on every event" — the obviously correct first instinct — produce two different, both-defensible numbers for the same hour?**
3. **How do you build one pipeline that's honest about being fast-and-approximate for one reader and slow-and-exact for another, without either reader being lied to?**

## 4. Umbrella words — kill them before using them

**"Real-time."** This is doing a lot of unearned work. Decomposed: the dashboard tolerates **seconds** of staleness (a windowed aggregate, refreshed on a 1-minute tumble), not milliseconds, and definitely isn't claiming to reflect an event the instant it happens. Say the actual number — "p99 event-to-dashboard latency" — not the adjective.

**"Exactly-once."** Exactly-once *delivery* does not exist over an unreliable network — a sender can never distinguish "you never got my message" from "you got it but I never got your ack," so it must always be free to retry. What *does* exist is exactly-once **effect**: at-least-once delivery, plus a receiver for whom processing the same event twice is a no-op. Every "exactly-once" claim in this space is really this, under a friendlier name.

**"Aggregation."** Decompose it into three questions that each have a different answer here: aggregated over **which window** (tumbling 1-minute, for a clean non-overlapping report)? Keyed by **which dimension** (ad ID, not "globally" — see the hot-key trap below)? Landing in **which store** (an in-memory counter for the dashboard, a replayed batch total for the invoice — never the same store serving both)?

## 5. The boxes — built one need at a time

**You need to know how many times an ad was clicked, this minute, fast enough for a human to watch it update.** The obvious first move: an in-memory counter, incremented once per event as it arrives.

```
1. Event arrives: "ad_442 clicked"
2. counter["ad_442"] += 1
3. Dashboard reads counter["ad_442"]
```

**Now — the gap that produces Monday's symptom.** Networks retry. A mobile client times out waiting for an ack it never sees, and — correctly, because it can't tell whether the click landed — sends the same click again. Your naive counter has no way to know these are the same event. It counts both. Multiply this by every flaky connection during a season-finale traffic spike, and your "exact" real-time counter is **quietly inflated**, by an amount nobody can name, because nothing about a retry looks different from a genuine second click.

```
Client:  click ad_442 → send → (ack lost, times out) → resend ad_442
Naive counter: sees TWO messages → counter["ad_442"] = 2   ← one real click, counted twice
```

**Fix: collapse "did I already count this" into one atomic check, the same move as any idempotency problem.** Every event carries an `event_id`. Before incrementing, check a dedupe store — has this `event_id` been counted already? Only a *new* `event_id` moves the counter. A resend of the same `event_id` is now a no-op, not a double-count. This is exactly-once *effect*, built on top of delivery that's still only at-least-once.

**Gap: a per-ad counter, checked and incremented one event at a time, still has a ceiling.** At tens of thousands of events/sec against a *popular* ad, every one of those events is contending for the **same key** — the same counter, the same lock, the same cache line. This is a hot-partition problem no amount of horizontal scaling fixes, because the bottleneck is one key, not total cluster capacity. **Fix: shard the counter itself** — `clicks:ad_442:{shard}` across N shards, summed only when read — so contention spreads across N independent keys instead of piling onto one.

**Gap: even a perfectly deduplicated, perfectly sharded counter is still approximate, on purpose.** At the cardinality of "every ad, every minute," keeping an exact counter per ad in memory doesn't scale — so a real pipeline uses a **Count-Min Sketch**, a fixed-size grid of counters where an item hashes into several cells and the estimate is the *minimum* across them. The trade being made, explicitly: a small, one-directional overcount error, in exchange for memory that doesn't grow with the number of distinct ads. This is a second, independent source of "the dashboard number isn't exact" — separate from and in addition to the dedupe story above.

**Last gap — the one that actually produced Monday's ticket.** The dashboard's number was never meant to be the invoice's number. The dashboard reads a windowed, deduplicated, *sketch-approximated* in-memory counter. The invoice comes from a **separate batch job**, re-reading the complete, raw, replayed event log from cold storage hours later, with no sketch and no window cutoff — an exact recount. **2.1M and 2.4M are not a bug. They're two different, both-correct answers to two different questions**, and the actual missing piece was never making that difference visible, or reconciling the two afterward.

Say the data flow back in one breath, because you'll need it later: **every event lands once in a durable, replayable log, deduplicated by `event_id`; a fast path reads that log into sharded, sketch-approximated, windowed counters for the dashboard; a slow path independently re-reads the same log, in full, for an exact total; and the exact number always overwrites the approximate one, in place, never the other way around.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the exact Kafka producer config for `ack=all`, the specific TTL on the idempotency-key dedupe store (24h is a reasonable default, not a law), the precise hash-function count in a Count-Min Sketch implementation.

**Understand once, then trust it:** the mechanics of *why* HyperLogLog's leading-zero-run trick estimates cardinality in fixed memory — know that it exists and what problem it solves ("how many *distinct* viewers," not "how many events") without being able to re-derive the estimator from scratch; Kafka consumer-group rebalancing mechanics — know that a rebalance pauses the whole group and reprocesses from the last committed offset, without needing to hand-trace the coordinator protocol.

**This is the actual idea — think hard here:** (1) exactly-once delivery is not a thing you can buy from a vendor — it's at-least-once delivery plus an idempotent consumer, full stop; (2) a single global counter on one key caps out regardless of cluster size — shard the key, not just the system; (3) the hot path and cold path are two independent, honest answers at two different prices, and the design's real job is reconciling them, never quietly pretending one is the other; (4) "system health" for a pipeline like this is lag measured as **age**, not count — a dead consumer produces zero errors and a flat graph, and only an age-based signal catches it.

## 7. The build — the smallest thing that actually shows the mechanism

No real Kafka or a live dashboard here — the one mechanism that actually matters, "at-least-once delivery inflates a naive counter, idempotency fixes it," is fully visible with plain Go and two goroutines simulating a retried click:

```go
package main

import (
	"fmt"
	"sync"
)

// naiveCounter: no idea an event has been seen before.
type naiveCounter struct {
	mu    sync.Mutex
	count int
}

func (c *naiveCounter) record(eventID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.count++ // every arrival counts, retry or not
}

// idempotentCounter: dedupes by event_id before it ever touches the count.
type idempotentCounter struct {
	mu    sync.Mutex
	count int
	seen  map[string]bool
}

func (c *idempotentCounter) record(eventID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen[eventID] {
		return // no-op: this is the exactly-once EFFECT, not exactly-once delivery
	}
	c.seen[eventID] = true
	c.count++
}

func main() {
	naive := &naiveCounter{}
	idem := &idempotentCounter{seen: map[string]bool{}}

	// One real click. The network times out, the client retries.
	// Two messages arrive for the SAME event_id — this is at-least-once delivery, working as designed.
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			naive.record("evt_ad442_click_001")
			idem.record("evt_ad442_click_001")
		}()
	}
	wg.Wait()

	fmt.Printf("naive counter:      %d  (WRONG — one real click, counted twice)\n", naive.count)
	fmt.Printf("idempotent counter: %d  (RIGHT — retry recognized as the same event)\n", idem.count)
}
```

Run it. `naive` prints `2`. `idempotent` prints `1`. Same two messages, same network retry, one silently wrong number and one that isn't — the entire idempotency argument in twelve lines you can watch execute.

## 8. The sabotage — one fault to inject, and exactly what to watch change

**Inject:** in the `idempotentCounter` demo above, comment out the `if c.seen[eventID] { return }` check — i.e., go back to the naive version — but now fire **five** retries instead of two (`for i := 0; i < 5; i++`).

**Watch:** the count goes to `5` for one real click. Then flip it back to the deduplicated version and fire the same five retries — the count stays `1`.

**The production-shaped version of this same fault:** kill the hot-path stream processor for 20 minutes (this repo's [Q31](./answers.md#a31-stream-processor-down-for-20-minutes)) — nothing is lost, because Kafka's retention holds the backlog and the consumer resumes from its last committed offset, but consumer lag, measured as *age*, climbs the whole time it's down and only that metric — not error rate, not request count — tells you anything is wrong. That's the same "which signal actually catches the failure" lesson as the counter demo, one layer up the stack.

## 9. One-sentence recap

**Every event lands once, deduplicated by `event_id`, in a durable replayable log; a fast, approximate, windowed path reads it for the dashboard; a slow, exact, fully-replayed path reads it independently for the invoice; and the exact number always corrects the approximate one, in place — the two were never supposed to match in real time, only to reconcile.**

## 10. What transfers

**Incidental to this stack:** Kafka specifically (Kinesis or Pulsar implement the same partitioned-replayable-log primitive), Redis specifically for the hot counters (any low-latency KV store with atomic increment does), Count-Min Sketch specifically (any fixed-memory approximate-counting structure trades the same error for the same memory bound).

**True of every system shaped like this:** at-least-once delivery is the default the moment a network is involved, so idempotency is never optional; a single hot key caps throughput regardless of how big the cluster is; a fast approximate view and a slow exact view of the same data are not a bug to be engineered away — they're the honest shape of the trade-off, and the design's job is reconciling them, not merging them into one system that's secretly neither.

---

## Recall check

Before moving on, answer these without scrolling up:

1. Describe the data flow in one sentence — the same sentence as the recap above.
2. What is each of the four boxes' job (ingestion, log, hot path, cold path), and what breaks if you delete one?
3. Monday-morning symptom again: dashboard says 2.1M, invoice says 2.4M. Which number do you trust, and what's the one-sentence explanation you'd give the advertiser?

If you can't answer #3 crisply — "the invoice is the exact, fully-replayed number; the dashboard is a fast estimate that was never meant to match it" — go re-read section 5, not the whole file.
