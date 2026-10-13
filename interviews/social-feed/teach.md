# Teach Script: Social Feed (Twitter / X)

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the system; don't just recognize the vocabulary.
> **Not a replacement for:** [`answers.md`](./answers.md) (the full Q&A grill) or [`deep-dive.md`](./deep-dive.md) (production depth). This is the narrated version.
> **Every number and fact below is pulled from this repo's own [`answers.md`](./answers.md)** — nothing here is a new claim.

---

## 1. The symptom

A celebrity account with 50 million followers posts a tweet. Some of their followers see it in their feed within a second. **Others don't see it for eight minutes.** And here's the part that should actually worry you: during those eight minutes, *everyone else on the platform* — people who don't even follow this celebrity — notices their own feed loading slower too.

One tweet, from one account, degraded the experience for users who have never heard of that account. Nothing crashed. No error page appeared. The system did exactly what it was built to do — and what it was built to do turned out to not work at this particular scale.

## 2. Why you should care

This is not a hypothetical. It's a named, documented failure mode at every social platform with a "follow" graph and any account with an outsized follower count — and it's exactly why Twitter's own engineering blog describes the fix it forced them into. Whoever owns feed generation at a company like this owns this problem, and it comes up not as a trivia question but as the central design decision of the whole system.

## 3. What / Why / How

1. **What does "load my home feed" actually have to compute** every time someone opens the app?
2. **Why does the obvious way to compute it — query everyone I follow, right now — fall over at scale?**
3. **How do you build a feed that's fast for everyone, without one popular account breaking it for everyone else?**

## 4. Umbrella words — kill them before using them

**"Real-time feed."** Decompose it: **feed load latency** (the actual number here is p99 < 200ms), the **read:write ratio** driving every architecture decision (1000:1 — 500B feed reads/day against 500M tweets/day), and **freshness** — how many seconds old is "recent" allowed to be before a user notices. "Real-time" without these three numbers is a vibe, not a spec.

**"Fan-out."** This word gets used as if it means one thing; it means two *opposite* things, and the whole topic is about knowing which one you're using and why. **Fan-out on write**: when someone tweets, immediately push that tweet into every follower's pre-computed timeline — work happens at write time, reads are cheap. **Fan-out on read**: store the tweet once, and at read time, pull from every account you follow and merge — work happens at read time, writes are cheap. These are not two flavors of the same idea; they move the *entire cost* of the system to opposite ends of the pipeline.

**"Scale."** Decompose into: **follower count distribution** (average users follow ~200 accounts; celebrities exceed 10K followers; mega-celebrities exceed 10M — three different orders of magnitude, not a smooth curve); **write amplification** (one tweet from a 50M-follower account is 50M individual timeline writes, not one); and **timeline size** (bounded at 800 entries per user — a deliberate memory ceiling, not an accident).

## 5. The boxes — built one need at a time

**A user opens the app and needs their home feed** — recent tweets from ~200 people they follow, sorted, in under 200ms. The obvious first move: query all 200 followees' recent tweets *at that moment*, merge, sort, return.

```
[ User opens app ] ──▶ [ Feed Service: query 200 followees' tweets, merge, sort ]
```

**Gap: does this actually work at 500M daily active users?** Walk the arithmetic out loud, because this is exactly where the naive design dies: 500M users × ~10 feed loads/day = 5 billion feed loads a day. Each one fans out to 200 followees, scattered across shards. That's roughly a trillion row scans a day, and the `IN (...)` query across 200 shards is catastrophically slow on its own — p99 lands somewhere past 5–10 seconds, not the 200ms the product needs. **This approach is not "a bit slow" — it is structurally the wrong shape**, because it does all its work at read time, and reads outnumber writes 1000:1 here. Doing expensive work on the side that happens a thousand times more often than the other side is exactly backwards.

**So flip it: do the expensive work at write time instead, when it happens 1000x less often.** When a user tweets, push that tweet's ID into every one of their followers' *pre-computed* timelines immediately. A feed load is now just: read one already-sorted list. That's **fan-out on write**, and for a normal user with 500 followers, it's 500 cheap writes for one tweet that will be read hundreds of times. Store `tweet_id` only, not the whole tweet object — 8 bytes instead of ~1KB per entry, a 125x memory difference at 500M users' worth of timelines — and hydrate the full tweet from a separate cache keyed by `tweet_id` at read time.

```
[ User A tweets ] ──▶ [ Fan-out Service ] ──▶ push tweet_id into each follower's
                                               Redis Sorted Set (score = timestamp)
```

