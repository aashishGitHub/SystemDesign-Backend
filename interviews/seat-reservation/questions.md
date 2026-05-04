# Interview Questions: Seat Reservation System (Ticketmaster)

> Attempt each question before reading [answers.md](./answers.md).
> Work level-by-level — later questions assume earlier concepts.
> Time yourself: 3–5 minutes per question, 15–20 minutes for architect-level questions.

---

## Level 1 — Fundamentals & Requirements
*Who: Validates shared vocabulary and problem framing before any design work.*

**Q1.** What is the single hardest constraint in a seat reservation system — and why does it make this fundamentally different from designing a shopping cart?

**Q2.** A PM says "just show the number of available seats on the event page." What three questions do you ask before deciding whether to read that number from a cache or the primary database?

**Q3.** Define the difference between a seat **hold** and a seat **booking**. What triggers each, and what happens if the hold expires before the booking is confirmed?

**Q4.** What does "overbooking prevention" require at the systems level? Describe it in terms of concurrency primitives, not business rules.

**Q5.** List the read-heavy operations and the write-heavy operations in a seat reservation system. Why does this split matter for architecture?

---

## Level 2 — Seat Hold Mechanics
*Who: Mid-level engineers — understand the Redis TTL pattern and its failure modes.*

**Q6.** A user selects seat A14 in Row 3, Section B. Describe step-by-step what happens in the system from the moment they click "Select Seat" to when they see the checkout timer start.

**Q7.** Why is Redis the right store for managing seat holds rather than the primary relational database? What specific Redis properties make it suitable?

**Q8.** Write the Redis commands to atomically hold seat `event:123:seat:A14` for user `user:456` with a 10-minute TTL. What happens if the seat is already held?

**Q9.** The user's 10-minute hold expires. List every side effect your system must produce — not just "release the seat."

**Q10.** A user holds seat A14, their browser crashes, and they return 8 minutes later. They see their seat still held (2 minutes remain). Now they try to add seat B22 to the same order. Walk through the hold logic for the second seat.

**Q11.** A Redis node crashes while 50,000 seats are held. What happens if you use a single Redis instance? What changes if you use Redis Cluster or Redis Sentinel? What changes if you use RedLock?

---

## Level 3 — Concurrency & Locking
*Who: Senior engineers — this is where most candidates lose points.*

**Q12.** Two users simultaneously select seat A14. Both requests arrive at the same microsecond. Describe the race condition and exactly how each locking strategy resolves it:
- (a) Pessimistic locking with `SELECT FOR UPDATE`
- (b) Optimistic locking with a version column
- (c) Redis `SETNX`-based atomic hold

**Q13.** When should you use pessimistic locking vs optimistic locking in a seat reservation system? Give a concrete rule, not a vague "it depends."

**Q14.** What is the "lost update" problem in the context of seat reservation? Show SQL that reproduces it and SQL that prevents it.

**Q15.** You use optimistic locking for seat confirmation. Under what traffic conditions does optimistic locking *degrade worse* than pessimistic locking? What is the metric you watch to detect this?

**Q16.** A seat is held in Redis but the database still shows it as `AVAILABLE`. A read replica returns the old `AVAILABLE` state. A second user sees this stale data and tries to hold the seat. What prevents the double-booking? Walk through the exact sequence.

**Q17. (Failure mode)** Your seat-hold service loses network connectivity to Redis for 30 seconds during a high-demand sale. Describe two different failure strategies (fail-open vs fail-closed) and the business consequences of each.

---

## Level 4 — Payment Flow & ACID Transactions
*Who: Senior engineers — correctness under payment failure.*

**Q18.** Sketch the ACID transaction boundary for confirming a seat booking. What operations must be inside the same transaction? What happens if payment succeeds but the database write fails?

**Q19.** A user double-clicks the "Pay Now" button and two payment requests hit your server simultaneously. How do you prevent charging the card twice? Write the idempotency key construction logic.

**Q20.** Your payment service (Stripe, Braintree) accepts the charge but your booking service crashes before writing the `CONFIRMED` status to the database. The user's card was charged. What does your recovery flow look like?

**Q21.** Design the saga pattern for the seat booking transaction: seat hold → payment charge → booking confirmation → ticket issuance. What is the compensating transaction for each step?

**Q22.** The payment provider returns HTTP 408 (timeout). You don't know if the charge went through. How do you handle this case without double-charging the user?

**Q23. (Failure mode)** A user's hold expires at exactly the same millisecond that their payment is being processed by the payment provider. The hold TTL fires in Redis and releases the seat. Another user immediately holds that seat. Payment then completes for the first user. Both users now think they own seat A14. Describe your prevention strategy.

