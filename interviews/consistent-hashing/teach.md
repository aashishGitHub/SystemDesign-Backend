# Teach Script: Consistent Hashing

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the system; don't just recognize the vocabulary.
> **Not a replacement for:** [`answers.md`](./answers.md) (the full Q&A grill) or [`deep-dive.md`](./deep-dive.md) (production depth). This is the narrated version.
> **Every number and fact below is pulled from this repo's own [`answers.md`](./answers.md)** — nothing here is a new claim.

---

## 1. The symptom

Traffic is growing, so you do the responsible thing: you add an 11th node to your 10-node cache cluster, ahead of a big sale, to buy yourself headroom. Within seconds of that node joining, your database goes from 20% CPU to fully saturated, and checkout starts timing out.

**You didn't remove capacity. You added it.** And adding it nearly took the site down. That's the sentence worth sitting with — the operation that was supposed to make things safer is the one that triggered the outage, and if you don't already know the exact mechanism, you don't yet understand why `hash(key) % N` — a completely reasonable-looking line of code — is the thing that did this.

## 2. Why you should care

This is the textbook justification for why consistent hashing exists at all, and it's asked constantly at the senior/staff level precisely because the naive approach *looks* correct, passes every test at a fixed cluster size, and only fails the first time the cluster actually needs to grow or shrink — which, in production, is inevitable. Whoever designs the sharding scheme for any cache or distributed store owns this decision, and it's one of the cheapest mistakes to avoid *if* you know to ask about it up front.

## 3. What / Why / How

1. **What is `hash(key) % N` actually deciding**, and why does it feel like an obviously fine thing to do?
2. **Why does changing N — even by exactly one — break almost every key's assignment**, not just a proportional few?
3. **How do you shard so that adding or removing one node moves roughly `1/N` of the keys**, not nearly all of them?

## 4. Umbrella words — kill them before using them

**"Distribute load evenly."** This phrase hides two *completely different* problems that get solved by two *completely different* mechanisms, and conflating them is the single most common mistake in this topic: distributing the **key space** evenly across nodes (what a ring plus virtual nodes solves) versus distributing **access frequency** evenly when one specific key is disproportionately popular (a *hot key* — which consistent hashing has no mechanism for at all, by design, because it only ever decides *where* a key lives, never *how often* it's requested).

**"Fault tolerant" / "replicated."** Decompose it into the actual mechanics: a **preference list** (the primary owner plus the next N-1 *distinct physical* nodes walking the ring — virtual-node duplicates of the same machine are skipped, or "3 replicas" could secretly mean 3 tokens on one box), the **quorum condition** `W + R > N` (which guarantees a read always overlaps a prior write), and — worth naming even though it's the less comfortable part — **sloppy quorum plus hinted handoff** trades some of that guarantee for availability: a write can succeed by landing on a substitute node during a failure, with a "hint" saying who it really belongs to. That hint sits on **exactly one, unreplicated node** — which means the write the client already got a `200 OK` for has a real, nameable way to still be lost (the substitute dies before handoff, or the outage outlasts the hint's retention window).

**"Even distribution."** Even this is two different guarantees: growing/shrinking the cluster should only move a **bounded fraction** of keys (the ring's job), and a *fixed-size* cluster should serve **roughly equal load per node** (virtual nodes' job) — a ring with too few physical points can satisfy the first and still badly fail the second.

## 5. The boxes — built one need at a time

**You need to spread millions of keys across a fixed number of nodes.** The obvious first move: `hash(key) % N` — hash the key, take it modulo the node count, that's the bucket. It requires no extra data structure, and it works *perfectly* — as long as N never changes.

```
hash("user:42") % 10 = 6  →  Node 6 owns this key
```

