# Teach Script: Seat Reservation (Ticketmaster / Concert Booking)

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the system; don't just recognize the vocabulary.
> **Not a replacement for:** [`story.md`](./story.md) (the full chronological walkthrough of one sale) or [`answers.md`](./answers.md) (the Q&A grill). This file uses a different lens — the piyush-teach demo-first method — so it's genuinely complementary, not a duplicate; read whichever framing clicks.
> **Every number and fact below is pulled from this repo's own [`answers.md`](./answers.md)** — nothing here is a new claim.

---

## 1. The symptom

Two fans, Priya and Dev, click "Select Seat" on A14 within the same microsecond. Both apps show a brief spinner. A fraction of a second later, **both** screens say "Seat A14 held for you — checkout now." Both proceed to enter their card details. Both pay. Both get a "Booking confirmed!" screen.

**One chair. Two confirmed tickets.** Nothing crashed, no error appeared on either screen, and both payment charges genuinely went through. One of these two people is going to find that out at the worst possible moment — standing at the venue door, ticket in hand, being told the seat is already occupied.

## 2. Why you should care

This is the single defining problem of every finite-inventory reservation system — concert tickets, flight seats, hotel rooms, a limited sneaker drop — and it shows up at senior/staff interviews precisely because the tempting first answer ("check if it's available, then mark it held") looks completely correct in every test you'd write with one user, and only fails, expensively and publicly, the moment two people show up in the same instant. This isn't hypothetical: real ticketing incidents involving exactly this class of failure under flash-sale load are part of this industry's well-known history.

## 3. What / Why / How

1. **What does "reserve one seat, for exactly one person" actually require** at the systems level, stripped of business language?
2. **Why does "check if it's available, then mark it held" — the obviously correct-looking approach — still let two people win?**
3. **How do you guarantee exactly one winner per seat while still handling 150,000 people hitting the same page in the same 60 seconds?**

## 4. Umbrella words — kill them before using them

**"Race condition."** This deserves an exact definition, not a wave of the hand: a race condition here is specifically **"check, then act" happening as two separate steps**, with a gap between them wide enough for someone else to also pass the check before either of you has acted. It is *not* "concurrency" in the abstract. The fix is never "be more careful about the order of operations" — it's collapsing check-and-act into a **single atomic operation**, so there is no gap left for anyone to slip into.

**"Locking."** Decompose it into three genuinely different mechanisms with different costs: **pessimistic** (`SELECT ... FOR UPDATE` — take a real row lock; the second reader physically blocks until the first transaction finishes, then loses cleanly on re-check), **optimistic** (a version column or Redis's `SET NX` — nobody blocks; whichever write lands first wins, and the loser detects the conflict immediately via a zero-rowcount or a `nil` reply), and a **TTL-based hold** (not really a lock at all — a value that expires on its own after a fixed time, used specifically when the thing you're protecting has to survive *human decision time*, which can be minutes).

**"Consistency."** Decompose it into the split this whole system is organized around: the **browse path** (~95% of traffic — search, seat maps, "3 left" badges — cacheable, eventual consistency is fine) versus the **book path** (~5% of traffic — hold, confirm, pay — must hit the real source of truth, strongly consistent). This repo's own material names conflating these two — serving live availability from the write path, or authorizing a hold straight from a cache — as **the single most common interview mistake** in this entire topic.

## 5. The boxes — built one need at a time

**You need exactly one person to be able to hold — and later book — a given seat.** The obvious first move: read the seat's status; if it says `AVAILABLE`, write `HELD`. This is what nearly everyone writes first, and it passes every test with one user, because with one user there's nothing to race against.

```
1. Read seat A14's status → "AVAILABLE"
2. Decide: it's free, I'll take it
3. Write: A14 = "HELD by me"
```

