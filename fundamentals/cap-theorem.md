# CAP Theorem

During a network partition, a distributed store must choose between **Consistency** (every node sees the same, latest data) and **Availability** (every live node keeps responding). It cannot have both while the network is actually split. Partition tolerance isn't the third option you pick — it's the reality you're forced to handle.

---

## The Problem It Names (Not Solves)

Networks partition. That's not a design choice, it's physics — cables get cut, routers fail, regions lose connectivity. CAP forces you to decide, ahead of time, what your system does the moment that happens: keep answering with possibly-stale data, or stop answering until it can be sure the data is current.

---

## How It Works

```
THE COMMON MISCONCEPTION:  "pick 2 of {Consistency, Availability, Partition tolerance}"
WHY THAT'S WRONG:          Partitions happen whether you "pick" them or not — P isn't optional.
THE CORRECT FRAMING:       P is mandatory. DURING a partition, you choose C or A.
                            With NO partition, a well-built system gives you both.
```

| Choice during a partition | What happens |
|---|---|
| **CP** | Refuse or limit requests on the minority side rather than risk stale/conflicting data |
| **AP** | Keep serving everyone — some nodes may answer with stale or divergent data |
| **"CA"** | Not a real distributed system — this is just a single node, or one that halts entirely on any partition |

---

## Analogy

> Two shops sharing one stock ledger by phone. The phone line gets cut. A customer wants the last item at shop 1: refuse the sale until the line is back (chose Consistency, gave up Availability), or sell it and risk shop 2 sold the same item (chose Availability, gave up Consistency). When the phone line works, you never had to choose — the dilemma only exists *during* the outage.

---

## The Subtlety That Trips People Up

CAP's "C" is **linearizability** — a replication-layer guarantee about the order and recency of reads/writes across nodes. It is **not** the same "C" as ACID's Consistency, which is about preserving application-level invariants (foreign keys, balance ≥ 0) within a single transaction. Confusing the two is one of the most common CAP mistakes in interviews. The second trap: CAP is not a global, whole-system label — mature systems choose CP or AP **per operation**, not once for the entire product (a "likes" counter can be AP while checkout is CP, in the same system).

---

## Interview Questions

**Q1. "Pick two of C, A, P" — what's wrong with that framing?**
Partition tolerance isn't something you opt into or out of; the network will partition regardless of your design, so P is a fact of distributed systems, not a design knob. The real choice CAP describes only exists *during* an actual partition: consistency or availability. Outside a partition, a well-designed system can and should provide both.

**Q2. Why can a single-node database claim to be "CA"?**
Because it has no partition to worry about in the first place — there's only one node, so there's nothing to partition between. "CA" only makes sense for a non-distributed system; claiming CA for a genuinely distributed, multi-node system is a category error, since some partition scenario always exists once there's more than one node talking over a network.

**Q3 (depth). Give a concrete example of choosing CP vs AP for two different endpoints in the same product.**
A "likes" counter can be AP — serving a slightly stale count during a partition is harmless, and refusing to show a number at all would be a worse user experience. A checkout endpoint reserving the last unit of inventory should be CP — serving an available-but-wrong answer risks selling the same physical item twice, which is a real, costly failure the business cares about far more than a brief unavailability.

**Q4 (senior). Amazon's Dynamo chose AP for the shopping cart. What did that cost them, and why was it acceptable?**
Choosing AP means concurrent writes during a partition (two devices adding items while disconnected from each other's replica) get reconciled by merging siblings at read time — and a known consequence of union-merge is that a concurrently-removed item can reappear (the "resurrected cart item," see [vector-clocks](./vector-clocks.md)). Amazon judged that an "add to cart" must never fail — losing a sale is worse than an occasional item needing to be removed twice — a judgment call that would be unacceptable for, say, a payment amount.

---

## Where This Shows Up in This Repo

- [distributed-transactions/deep-dive.md §3 — CAP Theorem, Stated Correctly](../interviews/distributed-transactions/deep-dive.md#3-cap-theorem--stated-correctly) — full misconception breakdown, the two C's, and per-operation CP/AP choice
- [pacelc-theorem.md](./pacelc-theorem.md) — the everyday extension of CAP that applies even when there's no partition at all