**Now — the gap that produces the symptom from section 1.** What happens the instant N changes, because you add an 11th node? For almost every key, `hash(key) % 10` and `hash(key) % 11` land on *different* numbers — there's no structural reason for them to agree, and mostly they don't. This repo's own numbers make the scale of it concrete: going from 4 to 5 nodes remaps **~80%** of keys; 10 to 11 remaps **~90%**; 100 to 101 remaps **~99%**. Notice the direction: **the bigger your cluster gets, the *worse* a single node addition becomes** — exactly backwards from what you'd want as a system scales. Every one of those remapped keys is now a guaranteed miss on a node that has never seen it, and if even a fraction of your traffic touches those keys at once, you get every one of those misses falling through to the database simultaneously — the thundering herd from section 1, at whatever fraction of your dataset just got reshuffled.

```
Key K → hash(K) % 10 = bucket 4 (before)
Key K → hash(K) % 11 = bucket 9 (after)     ← moved, for no structural reason
```

**Fix: stop coupling "which node owns this key" to "how many nodes currently exist."** Put both nodes and keys onto the same circular hash space, using the same hash function, and say a key belongs to whichever node comes next walking **clockwise**. Now, adding a node only carves into the range of the *one* existing node whose arc it lands inside — every other node on the ring is completely undisturbed.

```
Ring: A=10, B=120, C=230 (positions on a circle)
D joins at 180 → only C is affected (C's range shrinks from [121,230] to [181,230])
A and B never notice D exists.
```

**Gap: the ring fixes churn on resize, but introduces a brand-new problem when there are only a few physical nodes.** Three random points on a circle are, by simple probability, unlikely to be evenly spaced — the same way three darts thrown at a dartboard rarely land 120° apart. This repo's own worked example: three nodes at positions 5, 8, and 190 on a 360-point ring end up with one node owning **1%** of the ring while the other two own roughly **48%** and **51%**. That's not a bug in the hash function — it's the expected statistical outcome of only three sample points.

**Fix: virtual nodes.** Give each physical node *many* positions on the ring (100+), instead of one. **The lookup logic changes not at all** — still "hash the key, walk clockwise to the next position" — but now each physical node's share of the ring is the *sum* of many small, scattered arcs, and by the law of large numbers, that sum evens out across nodes even though any single arc is still random. There's a second benefit worth naming unprompted: when a physical node dies, its many small arcs hand off to *many different* neighbors, instead of dumping its entire share onto one single clockwise successor, who then risks falling over too.

**Gap, and the one that trips up candidates who think a well-balanced ring solved everything: what about one specific key that's disproportionately popular** — a celebrity's profile, mentioned in a million posts in an hour? Consistent hashing distributes the *key space* evenly. It has **no mechanism whatsoever** for uneven *access frequency* to a single key — every one of those million requests for that one key lands on the exact same node, no matter how perfectly balanced the ring is. This needs a separate fix entirely: **split the hot key itself** into sub-keys (`user:1:shard:0` … `user:1:shard:9`), fan writes out to all of them, spread reads across them at random — or add a local, in-process cache layer in front for just the hottest handful of keys.

**Last gap: a node holding a range simply dies, with no warning.** If there's only one copy of that data, that range is genuinely gone until the node is restored. Fix: **replication** — a key's preference list is the primary plus the next N-1 *distinct physical* nodes walking clockwise, and the quorum condition `W + R > N` decides how strongly a read is guaranteed to see the latest write. When the honest engineering trade shows up — a node is down and you want to keep accepting writes anyway — a **sloppy quorum** lets a substitute node accept the write with a hint attached, and **hinted handoff** delivers it once the original node recovers. Say the honest cost of that out loud: the hint lives on one unreplicated node, so the client's `200 OK` is genuinely weaker than it looks until that handoff actually completes.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **nodes and keys are hashed onto the same ring so a key belongs to whichever node comes next clockwise, which decouples "who owns this key" from "how many nodes currently exist"; each physical node claims many scattered positions on that ring so the key space balances out statistically even with few physical machines; and none of that touches access frequency, so a single overloaded key needs its own fix — splitting or a local cache — entirely separate from the ring.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the exact ring-size constant (`0` to `2³²-1` is common), Cassandra's specific default of 256 vnodes, and which hash function a given system uses (Murmur3, CRC16) — useful facts to cite, not things you derive from scratch.

