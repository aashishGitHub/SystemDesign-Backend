# Split Brain

Two (or more) partitions of a cluster each believe **they** are the legitimate leader/owner and both keep accepting writes independently. It's the failure mode every leader-election and quorum mechanism exists to prevent.

---

## The Problem

A network partition doesn't stop nodes from running — it just stops them from talking to each other. If both sides of the partition can independently conclude "the old leader is unreachable, I should take over," you end up with two active leaders accepting conflicting writes, and no way to reconcile them afterward without data loss or manual intervention.

---

## How It Works (as a failure, and its prevention)

```
Before partition:      [A(leader) - B - C]  — one cluster, one leader

Network splits:        [A(leader)]   |   [B - C]
                         minority         majority

Without protection:    A keeps serving writes (it doesn't know it's isolated)
                       B and C elect a new leader, say B, and ALSO serve writes
                       → TWO leaders, TWO independent write streams → split brain

With quorum:           A is alone — cannot get a write quorum ack from anyone
                       → A's writes can be accepted locally but never commit
                       B+C form a majority → B can be legitimately elected and commit writes
                       → only ONE side can make committed progress
```

The prevention is always the same idea: require a **majority** ([quorum](./quorum.md)) to make any decision stick, so the minority side is structurally unable to commit anything, even if it doesn't realize it's the minority.

---

## Analogy

> A company where the CEO gets cut off from headquarters during a crisis. If both the isolated CEO and a VP back at HQ start independently signing contracts on the company's behalf, you don't have "cautious redundancy" — you have two companies making conflicting commitments, and reconciling them after the fact might not be possible at all.

---

## The Subtlety That Trips People Up

Quorum prevents the **minority side from committing new state** — it does not prevent the minority leader from believing it's still in charge and accepting writes *locally*. Those locally-accepted-but-never-committed writes need to be discarded once the partition heals and the stale leader discovers a newer term/leader exists. This is why "quorum-safe" and "split-brain-proof" aren't quite the same claim as "no node will ever briefly act like a zombie leader" — the zombie can exist for a window; it just can never get its writes to durably matter.

---

## Interview Questions

**Q1. Why doesn't the isolated leader just realize it's cut off and step down?**
It can't distinguish "the network is down" from "everyone else crashed" — both look identical from inside a partition (this is the same "can't tell slow from dead" limit as [heartbeat](./heartbeat.md) detection). The isolated leader keeps believing it's the legitimate leader precisely because nothing tells it otherwise from its own vantage point.

**Q2. How does requiring a quorum prevent split brain, given the isolated leader doesn't know it's isolated?**
It doesn't stop the isolated leader from *believing* it's in charge — it stops that belief from mattering. Any write requiring quorum ack simply cannot get enough acks from a minority partition, so those writes never commit, no matter how confidently the isolated leader accepts them locally.

**Q3 (depth). A cluster splits exactly in half (say 3-3 out of 6 nodes) — what happens?**
Neither side has a majority, so neither side can elect a new leader or commit writes — the whole cluster stalls until the partition heals. This is precisely why odd-sized clusters (5, not 6) are preferred: an even split is structurally impossible, so one side always has a majority and the system can keep making progress.

**Q4 (senior). The partition heals and the old, isolated leader is still running — what needs to happen for it to stop causing problems?**
It needs to discover a higher term/epoch number exists (from the now-reconnected majority side) and step down, discarding any writes it accepted locally that never committed. Systems that expose the shared resource itself (storage, a downstream API) to both leaders during the overlap window additionally need a [fencing token](./fencing.md) so the resource can reject the stale leader's writes even before it realizes it's stale.

---

## Where This Shows Up in This Repo

- [consensus/deep-dive.md §10 — Split Brain and Network Partitions](../interviews/consensus/deep-dive.md#10-split-brain-and-network-partitions) — "🔴 Architect — Asymmetric Partitions and the 'Zombie Leader'"
- [consensus/deep-dive.md §14 — Membership Changes Without Split-Brain](../interviews/consensus/deep-dive.md#14-membership-changes-without-split-brain)
- [seat-reservation/deep-dive.md §4 — Distributed Locks and the RedLock Debate](../interviews/seat-reservation/deep-dive.md#4-distributed-locks-and-the-redlock-debate)
- [quorum.md](./quorum.md) and [fencing.md](./fencing.md) — the two mechanisms that jointly close this failure mode
