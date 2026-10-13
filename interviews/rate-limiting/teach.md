# Teach Script: Rate Limiting

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the system; don't just recognize the vocabulary.
> **Not a replacement for:** [`answers.md`](./answers.md) (the full Q&A grill) or [`deep-dive.md`](./deep-dive.md) (production depth). This is the narrated version.
> **Every number and fact below is pulled from this repo's own [`answers.md`](./answers.md)** — nothing here is a new claim.

---

## 1. The symptom

You set a rate limit: 100 requests per minute, per user. You check every gateway's logs — each one individually enforced it perfectly. Not one gateway ever let a single user through past 100 requests in a minute. Every component, checked in isolation, was 100% compliant with the policy.

**And yet one user made roughly a thousand requests against your backend in that same minute** — ten times the advertised limit — without a single gateway ever breaking its own rule. Nothing lied. Nothing crashed. Every individual piece of the system did exactly what it was told, and the system as a whole still failed at the one thing it existed to guarantee.

## 2. Why you should care

This is not an edge case — it's the default outcome the instant an API runs on more than one server, which is essentially every production API that cares about availability at all. It's the single most common reason a team ships a rate limiter, feels confident about it, and then gets paged for an "impossible" quota violation the first time traffic actually needs two machines instead of one.

## 3. What / Why / How

1. **What is a rate limiter actually deciding**, and where does that decision have to physically live?
2. **Why does every gateway enforcing the limit correctly, on its own, still produce a globally wrong result?**
3. **How do you build a limiter that's both fast (a 5ms decision, per this repo's own SLA) and actually global, without becoming a single point of failure itself?**

## 4. Umbrella words — kill them before using them

**"Rate limiting."** This single phrase covers a family of algorithms with genuinely different output shapes, and picking the wrong one is a real design mistake, not a style preference: **fixed window** (simple, but has a hard edge — more below), **token bucket** (tokens refill continuously up to a cap; allows a short legitimate burst, which is why it's the default for user-facing APIs), **leaky bucket** (smooths everything to a constant drain rate; used to protect a downstream that genuinely can't handle spikes), and **sliding window counter** (approximates a smooth window cheaply, the usual production compromise between the exact-but-expensive sliding log and the cheap-but-unfair fixed window).

**"Resilient" / "fails gracefully."** Decompose it into a decision that has to be made **per endpoint**, never once globally: **fail-open** (let the request through if the limiter itself is unavailable — right for a low-risk public read) versus **fail-closed** (reject if the limiter is unavailable — right for login or payment, where an unguarded flood costs far more than a few false rejections). Saying "the limiter fails open" as a single blanket statement is a red flag, not an answer.

**"Atomic."** This word has an exact, checkable meaning here, not a vague sense of "safe": does the read-modify-write happen as **one indivisible operation**, or as multiple separate round-trips that another concurrent request could interleave with? `INCR key` followed by a separate `EXPIRE key 60` is *not* atomic — a crash between the two steps corrupts the limit. A single Lua script executed on Redis's single thread *is* atomic — nothing else can run in the middle of it.

## 5. The boxes — built one need at a time

**You need to stop one client from consuming shared capacity meant for everyone.** The simplest version: track how many requests a key (a user, an IP, a tenant) has made recently, and compare it to a limit. That's a **counter**.

**Gap: the cheapest way to implement that counter is a fixed window** — count requests in this calendar minute, reset to zero at the top of the next minute. It's simple, and it has a real, provable edge case worth naming unprompted: a client can send its full 100-request quota at `12:00:59.9`, and its full 100-request quota again at `12:01:00.1` — two hundred milliseconds apart, both technically "within the window," for an effective 200 requests where the policy says 100. **This isn't a hypothetical corner case — it's the fixed-window algorithm working exactly as designed and still producing double the intended limit.**

```
12:00:59.900 → send 100 (allowed — within this minute's window)
12:01:00.100 → send 100 (allowed — within the NEXT minute's window)
Effective burst in 200ms: 200 requests, against a "100/min" policy
```

**Fix: token bucket.** Instead of a hard reset, tokens refill continuously, at a steady rate, up to a fixed capacity — there's no discontinuity to exploit at a window boundary, and a legitimate short burst (a user's page load firing several API calls at once) is naturally absorbed by whatever tokens have accumulated, rather than being rejected by an arbitrary calendar line.

**Now — the gap that produces the symptom from section 1.** Where does this bucket's state actually *live*? If it's a variable inside one running gateway process's memory, it only knows about requests *that one process* has seen. The moment you run more than one gateway — which you do, for redundancy alone — each instance keeps its **own**, disconnected bucket. Ten gateways, each correctly enforcing "100/min," add up to an effective global limit of roughly 1,000/min, and not one of them is lying when it says it enforced the policy — it enforced *its own local copy* of the policy perfectly.