**Now — the gap that produces the symptom from section 1.** Steps 1 and 3 are two separate round trips, with a real gap between them — network time, processing time, however small. Priya reads `AVAILABLE`. Before her write lands, Dev *also* reads `AVAILABLE` — nothing has told him otherwise yet, because Priya hasn't written anything. Both of them, independently and correctly, decide "it's free." Both write `HELD`. Whichever write lands *last* simply **overwrites** whichever landed first — a classic **lost update** — and nothing in this naive flow ever notices that two different people just believed they'd won the same seat.

```
Priya: READ A14 → AVAILABLE
                              Dev: READ A14 → AVAILABLE   (before Priya's write lands)
Priya: WRITE A14 = HELD(Priya)
                              Dev: WRITE A14 = HELD(Dev)   ← silently overwrites Priya's win
```

**Fix: collapse check-and-act into one atomic operation, so there is no gap left for anyone to land in.** Three different technologies implement the *exact same idea*: Redis `SET seat NX` (atomic test-and-set — the key either didn't exist, meaning you own it now, or it did, meaning you're flatly rejected, with nothing in between); a SQL conditional `UPDATE ... WHERE status = 'AVAILABLE'`, checking the affected-row count (`1` means you won, `0` means someone beat you); or `SELECT ... FOR UPDATE` (a real row lock — the second transaction physically cannot proceed until the first commits). All three enforce the identical invariant: **at most one writer can ever complete the transition for a given seat**, and every loser gets a clean, immediate rejection instead of silently clobbering the winner.

**Gap: which of these three do you actually reach for, and when?** This is decided by the *shape* of the contention, not habit. **Pessimistic locking** makes the second person genuinely wait, then lose cleanly — right for a short, unavoidable pile-up on one row (the very last seat in a small shared pool), wrong if you'd hold that lock for the *minutes* a human spends deciding, because now everyone else queues up behind one slow human's think time. **Optimistic** (version column, or Redis `NX`) never blocks anyone — the loser is told "no" immediately and can go try a different seat — the right default for ordinary, comparatively rare contention, but it would **livelock** (everyone retries, everyone fails again) if literally everyone were fighting over the exact same single row nonstop.

**Gap: a hold has to survive several minutes of human "think time" before auto-releasing if the person never pays.** A live database row lock held for that long, multiplied across tens of thousands of simultaneous checkouts during a flash sale, pins a database connection *per open checkout* — this repo's own numbers: connection pools are sized in the hundreds, not the hundreds of thousands, so this alone exhausts the pool and stalls the *entire* database, unrelated to the actual seat race. **Fix: hold seats in Redis, not the primary database.** Redis gives you a native per-key TTL (auto-release on abandonment or crash — no cleanup job needed) plus the identical atomic test-and-set, at in-memory latency. Losing a Redis hold on a crash is merely annoying — the seat just becomes available again — **never a correctness violation**, because the database never said `BOOKED`. The permanent `HELD → BOOKED` transition still goes through the database's own atomic compare-and-set; Redis is an optimization layer sitting in front of the real guarantee, never a replacement for it.

```
SET event:123:seat:A14 "user:456:hold:h789" NX PX 600000
  → "OK"   the key didn't exist — hold acquired, auto-expires in 10 minutes
  → nil    the key already exists — someone else got there first, reject
```

**Last gap: 150,000 people hit this page in the same 60 seconds, but only 50,000 seats exist.** If all 150,000 requests hit the hold-and-book path directly, you get a stampede of contention on the same hot rows — most of those requests are *mathematically guaranteed to lose*, yet still cost real load just to reject. The insight worth naming: **reads are unbounded** (anyone can look), **writes are bounded by actual inventory** (at most 50,000 will ever succeed) — browsing and booking are fundamentally different traffic *shapes*, and belong on fundamentally different infrastructure. Fix: a **virtual waiting room** admits people into the actual booking flow at a controlled rate, so the hold/book path only ever sees traffic sized to what the database can genuinely absorb, instead of the full, unfiltered spike.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **a seat transitions from available to held to booked only through a single atomic compare-and-set, never through a separate check followed by a separate write; the hold itself lives in Redis as disposable, TTL-bound state so a crash only costs a re-selection, never a double-booking; and the browse path is deliberately kept off the same infrastructure as the book path, because unbounded reads and inventory-bounded writes are not the same traffic shape.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the exact Redis `SET ... NX PX 600000` syntax, the specific Lua compare-and-delete script used for safely releasing only your *own* hold, the exact 10-minute TTL constant — useful specifics to reach for, not things to derive from first principles each time.

