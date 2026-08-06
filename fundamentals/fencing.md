# Fencing

A **monotonically increasing token** issued every time leadership/lock ownership changes hands. The *resource being protected* checks the token and rejects any write carrying an older one — even from a node that still believes it's in charge.

---

## The Problem

A [lease](./lease.md) can expire on the coordinator's clock while the holder — paused by GC, a slow disk, or a brief network hiccup — still believes it's valid. That stale holder can then write to a shared resource (storage, a downstream API) *after* a new leader has already taken over, silently corrupting state with no error on either side. Fencing closes this gap by making the resource itself the enforcer, instead of trusting each node's private belief about its own validity.

---

## How It Works

1. Every time a new leader/lock-holder is granted, the coordinator hands it a token that is strictly greater than any token issued before (e.g. an incrementing integer, or a Raft term number).
2. Every write to the protected resource must include this token.
3. The resource remembers the **highest token it has ever seen** and rejects any incoming write with a lower token — regardless of who sends it or how confident they are.

```
t=0   Node A gets lease + fencing token = 33
t=10  A pauses (GC). Lease expires on coordinator.
t=11  Node B gets lease + fencing token = 34
t=12  B writes to storage with token=34 → storage records "highest seen: 34" → accepted
t=15  A wakes up, still thinks it's leader, writes with token=33
t=15  storage sees 33 < 34 → REJECTED, even though A doesn't know it's stale
```

---

## Analogy

> A ticket number system with a twist: the counter at the desk only ever serves a *higher* number than the last one it accepted, no exceptions. If someone shows up waving ticket #33 after the desk has already served #34, they're turned away — it doesn't matter that they genuinely believe #33 is still valid.

---

## The Subtlety That Trips People Up

**The token only works if the resource itself enforces it.** Fencing does nothing if the downstream system (a database, an S3 bucket, a payment gateway) has no way to compare tokens and simply accepts whatever write arrives. This is why "just use a lease" is an incomplete answer in an interview — the interviewer is listening for whether you name the fact that the *protected resource*, not the lock service, is where the actual safety check has to live.

---

## Interview Questions

**Q1. Why isn't a lease alone enough to prevent a stale leader from writing?**
A lease only constrains the *holder's own belief* about its validity — it does nothing to stop the holder from acting if it hasn't yet noticed the lease expired (e.g. due to a pause). The write still physically reaches the shared resource; without fencing, the resource has no way to know that write came from a leader that's no longer current.

**Q2. Why must fencing tokens be monotonically increasing rather than just unique?**
The resource's rejection rule is "reject anything lower than the highest I've seen" — that only works if a *newer* leader always gets a *strictly greater* token than every previous one. If tokens were merely unique (e.g. random UUIDs), the resource would have no ordering to compare against and couldn't tell an old token from a new one.

**Q3 (depth). Where does the fencing token typically come from in a Raft-based system?**
The Raft **term number** already has exactly the right property — it strictly increases every time a new leader is elected, and every node agrees on it via consensus. Many systems reuse the term as the fencing token directly instead of inventing a separate counter.

**Q4 (senior). A team says "we use distributed locks, so we're safe from split-brain writes" — what's the follow-up question?**
"Does the resource you're writing to actually check a fencing token, or are you just trusting that only the lock holder will attempt to write?" If the answer is the latter, the lock only prevents *well-behaved, alive-and-current* nodes from racing each other — it does nothing about a paused or partitioned former holder waking up and writing anyway. Locks solve coordination among healthy nodes; fencing solves the case where the lock's belief and reality have diverged.

---

## Where This Shows Up in This Repo

- [consensus/deep-dive.md §12 — Recipe: Leader Election, Locks, and Leases](../interviews/consensus/deep-dive.md#12-recipe-leader-election-locks-and-leases) — "🔴 Architect — The Fencing Token Is Non-Negotiable"
- [seat-reservation/deep-dive.md §4 — Distributed Locks and the RedLock Debate](../interviews/seat-reservation/deep-dive.md#4-distributed-locks-and-the-redlock-debate)
- [lease.md](./lease.md) and [split-brain.md](./split-brain.md) — the failure mode fencing exists to close