**Gap — and this is the symptom from section 1, arriving right on schedule.** What happens when the account that tweets has 50 million followers, not 500? Fan-out on write means **50 million individual writes**, for one tweet. At a real, achievable throughput of ~100K writes/sec, that's 500 seconds — over eight minutes — before every follower has it. Fan-out workers are saturated the entire time, which means *every other tweet in the system*, from *any* other user, is now waiting behind this one celebrity's fan-out job. One popular account's success degrades the whole platform's write path. **You cannot fix this by making fan-out faster — you have to stop doing it for these accounts.**

**The fix: don't fan out celebrity tweets on write at all.** Store the tweet once, same as always — but instead of pushing it to 50 million timelines, let it sit there. At read time, for the small number of celebrities a given user follows (nearly everyone follows *some* accounts with 10K+ followers, but nobody follows thousands of them), pull their recent tweets directly and merge them into the pre-computed timeline on the fly. This is **fan-out on read**, applied *only* to the accounts where fan-out on write is catastrophic.

```
Feed load = [ pre-computed timeline (pushed, normal accounts) ]
          + [ pull recent tweets from the small set of celebrities you follow, live ]
          → merge, sort, return
```

**This is hybrid fan-out**, and it is the entire senior-level answer to this topic in one sentence: **push for everyone below the threshold, pull for everyone above it, merge the two at read time.** The threshold in this repo's material is ~10K followers, and it's worth naming as tunable — a smarter version classifies by `follower_count × tweet_rate`, because a celebrity who rarely tweets costs less than a merely-popular account that tweets constantly.

**Two things that fall out of this design, both worth stating unprompted:** deletions and unfollows are handled *lazily*, at read time, never by eagerly rewriting every timeline the change touches — mark a tweet deleted and filter it out during hydration; on unfollow, just stop including that author's future tweets and let old ones age out of the 800-entry window naturally. Rewriting millions of already-computed timelines synchronously would just reintroduce the exact fan-out storm you built hybrid fan-out to avoid.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **a normal user's tweet is pushed into every follower's pre-computed timeline at write time; a celebrity's tweet is stored once and pulled by each follower at read time; and a feed load merges the pushed timeline with the pulled celebrity tweets, so the read path stays fast no matter how large any single account's follower count grows.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the exact Redis Sorted Set commands (`ZADD`, `ZREVRANGE`, `ZREMRANGEBYRANK`) — once you know *why* a sorted set (`O(log N)` insert, automatically sorted by timestamp), the specific command syntax is something you look up, not memorize; the exact 800-entry trim number, which is a tuned constant, not a law.

**Understand once, then trust it:** that the follow graph needs *two* denormalized tables (`follows_by_follower` and `follows_by_followee`) so both "who do I follow" and "who follows me" are local, single-shard queries instead of a scatter-gather — know this trade exists, you don't need to re-derive it from scratch every time; WebSocket/SSE mechanics for pushing live updates to an open client, covered in its own right in [`sse`](../sse/teach.md) and [`chat-system`](../chat-system/).

**This is the actual idea — think hard here:** (1) fan-out on write and fan-out on read are not two implementations of the same feature — they move the system's entire cost to opposite ends of the pipeline, and picking the wrong one for a given account is a category error, not a tuning problem; (2) the hybrid threshold exists *because* the cost of fan-out is proportional to follower count, so there is a real number above which "push to everyone" stops being viable no matter how much hardware you add; (3) store IDs, hydrate separately — this single decision is the difference between a system that fits in memory at 500M users and one that doesn't; (4) lazy, read-time filtering for deletes/unfollows/mutes is the same idea as the celebrity pull, applied to a different problem: don't do expensive work eagerly when you can defer it to the much-less-frequent moment it's actually needed.

## 7. The build — the smallest thing that actually shows the mechanism

No real Redis cluster or 500M simulated users here — that infrastructure exists to solve a scale problem, and scale is exactly the one thing a local demo can't show you. What a local demo *can* show you is the actual arithmetic asymmetry that forces the hybrid design — and that fits in code you can run right now:

```python
# save as fanout_cost_demo.py, run with: python3 fanout_cost_demo.py

WRITES_PER_SECOND = 100_000   # a real, achievable fan-out worker throughput

def fanout_on_write_cost(follower_count):
    """How many seconds to push one tweet to every follower's timeline."""
    return follower_count / WRITES_PER_SECOND

def fanout_on_read_cost(followee_count, ms_per_query=5):
    """How many milliseconds to pull-and-merge tweets from everyone you follow."""
    return followee_count * ms_per_query

accounts = {
    "normal user (500 followers)":        500,
    "micro-celebrity (50K followers)":     50_000,
    "celebrity (5M followers)":            5_000_000,
    "mega-celebrity (50M followers)":      50_000_000,
}

print("Cost of FAN-OUT ON WRITE, per tweet, by account size:")
for label, followers in accounts.items():
    seconds = fanout_on_write_cost(followers)
    print(f"  {label:35s} -> {seconds:>10.1f} seconds to reach every follower")

print()
print("Cost of FAN-OUT ON READ, per feed load, by how many people YOU follow:")
for followees in (200, 1000):
    ms = fanout_on_read_cost(followees)
    print(f"  following {followees:5d} accounts -> {ms:>6} ms just to query+merge")
```