**Understand once, then trust it:** Redis's *lazy* key expiry (a background process samples a handful of keys roughly ten times a second rather than deleting exactly on the millisecond a TTL hits zero, so an "expired" key can linger a moment past its nominal deadline) — know this is why you'd double-check a hold's `expiresAt` at confirmation time rather than trusting an expiry notification alone; the RedLock controversy (whether a multi-master Redis lock gives a hard mutual-exclusion guarantee under GC pauses and clock skew) — know that the real answer, either way, is that the database's own atomic CAS is the actual correctness backstop, without needing to relitigate the whole debate from scratch.

**This is the actual idea — think hard here:** (1) "check, then act" as two steps *is* the race, full stop — the fix is always one atomic operation, never more careful sequencing; (2) pick pessimistic, optimistic, or a TTL hold based on the actual *shape* of the contention (a short unavoidable pile-up, ordinary rare conflict, or multi-minute human think-time) — not by whichever one you learned first; (3) a Redis hold is deliberately soft, disposable state, and the *only* place the real no-double-booking guarantee lives is the database's atomic transition — losing a hold is an inconvenience, never a correctness failure; (4) unbounded reads and inventory-bounded writes are different traffic shapes needing different infrastructure — conflating them is this repo's own named #1 mistake in this topic.

## 7. The build — the smallest thing that actually shows the mechanism

No real Redis or a live 50,000-seat database here — the one mechanism that actually matters, "check-then-act races, one atomic operation doesn't," is fully visible with plain Python threads:

```python
# save as seat_race_demo.py, run with: python3 seat_race_demo.py
import threading
import time

# ---- Naive: check, then act, as two SEPARATE steps ----
naive_status = {"A14": "AVAILABLE"}
naive_winners = []
list_lock = threading.Lock()   # only protects the shared Python list itself

def naive_claim(user):
    if naive_status["A14"] == "AVAILABLE":            # CHECK
        time.sleep(0.001)                              # the real-world gap: network/processing time
        naive_status["A14"] = f"HELD by {user}"         # ACT — nothing stopped anyone else in between
        with list_lock:
            naive_winners.append(user)

# ---- Fixed: the ENTIRE check-and-act is one atomic operation ----
cas_status = {"A14": "AVAILABLE"}
cas_lock = threading.Lock()
cas_winners = []

def cas_claim(user):
    with cas_lock:                                      # check AND act, together, or not at all
        if cas_status["A14"] == "AVAILABLE":
            cas_status["A14"] = f"HELD by {user}"
            cas_winners.append(user)

def simulate(claim_fn, num_users=50):
    threads = [threading.Thread(target=claim_fn, args=(f"user-{i}",)) for i in range(num_users)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

simulate(naive_claim)
print(f"Naive check-then-act:   {len(naive_winners)} user(s) think they won seat A14")

simulate(cas_claim)
print(f"Atomic compare-and-set: {len(cas_winners)} user(s) actually won seat A14: {cas_winners}")
```

Run it. Fifty users hit the naive version at once, and **all fifty** believe they hold seat A14 — every single one passed the check before any of them had written, exactly the gap from section 5. The atomic version, run against the same fifty concurrent users, produces **exactly one** winner, every single time.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** Add a third, "fixed-looking" version that only wraps the *write* in a lock, leaving the check outside it:

