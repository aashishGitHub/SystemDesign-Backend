# Lease

A **time-bound grant of exclusivity** — "you are the leader / you hold the lock **until timestamp T**," not forever. It solves the problem plain locks can't: what happens when the lock holder dies and never releases it.

---

## The Problem

A plain distributed lock held by a node that crashes is held **forever** — nobody released it, so nobody else can acquire it, and the system stalls waiting for a node that's never coming back. A lease fixes this by building an expiry into the grant itself: if the holder doesn't renew before `T`, the lease is automatically available to someone else, no manual intervention required.

---

## How It Works

1. Node A requests a lease from a coordinator (or via consensus): "grant me exclusivity for the next 10 seconds."
2. A must **renew** before the lease expires to keep holding it — usually well before the deadline, to survive a missed renewal or clock skew.
3. If A stops renewing (crash, partition), the lease **expires on its own** — no one has to detect A's death and manually revoke anything.
4. Once expired, another node can acquire the lease and become the new leader/lock holder.

```
t=0    A acquires lease, expires at t=10
t=3    A renews → new expiry t=13
t=6    A renews → new expiry t=16
t=9    A crashes, stops renewing
t=16   lease expires — no renewal came in
t=17   B acquires the lease, becomes leader
```

---

## Analogy

> A library book due back in 3 weeks, renewable if you show up before it's due. If you never renew and never return it, the system doesn't wait for you forever — the due date passes and someone else can check it out, automatically, with no librarian needing to chase you down.

---

## The Subtlety That Trips People Up

**Clock skew and pauses are the actual danger, not crashes.** A GC pause or a slow disk write can make node A *believe* it still holds the lease past its real expiry — because A's own clock says "not expired yet" while the coordinator's clock has already moved past `T`. This is why a lease alone isn't safe for exclusive access to a shared resource without a **fencing token**: A might act as leader after B has already taken over, writing stale data with no way for the resource to know A is no longer valid. See [fencing](./fencing.md).

---

## Interview Questions

**Q1. Why is a lease safer than a plain lock for leader election?**
A plain lock has no self-healing story — if the holder dies without releasing it, the system is stuck until an operator or a separate failure-detection mechanism intervenes. A lease bounds the exclusivity in time, so failure recovery is just "wait for the lease to expire," with no extra detection logic needed.

**Q2. Why does the holder renew *before* the deadline instead of exactly at it?**
Network latency and processing time mean a renewal request sent right at the deadline might not arrive and be processed before expiry — the lease would lapse even though the holder is alive. Renewing with margin (e.g. renew at 1/3 of the lease duration) absorbs that latency and avoids unnecessary leadership flapping.

**Q3 (depth). Can a lease alone guarantee only one node ever acts as leader at any instant?**
No — this is the trap. Clock skew between the lease-granting coordinator and the lease holder means the holder's local sense of "still valid" can outlive the coordinator's actual expiry, especially across a pause (GC, VM freeze, slow I/O). During that window, a new leader can already be active while the old one still believes it's in charge — a real split-brain window, however short.

**Q4 (senior). How do you make lease-based leadership actually safe against that clock-skew window?**
Pair the lease with a **fencing token** — a monotonically increasing number issued with each lease grant. Every write to the shared resource (storage, downstream service) must include the token, and the resource rejects any write with a token lower than the highest it's already seen. This makes the *resource itself* the enforcer of "only the latest leader's writes count," instead of trusting each node's local belief about lease validity.

**Q5 (staff). Your service does a "lease read" — serving a strongly consistent read from the leader without a full quorum round-trip on every read — is this safe?**
Only if the leader can prove no newer leader has been elected during the lease window, which typically means the leader waits out any clock-skew margin before trusting its own lease, or cross-checks with a quorum "read index" instead of relying purely on wall-clock time. Naively trusting "my lease says I'm still leader" without accounting for skew reintroduces the exact split-brain window leases are supposed to bound.

---

## Where This Shows Up in This Repo

- [consensus/deep-dive.md §12 — Recipe: Leader Election, Locks, and Leases](../interviews/consensus/deep-dive.md#12-recipe-leader-election-locks-and-leases) — "🔴 Architect — The Fencing Token Is Non-Negotiable"
- [consensus/deep-dive.md §15 — Read Optimizations and Geo-Distributed Consensus](../interviews/consensus/deep-dive.md#15-read-optimizations-and-geo-distributed-consensus) — "🟡 Senior — Lease Reads vs Read Index"
- [seat-reservation/deep-dive.md §2 — Hold vs Booking: The Two-State Model and Redis TTL Holds](../interviews/seat-reservation/deep-dive.md#2-hold-vs-booking-the-two-state-model-and-redis-ttl-holds) — a lease used for a business-level hold, not just leadership
- [fencing.md](./fencing.md) — the mechanism that closes the clock-skew gap leases leave open