Run it. Fan-out on write costs a fraction of a second for a normal user and **over eight minutes** for a mega-celebrity. Fan-out on read costs 1 second at 200 followees — already past the 200ms budget — and gets linearly worse the more people you follow, with sorting and merging still to come on top. Neither cost is "wrong" — they're just catastrophic at opposite ends of the follower-count spectrum, which is exactly why the design needs both, not one.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** Change `WRITES_PER_SECOND` from `100_000` to `10_000` — simulate a smaller cluster, or a traffic spike that's saturating your fan-out workers — and rerun. Watch the mega-celebrity's fan-out time jump from ~8 minutes to ~83 minutes. Now add a second mega-celebrity account to the `accounts` dict with 150,000,000 followers and rerun again. **This is the exact arithmetic behind the fan-out storm** — it's not a hand-wavy "it gets slow," it's a number you can compute, and it's the number that decides your celebrity threshold, not a gut feeling.

**Sabotage 2 (walk it in your head, no code needed).** Now imagine you "simplify" the architecture by picking just one model for every account, no hybrid. Walk both branches: pure fan-out on write means every mega-celebrity tweet takes minutes to reach all followers and, worse, **saturates the fan-out workers for that whole window, so a completely unrelated normal user's tweet posted during those eight minutes is also delayed** — the failure from section 1. Pure fan-out on read means every single feed load, for every one of 500M daily active users, does the expensive multi-shard scatter-gather that was already shown to blow past the 200ms budget at just 200 followees — the *entire* platform is now as slow as the naive approach from section 1's opening move. There is no single threshold-free choice that works. That's why the account's own follower count has to change which model applies to it.

## 9. One-sentence recap

Same words as before, on purpose: **a normal user's tweet is pushed into every follower's pre-computed timeline at write time; a celebrity's tweet is stored once and pulled by each follower at read time; and a feed load merges the pushed timeline with the pulled celebrity tweets, so the read path stays fast no matter how large any single account's follower count grows.**

## 10. What transfers

Swap Redis Sorted Sets for a different in-memory store, or Cassandra for a different wide-column database, and this lesson is unchanged — those are the incidental, swappable pieces. What transfers to **every** high-fan-out system (a subscriber feed, a notification system, any "push this to N followers" feature): the fundamental asymmetry between push-cost-per-write and pull-cost-per-read, and the fact that one static choice between them is wrong at the extremes of *any* skewed distribution; a **dynamic threshold** based on the actual cost driver (follower count × activity rate, not follower count alone); storing lightweight references and hydrating separately to control memory; and doing destructive-looking updates (deletes, unfollows) lazily, at read time, rather than eagerly rewriting every derived copy the moment the underlying fact changes.

---

## Recall check — answer these without scrolling up

1. **Describe the data flow in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5.)*
2. **What is each box's job, and what breaks if you delete it?**
   - *Model answers:* delete the celebrity pull-at-read path and rely only on fan-out on write → every mega-celebrity tweet takes minutes to propagate and stalls every other user's tweet in the meantime, the exact symptom from section 1. Delete the pre-computed timeline and rely only on fan-out on read → every feed load for every user becomes a multi-shard scatter-gather that blows past the 200ms budget. Delete lazy filtering for deletes/unfollows and do it eagerly instead → you've reintroduced a fan-out-shaped storm for every unfollow and every deletion, at the exact scale you built hybrid fan-out to avoid.
3. **What would you look at first if this got slow, or wrong, in production?** *(Model answer: fan-out queue depth first — a growing backlog means the write side can't keep up, likely a celebrity tweet or a burst of them; then timeline cache hit rate, because a miss means an expensive on-demand rebuild; then which accounts are triggering the load, to check whether the celebrity classification threshold needs to move.)*

If you answered all three cold, go read `answers.md` anyway — this script deliberately skipped ranking/relevance scoring, A/B test guardrails, protected accounts, and cross-device consistency (A35–QB6) because piling every idea into one narrative would bury the four that actually matter. Those are the natural next read.