```
1 gateway, local state:   100/min enforced
10 gateways, local state: ~1,000/min enforced globally (10 disconnected buckets)
10 gateways, SHARED state: 100/min enforced globally (one true count)
```

**Fix: move the bucket's state out of any single process and into one shared store every gateway reads and writes** — Redis, most commonly. Now there's exactly one count for a given key, not N disconnected ones, no matter how many gateways are running.

**Gap: multiple gateways now hit the *same* Redis key at the *same* moment for a popular user.** If checking and updating that key is two separate commands — `INCR key`, then a later `EXPIRE key 60` — a crash between them can leave the key without a TTL (corrupting future limits), and two concurrent callers can each read "there's room" before either one's write lands, letting both through when the policy meant to allow only one. This is exactly what "atomic" has to mean in practice.

```lua
-- One atomic script: read, compute, decide, write — nothing can interleave.
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens')) or capacity
if tokens < cost then return {0, tokens} end
redis.call('HSET', KEYS[1], 'tokens', tokens - cost)
return {1, tokens - cost}
```

**Gap: one especially large tenant now generates a huge share of total traffic, and every one of their requests hits the exact same Redis key.** Redis overall has plenty of headroom — but *this one key* becomes a hot spot, a concentration problem rather than a total-capacity one. Fix: shard the key itself — hash-tag prefixes, hierarchical keys (`tenant`, then `tenant:endpoint`) — so one giant hot bucket becomes many smaller, independently-served ones.

**Last gap: what happens when Redis itself has an outage or a slow blip?** If every gateway synchronously blocks on a now-slow dependency before it can decide anything, the rate limiter — a thing built to protect availability — becomes the reason the entire API goes down. The fix has two parts, and they're not the same decision: a **circuit breaker** in front of the limiter call, falling back to a cheap, rough local emergency limiter instead of hanging; and a **per-endpoint** choice of what "degraded" means — fail-open (let it through) for a public read endpoint where a brief lapse in strictness is cheap, fail-closed (reject) for login or payment where an unguarded flood is expensive.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **every gateway checks the exact same shared counter before allowing a request, so a limit enforced correctly by ten independent gateways is still ten times too generous unless that state is centralized; the check-and-increment happens as one atomic operation so two concurrent gateways can't both read "room available" and both be right; and the limiter itself sits behind a circuit breaker with a per-endpoint fail-open or fail-closed fallback, so a slow rate limiter never becomes the outage it was built to prevent.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the exact `429` response headers (`Retry-After`, `RateLimit-Remaining`) — know they should exist so clients can back off deterministically, look up the exact spelling when you write the handler; the specific canary rollout percentages (1% → 5% → 25% → 100%) for a policy change — a sensible default, not a law.

**Understand once, then trust it:** the token-bucket refill formula itself (elapsed time × refill rate, capped at capacity) — and specifically *why* it uses a **monotonic clock, not wall-clock time**, since NTP adjustments or manual clock changes can jump backward and corrupt the elapsed-time math; you don't need to re-derive this each time, just remember monotonic time exists for exactly this reason.

**This is the actual idea — think hard here:** (1) local, per-process enforcement is fundamentally insufficient the instant there's more than one instance — this *is* the symptom, and it's the entire reason "distributed state" is its own section of this topic, not an optional refinement; (2) atomicity is a concrete, checkable property of *how many round-trips* a read-modify-write takes, not a vague promise; (3) fail-open versus fail-closed must be decided **per endpoint** based on that endpoint's actual risk, never as one blanket global mode; (4) a rate limiter that sits synchronously on the hot path with no circuit breaker can itself become a bigger outage than the abuse it was meant to stop — the same structural lesson as [distributed-caching](../distributed-caching/teach.md)'s cold-cache incident, worth naming as a direct parallel if it comes up.

## 7. The build — the smallest thing that actually shows the mechanism

No real Redis cluster or ten real gateway processes here — the mechanism that actually matters, "local state undercounts the aggregate; shared state doesn't," is visible with two tiny in-memory classes:

```python
# save as distributed_limiter_demo.py, run with: python3 distributed_limiter_demo.py

LIMIT_PER_WINDOW = 100   # the advertised, single-user policy

class LocalLimiter:
    """Each gateway instance keeps its OWN count — unaware of any other instance."""
    def __init__(self, limit):
        self.limit = limit
        self.count = 0
    def allow(self):
        if self.count >= self.limit:
            return False
        self.count += 1
        return True

class SharedLimiter:
    """All gateway instances check the SAME counter — as if backed by one Redis key."""
    def __init__(self, limit):
        self.limit = limit
        self.count = 0
    def allow(self):
        if self.count >= self.limit:
            return False
        self.count += 1
        return True

NUM_GATEWAYS = 10
REQUESTS_PER_GATEWAY = 150   # one user's traffic happens to spread across all 10 gateways

# Scenario 1: each gateway enforces the SAME policy, but in isolation.
local_limiters = [LocalLimiter(LIMIT_PER_WINDOW) for _ in range(NUM_GATEWAYS)]
allowed_local = sum(1 for lim in local_limiters for _ in range(REQUESTS_PER_GATEWAY) if lim.allow())

# Scenario 2: every gateway checks the SAME shared counter before allowing.
shared_limiter = SharedLimiter(LIMIT_PER_WINDOW)
allowed_shared = sum(1 for _ in range(NUM_GATEWAYS) for _ in range(REQUESTS_PER_GATEWAY) if shared_limiter.allow())

print(f"Advertised policy: {LIMIT_PER_WINDOW} requests/window for this user")
print(f"{NUM_GATEWAYS} gateways, each with its OWN local counter -> {allowed_local} requests actually allowed")
print(f"{NUM_GATEWAYS} gateways sharing ONE counter          -> {allowed_shared} requests actually allowed")
```

Run it. With ten gateways and local state: **1,000 requests allowed** against a "100/min" policy — exactly the symptom from section 1, reproduced with two Python classes. With shared state: **exactly 100**, no matter how the traffic happened to be distributed across the ten gateways.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** Change `NUM_GATEWAYS` from `10` to `50` and rerun. The local-state total climbs to **5,000** — the more you scale out for redundancy, the *more* the effective limit balloons, which is exactly backwards from what "scaling out" should mean for a safety control. The shared-state total stays locked at **100**, completely indifferent to how many gateways exist. That indifference to instance count is the entire point of centralizing the state.

**Sabotage 2 (walk it in your head, no code needed).** Now imagine two gateways both handle a request for the same popular user at nearly the same instant, and instead of one atomic Lua script, each one does it as two separate steps: **read** the current count, **then** write count+1 if it's under the limit. Walk it: both gateways read the count as 99 (neither has written yet), both independently conclude "99 < 100, allow it," and both write 100. **Two requests were just allowed when the policy only had room for one** — not because either gateway made a mistake, but because "read, then decide, then write" was never a single operation, so nothing prevented two callers from occupying the exact same gap in time. This is the identical shape of bug as the naive `INCR` + `EXPIRE` split from section 5 — a crash or a race in the gap between two supposedly-linked steps — which is why the real fix collapses the whole read-modify-write into one atomic script, not "be more careful with the order of operations."

## 9. One-sentence recap

Same words as before, on purpose: **every gateway checks the exact same shared counter before allowing a request, so a limit enforced correctly by ten independent gateways is still ten times too generous unless that state is centralized; the check-and-increment happens as one atomic operation so two concurrent gateways can't both read "room available" and both be right; and the limiter itself sits behind a circuit breaker with a per-endpoint fail-open or fail-closed fallback, so a slow rate limiter never becomes the outage it was built to prevent.**

## 10. What transfers

Swap Redis for another shared, low-latency store, and this lesson is unchanged — the exact Lua syntax and the specific header names (`RateLimit-Remaining`, etc.) are the incidental, swappable pieces. What transfers to **every** distributed enforcement problem, not just rate limiting: state has to be centralized the instant there's more than one enforcement point, or "correct locally" stops meaning "correct globally"; atomicity is a property you can name and check (one operation vs. several), not an adjective you assert; a policy about *how to fail* has to be scoped to the specific thing being protected, never applied as one global default; and anything sitting on a hot path in front of your real traffic — a cache, a rate limiter, an auth check — needs its own circuit breaker, or its own outage becomes your outage.

---

## Recall check — answer these without scrolling up

1. **Describe the data flow in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5.)*
2. **What is each box's job, and what breaks if you delete it?**
   - *Model answers:* delete the shared state and go back to per-gateway local counters → the section 1 symptom returns exactly: N gateways enforce N times the advertised global limit, each one innocently correct on its own. Delete atomicity (split the check-and-increment into two round-trips) → two concurrent requests can both read "there's room" and both get allowed, quietly overselling the limit. Delete the circuit breaker and per-endpoint fail mode → a Redis blip forces every gateway to either hang on a dead dependency or let every endpoint through unlimited, including the ones (login, payment) that most needed to fail closed.
3. **What would you look at first if this got slow, or wrong, in production?** *(Model answer: decision latency p50/p95/p99 first — is the limiter itself now the bottleneck; then allow/deny counts by policy key plus the list of top-denied tenants — is this a real abuse pattern or a false-positive policy regression; then Redis error/timeout rate and fallback-mode activation count — is the limiter currently running in its degraded mode at all.)*

If you answered all three cold, go read `answers.md` anyway — this script deliberately skipped weighted endpoint costs, policy versioning and rollback controls, and multi-signal bot detection beyond IP (A22–A32) because piling every idea into one narrative would bury the four that actually matter. Those are the natural next read.