```python
def broken_claim(user):
    if naive_status["A14"] == "AVAILABLE":   # check is still OUTSIDE the lock
        time.sleep(0.001)
        with cas_lock:                          # only the write is "protected"
            naive_status["A14"] = f"HELD by {user}"
            naive_winners.append(user)
```

Run it through the same `simulate()` harness. **It still produces fifty winners** — identical to the fully naive version. This is the sharpest lesson in the whole topic: adding a lock *somewhere* doesn't fix a race. The gap was never inside the write — it was the entire span between reading the value and deciding what to do about it. A lock has to wrap that **whole** span, or it protects nothing.

**Sabotage 2 (walk it in your head, no code needed).** Now imagine Redis — holding 50,000 active holds during a live flash sale — crashes outright. Walk it: every one of those 50,000 hold keys disappears. Every one of those seats instantly becomes `AVAILABLE` again, and 50,000 real people just lost their spot in the checkout flow — genuinely bad, a wave of angry re-contention. But **not one seat gets double-booked**, because the database never said `BOOKED` for any of them; it only ever knew about a hold that lived entirely in Redis. Now walk the mirror-image failure: imagine instead that the *database's* atomic `HELD → BOOKED` transition were skipped or corrupted for one seat under load. That genuinely *would* be a double-booking, because the database is where the real, permanent guarantee lives. This is exactly why Redis holds are called soft state and the database CAS is called the correctness layer — they can fail in very different ways, and only one of those failures is actually a broken promise to a customer.

## 9. One-sentence recap

Same words as before, on purpose: **a seat transitions from available to held to booked only through a single atomic compare-and-set, never through a separate check followed by a separate write; the hold itself lives in Redis as disposable, TTL-bound state so a crash only costs a re-selection, never a double-booking; and the browse path is deliberately kept off the same infrastructure as the book path, because unbounded reads and inventory-bounded writes are not the same traffic shape.**

## 10. What transfers

Swap Redis for another TTL-capable store, or `SELECT FOR UPDATE` for a different database's row-locking syntax, and this lesson is unchanged — those are the incidental, swappable pieces. What transfers to **every** finite-inventory system — flight seats, hotel rooms, a limited product drop, a single promo code: collapsing check-and-act into one atomic operation as the *only* real fix for a race, never "more careful ordering"; matching the locking strategy to the actual shape of contention rather than reaching for the same one by habit; treating a temporary reservation as disposable, TTL-bound state that's allowed to fail cheaply, while keeping the permanent, correctness-critical transition on a strongly consistent store; and separating unbounded read traffic from inventory-bounded write traffic as a first-class architectural decision, not an afterthought.

---

## Recall check — answer these without scrolling up

1. **Describe the data flow in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5.)*
2. **What is each box's job, and what breaks if you delete it?**
   - *Model answers:* delete atomicity and go back to check-then-write as two steps → the section 1 symptom returns exactly: two people can both believe they hold or booked the same seat, with neither system nor user ever notified of the conflict. Delete the TTL on Redis holds (make them permanent until explicit release) → an abandoned checkout locks a seat forever, since nothing ever automatically frees it back to the pool. Delete the browse/book split and serve live seat-map data straight from the same path as the atomic hold → the read storm competes directly for the same scarce capacity the correctness-critical writes need, degrading both.
3. **What would you look at first if this got slow, or wrong, in production?** *(Model answer, from this repo's own material: hold-expiration rate and conversion rate first — an unusually high expiration rate can mean a UX problem or bots grabbing holds without paying; then overbooking-attempt counters — attempts, even rejected ones, tell you if contention on a specific seat/row is unusually hot; then whether the browse path or the book path is the one actually slow, since they're deliberately different infrastructure with different failure surfaces.)*

If you answered all three cold, go read [`story.md`](./story.md) for the full chronological version of one sale, or `answers.md` for QR ticket issuance, the virtual waiting room's queue-fairness mechanics, and payment-saga compensation (A19–A29, A43–A47) — this script deliberately skipped those because piling every idea into one narrative would bury the four that actually matter.