**Understand once, then trust it:** the shape of a zero-downtime migration from modulo to consistent hashing (dual-write to both systems, read from the new one with a fallback to the old, then cut the fallback once the new system is warm) — know the *shape*, not every step by memory; Redis Cluster's alternative design (16,384 fixed hash slots instead of a continuous ring) as a deliberate, valid choice for operational explicitness, not a "wrong" version of consistent hashing.

**This is the actual idea — think hard here:** (1) the ring's entire contribution is decoupling key assignment from cluster size — everything else in this topic is refinement layered on top of that one move; (2) virtual nodes are a **correctness requirement**, not a tuning knob, the moment your physical node count is small enough that random placement can plausibly be lopsided; (3) consistent hashing solves key-space distribution and has *zero* mechanism for access-frequency distribution — a hot key is a different problem needing a different fix, never "add more vnodes"; (4) replication turns "a node died" from "this data is gone" into "read from one of its other known copies," but a sloppy quorum's hinted write is itself briefly a single point of failure for a write the client already believes is durable.

## 7. The build — the smallest thing that actually shows the mechanism

No real 10-node Redis or Cassandra cluster here — the two mechanisms that actually matter (churn on resize, and load balance with few physical points) are both visible with plain Python and a hash function:

```python
# save as ring_demo.py, run with: python3 ring_demo.py
import hashlib
import bisect
from collections import Counter

def h(x):
    return int(hashlib.md5(x.encode()).hexdigest(), 16)

NUM_KEYS = 10_000
keys = [f"key-{i}" for i in range(NUM_KEYS)]

# ---- Part 1: how many keys move when the cluster grows by ONE node? ----

def modulo_owner(key, n):
    return h(key) % n

moved_modulo = sum(
    1 for k in keys if modulo_owner(k, 10) != modulo_owner(k, 11)
)

class Ring:
    """A consistent-hash ring with `vnodes_per_node` positions per physical node."""
    def __init__(self, nodes, vnodes_per_node=100):
        self.ring = {h(f"{n}-{v}"): n for n in nodes for v in range(vnodes_per_node)}
        self.positions = sorted(self.ring)

    def owner(self, key):
        pos = h(key)
        idx = bisect.bisect(self.positions, pos) % len(self.positions)
        return self.ring[self.positions[idx]]

nodes_10 = [f"node-{i}" for i in range(10)]
nodes_11 = nodes_10 + ["node-10"]
ring_before, ring_after = Ring(nodes_10), Ring(nodes_11)

moved_ring = sum(1 for k in keys if ring_before.owner(k) != ring_after.owner(k))

print("--- Adding ONE node to a 10-node cluster ---")
print(f"Modulo hashing:       {moved_modulo:5d}/{NUM_KEYS} keys moved ({moved_modulo/NUM_KEYS:.0%})")
print(f"Consistent hash ring: {moved_ring:5d}/{NUM_KEYS} keys moved ({moved_ring/NUM_KEYS:.0%})")

# ---- Part 2: does the ring alone (no vnodes) balance load evenly? ----

def load_spread(ring):
    counts = Counter(ring.owner(k) for k in keys)
    return min(counts.values()), max(counts.values())

lo1, hi1 = load_spread(Ring(nodes_10, vnodes_per_node=1))
lo100, hi100 = load_spread(Ring(nodes_10, vnodes_per_node=100))

print()
print("--- Load balance across 10 nodes (10,000 keys, ideal = 1,000/node) ---")
print(f"1 vnode per node:    min={lo1}, max={hi1} keys on a single node")
print(f"100 vnodes per node: min={lo100}, max={hi100} keys on a single node")
```

