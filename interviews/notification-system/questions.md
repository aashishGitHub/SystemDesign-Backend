# Interview Questions: Notification System (Push, Email, SMS)

> Attempt each question before reading [answers.md](./answers.md).
> Work level-by-level — later questions assume earlier concepts.

---

## Level 1 — Fundamentals & Requirements
*Who: Juniors and early seniors — verify shared vocabulary before diving into design.*

**Q1.** What are the three most important guarantees a notification system must make? Order them by user impact.

**Q2.** What is the difference between *at-most-once*, *at-least-once*, and *exactly-once* delivery? Which is correct for notifications, and why?

**Q3.** A product manager says "send 50 million promotional emails at 9 AM". What three clarifying questions do you ask before designing anything?

**Q4.** What does "channel" mean in a notification system, and why must each channel have its own delivery pipeline rather than sharing one?

**Q5.** What is the difference between a transactional notification (password reset, OTP) and a marketing notification? Why does this distinction affect architecture?

---

## Level 2 — Channel Architecture (Push, Email, SMS)
*Who: Mid-level engineers — understand each channel's external constraints.*

**Q6.** Explain the role of APNs (Apple Push Notification service) and FCM (Firebase Cloud Messaging) in mobile push delivery. What does your system send to them?

**Q7.** What happens when a user's device is offline when a push notification arrives at APNs/FCM? What TTL behavior should your system configure?

**Q8.** SMS delivery has a hard per-second limit with most providers (e.g., Twilio: 1 SMS/sec per long code). How do you handle a burst of 100K OTP SMSes in 10 seconds?

**Q9.** Email sending has per-day volume quotas and domain reputation. What goes wrong if you send 10 million cold emails from a single domain on day 1, and how do you prevent it?

**Q10.** What is the difference between email *delivery* (accepted by receiving MTA) and email *open* (user actually opened it)? Which metric matters for a notification audit trail?

---

## Level 3 — Core Pipeline Design
*Who: Senior engineers — design the end-to-end write and dispatch paths.*

**Q11.** Draw the high-level components of a notification system from API call to channel dispatch. Name each component and its responsibility. Where do load balancers sit, and why don't the dispatch workers need one?

**Q12.** Why should notification ingestion (accepting the request) be decoupled from dispatch (calling the provider) with a message queue in between?

**Q13.** What schema should a normalized notification record contain? List the fields and explain why each is required.

**Q14.** What is a "notification template" and why is rendering (merging template + user data) done at dispatch time rather than at creation time for bulk sends?

**Q15.** How does a routing service decide which channel(s) to use for a given notification? What user-level data does it need to read?

---

## Level 4 — Fan-out and Bulk Targeting
*Who: Senior engineers — handle bulk sends without killing the database.*

**Q16.** A campaign targets "all users who made a purchase in the last 30 days" — potentially 20 million users. Explain the fan-out pattern your system uses to turn this into per-user notifications without doing it synchronously in the API path.

**Q17.** What is the difference between *push fan-out* (write to each user's inbox at send time) and *pull fan-out* (let users fetch their notifications on demand)? When do you use each for notifications?

**Q18.** During fan-out, you write 20 million notification records to a database. What write amplification problems occur and how do you mitigate them?

**Q19.** How do you ensure a bulk campaign sends to each target user exactly once, even if the fan-out job crashes halfway through and restarts?

**Q20.** What is a "send window" for promotional notifications and why must your fan-out respect user time zones?

---

## Level 5 — Delivery Guarantees & Idempotency
*Who: Senior engineers — correctness under failure.*

**Q21.** Your dispatch worker crashes after calling Twilio but before updating the DB status to "sent". On restart, it retries and calls Twilio again. How do you prevent the user from receiving two identical SMS messages?

**Q22.** What is an idempotency key in the context of notification dispatch? What fields form a good idempotency key?

**Q23.** A push notification is delivered to APNs successfully (HTTP 200) but the user never receives it. What could explain this, and what should your system log?

**Q24.** What is a dead-letter queue, and what three categories of failures should route to it rather than being retried endlessly?

**Q25.** How do you implement a retry strategy with exponential backoff + jitter for failed notification sends? Write the backoff formula.

---

## Level 6 — Priority, Rate Control & User Preferences
*Who: Senior / Staff engineers — multi-tenant fairness and compliance.*

**Q26.** How do you implement a two-tier priority system (critical vs promotional) in a single notification pipeline? What guarantees does each tier get?

**Q27.** A single user receives 50 push notifications in 5 minutes from different features. What per-user notification rate cap do you enforce, and where in the pipeline do you enforce it?

**Q28.** A user has set quiet hours (10 PM – 8 AM in their local time zone). A critical OTP notification arrives at 11 PM. What does your system do?

**Q29.** GDPR / CAN-SPAM require that users can unsubscribe from marketing emails. Where in the pipeline is the unsubscribe check enforced, and why must it be close to dispatch rather than at ingestion?

**Q30.** How do you implement per-product, per-channel notification preferences so a user can say "only send me Uber Eats promotions via email, not push"?

---

## Level 7 — Failure Modes & Observability
*Who: Staff engineers — production-grade reliability.*

**Q31.** Your primary SMS provider (Twilio) goes down. Walk through your fallback strategy. What triggers the failover and what does the dispatch worker do differently?

**Q32.** Your notification system is the first to detect that a downstream email provider is rate-limiting you (HTTP 429). How do you propagate this signal to all workers to back off without each worker independently hammering the provider?

**Q33.** What four SLO metrics would you define for a notification system, and what alert expressions would page on-call?

**Q34.** A user complains they received the same marketing notification 3 times. Describe the complete investigation path: what logs you check, what state you query, and the likely root causes.

**Q35.** How do you test notification delivery in production without spamming real users? What infrastructure does your testing strategy require?

---

## Level 8 — Scale & Multi-Region Architecture
*Who: Staff / Principal engineers — capacity math and global design.*

**Q36.** Your system needs to handle 1M notifications/second. Walk through the capacity math: how many queue partitions, how many dispatch workers per channel, and how much database write throughput do you need?

**Q37.** You operate in US, EU, and APAC regions. A notification for a user in Germany should be dispatched from the EU region. How does your routing layer achieve this, and what data must be region-local vs globally consistent?

**Q38.** During a flash sale, notification volume spikes 10x in 30 seconds. How does your system absorb the spike without dropping notifications or overwhelming downstream providers?

**Q39.** Your notification database grows by 50 million rows/day. After 90 days you have 4.5 billion rows. How do you partition and archive this data while keeping recent-notification queries fast?

**Q40.** A large customer wants a dedicated notification pipeline (SLA-isolated from other tenants). How do you architect multi-tenancy with optional dedicated dispatch workers?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** "Before we finalize the design, how are we instrumenting notification funnel drop-off? We need to know at which exact stage — enqueued, dispatched, provider-accepted, device-delivered — messages are being lost."

**QB2.** "For email, what's our warm-up strategy for new sending domains? We can't just start sending 10M emails/day from a fresh IP — ISPs will blacklist us."

**QB3.** "What's our notification deduplication window? If a user clicks a link and triggers a push and email simultaneously, do we collapse them, and over what time horizon?"

**QB4.** "Have we designed for notification shadowing — the ability to run a new dispatch path alongside the old one and compare outputs before cutting over? That's how Meta rolls out notification system changes safely."