---

## Level 5 — Flash Sale Handling & Thundering Herd
*Who: Senior / Staff engineers — architecture under extreme load.*

**Q24.** It is 9:59:58 AM. Taylor Swift tickets go on sale at 10:00:00 AM. You have 150,000 users with the page open, all ready to click "Buy." Describe what happens to your system at 10:00:00 AM with a naive architecture (no queue, direct DB access).

**Q25.** What is a virtual queue (waiting room) and how does it prevent the thundering herd problem at ticket sale open time? Draw the architecture.

**Q26.** How do you assign fair, tamper-proof queue positions to 150,000 users who all arrive within the same second? What data structure and algorithm do you use?

**Q27.** A user in the virtual queue closes their browser tab and comes back 20 minutes later. Their queue position was #4,200 and they would have been admitted 15 minutes ago. What does your system do?

**Q28.** How do you set the admission rate for the virtual queue? What signals do you use to dynamically throttle or increase the rate? Give specific metrics and thresholds.

**Q29. (Failure mode)** During the Taylor Swift sale, bots exhaust your virtual queue token pool by claiming positions faster than real users. Describe your bot mitigation strategy at the waiting room layer. Reference what Ticketmaster got wrong in 2022.

**Q30.** After the virtual queue admits users, the seat inventory service still receives 5,000 concurrent "hold seat" requests per second. How do you scale the inventory service horizontally while maintaining the no-overbooking guarantee?

---

## Level 6 — Database Design
*Who: Senior engineers — schema, indexing, sharding.*

**Q31.** Design the database schema for the venue → section → row → seat hierarchy. Include all tables, columns, primary keys, and foreign keys. What indexes are required for the seat selection query?

**Q32.** The `seats` table for a single event has 80,000 rows. A seat map query must return all seats with their status (AVAILABLE / HELD / SOLD) within 200ms. What does the query look like, and how do you index and cache it?

**Q33.** How do you shard the seat inventory database across multiple nodes? What is the shard key, and what query pattern breaks with that sharding strategy?

**Q34.** Event browsing (search by artist, city, date) and seat booking (read/write on specific seat rows) have completely different access patterns. How do you separate the data stores for each, and what consistency trade-off does that introduce?

---

## Level 7 — Operations & Failure Modes
*Who: Staff engineers — production reliability under Murphy's Law.*

**Q35.** Your booking service deploys a bad version that marks seats as CONFIRMED without charging payment. You discover this 4 hours later. 2,000 seats have been confirmed without payment. What is your incident response plan?

**Q36.** You need to roll out a schema migration (adding a column to the `seats` table with 1 billion rows) without downtime. Describe your migration strategy.

**Q37. (Failure mode)** The primary database for seat inventory goes down during the Taylor Swift sale. Describe your failover procedure. What happens to in-flight holds and payments?

**Q38.** How do you monitor seat hold expiration rate, seat conversion rate (hold → booked), and overbooking attempts in real time? What dashboards and alerts do you set up?

---

## Level 8 — Architect-Level Questions
*Who: Staff / Principal engineers — system-wide tradeoffs and design review depth.*

**Q39.** A staff engineer proposes replacing the Redis hold layer with a Zookeeper-based distributed lock. Argue for or against this proposal with specific technical reasons and production data points.

**Q40.** Ticketmaster's 2022 Taylor Swift incident resulted from not scaling the virtual queue sufficiently and allowing bot traffic into the seat selection layer. Given 6 weeks to redesign the sale flow before the next high-demand event, what are your top 3 architectural changes and why?

**Q41.** You are designing the system to support global events (same event, seats available in multiple regions). How does seat inventory consistency change when users from New York and London can both book seats for a London concert, served from different data center regions?

**Q42.** A product team wants to introduce "dynamic pricing" — seat prices change in real-time based on demand (like airline pricing). What parts of your architecture does this require changing, and what new consistency problems does it introduce?

---

## Bonus — Unprompted Senior Questions
*These are questions a strong candidate raises without being asked. Raising them unprompted is a strong positive signal.*

**B1.** How do you handle the seat map for venues that have variable configurations (a theater that converts to a concert hall changes its seat count and section layout)? This is an event-time vs venue-time schema problem — explain it.

**B2.** Ticket scalping and resale: if you implement seat holds with predictable IDs, a bot can enumerate and hold every available seat and then release them just before expiry to disrupt competitors. What system design change prevents this attack?

**B3.** A user successfully books 4 seats in Section A Row 5 but then calls customer support to upgrade to better seats. The upgrade involves canceling 4 seats and booking 4 new ones. How do you make this atomic so the user never ends up with no seats due to a partial failure mid-swap?
