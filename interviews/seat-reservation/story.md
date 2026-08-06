# The Story: One Seat, One Fan, One Sale

> **Read this first, before anything else in this folder.**
> This is the *spine* — one purchase, told in order, from 90 seconds before the sale opens to walking through
> the turnstile on concert night. The other files are the *depth*: [questions.md](./questions.md) to test
> yourself, [answers.md](./answers.md) for the code, [deep-dive.md](./deep-dive.md) for capacity math,
> [diagrams.md](./diagrams.md) to whiteboard.
> No prior knowledge assumed. Every term is explained in plain words *before* it is named.
> Numbers marked "illustrative" are teaching figures, not measured facts — the same caveat the source files carry.

---

## What you are about to read

There is one chair. Two people want it. You cannot cut the chair in half and give each of them a piece.

That is the whole problem. Everything else in this folder — 53 interview questions, ten diagrams, a thousand
lines of SQL and Redis — exists to make that one sentence true under conditions where it desperately wants to
be false: 150,000 people clicking the same button in the same second, networks timing out mid-payment, a cache
that is honestly wrong, a database that dies at the worst possible moment, and a farm of bots that is faster
than every human in the queue.

The reason this material is hard to connect is not that any single piece is hard. It is that the pieces are
filed by *topic* rather than by *time*. The command that creates a seat hold lives 1,400 lines away from the
race condition that attacks it. So this file does one thing: it puts everything back in chronological order,
and at each moment it stops to explain the machinery that fires at exactly that instant, then asks "but what
if…" and walks the failure modes that belong right there.

### The cast

| Who | Role |
|---|---|
| **Priya** | Our fan. Wants seat A14, Row 3, Section B. We follow them the whole way. |
| **Dev** | The other fan. Wants the *same* seat, at the *same* microsecond. Dev is the antagonist of every race in this story. |
| **The bot farm** | Thousands of scripted clients, faster and more patient than any human, trying to claim everything. |

### The clock

