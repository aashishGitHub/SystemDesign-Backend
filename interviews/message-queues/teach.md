# Teach Script: Message Queues & Event Streaming

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the system; don't just recognize the vocabulary.
> **Not a replacement for:** [`answers.md`](./answers.md) (the full Q&A grill) or [`deep-dive.md`](./deep-dive.md) (production depth). This is the narrated version.
> **Every number and fact below is pulled from this repo's own [`answers.md`](./answers.md)** — nothing here is a new claim.

---

## 1. The symptom

A customer emails support: "I was charged twice for one order." You check the orders table — exactly **one** order, `order-789`. You check the payment gateway's dashboard — **two** successful charges, thirty seconds apart, same amount, same card. Nobody double-clicked "Buy." There's no error anywhere in the logs. The system did precisely what it was built to do, and it still charged someone twice.

That's the part worth sitting with: **nothing crashed in a way anyone would notice.** No alert fired. No exception was thrown. A perfectly healthy-looking system produced a wrong, expensive answer — and if you don't already know exactly why, you don't yet understand what a message queue actually promises you.

## 2. Why you should care

The moment a backend splits into services that talk asynchronously — order service, inventory service, payment service, notification service — someone has to own the queue between them, and it's usually a backend engineer who gets paged when "the queue" produces a bug like this one. This isn't a Kafka-specific quirk; it's a property of **every** message queue, because it follows from a fact about networks, not about any particular vendor.

## 3. What / Why / How

1. **What is a message queue actually doing** between two services?
2. **Why can't you just call the other service directly over HTTP** — what specifically breaks?
3. **How do you build a pipeline that can't double-charge anyone**, given that the queue itself is going to deliver the same message twice sometimes, on purpose, as a feature?

## 4. Umbrella words — kill them before using them

**"Decoupled" / "asynchronous."** Vague until you can list what the producer specifically doesn't have to know: **who** the consumers are, **how many** of them exist, **whether** they're online right now, and **how fast** they process. A producer that publishes "order.created" and moves on is decoupled on all four axes at once — that's the whole value, not a side effect.

**"Reliable" / "guaranteed delivery."** This phrase is doing damage until you decompose it into the three delivery guarantees that actually exist: **at-most-once** (fire and forget — may lose, never duplicates), **at-least-once** (retry until acked — never loses, may duplicate), and **exactly-once** (delivered once, period). And here's the part worth saying out loud before it gets said to you in an interview: **exactly-once delivery is not actually achievable over a network.** This is the two generals problem — a producer that sends a message and gets no ack cannot tell "the message was lost" apart from "the message arrived and the ack was lost," so it must always be willing to retry, which means duplicates are always possible. What's real is **exactly-once *effect***: at-least-once delivery plus a consumer that makes a duplicate a no-op. That gap between the phrase and the reality is the entire lesson of this topic.

**"Ordering."** Kafka guarantees ordering **only within a partition** — global order across the whole topic is not a thing. `msg1` and `msg4` can be consumed in either order if they're on different partitions. So "ordering" only means something once you've said *which* partition key groups the things that need to stay in order.

## 5. The boxes — built one need at a time

**The Order Service needs to tell Inventory, Payment, and Notification that an order happened** — but it can't call all three synchronously, because if Payment is slow, the customer's whole checkout hangs waiting on a service they don't even know exists. So the first thing you need is something that sits between the producer and the consumers, absorbing the speed difference. That's the **queue** (or broker).

```
[ Order Service ] ──▶ [ Queue ] ──▶ [ Inventory Service ]
                                 └─▶ [ Payment Service ]
                                 └─▶ [ Notification Service ]
```

**Gap: does every service need to see every message, or should exactly one worker handle each job?** These are genuinely different shapes, and conflating them is a real design mistake. **Point-to-point** (a queue): each message goes to exactly one consumer — right for distributing work, like "process this uploaded image." **Pub-sub** (a topic): each message goes to every subscriber — right for broadcasting a fact, like "an order happened," which Inventory, Payment, *and* Notification all need to react to independently.

**Gap: for a given user, their orders need to process in the order they were placed — how do you guarantee that?** A **partition key** decides which partition a message lands in, and only messages *with the same key* are ordered relative to each other. Partition by `user_id`, and `order1` for `user_123` is always processed before `order2` for `user_123` — but a different user's order can land anywhere and interleave freely, which is fine, because it doesn't need to be ordered against `user_123`'s.

```
partition = hash(key) % num_partitions
```