Run it. Modulo hashing moves **~90%** of keys for one node addition — matching this repo's own documented figure for a 10→11 transition exactly. The ring moves **~10%**, right around the ideal `1/11 ≈ 9%`. Then, with only one position per node, load swings from roughly 100 keys on the least-loaded node to nearly 3,000 on the most-loaded one — the statistical accident from section 5, reproduced on your own machine. With 100 positions per node, that gap collapses to a tight band around the ideal 1,000.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** Change `nodes_11` to add *two* new nodes instead of one (`nodes_10 + ["node-10", "node-11"]`) and rerun Part 1. Modulo hashing's churn stays catastrophic (going 10→12 remaps almost everything, same as before) while the ring's churn scales roughly linearly with the number of nodes added — two new nodes disturb roughly twice as many keys as one did, and *still* only the handful of existing nodes whose arcs those new positions land inside. The ring's disruption is proportional to what changed; modulo's disruption is total, regardless of how small the change was.

**Sabotage 2 (walk it in your head, no code needed).** Now imagine the ring is perfectly vnode-balanced — 100 positions per node, beautifully even load, exactly like Part 2's second measurement — and one specific key, say `"user:1"`, starts receiving a million requests an hour while every other key gets a handful. Walk it: `h("user:1")` still hashes to exactly one position on the ring, which still resolves to exactly one physical node, no matter how many *other* keys are perfectly spread across the other nine. All one million requests land on that single node. **Adding more vnodes does nothing here** — vnodes redistribute the *ring's geometry*, and the geometry was never the problem; the *access pattern* is. This is precisely why hot-key mitigation (splitting the key, or a local cache in front of it) has to be a separate, deliberate design decision — no amount of ring tuning touches it.

## 9. One-sentence recap

Same words as before, on purpose: **nodes and keys are hashed onto the same ring so a key belongs to whichever node comes next clockwise, which decouples "who owns this key" from "how many nodes currently exist"; each physical node claims many scattered positions on that ring so the key space balances out statistically even with few physical machines; and none of that touches access frequency, so a single overloaded key needs its own fix — splitting or a local cache — entirely separate from the ring.**

## 10. What transfers

Swap the ring for Redis Cluster's fixed hash-slot model, or swap MD5 for Murmur3/CRC16, and this lesson is unchanged — those are the incidental, swappable pieces. What transfers to **every** system that shards data across a variable number of nodes: decoupling assignment from node *count* (not just cache clusters — CDN edge routing and DNS-based load balancing use the identical ring idea); virtual nodes as the standard fix for small-N statistical imbalance, and as a genuine correctness requirement rather than an optional tuning parameter; the hard distinction between key-space balance and access-frequency balance, which is never solved by the same mechanism; and replication with an honest quorum trade-off — including naming, out loud, the specific window where a sloppy quorum's acknowledgment is weaker than the client thinks it is.

---

## Recall check — answer these without scrolling up

1. **Describe the data flow in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5.)*
2. **What is each box's job, and what breaks if you delete it?**
   - *Model answers:* delete the ring and go back to plain modulo hashing → the section 1 symptom returns exactly: a single node addition remaps ~80-99% of keys depending on cluster size, and every remapped key becomes a simultaneous database miss. Delete virtual nodes and keep only one ring position per physical node → load can swing wildly uneven purely by chance, exactly like the 1%/48%/51% example, even though "the ring" is technically working. Delete replication → a single node failure makes its entire key range genuinely unavailable until that one node is restored, with no fallback.
3. **What would you look at first if this got slow, or wrong, in production?** *(Model answer: per-node key count and request-rate ratio first — a ratio consistently over ~2x between nodes with the same vnode count signals either a biased hash function or a hot key, and those two have different fixes; then whether the imbalance follows *specific keys* [hot key → splitting] or *specific nodes* [biased hash or under-weighted vnodes → check hash uniformity or heterogeneous node capacity]; then, if nodes are flapping up and down, whether you're seeing genuine failures or ring oscillation from a too-aggressive failure-detection timeout.)*

If you answered all three cold, go read `answers.md` anyway — this script deliberately skipped jump consistent hash, weighted vnodes for heterogeneous hardware, and the range-vs-hash sharding decision (A26, A29–A30) because piling every idea into one narrative would bury the four that actually matter. Those are the natural next read.