| Time | Scene | What the system is doing |
|---|---|---|
| — | [Scene 0](#scene-0--before-anything-happens-why-this-is-hard) | Why a seat is not a shopping cart |
| 09:59:58 | [Scene 1](#scene-1--095958--150000-people-one-button) | 150,000 people arrive at once |
| 10:00:00 | [Scene 2](#scene-2--100000--priya-becomes-number-4200) | The waiting room hands out numbers |
| 10:03:00 | [Scene 3](#scene-3--100300--priya-is-let-in-and-sees-80000-seats) | Drawing and streaming a live seat map |
| 10:03:14 | [Scene 4](#scene-4--100314--priya-clicks-seat-a14) | **The hold** — the heart of the system |
| 10:04:00 | [Scene 5](#scene-5--100400--the-timer-starts-ticking) | The 10-minute countdown, and honest clocks |
| 10:06:00 | [Scene 6](#scene-6--100600--priya-pays) | Money, and what happens when money goes wrong |
| 10:06:03 | [Scene 7](#scene-7--100603--one-update-decides-everything) | **The commit** — where overbooking is actually prevented |
| 10:06:05 | [Scene 8](#scene-8--minutes-later--the-ticket-and-the-emails) | The ticket, the QR, the reminders |
| Concert night | [Scene 9](#scene-9--concert-night--the-turnstile) | Validating a ticket with no internet |
| Always | [Scene 10](#scene-10--backstage--everything-the-fan-never-sees) | Schema, shards, regions, failover, incidents |

---

## Scene 0 — Before anything happens: why this is hard

### The cake slice and the candy bowl

Imagine a birthday party with **one special corner slice of cake** and fifty kids who all want it. If two kids
grab the plate at the same instant, you cannot cut the slice in half and pretend both got "the corner slice."
It is a single, unique thing. Exactly one kid gets it.

Now imagine a **bowl of identical candies**. Two kids reach in at once — fine. There are hundreds, and they are
all the same. Nobody cares *which* candy they got.

A shopping cart is the candy bowl. If Amazon briefly sells one more phone charger than it has, it apologizes,
backorders, and refunds. Nobody is harmed. A seat is the corner slice. **There is no extra chair.** If two
people both hold a valid ticket for A14, someone gets turned away at the door on the night, in public, having
paid — and that is a refund, a chargeback, a support ticket, and a news story.

The word for this is **fungible** versus **non-fungible**. Candies are fungible (interchangeable). Seat A14 is
non-fungible (unique and named).

| | Shopping cart | Seat reservation |
|---|---|---|
| Inventory | Fungible — 100 identical widgets | Non-fungible — seat A14 is unique |
| Overselling | Tolerable — apologize and refund | **Never** — you cannot seat two people in one chair |
| Conflicts | Rare, fixable afterwards | The **normal case** during a hot sale |
| When must it be right? | Eventually — reconcile stock later | **At the moment you say "confirmed"** |
| Shape of the load | Spread over hours | A wall of traffic in the first second |

Here is a detail worth savouring: **the same company made the opposite choice** in each case. Amazon's original
shopping cart, described in the 2007 Dynamo paper (*Dynamo: Amazon's Highly Available Key-value Store*,
DeCandia et al.), deliberately chose to always accept an "add to cart" — even during a network partition — and
reconcile conflicting carts later. A deleted item could even reappear. That is *correct* for fungible cart
contents. It would be *catastrophic* for a seat map. Being able to name that contrast is a strong senior signal.

### Idea 1: this is two different systems glued together

Watch what Priya actually does. They *look* at things (search for the tour, open the event page, stare at the
seat map, read "1,200 seats left") — then, once, briefly, they *take* something (claim A14, pay for it).

Those two activities have nothing in common:

- **Looking** is about 95% of all traffic. It can be served from a copy. If the copy is two seconds out of date,
  literally nothing bad happens. You can add as many copies as you like, anywhere in the world, cheaply.
- **Taking** is about 5% of traffic. It must be exactly right, once, at the one place that holds the truth. You
  cannot make copies of "the truth" without inviting two people to both win.

The industry names for these are the **read path** and the **write path**. The single most common mistake in
this interview — and in real systems — is treating them as one thing. If you serve availability from the write
path you melt your database; if you let a cached number *authorize* a purchase, you oversell.

Draw this split first, always: [simple-diagram.md](./simple-diagram.md) and
[Diagram 1 — The Central Split](./diagrams.md#diagram-1--the-central-split-read-path-vs-write-path-start-here).

In the vocabulary of the CAP theorem (which says a distributed system under a network partition must choose
between staying available and staying consistent): **browsing chooses availability; confirming a seat chooses
consistency.** You would rather tell a real buyer "sorry, try again" than sell one chair twice.

That preference has an exact ranking, and it drives every single decision later in this file:

```
1. Two people confirmed for one seat  →  CATASTROPHIC  (refund + chargeback + trust + press)
2. A valid buyer is rejected          →  ANNOYING      (they retry in a few seconds)
3. The screen showed stale info       →  INVISIBLE     (one wasted click, re-checked on claim)
```

Whenever you are stuck later — fail open or fail closed? cache or not? — come back to this ladder. You always
prefer #2 or #3 over #1.

### Idea 2: "don't oversell" is not a rule, it is one machine instruction

Beginners describe overbooking prevention as a business rule: *"don't sell more tickets than there are seats."*
That sentence is true and completely useless, because it does not tell you what to type.

Here is the code a beginner writes:

```python
if seat.status == 'AVAILABLE':     # step 1: look
    seat.status = 'HELD'           # step 2: take
```

This is broken, and it is worth being precise about *where*: the bug is not in either line. **The bug is the
gap between them.** Priya's request runs line 1 and sees "available." Before it reaches line 2, Dev's request
also runs line 1 and also sees "available." Now both run line 2. Both think they won. One chair, two owners.

That gap is called a **race condition**, and it cannot be fixed by making the gap smaller. It has to be
*removed* — the looking and the taking must be one single indivisible step that nothing can interleave with.
The general name is an **atomic compare-and-set** (atomic = cannot be split; compare-and-set = "if it still
looks like this, change it").

You have exactly four ways to buy that guarantee, and you will meet all four in this story:

```
Redis:    SET seat NX                          -- "set it only if nobody has set it"
SQL:      UPDATE ... WHERE status='AVAILABLE'  -- conditional write; then count the rows changed
SQL:      SELECT ... FOR UPDATE                -- take a lock on the row first, make others wait
Version:  UPDATE ... WHERE version = 7         -- "only if nobody changed it since I looked"
```

Each one produces the same guarantee: **for one seat, at most one writer can win the transition. Everybody
else is told, unambiguously, that they lost.** Business rules (refunds, resale, transfers) sit on top of that
primitive. They never replace it.

Two more things to notice, because they shape the rest of the story:

- The seat only ever moves **AVAILABLE → HELD → BOOKED**, and each arrow needs its own atomic step. Skipping
  straight from AVAILABLE to BOOKED would mean nobody ever took the mutex.
- Priya's *whole* interaction is read-heavy and write-light: search, event page, seat map, availability counts,
  heat maps — all reads. Hold, release, confirm, payment record — the only writes. That ratio (roughly 95/5) is
  why the read path gets caches and copies and the write path gets locks and queues.

↳ *Sources: Q1, Q4, Q5 · A1, A4, A5 · deep-dive §1 · Diagram 1*

---

## Scene 1 — 09:59:58 — 150,000 people, one button

Priya has the page open. So do roughly 149,999 other people. Everyone is pressing F5. The sale opens at
10:00:00.

### What a stadium does wrong

Picture 150,000 fans pressed against a stadium's front doors, and at exactly 10:00 someone unlocks **all the
doors at once**. People are crushed. Nobody moves. The entrance jams. Ironically, *fewer* people get inside
than if you had opened the doors in an orderly stream.

Software does exactly this, and it is worth walking the death sequence in order, because being able to describe
the failure *before* you describe the fix is what separates a strong answer from a memorized one.

```
At 10:00:00.000, ~150,000 clients fire "Buy" inside the same second.

1. Each click is not one request. It is a seat-map load, an availability read, a hold
   attempt — call it ~4 requests each. 150,000 × 4 ≈ 600,000 requests in one second.
   (Illustrative fan-out — verify against your own client.)

2. Your database has a connection pool. Pools are sized in the HUNDREDS — say 500
   connections. 600,000 requests against 500 connections saturates it in milliseconds.

3. The hold and confirm queries pile up behind locks on the most-wanted rows — the front
   row, which everybody clicked.

4. Latency spikes. Clients hit their timeouts.

5. Timed-out clients RETRY. This is the part people miss: the load does not stay at
   600,000, it MULTIPLIES. A retry storm.

6. Health checks start failing because the service is too busy to answer them. The
   autoscaler decides the instances are unhealthy and kills them. Now there is less
   capacity than when you started.

7. Cascading failure. Even the users who "got in" get errors mid-checkout — which is the
   cruelest outcome, because they think they have a seat.
```

Only now is it worth naming the thing: this is a **thundering herd**. The naive architecture aims the
*arrival* rate at the database. Nothing in it distinguishes "how many people showed up" from "how many people
the database can safely serve" — and those two numbers differ by three orders of magnitude.

This is not hypothetical. On 15 November 2022, Ticketmaster opened the presale for Taylor Swift's Eras Tour and
this happened in public. Per Ticketmaster's own statement, the day drew an extraordinary request volume —
their post cited billions of system requests, far above their prior peak (treat the exact figure as *their
reported number*, not a verified engineering measurement). The public sale was cancelled outright on 18
November. It is the reference benchmark for every decision in this folder, and it comes back in Scene 2.

↳ *Sources: Q24 · A24 · deep-dive §7 · [Diagram 5](./diagrams.md#diagram-5--virtual-waiting-room-admission-fair-tokens-bot-mitigation)*

---

## Scene 2 — 10:00:00 — Priya becomes number 4,200

### What a stadium does right

Real venues do not open all the doors. They use **turnstiles and a marshalled holding area**: fans wait in a
line and are let through at the rate the concourse can actually absorb. Nobody is crushed. The flow is steady.
Counter-intuitively, everybody gets in *faster*.

The software version is a **virtual queue**, usually called a **waiting room**. Priya clicks "Buy" at 10:00:00
and does not reach the seat map. They reach a page that says *"You are number 4,200. Estimated wait: 3 minutes.
Do not refresh."*

```
        150K users hit the sale URL at 10:00:00
                        │
             ┌──────────▼───────────┐
             │  WAITING ROOM (edge)  │  stateless, served from a CDN / edge worker
             │  - assigns a position │
             │  - shows "you are #N" │
             └──────────┬───────────┘
                        │  admits in batches — e.g. 5,000/min (illustrative)
             ┌──────────▼───────────┐
             │   ADMISSION TOKEN     │  a signed token granting a bounded entry window
             └──────────┬───────────┘
                        │  only admitted users pass
             ┌──────────▼───────────┐
             │ SEAT INVENTORY SVC    │  sees ~5K/min, never 150K at once
             └──────────┬───────────┘
                        ▼
                DB (primary) + Redis holds
```

One sentence carries this entire scene, and it is worth memorizing word for word:

> **The inventory tier is capacity-planned for the *admitted* rate, never the *arrival* rate.**

That decoupling is the whole point. The waiting room's job is to **stretch a one-second stampede into a
several-minute drip**.

Two properties make it work, and both are easy to get wrong:

- It must be **stateless and at the edge** (CDN or edge worker). Think about why: the waiting room is the thing
  that absorbs the load your real service cannot survive. If it needs your database to tell people their
  position, you have moved the fire, not put it out.
- It must be **the only door**. If a clever user can bypass the queue by calling the seat API directly, the
  queue is decoration. Admission is enforced by a token that the inventory service *checks*.

### Handing out fair numbers to 150,000 people in one second

Two properties are needed: **fairness** (order by who actually arrived first) and **tamper-proofness** (Priya
cannot edit their way to number 3).

Fairness has two standard answers, and the trade between them is real:

```redis
# Option A — one atomic counter:
INCR queue:event:123:counter
#   INCR = "add one and tell me the new value", as a single indivisible step.
#   Priya gets 4200, Dev gets 4201. Nobody can ever get the same number.
#   Cost: every one of the 150,000 requests touches ONE key. That key is now the
#         hottest thing in your infrastructure. (Shard it, or count per edge node.)

# Option B — a sorted set, ordered by true arrival time:
ZADD queue:event:123 1699999200123456 user:456
#   ZADD = "put this member in a sorted collection with this score".
#   The score here is the arrival timestamp in microseconds, so the collection is
#   permanently sorted by who really arrived first.
ZRANK queue:event:123 user:456
#   ZRANK = "what position is this member at?" → 4199 (zero-based).
#   Cost: more memory, and O(log N) instead of O(1) per operation.
```

| Structure | Gives you | Costs you |
|---|---|---|
| `INCR` counter | O(1), atomic, trivially simple | One very hot key; order is "whoever's call landed first" |
| Sorted set | True arrival-time ordering, rank lookups | More memory, O(log N) operations |

For most sales, a signed token plus `INCR` (optionally several per-shard counters merged) is enough.

Tamper-proofness is simpler than it sounds. The server does not send Priya a number it will later trust; it
sends a **signed token** — a small blob containing `{userId, eventId, position, issuedAt}` plus a signature
computed with a secret only the server knows. Change any field and the signature no longer matches. The browser
can *display* the position. It can never *assert* it. And the token is bound to Priya's session, so it cannot
be sold or replayed by someone else.

### The admission rate is a thermostat, not a constant

How fast should you let people in? "5,000 per minute" is a starting guess, not an answer. The right model is a
**closed loop**: admit as fast as the inventory tier can absorb, and back off the instant it strains.

```
Start (open loop):  admit_rate ≈ the throughput inventory can sustain within its latency SLA
                    e.g. 5,000 holds/sec at p99 < 500 ms → start near there  (illustrative)

Then close the loop:

  TURN IT DOWN when:
    - inventory p99 latency  > 500 ms      (the service is getting slow)
    - DB connection pool     > 80% used    (you are running out of room)
    - hold errors/timeouts   > 1%          (it is already failing)
    - hold→book conversion is falling      (people are getting in but can't finish)

  TURN IT UP when:
    - p99 < 250 ms AND pool < 60% AND errors low   (you have headroom)
    - and the queue is long (drain it while you can)
```

All thresholds above are illustrative — tune them against your own load tests. The control pattern is **AIMD**
(additive increase, multiplicative decrease): creep up gently, cut hard at the first sign of strain, and aim to
keep the database around 60–70% utilized so there is always slack for a surprise.

Notice what this means: **admission control and monitoring are the same system.** The dashboard numbers from
Scene 10 are the inputs to this thermostat. Get too aggressive and you have recreated the thundering herd. Get
too timid and the sale drags on for an hour while people give up.

### Priya closes the tab and comes back 20 minutes later

They were number 4,200. They would have been admitted 15 minutes ago. What now? This is a **policy** question,
not a technical one, and the interviewer wants you to *pick one and defend it*:

| Policy | Behavior | Trade |
|---|---|---|
| Strict expiry | Position forfeited; back of the line | Simple, harsh; punishes flaky mobile networks |
| **Grace window (recommended)** | The admission is valid for a bounded window (say 10 min); inside it they walk in at their spot, past it they re-queue | Balances fairness and kindness; reclaims abandoned slots |
| Position held forever | Their place waits indefinitely | Feels fairest, but no-shows block real buyers, and it is gameable |

```
On return with a queue token:
  if the token was ADMITTED and (now - admittedAt) <= graceWindow:
      → let them straight into the buying flow
  elif the token is still WAITING and valid:
      → show their CURRENT live position (they never lost their place)
  else:
      → issue a new position at the current tail, and say so clearly in the UI
```

The recommendation is the grace window, and the reason is inventory: a scarce seat sitting reserved for someone
who left is worse for everyone than giving it to the next real buyer.

### The bot farm — and the one lesson from 2022

Bots are fast, parallel, patient, and cheap. They will claim positions faster than any human. And here is the
critical architectural point: **they must be stopped at the gate, before the seat-selection layer.** Once
automated traffic is inside the buying flow, it is holding real seats, and it is already too late.

```
Bot mitigation stack, at the waiting room:
  1. Identity friction   — account age, verified email/phone, "verified fan" pre-registration.
                           The goal is to make mass fake accounts expensive.
  2. Bot detection       — device fingerprinting, behavioral signals (mouse, timing),
                           CAPTCHA or proof-of-work on suspicious sessions only.
  3. Rate limits         — per identity, per IP, per network (ASN), plus anomaly detection:
                           thousands of positions from one network in one second → block.
  4. Non-guessable tokens— nothing sequential for a script to enumerate.
  5. Edge WAF / managed bot rules.
  6. Priority lanes      — verified humans first; unverified traffic deprioritized.
```

What went wrong in 2022, stated the way the sources state it — **as publicly reported and discussed at the
January 2023 U.S. Senate hearing, not as confirmed internal engineering detail**: the virtual queue was
under-provisioned for the true demand, and bot / unverified automated traffic reached the seat-selection layer.
The three lessons codified in this design:

1. **Verify humans and filter bots at the gate**, before inventory sees them.
2. **Capacity-plan the queue for real demand**, not for the demand you hope for.
3. **Never let unverified automated traffic touch inventory.**

If you are ever asked "you have six weeks before the next big on-sale, what are your top three changes?" —
that is the answer, in that order, plus a load test at 2–3× projected peak and a game-day drill before the
doors open.

↳ *Sources: Q25, Q26, Q27, Q28, Q29, Q40 · A25–A29, A40 · deep-dive §7 · [Diagram 5](./diagrams.md#diagram-5--virtual-waiting-room-admission-fair-tokens-bot-mitigation)*

---

## Scene 3 — 10:03:00 — Priya is let in and sees 80,000 seats

Priya's token is admitted. The seat map loads. Everything in this scene is the **read path** — and the read
path's defining property is worth stating bluntly:

> **This is the one screen that is allowed to lie.**

Not "might accidentally be wrong." *Allowed* to be wrong, by design, because being slightly stale here costs a
wasted click and buys you orders of magnitude of cheap scale. Hold that thought; it is what makes the rest of
the scene safe.

### The number on the page: display count vs decision count

The event page says **"1,200 seats left."** Where does that number come from — a cache, or the real database?

The right way to decide is to ask three questions, in this order:

```
1. How stale is acceptable?
     A marketing badge ("1,200 left")     → cache. Seconds or minutes of staleness is fine.
     A number someone ACTS on to buy      → must reflect true inventory at write time.

2. Is this a DISPLAY count or a DECISION count?
     Display  → read replica or a Redis counter. Eventual consistency.
     Decision → the source of truth. Strong consistency.

3. What is the read rate vs the write rate for THIS event?
     A normal event, 95% reads     → cache aggressively.
     A hot on-sale                 → the count changes every millisecond. A cached number is
                                     already wrong before it finishes rendering. Show an
                                     approximate count, and re-check on click.
```

| What the number is for | Read it from | Consistency |
|---|---|---|
| "Seats remaining" badge on a listing | CDN / Redis counter | Eventual — stale is fine |
| Section heat map on the seat map | Read replica, short TTL | Eventual — stale is fine |
| **The actual attempt to take a seat** | Source of truth, atomic claim | **Strong — must be exact** |

The rule, stated as a rule rather than "it depends": **cache the display count; never let a cached count
authorize a claim.** The claim is always validated against the truth. This one sentence is the thread that
survives all the way to Scene 7.

### Two stores, because browsing and buying are opposites

Priya found this event by searching "Eras Tour, London, June." That query is full-text, faceted, geographic,
and sorted by relevance. The seat claim is a single-row point write on a specific seat. Those two workloads want
opposite database designs, so you give them **different stores**:

```
BROWSE / SEARCH store                      BOOK / INVENTORY store
  - a search engine (Elasticsearch /         - a relational DB (Postgres / MySQL / Spanner),
    OpenSearch) or a read-optimized replica    sharded by event_id
  - full-text, faceted, geo search           - strong consistency, atomic claims, ACID
  - denormalized, eventually consistent      - the SOURCE OF TRUTH for seat state

Sync, strictly ONE-WAY:
  Inventory DB ──(change stream / CDC, e.g. Debezium → Kafka)──▶ Search index
```

"CDC" is change data capture: the search index does not query the inventory database; it *subscribes* to a
stream of changes and updates itself. The pattern of splitting reads and writes into different stores like this
is called **CQRS** (Command Query Responsibility Segregation — commands write, queries read, and they don't
share a model).

The consequence is honest and acceptable: the search index lags. An event can still show "available" for a few
seconds after it sold out. That is fine **only because** the claim re-validates against the source of truth.
Worst case: Priya clicks a seat that is gone and gets a clean, immediate "taken, pick another."

### Drawing 80,000 seats without setting the phone on fire

A seat map is not a document. It is a **spatial dataset**. That reframing decides everything.

| Approach | Sweet spot | What happens at 80,000 seats | Hit-testing (finding the tapped seat) |
|---|---|---|---|
| **SVG** — one DOM node per seat | Small venues, up to a few thousand (illustrative) | 80,000 DOM nodes destroy layout, style recalculation, memory, garbage collection. Pan and zoom judder. | Free — the browser does it. And that free convenience is exactly what collapses at scale. |
| **Canvas 2D** — draw pixels | **The pragmatic default**, tens of thousands | One `<canvas>`, zero per-seat DOM. Draw only the visible seats. CPU-bound on huge repaints. | You own it — spatial index or colour picking |
| **WebGL** — GPU, instanced | 80,000+ with buttery zoom | The GPU draws every seat as an instance of one quad. 60 fps at full venue. | You own it — same spatial index, or GPU colour-id picking |

Default to **Canvas 2D with viewport virtualization**. Reach for WebGL only when profiling on your *target
low-end device* shows Canvas cannot hold 60 fps. Keep a handful of real DOM/SVG nodes as an **overlay** for
interactive chrome — the selection ring, the tooltip, the held-seat highlight — layered on top of the raster.
That hybrid gives you crisp, stylable, accessible chrome without paying for 80,000 nodes.

Two techniques do the heavy lifting:

```
LEVEL OF DETAIL (LOD) — draw what the eye can actually use:
  zoomed way out → draw SECTION polygons with an availability heat colour. No seats at all.
  mid zoom       → seat dots, no labels.
  zoomed in      → seat rectangles + row/seat labels — for the viewport only.

VIEWPORT CULLING — every frame, inside requestAnimationFrame:
  visible = spatialIndex.query(whatTheScreenCoversInWorldCoordinates)
  for seat in visible: draw(seat, colourFor[seat.status])
  # 80,000 seats exist. A few hundred to a few thousand are ever on screen.
```

A **spatial index** is a lookup structure over 2D space — a quadtree (recursively split the map into quadrants)
or a uniform grid (buckets by coordinate). It answers "what is in this rectangle?" quickly. And here is the
elegant part: the same index you build for culling is the one that answers "which seat did Priya just tap?"

| Hit-test technique | How | Cost |
|---|---|---|
| **Spatial index** | Tap (x,y) → convert to world coordinates → query the index | O(log n) or O(1); reuses the culling index |
| **Colour-id picking** | Render a hidden "hit canvas" where each seat is a unique RGB value; read the pixel under the tap and decode it back to a seat id | One extra buffer; robust for irregularly-shaped seats |

For smooth gestures, keep a world→screen **transform matrix**; on pan, translate the matrix and repaint the
culled seats inside `requestAnimationFrame`. A cheap trick that feels great: apply a CSS `transform` to the
whole canvas *during* the gesture (free, GPU-composited, slightly blurry) and re-rasterize crisply when the
gesture settles. Respect `window.devicePixelRatio` or retina screens look soft.

One more framing that pays off repeatedly: **the venue geometry and the seat status are two different
problems.** Geometry (where every seat physically is) is immutable per venue configuration — precompute it once,
version it by layout id, cache it hard at the edge. Only *status* is live.

### Keeping it live: the seat flips grey the instant Dev takes it

Priya must see A15 go grey the moment Dev claims it. But you must never push 80,000 seat states to every
connected client. Two levers solve this.

**Lever one — the right transport:**

| Transport | Direction | Fit |
|---|---|---|
| **WebSocket** | Both ways | **Recommended.** More infra (sticky sessions, a gateway) |
| **SSE** (Server-Sent Events) | Server → client only | Good fallback. Simpler, native auto-reconnect and `Last-Event-ID` resume |
| Long-poll / poll | Client pulls | Last resort. Wasteful and laggy — but it still works when the others are blocked |

Why WebSocket rather than the simpler SSE? Because — and this is the non-obvious reason — **the traffic is
genuinely two-way.** As Priya pans and zooms across the venue, the client constantly changes *which* sections it
wants updates for. That "subscribe to section C, unsubscribe from section B" message is upstream traffic. A
duplex connection carries it natively; with SSE you would need a separate side-channel HTTP call for every
viewport change.

**Lever two — snapshot once, then send only differences:**

```
On open:   ONE snapshot of only the section(s) currently in the viewport, as a packed bitmap.
Steady:    DELTAS only →  { ev:123, seat:"B-R3-A14", status:"HELD", v:42 }
           `v` is a per-seat version number, so the client can throw away updates that
           arrive out of order or twice.
```

Three techniques keep the fan-out bounded:

```
1. SCOPE it.     The client subscribes to the SECTIONS it can see — one pub/sub topic per
                 section (channel: seatmap:event:123:section:B). A seat change is fanned out
                 only to that section's subscribers, not to every connection in the venue.
2. COALESCE it.  During a hot sale, batch the deltas per section and flush every ~100 ms
                 (illustrative — tune it). A burst of 500 changes becomes one message.
3. RESYNC it.    On reconnect, pull a fresh section snapshot from cache, then resume deltas
                 from your last version cursor. Never replay the entire history.
```

A number worth getting right, because the source files are careful about it: a **bitmap encoding** at 2 bits
per seat gives 80,000 × 2 ÷ 8 = **20,000 bytes ≈ 20 KB for an entire venue** (illustrative arithmetic), versus
multiple megabytes of JSON. But that 20 KB figure is the *whole-venue encoding density* — it is **not** what you
actually send a client. You send one *section*: a few thousand seats, a few hundred bytes.

And the sentence that ties this scene back to Idea 2:

> **The stream only paints pixels. It never grants a seat.**

If a delta is dropped and Priya's screen shows a seat as free when it isn't, they click it and get rejected by
the atomic claim. A dropped update is a **cosmetic bug**, never an overbooking. That is precisely why you are
allowed to build this whole layer out of caches and best-effort pushes.

### The parts that are usually bolted on later, and shouldn't be

**Accessibility.** You cannot make 80,000 seats individually tabbable, and a screen reader cannot narrate a
canvas of pixels. The answer is a **semantic grid scoped to one section at a time** — matching the same section
scoping you already use for rendering and for updates, so the accessibility tree never has to represent the
whole venue:

```html
<div role="grid" aria-label="Section B seat map" aria-rowcount="40" aria-colcount="30">
  <div role="row" aria-rowindex="3">
    <div role="gridcell" tabindex="0" aria-colindex="14" aria-selected="false"
         aria-label="Section B, Row 3, Seat A14, available, $120">A14</div>
  </div>
</div>
```

The technique is a **roving tabindex**: exactly one cell has `tabindex="0"` and every other has `-1`, so the
grid is a single tab stop and arrow keys move focus cell to cell (Home/End for row ends, PageUp/PageDown to
jump rows). `aria-rowindex` / `aria-colindex` stay honest even when the grid is virtualized, so the announced
position is correct.

Look closely at that `aria-label`: the word **"available"** is inside it. That is deliberate and it is the whole
trick — a screen-reader user receives the same information a sighted user gets from colour, through the normal
accessible name, with no separate announcement mechanism.

| Seat state | Colour (one signal) | Second, non-colour signal | ARIA |
|---|---|---|---|
| Available | green | outline, selectable shape | `aria-disabled="false"` |
| Held by someone else | amber | hatch pattern + lock glyph | `aria-disabled="true"`, label says "held" |
| Sold | grey | solid fill / × glyph | `aria-disabled="true"`, label says "sold" |
| Your selection | blue | ring + checkmark | `aria-selected="true"` |

Encoding state with a second, non-colour signal satisfies WCAG 1.4.1 (use of colour) — never red/green alone.

Then the part that matters most: ship a **text-based "find seats" form** (section, row preference, quantity,
accessibility needs) as a **first-class path**, not a consolation prize. For many keyboard and screen-reader
users it is the *primary* flow — and it doubles as the bottom rung of the degradation ladder below.

**Performance**, as four separate budgets rather than one vague goal:

| Concern | Target (illustrative — verify on real target devices) | Lever |
|---|---|---|
| Initial interactive map | ~2–3 s on a mid-range device | Edge-served geometry + compact status, LOD first |
| Zoom/pan frame | 60 fps (~16 ms per frame) | Canvas/WebGL + culling, heavy work off the main thread |
| Real-time update cost | Only visible sections repaint | Scoped subscriptions + batched deltas |
| The floor | The worst device you support **can still book** | Feature-detect and fall back |

Practical moves: offload geometry work to a Web Worker and render via `OffscreenCanvas` where supported (verify
support; fall back to main-thread Canvas). Repaint only changed seats — a dirty-rectangle update on the overlay
layer — so a flood of holds does not re-render the venue.

And the ladder, so that "the fanciest tier" is never "the only tier":

```
Renderer:  WebGL available?  → WebGL
           else Canvas2D?    → Canvas
           else              → section list + heat map + the "find seats" form

Network:   WebSocket works?  → live deltas over WS
           WS blocked?       → SSE: snapshot + resume via Last-Event-ID
                               (Last-Event-ID is SSE-specific; the WS path resumes from
                                its own version cursor instead)
           both blocked?     → periodic poll, with an honest "updated 8s ago" badge

Device:    low memory / prefers-reduced-motion → no animation, coarser LOD, smaller batches
```

On every one of those paths the display can be stale **safely**, for the same reason as always: a claim is
authorized by the atomic write at the source of truth, so degradation costs a wasted click, never a double sale.

↳ *Sources: Q2, Q32, Q34, Q48, Q49, Q52, Q53 · A2, A32, A34, A48–A53 · deep-dive §8, Caching appendix · [Diagram 8](./diagrams.md#diagram-8--real-time-seat-map-fan-out-websocket-per-section-deltas-only), [Diagram 9](./diagrams.md#diagram-9--frontend-seat-map-rendering-virtualization--lod--hit-testing)*

---

## Scene 4 — 10:03:14 — Priya clicks seat A14

This is the heart of the system. Everything before it was preparation; everything after it is consequence.

### First, the distinction that everything depends on

Priya clicks A14. They have not bought it. They have not locked it. They have **held** it — and "hold" is a
precise, third thing that is neither of the other two.

The library analogy is exact. When you *reserve* a book online, the library sets it aside for three days. It is
not yours. If you never turn up, the reservation quietly lapses and the book goes back on the shelf — **no
librarian has to chase you.** *Checking out* the book is different: your card is scanned, it is on your account,
and that record survives the library's computer rebooting.

- A **hold** is the three-day reservation: temporary, self-expiring, cheap, and *fine to lose*.
- A **booking** is the checkout: durable, paid, permanent, and *never* fine to lose.

| | Hold | Booking |
|---|---|---|
| Where it lives | Redis (fast, in memory, has timers) | Relational database (durable) |
| Lifetime | 10 minutes, then it vanishes by itself | Permanent, until refunded or cancelled |
| If the machine crashes | Gone — and that is **fine** | Survives — the "D" (durability) in ACID |
| Cost to create | Microseconds | A committed transaction |
| Triggered by | Clicking "Select Seat" | Payment succeeding |

If the hold expires before payment completes: the Redis key disappears, the seat is available again, and the
database never needed to be told anything — because the database never said the seat was booked in the first
place. **Nothing to clean up.** That self-healing property is why the split exists.

### Second, why a hold is not a lock either

The obvious idea is to lock the row in the database for ten minutes:

```sql
BEGIN;
SELECT status FROM event_seats WHERE event_id=123 AND seat='A14' FOR UPDATE;
-- ... now wait for the human to type in their card details ...
```

Do the arithmetic on that and it becomes obviously fatal. `SELECT ... FOR UPDATE` holds a **row lock** and pins a
**database connection** for as long as the transaction is open. If the transaction spans the checkout, then
**every open cart pins one connection and one row lock for up to ten minutes.**

Connection pools are sized in the **hundreds**. Open carts during a hot sale number in the **hundreds of
thousands**. The pool is gone in milliseconds, and not just for holds — for *everything*, including the queries
that let other people browse.

That single paragraph is the entire reason Redis exists in this design:

| What Redis gives you | Why it matters for a hold |
|---|---|
| A per-key expiry (TTL) built in | The seat auto-releases on abandonment or crash. **No cleanup job, no cron, no timer thread.** |
| An atomic "set only if absent" | The compare-and-set primitive from Idea 2, in one round trip |
| In-memory latency | Sub-millisecond, so it can absorb a flash sale's write rate |
| No database locks at all | A ten-minute hold costs zero connections and zero row locks |

### Third, the command itself

```redis
SET event:123:seat:A14 "user:456:hold:h789" NX PX 600000
```

Line by line, every token:

- `SET` — write a value at a key.
- `event:123:seat:A14` — the key. One key per seat per event. **This key *is* the mutex.** Its existence means
  "taken."
- `"user:456:hold:h789"` — the value: *who* holds it, and a unique **hold token** (`h789`). We will need that
  token twice more, in this scene and in Scene 7.
- `NX` — **"only if it does Not eXist."** This is the atomic part. If the key is already there, do nothing.
- `PX 600000` — expire after 600,000 **milliseconds** = 600 seconds = 10 minutes.

Two possible replies, and no third:

```
"OK"    → the key did not exist. Priya holds A14. Start the countdown.
(nil)   → the key already existed. Someone else has it. Return 409 Conflict; grey out A14
          in the UI; refresh that part of the map.
```

Notice that `NX` and `PX` are in **one command**. Doing it as `SETNX` followed by a separate `EXPIRE` looks
equivalent and is not: if the process dies between the two commands you have created a key **with no expiry** —
a seat that is held forever, by nobody, and no timer will ever free it.

Now the release, which is subtler than it looks:

```redis
EVAL "if redis.call('GET', KEYS[1]) == ARGV[1]
        then return redis.call('DEL', KEYS[1])
        else return 0 end" 1 event:123:seat:A14 "user:456:hold:h789"
```

In plain words: *"read the key; **only if** its value is still my exact hold token, delete it; otherwise do
nothing."* `EVAL` runs that whole if-then as a single atomic Lua script inside Redis.

Why not simply `DEL`? Because of a race that is genuinely easy to miss. Suppose Priya's hold has *already*
quietly expired, and Dev has legitimately taken A14 in the meantime. Priya now clicks "remove seat," and a bare
`DEL event:123:seat:A14` **erases Dev's hold.** Dev did nothing wrong and just lost their seat. Comparing the
token before deleting closes that window. (This is the same concern as fencing a distributed lock — it comes
back later in this scene.)

### Fourth: Dev clicks A14 at the same microsecond

Both requests read "available." Both intend to write "held." Without atomicity, both succeed. Here is how each
of the three strategies resolves it — and, just as importantly, **how the loser finds out**.

**(a) Pessimistic — take a lock first, make the other wait**

```sql
BEGIN;
SELECT status FROM event_seats
  WHERE event_id=123 AND seat='A14' FOR UPDATE;   -- Priya takes the row lock
-- Dev's identical statement BLOCKS right here until Priya commits.
UPDATE event_seats SET status='HELD', hold_id='h789'
  WHERE event_id=123 AND seat='A14';
COMMIT;                                            -- lock released
-- Dev unblocks, re-reads, now sees status='HELD' → rejects the hold.
```

Priya wins by owning the lock. Dev *waits*, then loses on re-reading. Nobody had to retry, but somebody had to
stand still.

**(b) Optimistic — no lock, detect the clash afterwards**

```sql
-- Both read version = 7.
-- Priya:
UPDATE event_seats SET status='HELD', version=8
  WHERE event_id=123 AND seat='A14' AND version=7;   -- rows affected = 1  → WINS
-- Dev:
UPDATE event_seats SET status='HELD', version=8
  WHERE event_id=123 AND seat='A14' AND version=7;   -- rows affected = 0  → LOSES
```

`version` is just an integer that increases on every write. `rows affected = 0` is the database saying, without
ambiguity: *"the world moved since you looked."* No lock is held while the human thinks. The loser refreshes
and retries.

**(c) Redis `SET NX`**

```redis
# Priya:
SET event:123:seat:A14 "hold:Priya" NX PX 600000   → OK    (wins)
# Dev, microseconds later:
SET event:123:seat:A14 "hold:Dev"   NX PX 600000   → (nil) (loses)
```

Redis executes commands **one at a time, single-threaded**. There is no "same microsecond" inside Redis — one
of them is genuinely first, and exactly one `NX` succeeds.

| Strategy | Winner decided by | Loser learns via | Holds a lock while the human thinks? |
|---|---|---|---|
| Pessimistic | Who owns the row lock | Blocked, then re-reads | **Yes** — dangerous for long holds |
| Optimistic | Who bumped `version` first | `rows affected = 0` | No |
| Redis `NX` | Whose `NX` landed first | `(nil)` reply | No — a TTL, not a database lock |

### The rule for choosing, and the counter-intuitive part

Not "it depends." A concrete rule, driven by **contention on the specific row**:

```
Most seats, most of the time (low/medium contention)  → OPTIMISTIC or Redis NX.
    Cheap, nothing blocks, the loser just retries.

ONE genuinely hot row (the last GA ticket, a shared counter) → PESSIMISTIC.
    Serialize them into a queue; do not let 10,000 clients retry-storm one row.

A hold spanning minutes of human "think time"  → NEITHER database lock. Redis TTL.

The final HELD→BOOKED commit of an already-decided seat → OPTIMISTIC compare-and-set
    on hold_id (plus a fence token — see below).
```

Now the counter-intuitive result you should be able to defend, because interviewers probe it: **optimistic
locking degrades *worse* than pessimistic under high contention on one row.**

The intuition is that optimistic is "lighter," so it should always win. Watch what actually happens when 10,000
buyers hit one row: each one reads, tries its compare-and-set, gets `rows affected = 0`, and retries. Every
attempt costs a read plus a failed write. Per single success you pay N reads + N failed writes + N retries.
Throughput *collapses* — a retry storm, close to livelock. Pessimistic, meanwhile, would have quietly formed a
line: one lock-wait queue, linear and predictable.

```
Low conflict:   optimistic wins   (no locks, high concurrency)
High conflict:  optimistic pays N reads + N failed writes + N retries per success
                pessimistic pays one orderly queue
```

The worked example from the source material: the "last 100 general-admission tickets" pool, held as a single
counter row. With 10,000 buyers, an optimistic `UPDATE remaining = remaining-1 WHERE remaining > 0 AND
version=?` produces a conflict rate near **100%**. Teams that hit this move the hot counter onto a serialized
path — a single-threaded worker, a Redis atomic `DECR`, or a pessimistic lock — so the allocation runs
one-writer-at-a-time instead of ten-thousand-retriers-at-once.

And the metric that tells you to make that switch is the **update-conflict rate** = writes with
`rows affected = 0` ÷ total write attempts:

```promql
rate(seat_update_conflicts_total[1m]) / rate(seat_update_attempts_total[1m]) > 0.2
# More than ~20% of writes conflicting (illustrative threshold — tune per workload)
# → move that specific row or pool onto a pessimistic lock or a serialized queue.
```

### The bug all three of these prevent, by name

The **lost update**: two transactions read the same value, both compute from that stale read, and the second
write silently clobbers the first.

```sql
-- BROKEN — read, then modify, then write, with no guard:
-- T1                                     -- T2
SELECT status FROM event_seats            SELECT status FROM event_seats
  WHERE seat_id=42;  -- 'AVAILABLE'         WHERE seat_id=42;  -- 'AVAILABLE'
UPDATE event_seats                        -- (T2 also believes it is free)
  SET status='BOOKED', user_id=1
  WHERE seat_id=42;  -- succeeds
COMMIT;                                   UPDATE event_seats
                                            SET status='BOOKED', user_id=2
                                            WHERE seat_id=42;  -- OVERWRITES. User 1 is gone.
                                          COMMIT;
```

The fix is one clause:

```sql
UPDATE event_seats
   SET status='BOOKED', user_id=2
 WHERE seat_id=42 AND status='AVAILABLE';   -- rows affected = 0 for the loser
-- The application MUST check the row count. 0 → "no longer available" → do NOT confirm.
```

Say the principle out loud, because it generalizes to every atomic write in this system:

> **The write's `WHERE` clause must re-assert the state the read observed.**

`AND status='AVAILABLE'`, or `AND version=7`, or `AND hold_id='h789'`. A blind
`UPDATE ... SET status='BOOKED'` with no guard is the bug. Equivalent guards: a version predicate (optimistic),
`SELECT FOR UPDATE` (pessimistic), or serializable isolation (the database aborts one transaction for you).

### "But the seat map said it was free!" — the stale replica

Here is a scenario that *sounds* like it should cause a double booking, and doesn't.

```
1. Priya holds A14 → Redis SET NX → OK. Redis now says HELD.
2. The database primary hasn't been told (holds don't go there), and the read replica lags anyway.
3. Dev's browse hits the replica → the UI shows A14 as free. This is a genuine lie.
4. Dev clicks "Select A14" → the server does NOT trust the replica. It issues the atomic
   claim: SET event:123:seat:A14 NX PX 600000
5. The key exists → (nil) → Dev is rejected with 409.
   → No double booking. The stale read cost Dev one wasted click.
```

The principle: **reads may be stale; the write is always validated against the authority.** You never let a read
— cached, replicated, or pushed over a WebSocket — be the *gate* for a state transition. This is exactly why
Scene 3 was allowed to be built out of caches.

### What actually has to happen when a hold expires

Priya wanders off. Ten minutes pass. "Release the seat" is only step one of eight, and missing any of the rest
is a real bug:

```
1. Seat inventory     — the hold key is gone in Redis → the seat is AVAILABLE again.
2. Availability counts— decrement "held", increment "available" (cache and DB counters).
3. Seat-map cache     — invalidate/refresh so other users see A14 free.
4. Waiting room       — if admission is demand-gated, signal that inventory freed up.
5. User session       — mark the checkout EXPIRED; the UI must say "you lost the hold."
6. In-flight payment  — if a payment is MID-FLIGHT for this hold, block or compensate it.
                        Never let a late payment confirm an expired hold. (Scene 7.)
7. Analytics          — emit hold_expired → abandonment and conversion dashboards.
8. Idempotency        — expire the checkout idempotency key so a fresh attempt starts clean.
```

And now the gotcha that catches almost everyone: **Redis expiry is not instant.** Redis removes an expired key
either *lazily* (when something next touches that key) or via a background sampler that checks a small random
sample of keys roughly ten times per second (documented behavior; the exact sampling constants are Redis
internals). Under load, an expiry notification can lag the nominal TTL by a fraction of a second — or longer.

The design consequence is a rule you must carry into Scene 7:

```
Do NOT rely on "the TTL fired" to decide who owns a seat.
ALWAYS re-validate the hold token and expiry at CONFIRMATION time, in the database.
The Redis TTL is an optimization. The database confirmation is the arbiter.
```

### But what if Redis dies with 50,000 holds open?

| Setup | What happens on crash | Consequence |
|---|---|---|
| **Single Redis** | All 50,000 hold keys are lost (barring AOF/RDB replay) | Every held seat reverts to AVAILABLE. **No double booking** — the database never said BOOKED. But 50,000 people lose their holds and all re-contend. Angry, not incorrect. |
| **Redis Sentinel** (primary + replicas) | Sentinel promotes a replica; holds inside the replication gap are lost | Failover in seconds; *some* recent holds lost |
| **Redis Cluster** | Only the failed shard's key range is affected | Blast radius limited to some events, not all holds |
| **RedLock** (N independent masters, acquire on a majority) | One master failing doesn't lose the lock if a majority still hold it | Higher correctness bar, higher latency, more complexity |

Read the first row again, because it contains the punchline of the entire two-tier design: **losing every hold
is annoying, not incorrect.** The seat returns to AVAILABLE — a state the durable database always agreed with.
Nothing has to be reconciled. That is *why* it is acceptable to keep holds in a store that can lose data, and
why most production systems accept Sentinel or Cluster with asynchronous replication rather than paying
RedLock's cost on every hold.

Which leads to a debate you should be able to summarize accurately, because it is a favorite probe:

```
- RedLock is a Redis-authored algorithm for locks across N independent masters: acquire on
  a MAJORITY within a time bound.
- Martin Kleppmann's 2016 critique ("How to do distributed locking") argued it is NOT safe
  as a hard mutex: a garbage-collection pause or a clock jump can make a client believe it
  still holds a lock after the TTL expired — so two clients can act at once.
- Redis's author (Salvatore Sanfilippo / antirez) published a rebuttal defending it.
- What EVERYONE agrees on: if correctness truly depends on a lock, you need a FENCING TOKEN
  — a number that only increases, issued with the lock — and the protected resource must
  REJECT any write carrying a stale token.
```

(That exchange is real and public; treat the arguments as the positions their authors published, not as settled
fact.) The architectural conclusion is the sentence to carry forward:

> **Do not put the overbooking guarantee in the Redis lock at all.**

Put it in the database confirmation, and fence it:

```sql
UPDATE event_seats
   SET status='BOOKED', booking_id=:bid
 WHERE event_id=123 AND seat='A14'
   AND status='HELD'
   AND hold_id=:holdId
   AND fence_token >= :expectedFence;   -- reject a write from a "zombie" holder
-- rows affected 1 → booked.  0 → the hold was stale or stolen → do NOT confirm.
```

Under this design, Redis may lose locks, pause, or skew its clock, and the worst possible outcome is a
**double-*hold***, never a **double-*book***.

### But what if Redis is just unreachable for 30 seconds, mid-sale?

Two strategies, and you must choose consciously:

| Strategy | Behavior when Redis is unreachable | Business consequence |
|---|---|---|
| **Fail open** | Grant holds anyway, skipping the check | The sale keeps running — but you have thrown away the mutex. **Risk of double-holds and overbooking.** |
| **Fail closed** | Reject new holds: "high demand, please retry" | No overbooking, but 30 seconds of lost sales and bad UX at peak |

For the hold primitive, **fail closed.** Go back to Scene 0's severity ladder: a brief "try again" is outcome
#2 (annoying); an overbooking incident is #1 (catastrophic). Then engineer the outage *window* down rather than
trading away correctness:

```
- A fast circuit breaker: after N Redis errors, trip open, show "high demand, retrying…",
  back off, probe, and close when healthy again.
- A second net: even a fail-open path must still pass the database confirmation guard, so
  a Redis outage can at worst double-HOLD, never double-BOOK.
- Sentinel/Cluster so a 30-second single-node loss becomes a sub-10-second failover.
```

### "Why not use Zookeeper for the locks?"

A staff engineer proposes replacing the Redis hold layer with Zookeeper distributed locks. **Reject it for
holds** — and be able to say why, and where Zookeeper *is* right.

| | Redis hold (`SET NX PX`) | Zookeeper (ephemeral znode lock) |
|---|---|---|
| Model fit | A TTL-based soft reservation | Strong, session-based mutual exclusion |
| Throughput | Very high, in-memory | Lower — **every lock is a write through consensus** |
| Latency | Sub-millisecond | Higher — a quorum write per lock operation |
| Scale of locks | Millions of ephemeral holds | Hundreds or thousands of coordination locks |
| Auto-expiry | Native per-key TTL | The znode dies with the **session**, not on a per-hold timer |
| Correctness | Not a hard mutex (fence at the DB) | Strong, linearizable, with fencing built in |

In plain words: Zookeeper is a *coordination* service. Every lock acquire and release goes through a consensus
protocol, so it cannot match Redis's throughput for millions of holds. And holds need a *ten-minute per-hold
timer*, whereas a Zookeeper ephemeral node expires when the **client session** dies — so you would end up
bolting TTL logic on top anyway. Meanwhile the guarantee you actually need already lives in the database
confirmation.

Where Zookeeper or etcd genuinely *is* the right tool: a **handful** of coarse, low-volume locks that need
strong guarantees — leader election for the reconciler, "which node owns admission control for event X," schema
migration coordination. Low volume, high stakes. That is its sweet spot.

### Scaling this to 5,000 holds per second without weakening it

The waiting room admitted people at a safe rate, but "safe" is still thousands of holds per second. How do you
scale that horizontally and keep the guarantee?

```
Partition (shard) inventory by event_id:
  All 80,000 seats of event 123 live on one shard.
  Requests for event 123 route to the shard (and the Redis) that owns event 123.
  Different events scale independently across shards → linear horizontal scale.

The guarantee survives sharding, and here is exactly why:
  The mutex is per-SEAT. Sharding does not weaken it — each seat still has precisely one
  authoritative owner that serializes all writes to it. The atomic operation is the
  serialization point, NOT the application instance. So the app tier can be stateless and
  you can add as many pods as you like.

The catch — one mega-event is a HOT SHARD:
  A single Taylor Swift event can exceed one shard's capacity while other shards idle.
  Fix: sub-shard WITHIN the event, by SECTION (event:123:sectionA on shard 1, sectionB on
  shard 2). A seat never belongs to two sections, so the per-seat mutex is untouched and
  the load spreads. And keep the waiting room in front to cap the admitted rate.
```

| Scaling axis | What it buys | Where it stops |
|---|---|---|
| More stateless inventory pods | Request handling | Bounded by the shard/Redis/DB behind them |
| Shard by `event_id` | Independent events scale linearly | One hot event still lands on one shard |
| Sub-shard by section | Spreads a single hot event | More routing complexity |
| Waiting room in front | Caps the admitted rate to something safe | Adds queue wait time |

### One more attacker: the bot that holds every seat

A nastier bot strategy than buying: hold **everything**, then release it just before expiry. Nobody can buy,
competitors are disrupted, and the bot never pays a cent. This works when hold targets or hold IDs are
**guessable**.

```
1. Non-enumerable identifiers:
   - Hold tokens are random UUIDs or signed opaque strings, never sequential integers.
   - Don't expose internal sequential seat ids in a way that makes "hold seat_id + 1"
     scriptable. Require the seat to come from a seat map the SERVER signed and issued.

2. Rate-limit and quota the HOLD action per identity / IP / session:
   - A human holds a handful of seats. A bot tries hundreds. Cap holds per user per event
     (at the order maximum) and cap the hold rate per IP and per network.

3. Gate behind verification (Scene 2): verified fan, challenges on suspicion, edge bot
   management — so mass automated holding is expensive rather than free.

4. Detect the pattern itself: hold-then-release-just-before-expiry, repeatedly, is not human.
   Penalize it — shrink the TTL for suspicious sessions, force re-verification.

5. Bind holds to verified accounts and cap concurrent holds per account.
```

The trade is explicit and you should name it: **frictionless holds are the best UX and are trivially abusable.**
For scarce inventory you deliberately add friction. Same call as the bot filtering in Scene 2.

↳ *Sources: Q3, Q6, Q7, Q8, Q9, Q11, Q12, Q13, Q14, Q15, Q16, Q17, Q30, Q39, B2 · A3, A6–A9, A11–A17, A30, A39, AB2 · deep-dive §2, §3, §4 · [Diagram 2](./diagrams.md#diagram-2--seat-state-machine-available--held--booked), [Diagram 3](./diagrams.md#diagram-3--setnx-hold--ttl-lifecycle), [Diagram 4](./diagrams.md#diagram-4--concurrency-race-resolution-setnx-winner--optimistic-confirm)*

---

## Scene 5 — 10:04:00 — The timer starts ticking

Priya sees **09:58** counting down. Where did that number come from?

### The countdown is a rumour, not a fact

The seat is released by **Redis's TTL**, on the server, and by nothing else. The number on Priya's screen is a
*projection* of a server timestamp — a rumour the client repeats. Getting this backwards causes real bugs, in
both directions.

The server returns its absolute expiry **and its own current time**, so the client can correct for the fact that
the two clocks disagree:

```ts
type HoldResp = { expiresAtServerMs: number; serverNowMs: number };

function makeCountdown(r: HoldResp) {
  const skew = r.serverNowMs - Date.now();   // how far this device's clock is from the
                                             // server's, measured ONCE at hold time
  const correctedExpiry = r.expiresAtServerMs;   // on the SERVER's timeline
  return () => {
    const nowServer = Date.now() + skew;         // "what time is it, in server terms?"
    const SAFETY_MS = 5_000;                     // show it expiring 5s EARLY (illustrative)
    return Math.max(0, correctedExpiry - nowServer - SAFETY_MS);
  };
}
```

Two honest caveats live in that code. The `skew` estimate is captured once, so it is already stale by roughly
half the request's round-trip time — that inaccuracy is precisely what `SAFETY_MS` exists to absorb. And you must
**re-fetch the authoritative expiry** on reconnect, on tab re-focus (`visibilitychange`), and periodically,
because browsers throttle timers in background tabs — a "frozen" countdown will happily lie to Priya.

Now the two directions of dishonesty, both of which you must handle:

**The client hitting zero must not release the seat.** Only the server TTL does that. A client-side zero just
disables "Pay" and forces a re-check. If the client were allowed to release, a laggy phone would hand Priya's
seat away while she was still typing her card number.

**A still-positive countdown is not proof the hold is alive.** This is the direction people forget. The server
can end a hold *early* — a shorter real TTL than advertised, a fraud action, an admin release. So handle it on
two paths:

- **The real-time path:** the same per-section delta stream from Scene 3 carries a `HELD → AVAILABLE` transition
  for Priya's *own* seat if the server released it. On receipt: move focus off the dead hold, disable "Pay,"
  prompt a re-select. Do not wait for the countdown to catch up.
- **The payment-time path — the actual guarantee:** whether or not that delta arrives, **the payment call
  re-validates the hold server-side before charging.** Even a completely stale client can never charge a card
  for a seat that is no longer held.

### Priya adds a second seat, and applies a promo code

| Action | The client does | The server decides |
|---|---|---|
| Add seat B22 mid-order | Request a new atomic hold for B22 | Granted only if free; the order's expiry is recomputed server-side |
| Remove a seat | Release that specific hold | Seat → AVAILABLE at once; order total recomputed server-side |
| Apply an offer/promo | Show the discounted price optimistically | Validate the code, recompute, and **lock the price into the hold** |
| Timer during edits | Re-render from the authoritative `expiresAt` | Adding a seat does **not** silently extend the TTL unless the server says so |
| Server ends the hold early | Delta moves focus, disables Pay | The payment re-check is the real backstop regardless |

Adding B22 is just another atomic hold — same `SET ... NX PX`, same two outcomes. If B22 is taken, reject **B22
only** and keep A14. But there is a genuine design decision hiding here, and you should state which one you pick:

```
(a) Independent TTLs:  A14 expires in 2 minutes, B22 in 10. Simple — each hold self-heals.
                       But the ORDER can partially expire: Priya loses A14 while still
                       checking out with B22. Confusing, upsetting UX.

(b) Unified order TTL: model the ORDER as the hold unit; all member seats share one expiry,
                       reset on each add. The order expires as a single unit. Cleaner UX,
                       slightly more state to track.
```

**Recommendation: the unified order TTL** — plus a cap on the total window (say 15 minutes), otherwise a user
can extend forever by adding and removing seats in a loop.

The promo row deserves a note, because it foreshadows a whole feature. If prices are **dynamic** (changing in
real time with demand, airline-style), one discipline becomes mandatory: **snapshot the price into the hold at
the moment you lock the seat.** Priya pays the price she was quoted, not one that moved mid-checkout. Optimistic
UI is fine for feeling fast, but the price paid and the seats owned are decided server-side. (The rest of dynamic
pricing is in Scene 10.)

↳ *Sources: Q10, Q50 · A10, A50 · deep-dive §2 · [Diagram 3](./diagrams.md#diagram-3--setnx-hold--ttl-lifecycle)*

---

## Scene 6 — 10:06:00 — Priya pays

### The boundary that beginners get wrong

The instinct is to wrap everything in one database transaction: charge the card, flip the seat, write the
booking, `COMMIT`. It feels safe. It is impossible.

**You cannot put the card charge inside the database transaction.** The charge is a remote call to Stripe or
Braintree that can take seconds — and no `ROLLBACK` in the world can un-charge a credit card. Your database has
no idea that money moved.

So the boundary is drawn differently: keep the **local** writes in one all-or-nothing transaction, and treat the
**payment** as an external step wrapped in idempotency and a saga.

```sql
-- The ACID transaction, AFTER the payment is authorized/captured:
BEGIN;
  UPDATE event_seats
     SET status='BOOKED', booking_id=:bid, hold_id=NULL, version=version+1
   WHERE event_id=:eid AND seat IN (:seats)
     AND status='HELD' AND hold_id=:holdId;   -- the guard: is MY hold still valid?
  -- assert rows affected == number of seats; otherwise ROLLBACK (hold expired or stolen)
  INSERT INTO bookings (booking_id, user_id, event_id, amount, payment_ref, status)
       VALUES (:bid, :uid, :eid, :amt, :paymentRef, 'CONFIRMED');
  INSERT INTO payments (payment_ref, booking_id, status)
       VALUES (:paymentRef, :bid, 'CAPTURED');
COMMIT;
```

Inside the transaction: **seat flip + booking row + local payment record.** All three commit or none do — because
a booking with no payment record, or a payment record with no seat, is corruption. Outside the transaction: the
actual charge.

### The milestone analogy, and its real name

You hire a contractor to renovate a kitchen. You do not hand over all the money and hope. You pay in milestones
— deposit, then after cabinets, then after countertops. If the countertop step fails you do not tear out the
cabinets; you have a record of what was done and what to refund. **Each step is recorded, and each step has a
matching undo.**

That is a **saga**: a sequence of local transactions, each with a **compensating action**.

| Step | Forward action | Compensating action (the undo) |
|---|---|---|
| 1. Hold | `SET NX` the seat in Redis, 10-min TTL | Compare-and-delete the hold |
| 2. Charge | Capture payment (idempotently) | Refund the charge |
| 3. Confirm | `UPDATE seat → BOOKED` (guarded on `hold_id`) | `UPDATE seat → AVAILABLE` + cancel the booking |
| 4. Issue ticket | Generate and deliver the ticket | Void / revoke the ticket |

```
Orchestrator — each step idempotent, state persisted after every step:
  try:
    hold    = acquireHold(seat)            # undo: releaseHold
    charge  = capture(payment, idemKey)    # undo: refund(charge)
    booking = confirm(seat, hold, charge)  # undo: unconfirm(booking)
    ticket  = issue(booking)               # undo: void(ticket)
    return success(ticket)
  except StepFailure as f:
    for step in reverse(completed_steps):  # compensate in REVERSE order
        step.compensate()
    return failure(f)
```

Prefer **orchestration** (one central coordinator drives the steps) over **choreography** (each service reacts to
events from the last) here, for a specific reason: the flow is linear, and you want exactly one place that knows
how to drive compensation when it breaks.

The trade has a name — **atomicity vs availability, 2PC vs saga.** A true two-phase commit spanning your
database and the payment provider would give real atomicity, but the coordinator blocks and payment providers
simply do not expose XA transactions. So you accept a saga: **no global rollback**, eventual correctness via
idempotent compensations. (Chris Richardson's *Microservices Patterns* is the canonical write-up.)

### Priya double-clicks "Pay Now"

Two identical requests hit your server in the same instant. **They must produce one charge.**

The tool is an **idempotency key** — but the important detail is what it is computed *from*. Not the HTTP
request (each click is a different request). It is derived from the *logical payment*:

```typescript
// Stable across double-clicks and retries of the SAME order + hold:
function idempotencyKey(userId: string, orderId: string, holdId: string): string {
  return sha256(`${userId}:${orderId}:${holdId}`);
}

async function pay(order: Order): Promise<PaymentResult> {
  const key = idempotencyKey(order.userId, order.id, order.holdId);

  // Insert FIRST. The UNIQUE constraint on idempotency_key is the real guard.
  const inserted = await db.query(
    `INSERT INTO payment_attempts (idempotency_key, order_id, status)
     VALUES ($1, $2, 'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [key, order.id]);

  if (inserted.rowCount === 0) {
    // The first click already owns this key → return ITS result. Do NOT charge again.
    return await getExistingResult(key);
  }

  // We won the race → charge exactly once, handing the SAME key to the provider:
  return await stripe.charges.create({ amount: order.total /* ... */ },
                                     { idempotencyKey: key });
}
```

Read that carefully: the guard is not an `if` statement in your code (which would be its own check-then-act
race). The guard is the **database's `UNIQUE` constraint** — the same trick as Idea 2, one atomic step. And note
`rowCount === 0` here means "somebody else already claimed this key," which is the *good* case.

You get two independent layers of protection: your own unique constraint, **and** the payment provider's
idempotency key (Stripe and Braintree both document support for this; verify current field names against their
live docs). Belt and suspenders — the provider protects you even if your own app double-fires.

### The payment provider returns HTTP 408

A timeout is the worst possible answer, because it is **ambiguous**: the charge may have succeeded, may have
failed, or may still be in flight. You genuinely do not know.

The rule: **never blindly retry a raw charge.** That is how you double-charge someone.

```
On 408 or a network timeout:
  1. Do NOT create a new charge.
  2. Retry with the SAME idempotency key.
       The provider dedupes: if the first charge landed, you get THAT SAME result back
       (no second charge). If it did not land, this creates exactly one.
  3. OR ask the provider for the status by idempotency key:
       SUCCEEDED        → proceed to confirm the booking
       FAILED           → surface the error; keep the hold if TTL remains; let Priya retry
       PENDING/UNKNOWN  → back off and poll. Do NOT confirm yet.
  4. Bound the ambiguity window: if it is still unresolved as the hold TTL approaches,
     either move the seat to PENDING_PAYMENT (so the TTL cannot release it) or compensate.
```

The elegant part: **the idempotency key turns an unsafe retry into a safe one.** A timeout stops being a
*re-charge* problem and becomes a *query* problem.

### The card was charged and then your service crashed

Money has moved. The seat is not BOOKED. Nobody is watching. This must be **self-healing**, not a 3am scramble.

```
What makes recovery possible (you must set this up BEFORE charging):
  - Persist INTENT before you charge: a payment_attempts / outbox row keyed by the
    idempotency key with status PENDING. So on restart you KNOW a charge may exist.
  - The charge carried that key → the provider can always tell you its outcome.

The reconciler (runs on restart, and on a timer, forever):
  1. Find payment_attempts stuck PENDING past a threshold.
  2. Ask the provider for the charge status by idempotency key.
     - CAPTURED, no booking, hold still valid → COMPLETE the booking now (idempotently).
     - CAPTURED but the hold expired / seat gone → COMPENSATE: auto-refund + notify Priya.
     - NOT captured → safe to cancel the attempt.
  3. Emit an event either way — ticket issued OR refund issued — so the user is made whole.
```

Memorize the invariant. It is the one sentence that makes this whole area tractable:

> **Money captured ⇒ eventually a valid booking, OR a refund. Never money with no seat.**

You cannot make "charge + book" atomic, so you accept a brief window of inconsistency and *guarantee eventual
correctness* with a durable outbox plus a reconciler. If you cannot describe this loop in an interview, the
interviewer will assume you have never operated a payment system in production.

↳ *Sources: Q18, Q19, Q20, Q21, Q22 · A18–A22 · deep-dive §6 · [Diagram 6](./diagrams.md#diagram-6--booking-saga-hold--authorize--confirm--issue-ticket-with-compensations)*

---

## Scene 7 — 10:06:03 — One `UPDATE` decides everything

Payment succeeded. Now comes the single most important statement in the entire system.

### The state machine, and the transitions that must be impossible

```
                 hold (SET NX)                  confirm (DB guard on hold_id)
   ┌──────────┐ ──────────────▶ ┌────────┐ ──────────────────────────▶ ┌────────┐
   │AVAILABLE │                 │  HELD  │      (payment succeeded)     │ BOOKED │
   └──────────┘ ◀────────────── └────────┘                             └────────┘
        ▲    TTL expiry / release     │                                     │
        │    (compare-and-delete)     │ payment fails / user abandons       │ refund /
        └─────────────────────────────┘                                     │ cancel
        ▲                                                                   │
        └───────────────────────────────────────────────────────────────────┘

  Optional intermediate: HELD → PENDING_PAYMENT while the charge is in flight, so a naive
  TTL expiry cannot hand the seat to Dev while Priya's money is moving.

  LEGAL, and only these:
    AVAILABLE → HELD        (atomic claim, exactly one winner)
    HELD      → BOOKED      (database guard on hold_id — the overbooking arbiter)
    HELD      → AVAILABLE   (TTL expiry or explicit release)
    BOOKED    → AVAILABLE   (refund / cancellation — an admin or compensation path)

  ILLEGAL, and must be structurally impossible rather than merely discouraged:
    AVAILABLE → BOOKED             (skips the hold — nobody ever took the mutex)
    HELD(Priya) → BOOKED(Dev)      (confirming someone else's hold)
```

Note that BOOKED is not a dead end: a refund returns the seat to the pool, so this is a cycle, not a line.

### The statement

```sql
UPDATE event_seats
   SET status='BOOKED', booking_id=:bid, hold_id=NULL, version=version+1
 WHERE event_id=:eid AND seat=:seat
   AND status='HELD' AND hold_id=:holdId;
```

Clause by clause:

- `SET status='BOOKED'` — the seat is now sold. Durably. This is the money moment.
- `booking_id=:bid` — link the seat to the booking record.
- `hold_id=NULL` — the hold is consumed; it cannot be reused.
- `version=version+1` — bump the counter so any other in-flight optimistic writer loses.
- `WHERE ... status='HELD'` — **only if the seat is still merely held**, not already sold to someone else.
- `AND hold_id=:holdId` — **and only if the hold that is on it is *mine*.**

And then the only two possible outcomes in the whole system:

```
rows affected = 1  →  You own the chair. Nobody else can ever get 1 for this seat.
rows affected = 0  →  You do not. Your hold expired, or somebody else's hold is on it now.

There is no third answer, and there is no ambiguity to resolve later.
```

That is it. That is where "no overbooking" actually lives — not in the Redis hold, not in the waiting room, not
in a business rule in a document. **In one `WHERE` clause, on one row, in one database.** Everything else in this
folder is either making that statement fast enough to be usable, or making sure the fan is treated fairly when
they are the one who gets `0`.

### The nastiest race in the folder

Now put Dev back in the story, and pick the worst possible microsecond.

```
1. Priya holds A14 (hold_id = HA, TTL 10 minutes).
2. Priya submits payment. The provider takes ~2.9 seconds.
3. At exactly 10:00 of hold age, the TTL fires. Redis evicts HA.
4. Dev — who has been refreshing — instantly gets SET A14 NX → OK. Dev holds it (HB).
5. Priya's payment provider returns SUCCESS. Priya's card is charged.

Both Priya and Dev now believe they own A14. Priya has PAID for it.
```

If Redis's TTL decided ownership, this would be a genuine double booking with money attached. It doesn't:

```sql
-- Priya's confirm:
UPDATE ... WHERE seat='A14' AND status='HELD' AND hold_id='HA';
--   → 0 rows. HA is gone. Priya did NOT book it.

-- Dev's confirm (after Dev pays):
UPDATE ... WHERE seat='A14' AND status='HELD' AND hold_id='HB';
--   → 1 row. Dev owns A14.
```

**Redis's TTL is a hint. The database row is the arbiter.** Expiry never *itself* transfers ownership — it only
removes a claim; the transfer happens when somebody wins the guarded write.

Then the defense in depth, four layers, each doing a different job:

```
1. PREVENT it:   when the charge STARTS, move the seat HELD → PENDING_PAYMENT (or extend
                 the hold), so a naive TTL expiry cannot hand it to Dev mid-charge. This
                 layer's job is to make the race rare.
2. ARBITRATE it: the guarded UPDATE decides ownership. Exactly one writer gets 1 row.
                 This layer's job is to make the race harmless.
3. COMPENSATE:   Priya's confirm returned 0 but Priya was already charged → AUTO-REFUND,
                 apologize, optionally offer a comparable seat. Money never sits with no seat.
4. FENCE it:     the hold carries a monotonically increasing token; the database rejects a
                 confirmation carrying a stale one — so a garbage-collection-paused
                 "zombie" process cannot confirm late with an old hold.
```

Name the trade honestly, because an interviewer will push on it: **consistency vs UX.** Protecting the invariant
means occasionally refunding someone whose payment landed a hair too late. That is a worse experience than "you
got the seat" — and *far* better than selling the seat twice. You buy correctness with an apology and a refund
path.

### What this looks like on a dashboard (and what should be impossible)

```promql
# Guarded writes that returned 0 rows and WOULD have double-booked. A steady, high rate
# during an on-sale is NORMAL — it is just the losers of honest races:
rate(seat_double_book_prevented_total[1m]) > 50    # illustrative — investigate a SPIKE

# Two BOOKED rows for one seat must be IMPOSSIBLE. If this is ever non-zero it is a Sev-1
# correctness breach, not a performance problem:
sum(bookings_confirmed) by (event_id, seat_id) > 1     # must always be 0
```

The arithmetic behind "normal" is worth internalizing (illustrative figures): if 5,000 buyers race for a 500-seat front section, then
roughly **4,500 of those attempts legitimately lose.** That is not a bug — it is the *expected loser count*. So
you size the dashboard to expect a high prevented-double-book rate during on-sale and alert on **deviation from
the modeled shape**, never on the raw number.

Closing contrast, because it makes the whole scene click: **airlines deliberately do overbook** economy cabins —
they sell more seats than exist, betting on no-shows, and bump passengers when everyone turns up. That is legal
and rational because a coach seat is treated as *fungible* and the compensation cost is bounded. But **assigned
premium seats are never double-sold**, because those are non-fungible and the assignment is an atomic write.
Overbooking is a *policy* available only where inventory is fungible. For a named seat, the state machine
forbids it outright.

↳ *Sources: Q23 · A23 · deep-dive §5 · [Diagram 2](./diagrams.md#diagram-2--seat-state-machine-available--held--booked), [Diagram 4](./diagrams.md#diagram-4--concurrency-race-resolution-setnx-winner--optimistic-confirm), [Diagram 10](./diagrams.md#diagram-10--failure-mode-hold-expiry-during-payment-race--fenced-atomic-confirm)*

---

## Scene 8 — Minutes later — the ticket and the emails

The seat is BOOKED. Priya's money is captured. Now they need something to show at the door.

### Issuance is downstream, and that is a deliberate choice

The tempting design is to generate the ticket inside the confirmation transaction. Don't. That would couple a
durable money-and-seat commit to a fragile rendering step — a QR failure would either roll back a real payment or
block the response.

Instead, the confirmation emits an event, **in the same transaction as the commit**, using the **outbox pattern**:

```
tx:
  booking.status = CONFIRMED
  outbox.insert(TicketIssuanceRequested{ booking_id })   # SAME transaction
COMMIT
# Because the event row commits atomically with the booking, the event CANNOT be lost.
# A separate relay publishes outbox rows onto a queue, retrying until acknowledged.
```

The framing to hold onto: **`CONFIRMED` is the source of truth; the QR is a downstream projection of it.**

### What goes inside the QR — and what must not

The wrong answer is "the booking id." Here is what the payload actually is:

```ts
type TicketToken = {
  v: 1;                     // schema version — lets a gate reject formats it doesn't know
  tid: string;              // opaque RANDOM ticket id — never the booking or seat id
  bid: string;              // the booking this credential is bound to (audit + revoke scope)
  eid: string;              // event id — the gate checks this matches THIS gate
  seat: string;             // section/row/seat — for display and audit only
  sub: string;              // holder reference (a hashed account id, not raw personal data)
  jti: string;              // random nonce — stops replay of an identical signed blob
  gen: number;              // credential GENERATION — bumped on re-issue (see below)
  nbf: number; exp: number;  // valid-from / valid-until — the entry window
  kid: string;              // which signing key was used — enables key rotation
  sig: string;              // the signature over every field above
};
```

Why a bare, unsigned booking id fails, in three distinct ways:

| If the QR contains… | Forgeable? | Enumerable? | Tamper-evident? | Revocable? |
|---|---|---|---|---|
| Raw booking id (unsigned) | **Yes** — anyone can fabricate the string | **Yes** — sequential ids are guessable by a bot | **No** integrity at all | **No** — nothing to verify against |
| The signed token above | No — you need the private key to mint one | Opaque random `tid`/`jti` — nothing to guess | Signature breaks if one bit changes | Yes — `kid` rotation + `gen`-scoped revocation |

The distinction the source files are careful about, and you should be too: putting the booking id *inside* a
signed token (as `bid`) is fine and useful. The bug is shipping a **bare unsigned id as the entire payload**.
The id is *data*; the QR must carry *proof*.

One practical constraint: a QR code holds only a few kilobytes (roughly ~2–3 KB binary at high versions —
illustrative, verify), and dense high-version QRs scan badly off a phone screen. So keep the payload to a few
hundred bytes: prefer a compact binary encoding (CBOR/COSE- or CWT-style — verify against current specs) over a
verbose JSON/JWT, whose base64url text is bulkier for the same fields.

### Where the ticket lives

| Channel | Works offline? | Rotating code? | Forwarding risk | Can you push a fix / re-issue? |
|---|---|---|---|---|
| App + account deep link | Yes (cached) | Yes — the app holds the seed | Low (tied to login) | Yes — the app refetches the live ticket |
| Apple Wallet pass (`.pkpass`, PassKit) | Yes, for the static barcode | **No local rotation** | Medium | Yes, via APNs + the pass web service (verify) |
| Google Wallet pass (Google Wallet API) | Yes, for the static barcode | Same limitation (verify) | Medium | Yes, via a server-initiated object update (verify) |
| Email + PDF | Yes, once downloaded | No (static) | **High** — just forward the file | No — you must re-send |

The wallet limitation is worth understanding precisely, because it is widely misunderstood: **a wallet pass has
no code execution environment.** It cannot run a rotating-code loop. A pass whose barcode appears to "rotate" is
being *refreshed by a server push* (Apple: APNs wakes the app, which calls the pass web service; Google: a
server-side object update). Treat both as verify-before-quoting. A *truly offline*, self-rotating code still
requires the live app with the seed on the device.

Core principle: **the canonical ticket lives server-side.** Wallet, email, and app are all *renderings* or
*pointers*. That is exactly what makes safe re-issue possible.

### Priya loses their phone

Re-issue must not create a second working door. The invariant: **one seat → exactly one active `ticket_id` →
exactly one active generation.**

```
reissue(ticket_id):
  tx:
    g     = current_generation(ticket_id)
    revoke(ticket_id, g)      # (ticket_id, g) goes on the revocation list —
                              # the old QR and every screenshot of it now FAIL validation
    g2    = g + 1
    seed2 = rng()             # a new rotating seed, if rotating codes are used
    persist(ticket_id, generation=g2, seed=seed2)
  push_wallet_update(ticket_id)                       # refresh the pass IN PLACE
  enqueue revocation_delta(ticket_id, g) → all gates  # offline gates learn at next sync
```

Why this beats "just email them another QR": a naive re-send leaves **two scannable credentials for one seat** →
double entry. Binding validity to a **generation counter** means minting a new credential *atomically
invalidates the old one*. The old QR is not "a second ticket" — it is a **revoked prior generation**. And the
wallet push refreshes the existing pass rather than adding a second one.

### The emails and reminders that actually arrive

| Notification | Trigger | When | Channels | Idempotency key |
|---|---|---|---|---|
| Booking confirmation | the `BookingConfirmed` event | immediately | push → email (always email a receipt) | (user, booking, "confirm") |
| Reminder T-24h | scheduled at booking time | event start − 24h | push → SMS fallback | (user, event, "rem_24h") |
| Reminder T-1h | scheduled at booking time | event start − 1h | push → SMS fallback | (user, event, "rem_1h") |
| Day-of change (gate/time) | an ops event | on change | push + SMS (urgent) | (user, event, "dayof", change_hash) |

```
on BookingConfirmed(b):
  # DURABLE ROWS — never in-process timers, which die with the pod.
  # And only schedule reminders still in the FUTURE: a booking made 10 minutes before
  # doors does not need a T-24h row.
  if b.event_start - 24h > now(): schedule(..., type="rem_24h", send_at=b.event_start - 24h)
  if b.event_start - 1h  > now(): schedule(..., type="rem_1h",  send_at=b.event_start - 1h)

# dispatcher — every ~60s (illustrative), at-least-once
for row in due(now):                       # send_at <= now AND status = PENDING
  if not lease(row, ttl=120s): continue    # lease TTL > dispatch interval, so ONE worker
                                           # holds the row for the whole send rather than
                                           # the next tick claiming it too
  key = (row.user, row.event, row.type)    # stable key, deliberately CHANNEL-INDEPENDENT
  if not ledger.insert_if_absent(key):     # the UNIQUE constraint IS the dedupe guarantee
      row.status = SKIPPED_DUP
      continue
  send(row, channel=pick(row), idempotency_key=key)   # SEND FIRST, passing `key` to the
                                                      # provider as ITS idempotency key too
  row.status = SENT                        # mark AFTER the send call succeeds
```

Two subtleties in that loop, both of which are the difference between working and silently broken:

- **Send before marking SENT.** If you mark first and then crash, you have recorded a notification that never
  went out — silently lost, forever. If you send first and then crash, the retry re-sends and the *provider's*
  idempotency key collapses it. One failure mode is invisible; the other is harmless. Choose the harmless one.
- **The key excludes the channel.** It is per (user, event, type), so push/email/SMS dedupe **against each
  other**. One logical notification = at most one delivery, not one per channel. (The booking confirmation is the
  intentional exception: always keep an emailed receipt.)

The trade: queues give **at-least-once** delivery cheaply; true exactly-once is expensive and fragile. So take
at-least-once *delivery* and make the *effect* exactly-once with a `UNIQUE`-key ledger.

### CONFIRMED, but the QR generation failed

| Layer | State | What you do |
|---|---|---|
| Payment | Captured | Leave it. The charge is valid; the seat is theirs. |
| Booking | CONFIRMED (durable) | Source of truth — unchanged |
| Ticket / QR | Missing | Retry issuance idempotently until it succeeds |
| What Priya sees | "Booking confirmed — your ticket is being prepared" + a booking reference | **Never** "payment failed" |

```
on TicketIssuanceRequested(booking_id):
  ticket = tickets.get_or_create(booking_id)   # UNIQUE(booking_id) → at most ONE row ever
  if not ticket.issued:
      ticket.credential = sign(build_token(booking_id))
      ticket.issued = true                     # MINT happens exactly once
  deliver(ticket)                              # DELIVERY always runs, on every retry
  ack
```

Look at why `deliver()` is *outside* the `if`. If you wrote the naive `if ticket.issued: return`, then a crash
between minting and delivering would leave a ticket that **exists but was never sent**, and every retry would
skip delivery forever. So: **mint once under a `UNIQUE` guard, deliver unconditionally.** Delivery is itself
idempotent (a wallet push or a re-sent email is safe to repeat).

If issuance keeps failing, the message parks in a dead-letter queue and an alert fires — **but the seat is still
validly booked.** The fallback is the box office looking up the booking by reference, because **the CONFIRMED
booking, not the QR, is the entitlement.**

↳ *Sources: Q43, Q45, Q46, Q47 · A43, A45, A46, A47 · [Diagram 7](./diagrams.md#diagram-7--qr-issuance--offline-gate-validation)*

---

## Scene 9 — Concert night — the turnstile

Priya arrives at the venue with 79,999 other people. Concrete walls, a metal roof, 80,000 phones fighting for
the same cell towers. **This is the worst network environment in the entire system.** So the ticket must render
and validate with *zero* signal. Everything the scanner needs is already on the device, and everything the phone
needs is already on the phone.

### Three attacks, three different defenses

Do not conflate these. Conflating them is the classic mistake:

- **Forgery** (fabricating a ticket from nothing) → a **cryptographic signature**. Prefer **asymmetric** signing:
  the gate holds only the *public* key, so a stolen or compromised gate device still cannot **mint** tickets.
  (An HMAC is simpler, but then every gate holds the minting secret.)
- **Screenshot-and-reuse by two people** → a signature does **not** help here. A screenshot is a *valid copy*.
  You need **single-use redemption** (first scan wins, recorded) and/or a **rotating code** that makes a
  screenshot stale within seconds.
- **Sharing to defeat entry** → the rotating code lives in the app, and the seed is delivered securely and never
  leaves the device, so a forwarded screenshot expires.

| | Signed static token | Rotating time-based code (TOTP-style, RFC 6238) |
|---|---|---|
| Stops forgery | Yes | Yes |
| Stops screenshot reuse | **No** on its own — needs online single-use dedupe | Yes — the code changes every ~15s (illustrative — verify) |
| Works offline at the gate | Yes — verify the signature with a cached public key | Yes, but the gate must pre-download per-ticket seeds |
| Needs the live app | No — a PDF or wallet pass is fine | **Yes** — the seed and clock live in the app |
| Revocation | Ship a revocation-list delta | Rotate the seed / generation |
| Complexity | Low | Higher (seed distribution, clock skew) |

Ticketmaster's SafeTix is publicly described as a rotating/refreshing barcode — treat the exact mechanism as
*verify before quoting*.

### The gate does zero network calls

```
BEFORE doors open (over any network, once): each gate device downloads
  - the event's PUBLIC key (or per-event HMAC key)
  - the revocation list for the event, keyed by (ticket_id, generation)
  - [rotating mode only] the encrypted per-ticket seed bundle

AT the turnstile, the gate is OFFLINE:

validate(qr, now):
  t = parse(qr)
  if not verify_sig(t, gate.pubkey):   return REJECT("forged")   # FIRST. Local. No network.
  if t.eid != gate.event_id:           return REJECT("wrong event")
  if now < t.nbf or now > t.exp:       return REJECT("outside window")
  if (t.tid, t.gen) in gate.revoked:   return REJECT("revoked")   # scoped by GENERATION
  if rotating:
     expected = totp(gate.seed[t.tid], now, period=15, skew=±1)   # illustrative — verify
     if t.code not in expected:        return REJECT("stale / replayed")
  if t.tid in gate.local_scanned:      return REJECT("already used")   # this lane
  gate.local_scanned.add(t.tid, now)   # queued for peer/central sync on reconnect
  return ACCEPT
```

Three details in that function are doing real work:

**The signature is checked first, before any other field is trusted.** This ordering is not stylistic. If you
validated `exp` or `eid` first, a *forged* token's fields would be influencing your decision path before you had
any reason to believe them.

**Two different keys, on purpose.** The used-set (`local_scanned`) is keyed by `tid` **alone** — a physical seat
is scanned once, full stop. The revocation list is keyed by **`(tid, gen)`**, because a re-issue (Scene 8) bumps
the generation and must invalidate only the *old* generation, not the ticket id forever. Get this wrong and
either re-issued tickets don't work, or revoked ones do.

**The rotating code is validated separately** — against the seed, not the outer token's signature. So a
compromised seed and a compromised signing key are *independent* failure modes.

### The residual risks, stated honestly

A design that claims to stop everything is a design that hasn't been thought through. What remains:

- **Cross-lane double entry while offline.** Each lane keeps a local scanned-set; lanes gossip scans
  peer-to-peer over the venue LAN and reconcile to the central log on reconnect. A determined double-scan across
  two *truly partitioned* lanes in the same second is real — shrunk to seconds by rotating codes (the copy at
  lane 2 is already stale) and otherwise covered by staff.
- **Live screen relay.** Rotation defeats a *forwarded screenshot*; it does not defeat a live video call to
  someone at the gate right now.
- **Seed extraction** from a rooted or compromised device — the seed sits at rest in the app's storage.
- **A stolen gate device.** Pre-distributing every per-ticket rotating seed to every gate is exactly what makes
  offline validation possible — and it means a stolen scanner carries **every seed for the event**. Asymmetric
  signing bounds this (a stolen gate still cannot forge the outer signature), and you reduce blast radius with
  per-gate seed subsets where the venue layout allows, plus short-lived, revocable rotation.

So the honest summary: **rotation narrows the exploitable window; it is not a standalone defense.** The real
guarantee against reuse is gate-side single-use redemption plus revoke-on-reissue.

The trade to name: **offline availability vs perfect single-use.** Strict global single-use requires a consistent
online check. Offline gates trade that for availability and accept a tiny reconciliation window — which rotating
codes compress to seconds.

On the phone side, both pieces are pre-cached at issuance:

```
Persist into IndexedDB (via a PWA / Service Worker Cache API) at issuance, while online:
  - the signed static token, AND
  - for rotating codes: the per-ticket TOTP seed.

At the gate, offline:
  if static:   QR = encode(signedToken)
  if rotating: otp = HMAC(seed, floor(deviceClock / step))   # step ~30s, illustrative
               QR = encode(otp) ; re-render every `step` seconds
  # HMAC via Web Crypto (crypto.subtle) is a real browser API. QR ENCODING is not —
  # there is no native browser QR-generation API, so verify your library choice.
```

↳ *Sources: Q44, Q51 · A44, A51 · [Diagram 7](./diagrams.md#diagram-7--qr-issuance--offline-gate-validation)*

---

## Scene 10 — Backstage — everything the fan never sees

Priya's story is over. This scene is everything that had to be true for it to work.

### Blueprints vs tonight's seating chart

A wedding venue has permanent **blueprints**: where the tables and chairs physically sit. That never changes. But
for *each* wedding there is a fresh **seating chart** saying who sits where *tonight*. You do not scribble
tonight's guests onto the permanent blueprint — last week's wedding and this week's would collide.

The database has exactly this split, and it is **mandatory, not tidy**:

```sql
CREATE TABLE venues (
  venue_id   BIGINT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL
);
CREATE TABLE sections (
  section_id BIGINT PRIMARY KEY,
  venue_id   BIGINT NOT NULL REFERENCES venues(venue_id),
  name       TEXT NOT NULL                -- 'Floor', 'Balcony', 'Section B'
);
CREATE TABLE seat_rows (
  row_id     BIGINT PRIMARY KEY,
  section_id BIGINT NOT NULL REFERENCES sections(section_id),
  row_label  TEXT NOT NULL                -- 'Row 3'
);
CREATE TABLE seats (                       -- PHYSICAL seat. Venue-time. Reused every event.
  seat_id    BIGINT PRIMARY KEY,
  row_id     BIGINT NOT NULL REFERENCES seat_rows(row_id),
  seat_label TEXT NOT NULL,               -- 'A14'
  x_coord    INT, y_coord INT             -- for rendering the interactive map
);
CREATE TABLE events (
  event_id   BIGINT PRIMARY KEY,
  venue_id   BIGINT NOT NULL REFERENCES venues(venue_id),
  artist     TEXT, starts_at TIMESTAMPTZ
);
CREATE TABLE event_seats (                 -- PER-EVENT state. The write-path table.
  event_id    BIGINT NOT NULL REFERENCES events(event_id),
  seat_id     BIGINT NOT NULL REFERENCES seats(seat_id),
  status      SMALLINT NOT NULL,           -- 0=AVAILABLE 1=HELD 2=BOOKED
  hold_id     TEXT,                        -- the current hold token (NULL if not held)
  booking_id  BIGINT,
  price_cents INT NOT NULL,
  version     INT NOT NULL DEFAULT 0,      -- optimistic-lock column
  fence_token BIGINT NOT NULL DEFAULT 0,   -- monotonic fence for the confirm (Scene 4)
  PRIMARY KEY (event_id, seat_id)
);
```

The reason this split is *required*: if `status` lived on the physical `seats` row, then **two events at the same
venue would clobber each other's inventory.** Tonight's sold-out show would make next week's show look sold out.

And here is the same idea taken to its conclusion — a venue that **converts** (a theater that becomes a concert
hall). Different configurations have different seat counts, different section layouts, even different coordinates
for the same physical chair:

```
seats        = VENUE-TIME:  physical seats and coordinates (may exist in only some configs)
venue_config = a named layout ('theater-mode', 'concert-mode') selecting which sections and
               seats are active, and where they sit
event_seats  = EVENT-TIME:  for THIS event, the concrete set of active seats with status,
               price and version. GENERATED from the chosen config at event creation.
```

So `event_seats` is a *snapshot of the layout for that show* — which is what makes one physical venue reusable
across arbitrary configurations with no inventory collisions.

The indexes that make Scene 3 and Scene 4 fast:

```sql
CREATE INDEX idx_event_seats_map ON event_seats (event_id, status);
-- A COVERING index, so the seat-map scan is index-only with no random disk fetches:
CREATE INDEX idx_event_seats_cover
   ON event_seats (event_id, seat_id) INCLUDE (status, price_cents);
-- The composite primary key (event_id, seat_id) already co-locates one event's seats
-- and makes a single-seat hold a fast point lookup.
```

And the seat-map query itself is a **range scan over one event**, not 80,000 point lookups:

```sql
SELECT seat_id, status, price_cents FROM event_seats WHERE event_id = 123;
```

### Sharding: chosen for locality, not for balance

**Shard key: `event_id`.** All of event 123's seats live on one shard.

```
shard = hash(event_id) % num_shards

WHY: a multi-seat order (Priya wanted A14 AND B22) stays a SINGLE-SHARD TRANSACTION. You
     never need a distributed transaction to hold N seats in one order. That is worth a lot.

WHAT BREAKS:
  1. HOT SHARD — one mega-event overloads its single shard while others idle.
     Fix: sub-shard THAT event by section, and cap the admitted rate with the waiting room.
  2. CROSS-EVENT QUERIES — "all events at venue X tonight", "this user's bookings across
     events" — now fan out across every shard (scatter-gather). Serve those from the
     separate read model (Scene 3), not from the sharded inventory DB.
```

| Shard key | Pro | Con |
|---|---|---|
| **`event_id`** (recommended) | Multi-seat order = one transaction; natural isolation | Hot shard for a mega-event |
| `seat_id` / hash(seat) | Perfectly even spread | Multi-seat order spans shards → distributed transaction. Avoid. |
| `venue_id` | Co-locates a venue's events | Popular venues get hot; uneven |

The trade, named: **transaction locality vs load balance.** You deliberately accept the hot-shard risk (and
handle it with section sub-sharding and the queue) because keeping a multi-seat order on one shard is worth far
more than perfectly even load.

### The primary database dies mid-sale

```
Failover:
  1. DETECT   — a health/replication monitor declares the primary down (bounded timeout).
  2. PROMOTE  — a synchronous (or lowest-lag) replica becomes the new primary. Managed HA
                (Patroni, Aurora, Cloud SQL) automates this in seconds to tens of seconds.
  3. REDIRECT — service discovery points writes at the new primary.
  4. FENCE    — kill the old primary (STONITH) so it can never accept a write again.
                Without this you get SPLIT-BRAIN: two "primaries", divergent seat state.

In-flight state:
  - HOLDS live in Redis, not in the failing database → THEY SURVIVE, and keep expiring
    normally. This is the second big payoff of keeping holds out of the primary.
  - Committed BOOKINGS are durable, present on the promoted replica up to its replication point.
  - Writes inside the async-replication gap at the moment of the crash may be LOST → the
    reconciler plus payment idempotency recover them (money ⇒ seat-or-refund, Scene 6).
  - In-flight PAYMENTS: idempotency keys mean a retry after failover does not double-charge.
```

The trade: **RPO vs latency (synchronous vs asynchronous replication).** Synchronous gives RPO ≈ 0 (no lost
writes on failover) but adds latency to every write. Async is fast but can lose the last few writes. For the
payments-adjacent commit of bookings and payments, prefer **synchronous replication** — accept the latency — and
lean on idempotency and reconciliation for any residual gap. Correctness strictly over latency at the money
moment.

### Adding a column to a billion-row table, mid-season

Never `ALTER TABLE` a billion rows in one statement — the exclusive lock is an outage. Use **expand → backfill →
flip → contract**:

```
EXPAND:   add the new column NULLABLE with a default that requires no table rewrite.
          New code writes BOTH columns; reads tolerate NULL in the new one.
BACKFILL: fill it in throttled batches (e.g. 10K rows at a time with sleeps between), to
          protect replication lag and live p99.
          MySQL: gh-ost (GitHub) or pt-online-schema-change (Percona) — copy to a shadow
          table and swap atomically. Postgres: batched UPDATEs + CREATE INDEX CONCURRENTLY.
FLIP:     once the backfill is verified complete, switch reads to the new column.
CONTRACT: stop writing the old column; drop it in a LATER deploy.
```

| Anti-pattern | Why it fails | Do instead |
|---|---|---|
| `ALTER TABLE ... ADD` with a rewrite | Long exclusive lock → sale outage | Nullable add, no rewrite; online tool |
| Backfill in one giant `UPDATE` | Huge transaction, replication lag, lock bloat | Batched, throttled |
| Add an index inline | Blocks writes | `CREATE INDEX CONCURRENTLY` / gh-ost |

The trade: **migration speed vs production safety.** Bigger batches finish sooner and stress replication; throttle
so replica lag and p99 stay inside SLA. A slow safe migration beats a fast one that pages you mid-sale. (GitHub
built and open-sourced **gh-ost** in 2016 precisely for this; Percona's `pt-online-schema-change` predates it and
solves the same class of problem with triggers. Naming one — *and why* — is a strong operations signal.)

### The incident: a bad deploy confirmed 2,000 seats without charging

Discovered four hours later.

```
1. STOP THE BLEEDING (minutes)
   - Roll back / disable the bad deploy (feature flag or previous image).
   - Halt ticket delivery for the affected window if you can.

2. QUANTIFY the blast radius
   - SELECT bookings WHERE status=CONFIRMED AND there is no matching CAPTURED payment,
     within the 4-hour window → exactly those 2,000.
   - This query is only possible because bookings and payments are reconcilable by
     payment_ref. Design for it before you need it.

3. REMEDIATE
   - Per booking: attempt to collect payment (re-charge with consent) OR cancel + notify.
   - Decide by policy: if the event is imminent, HONOR it and eat the cost. Brand > revenue.
   - Reconcile inventory: cancelled seats return to AVAILABLE.

4. COMMUNICATE proactively. Nobody should discover this at the gate.

5. PREVENT
   - Enforce the invariant in code AND as a CONTINUOUS RECONCILER: a booking may be
     CONFIRMED only if a CAPTURED payment exists.
   - Add a canary/integration test asserting that a confirm without a capture FAILS.
```

The systemic fix is the same *money ⇒ seat-or-refund* invariant from Scene 6, now enforced as **monitoring**
rather than only as code — so the next occurrence is caught in **minutes, not hours**.

### What goes on the dashboard, and why

```
hold_expiration_rate = holds_expired / holds_created        (abandonment health)
conversion_rate      = bookings_confirmed / holds_created   (funnel health)
overbooking_attempts = guarded confirms that returned 0 rows
hold_latency_p99, confirm_latency_p99                       (write-path SLA)
db_pool_utilization, redis_hit_rate                         (saturation)
```

```promql
# Conversion collapsing during a sale = checkout is failing downstream:
rate(bookings_confirmed_total[5m]) / rate(holds_created_total[5m]) < 0.3

# A surge in expirations = people are getting holds but cannot complete:
rate(holds_expired_total[5m]) / rate(holds_created_total[5m]) > 0.6
```

| Panel | Healthy | Alert when |
|---|---|---|
| Hold expiration rate | Steady baseline | Sudden surge — checkout is failing |
| Hold → book conversion | High during a sale | Collapses — payment or inventory problem |
| Double-books prevented | ≈ the expected loser count | Spikes — a bug or an attack |
| Write-path p99 | < 500 ms | Over SLA — this also throttles admission |
| DB pool / Redis hit rate | < 70% / high | Saturating |

And here is the loop that closes the whole story: **these are the same signals that drive the waiting room's
admission thermostat in Scene 2.** The numbers you alert on are the numbers that decide how fast people are let
in. Monitoring is not a bolt-on; it is part of the control system.

### A New York fan buying a London show

One paper signup sheet for a popular class, but students can enter the building through the front, side, or back
door. Photocopy the sheet and put a copy at each door, and two students at different doors both write their name
on "the last spot." Chaos. The safe rule: keep the **one real sheet at one door.** Copies at the other doors are
fine for *reading* ("is the class full?") — nobody signs a copy.

| Approach | How | Consistency | Cost |
|---|---|---|---|
| **Single home region per event** (recommended) | Each event has one authoritative region (London show → EU region). All *writes* route there; every region gets read replicas | Strong for writes — one writer | A cross-region round trip on writes for distant users (illustratively tens of ms) |
| Region-partitioned allocation | Pre-allocate seat blocks per region (30% to the US pool); each region writes its own block locally | Strong within a block; no global contention | Wasteful — one region sells out while another sits on unsold blocks; rebalancing is hard |
| Globally-distributed strong DB | Spanner / CockroachDB, synchronous cross-region consensus | Strong globally | Highest write latency — a cross-region quorum on every write |
| Multi-master + async replication | Every region writes locally, replicate later | Eventual → **can double-book** | **Unacceptable.** Off the table. |

The recommendation: **home-region authority.** Browse and seat map from local replicas everywhere (fast, and
allowed to be stale). Hold and confirm routed to the home region, so the per-seat mutex keeps exactly one owner.
Priya in New York pays a cross-region round trip **on the write only**; every read they do is local.

The trade is the CAP reality: you can have low-latency local writes *or* globally consistent writes, not both.
For zero overbooking you **must** choose consistency — and you minimize the cost by putting the authority near
the demand.

### Dynamic pricing, in full

```
1. Pricing service: price = f(demand, remaining inventory, time, tier). Publishes updates;
   must be low-latency and cache-friendly.
2. Seat-map read path: prices now change → shorter cache TTLs, and push price deltas
   alongside status deltas over the SAME WebSocket channel from Scene 3.
3. Hold step: SNAPSHOT price_cents into the hold record. Priya pays what she was quoted.
4. Payment: charge the LOCKED price; the confirm validates the charge equals the snapshot
   and rejects any drift.
5. Audit: log every price change — consumer trust, disputes, and possibly regulation.
```

New consistency problems it introduces, and their fixes:

- Priya sees $200, the price jumps to $250 before she holds → **lock the price at hold; honor the quote for the
  hold window.**
- Two users see different prices for the same seat mid-update → whoever holds first locks their price. The mutex
  still guarantees one owner; **pricing rides on top of it**, it does not complicate it.
- The charge amount must equal the locked price → pass the locked amount plus the idempotency key; reject drift.
- Rapid swings are a trust and possibly consumer-protection issue → bound the rate of change, log everything.

The trade: **revenue optimization vs price consistency and trust.**

### Priya calls support to upgrade to better seats

Cancel 4 seats, book 4 new ones. The one thing that must never happen: **Priya ends up with zero seats.**

```
WRONG order — release, then acquire:
   release the old 4 → [crash] → Priya has NOTHING, and her old seats may already be gone.

RIGHT order — ACQUIRE the new before RELEASING the old:
  1. HOLD the 4 new seats (SET NX). If ANY fails → abort. She keeps her old seats. No loss.
  2. In ONE database transaction (or a saga with compensation):
       BEGIN;
         UPDATE event_seats SET status='BOOKED', booking_id=:newB
           WHERE seat IN (:new4) AND status='HELD' AND hold_id IN (:newHolds);
         -- assert exactly 4 rows; otherwise ROLLBACK (someone took one) → keep the old seats
         UPDATE event_seats SET status='AVAILABLE', booking_id=NULL
           WHERE seat IN (:old4) AND booking_id=:oldB;
       COMMIT;
  3. Charge or refund the price difference — idempotently, saga-compensated.
```

| Order of operations | Worst-case outcome |
|---|---|
| Release old → acquire new | Priya ends with **zero** seats. Unsafe. |
| **Acquire new → release old** | Priya keeps her **old** seats. Safe. |

If the new seats are on a **different shard** than the old (which happens if they are for a different event), you
cannot use one transaction — drop to a saga, and if the release step fails the user still holds valid seats. The
generalizable principle, and it is the last big idea in this file:

> **When you cannot be atomic, choose the *safe* failure direction.**

The invariant to state: at every intermediate state, the user holds at least one valid set of seats.

↳ *Sources: Q31, Q33, Q35, Q36, Q37, Q38, Q41, Q42, B1, B3 · A31, A33, A35–A38, A41, A42, AB1, AB3 · deep-dive §8, §9, Redundancy appendix*

---

## The whole thing in twelve sentences

Close the file. Say these from memory.

1. A seat is a **unique** thing, so unlike a shopping cart it can never be oversold — correctness is required at
   the *instant* you say "confirmed," not eventually.
2. **Looking and taking are two different systems**: ~95% of traffic is cacheable browsing that is allowed to be
   stale, ~5% is claims that must hit the one place holding the truth.
3. "Don't oversell" is **one atomic instruction**, not a rule in a document — check-and-claim must be a single
   indivisible step, because the gap between a separate check and claim *is* the bug.
4. A **hold is not a booking** (temporary and fine to lose, vs durable and paid) and a **hold is not a lock**
   (a 10-minute database lock would pin one connection per open cart and destroy the pool).
5. So a hold is `SET seat NX PX 600000` in Redis: claim-if-absent plus a 10-minute expiry in one command, and
   abandonment cleans itself up with no cron job.
6. Losing every hold in a Redis crash is **annoying, not incorrect**, because seats simply revert to available —
   a state the durable database always agreed with.
7. Therefore the overbooking guarantee **does not live in Redis.** It lives in one guarded `UPDATE ... WHERE
   status='HELD' AND hold_id=:mine` — 1 row means you own the chair, 0 rows means you don't, and there is no
   third answer.
8. Optimistic locking wins when conflicts are rare and **degrades worse than pessimistic** when everybody fights
   over one row; watch the conflict rate and switch that row to a serialized path above roughly 20%.
9. You **cannot put a card charge inside a database transaction**, so the flow is a saga with a compensation for
   every step, an idempotency key so a double-click is one charge, and the invariant *money captured ⇒ eventually
   a booking or a refund.*
10. At sale open, the **arrival rate is not the admitted rate**: a stateless edge waiting room hands out signed
    positions and drips people through at the rate inventory can actually absorb, with bots filtered *before*
    they ever touch seats.
11. The **ticket is a downstream projection** of the confirmed booking — a signed, opaque, time-bounded token the
    gate can verify offline with a cached public key, minted once and delivered on every retry.
12. Everywhere you cannot be atomic, **choose the safe failure direction**: keep the old seats, refund the late
    payment, reject the doubtful buyer. You would always rather annoy one user than seat two people in one chair.

## If you catch yourself saying this, here is what breaks

| What you said | What breaks | What to say instead |
|---|---|---|
| "Check if it's free, then mark it held" | The gap between the two is the race → double booking | One atomic compare-and-set |
| "Lock the row for the checkout" | One connection + row lock per open cart → pool exhaustion | Redis TTL hold; a database lock only for the short commit |
| "Redis guarantees no double booking" | GC pause, clock skew, lost lock → double booking | The guarded database confirm, fenced. Redis is the fast path. |
| "Use optimistic locking everywhere" | ~100% conflict on one hot row → retry storm, throughput collapse | Pessimistic lock, serialized worker, or atomic `DECR` for hot rows |
| "Charge the card inside the transaction" | An external call cannot be rolled back | Saga + idempotency + outbox + reconciler |
| "It timed out, so retry the charge" | Double charge | Same idempotency key, or query the status |
| "Just let everyone hit the database at 10am" | Thundering herd → cascade (Ticketmaster 2022) | Waiting room + closed-loop admission |
| "Show the cached availability count and let them buy from it" | A stale read authorizes a taken seat | Cache the display; re-validate the claim against the truth |
| "Put the booking id in the QR" | Forgeable, enumerable, unverifiable offline | A signed, opaque, time-bounded token |
| "Email them a new QR if they lose it" | Two working credentials for one seat | Bump the generation and revoke `(ticket_id, gen)` |
| "Let every region write its own copy of inventory" | Concurrent regional writes → double booking | Home-region write authority + local read replicas |
| "Push the seat map to every client on change" | 80,000 states × every connection | Per-section subscriptions, versioned deltas |
| "`ALTER TABLE` it during the quiet hours" | A long exclusive lock on a billion rows | expand → backfill → flip → contract (gh-ost / pt-osc) |

## Where to go next

| You want | Read |
|---|---|
| To test whether you actually know it | [questions.md](./questions.md) — attempt all 53 before looking |
| The exact code, commands, and comparison tables | [answers.md](./answers.md) |
| Capacity math, failure modes, and the architect tier | [deep-dive.md](./deep-dive.md) |
| Something to draw on a whiteboard | [diagrams.md](./diagrams.md) — start with Diagram 1 |
| The one-screen mental model | [simple-diagram.md](./simple-diagram.md) |