**Gap: one consumer reading everything doesn't scale — how do multiple consumers split the work without breaking the ordering you just bought?** A **consumer group**: each partition is read by exactly one consumer in the group at a time, so partition 0 always goes to the same consumer while it's in that role, and per-partition order is preserved even though three different consumers are working three different partitions in parallel.

**Gap: the broker is one machine — what happens when that machine dies?** **Replication.** Each partition has one leader and N followers copying its log; the followers that are actually caught up are the **ISR** (in-sync replicas). The `acks` setting decides how safe a write is before the producer hears "success" — `acks=0` doesn't wait at all, `acks=1` waits for the leader, `acks=all` waits for every ISR member. More safety, more latency — a dial, not a default.

**Now — the gap that produces the symptom.** The consumer reads a message, does its work (charges the card), and then commits its **offset** back to the broker to say "I'm done with this one." What if the consumer crashes in between — *after* charging the card, *before* committing the offset? The broker never saw a commit. On restart, it redelivers the exact same message. The consumer charges the card again. **That's the double charge from section 1, and you've just built the architecture that produces it, on purpose, because at-least-once delivery requires this to be possible.**

```
1. Consumer reads: "charge customer $100 for order-789"
2. Consumer calls payment API — SUCCESS
3. Consumer CRASHES before committing the offset
4. Consumer restarts, offset was never advanced → same message redelivered
5. Consumer calls payment API AGAIN — the customer is charged twice
```

**The fix has to live in the consumer, not in the broker**, because the broker genuinely cannot know whether you finished the side effect before crashing — that information only exists in your application. Before doing anything with a real-world effect, check a durable dedupe record keyed on something like `order_id` (a DB unique constraint, or an explicit idempotency-key table): if it's already there, the message is a redelivery — return, do nothing. If not, do the work and record the key *in the same transaction* as the business write.

**One more gap, on the producer side, that's the mirror image of the same problem.** Writing the order to the database and publishing the event to the queue are two separate operations — what if the process dies between them? This is the **dual-write problem**: the DB commits but the publish never happens (a real order that no downstream service ever hears about), or the event gets published but the DB transaction then rolls back (downstream services process an order that doesn't exist). `@Transactional` does not save you here — Kafka is not inside your database's transaction. The fix is the **transactional outbox**: write the business row *and* an outbox row describing the event, in one local database transaction. A separate relay process reads unsent outbox rows and publishes them, marking them sent — so the event can never exist without the order, or the order without the event.

```
[ Order Service ] ──ONE local txn──▶ [ orders table + outbox table ]
                                              │
                                    [ Outbox relay, separate process ]
                                              │
                                              ▼
                                        [ Queue / Kafka ]
```

**Last gap: some messages will never succeed no matter how many times you retry them** — a permanently malformed payload, a business rule that will never pass. Retrying forever blocks the partition behind it. Retry a bounded number of times with exponential backoff, and after that move the message to a **Dead Letter Queue (DLQ)** for manual review — a place for messages you've given up on automatically fixing, not a place you forget about.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **the producer writes its business row and its outbox event in one local transaction; a relay publishes from the outbox into the broker; the broker holds it durably and may legitimately deliver it more than once; and a redelivery is always a no-op, never a second charge, because the consumer checks a durable dedupe key before doing anything with a real-world effect.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the exact `bootstrap_servers` connection string, the specific `KafkaConsumer`/`KafkaProducer` client boilerplate, and whether your cluster runs ZooKeeper or KRaft for metadata — these are configuration details that follow once you understand what they're *for*.

**Understand once, then trust it:** the `acks` levels and ISR mechanics (know that `acks=all` is safer and slower, you don't need to reimplement replication); that a consumer-group rebalance causes a stop-the-world pause and some reprocessing (know it happens, don't hand-roll the protocol); log compaction (A22) as a mechanism for changelog-style topics — useful to know exists, rarely the thing you're building yourself.

**This is the actual idea — think hard here:** (1) the dual-write problem and why the outbox is the *only* real fix, not a nice-to-have; (2) idempotent-by-key consumers as the true mechanism behind "exactly-once" — this is application code you write, not a Kafka setting you flip; (3) offset-commit timing — you deliberately commit *after* processing and accept that a crash mid-way means reprocessing, rather than trying to engineer that possibility away; (4) the partition key controls both per-key ordering *and* your parallelism ceiling, at the same time, with the same choice.

## 7. The build — the smallest thing that actually shows the mechanism

No real Kafka cluster here — that's genuinely infrastructure with real setup cost, and faking it with a few lines of `docker compose` would only teach you the YAML. The one mechanism from bucket three above — idempotent consumption — fits in fifteen lines of runnable Python:

```python
# save as idempotent_consumer_demo.py, run with: python3 idempotent_consumer_demo.py

charged_naive = []
charged_idempotent = []
processed_order_ids = set()   # stands in for a DB unique constraint on order_id

def naive_charge(order):
    """Charges the card. Has no memory of what it already did."""
    charged_naive.append(order["order_id"])

def idempotent_charge(order):
    """Charges the card only if this order_id has never been recorded before."""
    if order["order_id"] in processed_order_ids:
        return                     # already charged — a no-op, not an error
    charged_idempotent.append(order["order_id"])
    processed_order_ids.add(order["order_id"])

order = {"order_id": "order-789", "amount": 100}

# Delivery 1: consumer charges the card, then CRASHES before committing
# its offset back to the broker.
naive_charge(order)
idempotent_charge(order)

# The broker never saw a commit, so it redelivers the exact same message.
naive_charge(order)
idempotent_charge(order)

print("Naive consumer charged this order:     ", len(charged_naive), "time(s)")
print("Idempotent consumer charged this order:", len(charged_idempotent), "time(s)")
```

Run it. The naive consumer and the idempotent consumer disagree on how many times the card was charged — and at production volume instead of two lines of Python, that disagreement is a real refund queue.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** Add a third redelivery — copy the last two `naive_charge(order)` / `idempotent_charge(order)` lines once more, simulating a consumer-group rebalance that reprocesses the message yet again — and rerun. The naive consumer climbs to 3 charges; the idempotent one stays locked at 1, no matter how many times the exact same message shows up. **You cannot stop the broker from redelivering — you can only make the consumer immune to however many times it happens.**

**Sabotage 2 (walk it in your head, no code needed).** Now delete the outbox from the architecture and go back to a plain dual write: `db.save(order)` then `kafka.send("order.created", order)` as two separate lines. Kill the process between them. Walk both branches: if the DB commit succeeded and the process died before the send, you have a real order sitting in your database that **no downstream service will ever hear about** — inventory never reserved, payment never charged, and nothing in any log tells you this order exists until a customer asks where it is. If instead the send happened and the DB transaction then rolled back, downstream services just processed an order that **does not exist** — inventory gets reserved for nothing, a confirmation email goes out for an order with no row behind it. There is no version of "two separate writes" that closes both gaps. That's *why* the outbox has to be one atomic transaction, not an optimization you can skip under time pressure.

## 9. One-sentence recap

Same words as before, on purpose: **the producer writes its business row and its outbox event in one local transaction; a relay publishes from the outbox into the broker; the broker holds it durably and may legitimately deliver it more than once; and a redelivery is always a no-op, never a second charge, because the consumer checks a durable dedupe key before doing anything with a real-world effect.**

## 10. What transfers

Swap Kafka for RabbitMQ, SQS, or Pulsar and this lesson is unchanged — the exact client config, `ZooKeeper` vs `KRaft`, and the specific `acks` syntax are the incidental, swappable parts. What transfers to **every** message-driven system regardless of broker: the outbox-before-publish pattern as the only real fix for the dual-write problem; idempotent-by-key consumption as the actual mechanism behind "exactly-once," because true exactly-once delivery doesn't exist; a partition (or shard) key controlling both ordering and parallelism at once; committing after processing and *designing for* reprocessing rather than trying to prevent it; and a bounded retry plus a dead-letter queue for the messages that will never succeed no matter how many times you try.

---

## Recall check — answer these without scrolling up

1. **Describe the data flow in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5.)*
2. **What is each box's job, and what breaks if you delete it?**
   - *Model answers:* delete the outbox → the dual-write problem returns, and the database and the event stream can silently diverge in either direction. Delete the idempotency check → every redelivery becomes a second real-world side effect, exactly like the opening symptom. Delete the DLQ → one permanently-failing message either blocks its partition forever (if you keep retrying) or gets silently skipped and lost (if you don't) — neither is acceptable.
3. **What would you look at first if this got slow, or wrong, in production?** *(Model answer: consumer lag first — and whether it's climbing steadily [falling behind] or a brief spike; then whether the problem is on one partition [a poison message or a hot key] or all of them [a genuine capacity ceiling]; then under-replicated partition count, because that's your durability risk if the leader dies right now.)*

If you answered all three cold, go read `answers.md` anyway — this script deliberately skipped Kafka Streams, watermarked joins, Pulsar's architecture, and cluster-sizing math (A34–A42) because piling every idea into one narrative would bury the four that actually matter. Those are the natural next read.
