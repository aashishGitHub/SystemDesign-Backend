# Notification System — Answers in Plain English

> This file rewrites every answer from [answers.md](./answers.md) as complete, connected sentences.
> Read this when you want to *understand*, not just recall. Read answers.md when you want to *review*.
> Every section ends with a "So, the connection is..." sentence that links it to the next concept.

---

## Level 1 — Fundamentals & Requirements

### A1. The three guarantees, ordered by user impact

When you are designing a notification system, the first thing you need to establish is what promises you are making to the user. There are three core guarantees, and their order of importance matters because they inform every architectural decision you will make.

**Delivery comes first.** A notification that never reaches the user is completely worthless, regardless of how fast or relevant it would have been. When an OTP for a login attempt never arrives, the user cannot log in. When a fraud alert is silently dropped, the user's account may be compromised. This is the most critical guarantee because its failure is visible and immediately harmful.

**Timeliness comes second.** A notification that arrives two minutes after an OTP expires is functionally the same as a notification that was never delivered — it has zero value. The distinction between "critical" and "promotional" notifications exists precisely because of timeliness: a critical OTP must arrive within seconds, while a promotional offer can arrive in minutes or even hours without meaningfully harming the user experience.

**Relevance comes third.** Sending a notification to a user who has opted out is not just annoying — under GDPR and CAN-SPAM it is a legal violation. User preferences, quiet hours, and per-channel opt-outs must all be respected. However, relevance ranks below delivery and timeliness because a relevant notification that never arrives is still a failed notification.

*So, the connection is:* these three guarantees directly determine your pipeline design. Delivery → you need durable queues with retries. Timeliness → you need separate priority lanes. Relevance → you need a preference check just before dispatch.

---

### A2. Delivery semantics — why at-least-once is the right choice

There are three possible delivery contracts in any distributed messaging system, and understanding the tradeoffs between them is essential before you can choose one for a notification system.

**At-most-once** means you fire the notification once and never retry. If the call to Twilio times out, the message is lost forever. This is completely unacceptable for critical notifications like OTPs or security alerts because a dropped message directly harms the user.

**Exactly-once** sounds ideal, but it is practically impossible in a distributed system without expensive distributed transactions across your system and the provider (Twilio, SendGrid, APNs). You cannot make Twilio's network call and your database status update atomic — they are two separate systems. Anyone who claims to implement truly exactly-once delivery across external providers is either wrong or is paying a very high latency and complexity cost.

**At-least-once** is the correct answer. You retry until you get an acknowledgment, which means in failure scenarios a notification might be sent twice. The key insight is that you solve the "twice" problem separately, through idempotency, rather than trying to prevent retries entirely. This separation of concerns — "retry freely, deduplicate at the provider" — is what makes the system both reliable and practical.

*So, the connection is:* choosing at-least-once commits you to building idempotency keys (A22) and understanding how provider-side deduplication works. Those two concepts exist only because of this choice.

---

### A3. Three clarifying questions before designing a bulk send

When an interviewer or product manager says "send 50 million promotional emails at 9 AM," a senior engineer should not immediately start designing. Instead, three questions must be answered first because the answers fundamentally change the architecture.

The first question is about **recipient count and selection criteria**. "All users who made a purchase in the last 30 days" vs "all users globally" is a difference of potentially 10x in scale. More importantly, whether the cohort is pre-materialized (a static list) or dynamically queried (a live DB query) determines whether you need a fan-out worker that pages through the database or a system that reads from a pre-built audience segment file. Getting this wrong means either building the wrong fan-out architecture or underestimating DB load.

The second question is about **delivery window and time-zone sensitivity**. "9 AM" for a US-only campaign means a single UTC time. "9 AM in the user's local time zone" for a global campaign means a 26-hour delivery window (GMT-12 to GMT+14), and you need to schedule fan-out batches by UTC offset. This also has quiet-hours compliance implications: sending at 9 AM UTC to a user in Tokyo means delivering at 6 PM local time — acceptable. But if you miscalculate DST transitions you might deliver at 2 AM instead.

The third question is about **priority tier**. If this is a marketing blast, it must sit behind critical notifications in the queue and must honor unsubscribes. If it is a transactional alert (e.g., a billing notification legally required by contract), it may bypass marketing preferences entirely. Mixing these up means either violating user preferences or failing legal obligations.

*So, the connection is:* all three answers directly feed into the fan-out design (A16), the send-window scheduling (A20), and the routing logic (A15).

---

### A4. Why each channel needs its own separate pipeline

The single most common architectural mistake in a notification system is using one shared queue or one shared set of workers for push, email, and SMS. Understanding *why* this is wrong requires understanding the constraints of each external provider.

Mobile push via APNs and FCM communicates over persistent HTTP/2 connections. These connections must be maintained continuously, and the provider has strict limits on how many messages you can send per connection per second. If your push workers are also handling email, a backlog of email jobs (perhaps caused by a SendGrid rate-limit) will starve your push workers, delaying critical alerts to users.

Email via SendGrid or AWS SES has per-day sending quotas tied to your domain and IP reputation. If you exceed these, the provider starts throttling or bouncing messages. More importantly, if email workers are shared with SMS workers, a burst of SMS traffic (e.g., 100K OTP requests in 10 seconds) will cause email processing to stop — including important transactional emails like password resets.

SMS via Twilio is the most constrained of all: it has a strict per-second limit per number type, and each SMS costs money. You want fine-grained control over the rate at which SMS messages go out, completely independent of how fast you are sending emails or pushes.

By giving each channel its own queue and its own pool of workers, you gain three things: independent scaling (you can add more SMS workers without touching push workers), independent failure isolation (a SendGrid outage doesn't block APNs delivery), and independent rate limiting (you can throttle SMS at 500/sec without affecting email throughput).

*So, the connection is:* this is why the core pipeline design (A11) shows three separate queues, and why the priority system (A26) applies per-channel, not globally.

---

### A5. Transactional vs marketing notifications — why the distinction shapes your entire system

Transactional notifications and marketing notifications look similar on the surface — both are messages sent to users — but they differ in almost every dimension that matters for system design.

A transactional notification is something the user implicitly agreed to receive as part of using the service: an OTP for login, a password reset link, a shipping confirmation. Because the user has a service relationship with you, no explicit marketing consent is required. More importantly, these notifications *must* be sent — if a user cannot receive their OTP, they cannot log in. This means transactional notifications can never be blocked by a marketing unsubscribe, can never be delayed by quiet hours, and must be processed from a high-priority queue.

A marketing notification is something you are choosing to send to drive engagement or revenue: a discount offer, a "we miss you" re-engagement message, a product recommendation. Users must explicitly opt in (or in some jurisdictions, you must give them a clear way to opt out). These can be delayed, throttled, and dropped if the user is unreachable. They go through a bulk fan-out pipeline that processes them asynchronously, potentially hours after creation.

The architectural implication is significant: transactional notifications bypass the fan-out stage entirely. They target exactly one user, are enqueued directly to the channel queue with high priority, and are dispatched as fast as the provider allows. Marketing notifications always go through a campaign fan-out worker that slowly expands them from one "send to cohort X" job into millions of individual per-user jobs.

*So, the connection is:* this distinction drives the two-queue design (A26), the fan-out pattern (A16), and is why quiet hours only apply to promotional notifications (A28).

---

## Level 2 — Channel Architecture

### A6. What APNs and FCM actually do — and what your system is responsible for

A common misconception about mobile push notifications is that your server sends the message directly to the user's device. This is not how it works, and understanding the actual flow is critical for designing the system correctly.

Your server sends a JSON payload to Apple's APNs service (for iOS devices) or Google's FCM service (for Android and web). Both of these are maintained by Apple and Google respectively, and they hold a persistent, always-on connection to every active device running their mobile operating systems. When you send a payload to APNs, Apple's infrastructure takes responsibility for delivering it to the device — your involvement ends at the APNs API call.

This matters because it means your system's reliability guarantee ends at the APNs/FCM call. If APNs returns HTTP 200, you have successfully transferred the message to Apple's infrastructure. Whether it actually reaches the device (device is online, notifications are enabled, app is installed) is outside your control. This is why logging the APNs response code, the request ID, and the device token is so important — it's the evidence boundary between "your system's problem" and "Apple's problem."

The payload your server sends must include the device token (an opaque string that APNs/FCM uses to identify the specific app installation on the specific device), the alert content (title and body), and a TTL (how long to store the notification if the device is offline). The device token is obtained by the mobile app at startup and sent to your backend — it is not stable and will change if the user reinstalls the app or resets their device.

*So, the connection is:* understanding that APNs/FCM are intermediaries explains why token staleness (A23) is a problem, and why your TTL configuration (A7) matters for offline users.

---

### A7. Offline devices and TTL — the silent notification killer

When a user's device is offline (airplane mode, dead battery, no signal), APNs and FCM do not immediately discard your notification. Instead, they store it in their infrastructure and attempt delivery when the device reconnects. The crucial variable is the TTL (Time To Live) you configured on the notification — if the device comes back online after the TTL has expired, the notification is silently discarded with no error reported to your server.

This creates a subtle correctness problem that many engineers miss. For an OTP notification, you might set a TTL of 60 seconds because the code expires in 90 seconds anyway. If the user's device is offline for 2 minutes and then reconnects, APNs correctly discards the notification because there is no point delivering an expired OTP — delivering it would confuse the user. This is the right behavior, but your system needs to log the TTL you sent so that when a user reports "I never got my OTP," your on-call engineer can see "the notification was sent with TTL=60, the device was offline, and the TTL expired before reconnection."

For critical alerts (fraud warnings, account security notifications), use a TTL of 86400 seconds (24 hours). These notifications are still useful if delivered hours later because the underlying situation may not have resolved. For promotional notifications, match the TTL to your campaign's expiry window — if a "50% off today only" campaign expires at midnight, your push TTL should also expire at midnight.

The important operational habit is: always log the TTL you configure alongside the APNs request ID. This is your evidence for debugging the common "I never received the notification" complaint.

*So, the connection is:* TTL configuration directly feeds into the expiry-check logic at dispatch time (A25) — you check `expires_at` before sending, and you configure the provider TTL to match it.

---

### A8. SMS burst handling — the rate-limit math you must know

When a product team asks you to send 100,000 OTP SMS messages within 10 seconds, your first response should be to do the math to determine whether your current provider configuration can actually support this.

Twilio's long codes (standard 10-digit phone numbers) are limited to approximately 1 SMS per second per number due to carrier regulations designed to prevent spam. If you only have one long code, you can send at most 1 message per second — which means 100,000 messages would take over 27 hours, completely defeating the purpose of an OTP. Short codes (5-6 digit numbers) support roughly 100 messages per second, which means you would need 100 of them to handle 100,000 SMS in 10 seconds. Toll-free numbers are limited to about 3 per second, which is even worse.

The practical solution for high-volume SMS is to use Twilio's Messaging Service with a pool of short codes (carrier-registered A2P 10DLC numbers), which can support several hundred messages per second for a registered campaign. You also need a rate-limited dispatch queue: rather than firing all 100,000 messages simultaneously (which would exceed any provider's limits and cause mass failures), you fill the queue with all 100,000 jobs and configure the workers to drain it at exactly the provisioned rate.

The most important constraint to bake into your design is: OTP SMS messages must have a TTL in the queue. If a message sits in the queue for 5 minutes because of rate limiting and the OTP code has already expired, sending it anyway is actively harmful — the user will enter the code and get an "invalid OTP" error. Your dispatch worker must check the message's `expires_at` field before every attempt, not just at initial enqueue time.

*So, the connection is:* SMS rate-limit handling directly motivates why the dispatch queue (A11) needs per-channel separation with per-channel rate controls, and why the expiry check at dispatch (A24) is non-negotiable.

---

### A9. Email domain warm-up — the invisible reputation problem

If you are starting a new email sending domain or IP address and immediately send millions of emails, you will find that most of them silently land in spam or are blocked entirely. This is not a deliverability bug — it is the ISP ecosystem's spam defense mechanism working exactly as designed.

ISPs like Gmail, Outlook, and Yahoo! maintain reputation scores for every sending IP and domain. A brand-new IP or domain has no reputation history, which means ISPs treat it as high-risk. When millions of emails suddenly arrive from a new source, spam filters flag the volume spike as a potential spam campaign and begin routing messages to the spam folder. If your bounce rate or spam-complaint rate exceeds roughly 0.5%, the ISP may place your entire domain on a temporary or permanent blocklist.

The solution is a warm-up schedule: you start by sending a small number of emails on day one (500 is a common starting point), then double the volume approximately every day or every few days, gradually building your domain's reputation over 4-6 weeks. The key insight is that ISPs are watching for consistent, non-spammy sending patterns. As long as your recipients are engaged (opening emails, not marking them as spam), your reputation score improves and the ISPs allow progressively higher volume.

A critical operational rule is to keep your transactional email (OTPs, password resets, billing confirmations) on a completely separate IP and subdomain from your marketing email. The reason is risk isolation: if your marketing campaign generates a spike in spam complaints and gets your marketing domain blacklisted, your transactional emails must continue to work. Using `mail.yourcompany.com` for transactional and `promo.yourcompany.com` for marketing ensures that a marketing incident cannot block a user's ability to reset their password.

*So, the connection is:* the warm-up constraint explains why "just send to everyone immediately" is impossible, and it feeds directly into the fan-out rate controls (A16) — you cannot fan out faster than your email domain can handle.

---

### A10. Delivery vs open tracking — what you can actually trust

When you send an email via SendGrid or SES, there are multiple events that can be tracked, but they are not equally reliable and they do not all mean the same thing. Misunderstanding this is a common source of incorrect product analytics.

**Delivery** means the recipient's mail server (Gmail's servers, Outlook's servers) accepted the email. This is recorded via a webhook from SendGrid when the receiving MTA returns a `2xx` SMTP response. This event is highly reliable and is the correct event to use for audit trails — it proves the message left your system and was accepted by the destination.

**Open** tracking works by embedding a 1x1 invisible pixel image in the email body. When the user's email client loads images, it makes an HTTP request to your server to fetch the pixel, which you record as an "open." However, as of iOS 15 (2021), Apple Mail's Privacy Protection feature pre-fetches all images in the background before the user opens the email — which means your open rate for Apple Mail users is inflated with "fake" opens. Gmail also caches images through its own proxy. As a result, the "opened" event is increasingly unreliable as a proxy for user engagement.

**Clicked** tracking works by rewriting all links in the email to go through your redirect server, which logs the click and then redirects to the original URL. This is more reliable than open tracking because it requires an actual deliberate user action, though users with link preview software can also generate false positives.

For a notification system's audit trail, the answer is clear: log **delivery** (accepted by MTA). Never use "opened" as confirmation that a time-sensitive message was received — a user who says "I never got my password reset email" might have Apple Mail pre-fetching that made your system think it was "opened," when in reality the user's email app never rendered it.

*So, the connection is:* the gap between "delivered to MTA" and "seen by user" explains why the push notification delivery mystery (A23) has multiple possible root causes even when APNs returns HTTP 200.

---

## Level 3 — Core Pipeline Design

### A11. The high-level components and why each one exists

The notification system is composed of several distinct services, each with a single responsibility. Understanding why each component exists — not just what it does — is what interviewers are actually probing for.

**The API layer** accepts incoming requests from internal services ("send an OTP to user 123") and from campaign management tools ("launch campaign C47 targeting premium users"). Its job is to validate, authenticate, and immediately return a response to the caller. It does not wait for the notification to be delivered — that would couple the caller's latency to Twilio's network latency, which is unacceptable.

**The Notification Service** is responsible for enriching the raw request with the information needed for routing — assigning priority (critical vs promotional), resolving the user's registered channels, and writing a durable notification record to the database before anything else happens. Writing to the database first is the durability guarantee: even if the service crashes immediately afterward, the notification is not lost.

**The Router / Fan-out Service** is what turns a single campaign job into millions of per-user notification jobs. For single-user sends (transactional), it simply resolves which channels to use and enqueues the job. For campaign sends, it pages through the target cohort in batches, creating one per-user job per channel per user. This service is the most CPU and I/O intensive part of the write path.

**Per-channel queues** (one for push, one for email, one for SMS) serve as the durability boundary and the back-pressure mechanism. They absorb traffic spikes, provide guaranteed delivery semantics, and enable independent scaling of each channel's workers. A queue full of SMS jobs does not slow down push delivery.

**Dispatch workers** are the only component that actually calls an external provider. They consume jobs from the channel queue, render the notification template with the user's data, check the user's current preferences (to catch late opt-outs), verify the notification hasn't expired, call the provider API, and update the notification status.

**The Webhook Handler** receives asynchronous delivery receipts from providers (SendGrid sends a webhook when an email is delivered; APNs sends error callbacks for bad device tokens). It updates the notification status and handles cleanup like invalidating stale device tokens.

**A word on load balancers.** The system has two sync HTTP surfaces — the API layer and the Webhook Handler — and both need a real load balancer (AWS ALB, GCP HTTPS Load Balancer) in front of their pod pools. The API layer is where internal callers push notification requests; the Webhook Handler is where external providers (Twilio, SendGrid, APNs) push delivery callbacks. Both are stateless HTTP servers receiving inbound connections, so a traditional Layer 7 load balancer distributes traffic across horizontally scaled pod replicas. The dispatch workers, by contrast, need no load balancer at all. They are Kafka consumers — they pull work from queue partitions rather than receiving pushed connections. When the worker fleet scales up or down, Kafka's consumer group protocol automatically rebalances partition assignments across the available pods. The queue itself is the work distributor.

*So, the connection is:* every component boundary exists because of a specific failure mode. Remove the queue → provider latency blocks the API. Remove the webhook handler → you never learn about bad device tokens. Remove the notification service's DB-write-first approach → crashes silently lose notifications.

---

### A12. Why the queue between ingestion and dispatch is mandatory

The most fundamental architectural decision in a notification system is decoupling the moment a notification is accepted (ingestion) from the moment it is actually sent (dispatch). Many engineers understand this intellectually but struggle to articulate precisely why it is necessary. There are four distinct reasons.

**Provider latency isolation:** When you call Twilio or SendGrid, the network call can take anywhere from 50 milliseconds to 5 seconds, depending on their infrastructure health. If dispatch happened synchronously in the API handler, every internal service that wanted to send a notification would need to wait for Twilio to respond before getting an HTTP 200 back. A Twilio degradation would make your entire notification API appear degraded to internal callers.

**Traffic spike absorption:** When a major event triggers millions of notifications simultaneously (a flash sale launch, a breaking news alert), the notification ingestion rate can spike 100x in seconds. The queue absorbs this spike — ingestion writes at the spike rate, while workers drain at the sustainable provider rate. Without the queue, the spike either overloads your dispatch workers (causing failures) or overloads the provider (triggering rate limiting and 429s).

**Durability on worker failure:** Dispatch workers process one notification at a time and acknowledge the queue message only after the provider call succeeds. If a worker crashes mid-dispatch, the queue message is not acknowledged and becomes visible again for another worker to claim. Without the queue, an in-flight notification being processed by a crashed worker would be silently lost.

**Retry without re-exposing the caller:** Retry logic belongs inside the worker loop, not in the API caller. With a queue, a failed dispatch simply re-enqueues the job with a visibility delay. The original API caller that triggered the notification hours ago doesn't need to know anything about the retry. Without the queue, the caller would need to implement its own retry logic, which creates a distributed retry storm every time a provider has a brief outage.

*So, the connection is:* the queue is what makes the at-least-once guarantee (A2) achievable at scale. Without the queue, retrying without blocking callers is impossible.

---

### A13. The notification record schema — why every field exists

The notification record is the central data structure of the system, and every field in it serves a specific purpose in the delivery state machine. Leaving out fields is not an optimization — it is removing your ability to debug production incidents.

The **`id`** is a UUID generated at ingestion time and serves as the primary idempotency key for the entire notification's lifetime. If the same notification is accidentally enqueued twice (due to a retry at the API layer), the database's unique constraint on this ID prevents double-processing.

The **`expires_at`** field is checked at the beginning of every dispatch attempt. If the notification has expired (e.g., an OTP that was valid for 90 seconds but has been in the queue for 2 minutes due to a backlog), the worker marks it as expired and moves on rather than delivering a useless message to the user. This is why the field must be nullable (critical alerts don't expire) rather than defaulting to some arbitrary value.

The **`status`** field implements the state machine (`queued → dispatching → dispatched → delivered`). The transition from `queued` to `dispatching` is done with an atomic `UPDATE ... WHERE status='queued'` — this prevents two workers from claiming the same notification simultaneously. The transition to `dispatching` happens before the provider call; the transition to `dispatched` happens after. A notification stuck in `dispatching` for more than 30 seconds is evidence of a crashed worker and triggers the recovery process.

The **`provider_message_id`** (e.g., Twilio's SID, SendGrid's message ID) is the single most important field for post-dispatch debugging. If your worker calls Twilio successfully and then crashes before updating the database, you need the Twilio SID to query Twilio's API and confirm whether the message was actually delivered. Without it, you cannot distinguish "crashed before the call" from "crashed after the call" — which means you cannot safely retry.

*So, the connection is:* the schema is not just a data model. It is the operational instrument panel. Every missing field is a blind spot in a future production incident.

---

### A14. Rendering at dispatch, not at creation — the storage math

When you design a notification campaign for 20 million users, one of the first questions you face is: when do you render the personalized message body? "Dear {{user_name}}, you have {{item_count}} items in your cart" must eventually become "Dear Aashish, you have 3 items in your cart" for each user. The question is when.

**Rendering at creation time** means that when the campaign is created, your system immediately makes 20 million API calls to the user profile service, fetches each user's name and cart count, renders the message body, and stores 20 million rendered strings. At 1 KB per rendered message, that is 20 GB of storage per campaign. If you run 5 campaigns per day, that's 100 GB of rendered content per day that is mostly redundant (most of the text is identical across users). Additionally, if the campaign is scheduled to deliver 2 hours from now, the user might change their cart in that window — the rendered content would be stale.

**Rendering at dispatch time** means you store only the template ID and the keys needed to fetch the personalized variables (`user_id: 123`). Each dispatch worker fetches the current user data and renders the message in the 50ms before calling the provider. This has three advantages: storage drops from 20 GB to about 200 KB per campaign (just the template + user IDs), rendered content is always current at the moment of delivery, and the rendering load is distributed across your dispatch worker fleet (which you already need to scale for dispatch anyway) rather than requiring a separate rendering cluster during campaign creation.

The only downside of rendering at dispatch is that a slow user profile service increases dispatch latency. This is solved by caching user profile data for personalization fields (user name, locale, preferences) with a short TTL.

*So, the connection is:* render-at-dispatch is only possible because of the queue architecture (A12). Without the queue, dispatch happens inline with creation, making render-at-creation unavoidable.

---

### A15. How the routing service decides where to send

The routing service is the component that takes "send this notification to user 123" and answers "via which channel(s)?". It needs to combine four different types of information to make the correct decision.

First, it checks **channel availability** — does user 123 actually have a valid FCM device token? A verified email address? A confirmed phone number? A user who has never installed the mobile app cannot receive push notifications. A user who registered with a fake phone number cannot receive SMS. Routing to an unavailable channel wastes a dispatch worker's time and produces a provider error.

Second, it checks **channel freshness** — is the FCM token still valid? Device tokens become stale when a user uninstalls the app, reinstalls it, or resets their device. A token that hasn't been used in 90 days is probably stale. Rather than always discovering staleness at dispatch time (when APNs returns a `BadDeviceToken` error), the routing service can proactively skip channels with very old tokens.

Third, it checks **user preferences** — has user 123 opted out of email marketing? Set up push-only delivery for this product category? Agreed to receive SMS? For critical notifications, preferences are ignored (you always send an OTP regardless of marketing opt-out status). For promotional notifications, the routing service filters to only the channels the user has explicitly permitted for this category.

Fourth, it applies **priority rules** — critical notifications are routed to all available channels simultaneously (or in a fallback sequence), while promotional notifications might be sent to only the cheapest/most preferred channel.

*So, the connection is:* routing is the last "read" step before notifications enter the dispatch pipeline. Everything after routing is about getting the message out; routing is about making the correct policy decision about whether and how to get it out.

---

## Level 4 — Fan-out and Bulk Targeting

### A16. The async fan-out pattern — how one job becomes 20 million

When a campaign manager creates a new notification campaign targeting "all premium users who haven't logged in for 30 days," they are creating a job that might need to notify 20 million individual users. The critical insight is that this expansion from one campaign record to 20 million notification jobs must happen asynchronously, in the background, and in a way that is restartable if it crashes partway through.

The pattern works like this: the API accepts the campaign creation request, writes a single campaign record to the database with a status of "pending," enqueues one fan-out job to the fan-out queue, and immediately returns a `202 Accepted` response to the caller. The caller does not wait. From the caller's perspective, the campaign was accepted. The actual work happens in the background.

The fan-out worker picks up that single job and begins paging through the target user population in batches of 1,000. For each batch, it creates 1,000 individual notification jobs and pushes them to the appropriate channel queue. After each batch, it saves a checkpoint — the last processed user ID — back to the campaign record. This checkpoint is the key to making the fan-out restartable: if the worker crashes after processing 5 million users, the next worker that picks up the job reads the checkpoint and resumes from user 5,000,001 rather than starting over from zero.

The checkpoint combined with a unique database constraint on `(campaign_id, user_id)` gives you both restart safety and duplicate protection. Even if the checkpoint wasn't saved perfectly and the worker re-processes a batch it already handled, the database constraint rejects the duplicate insert — so the user only ends up in the dispatch queue once.

*So, the connection is:* the fan-out pattern's reliance on checkpointing is why the notification record schema (A13) needs a `campaign_id` field, and why the unique constraint on `(campaign_id, user_id)` is non-negotiable for correctness.

---

### A17. Push fan-out vs pull fan-out — knowing when each applies

These two terms are used in slightly different ways depending on context, so it is important to be precise about which problem each one solves.

**Push fan-out** in the context of notification delivery means that when a campaign is created, you immediately write a per-user notification job for every recipient. The expansion happens at write time. The advantage is that dispatch can begin immediately as soon as jobs are in the queue. The disadvantage is that you generate a write spike at the moment the campaign is created, and if the campaign is later cancelled, you have already done a lot of unnecessary work.

**Pull fan-out** in the context of an in-app notification feed means that you do not pre-write per-user records. Instead, you store the campaign once, and when a user loads their notification feed in the app, your read service queries which campaigns are relevant to that user and renders them on demand. The advantage is no write amplification at campaign creation time. The disadvantage is that every feed read becomes a query that must check campaign targeting rules, which gets expensive at scale.

The practical answer for a notification system that sends push, email, and SMS is: you always use push fan-out for channel delivery because you must call an external provider per user regardless — there is no way to "pull" a Twilio call. Pull fan-out is only relevant for in-app notification feeds (like the bell icon in the top right of a website), where users pull their notifications from your server. If your system only needs to send push/email/SMS, pull fan-out is irrelevant to your design.

*So, the connection is:* this distinction clarifies where the fan-out worker (A16) fits in the system. It applies to channel delivery, not in-app feeds.

---

### A18. Write amplification during fan-out — and how to mitigate it

A campaign targeting 20 million users means 20 million database writes in a short window. This is a significant stress test for any database, and if your schema or infrastructure isn't designed for it, the fan-out will either take hours or will degrade the database for all other traffic simultaneously.

The first mitigation is **choosing a write-optimized store**. A traditional relational database like PostgreSQL is optimized for mixed read/write workloads with strong consistency guarantees. For 20 million writes in a fan-out, you want a store like Cassandra or DynamoDB, which is specifically designed for high-throughput append operations. These systems use LSM (Log-Structured Merge) trees internally, which turn random writes into sequential disk writes — far more efficient at high volume.

The second mitigation is **partitioning strategy**. If your notification table has a `created_at` index and you insert 20 million rows with the same timestamp, all inserts land on the same B-tree page, causing severe contention (a "hot partition"). Shard by `user_id % N` instead — this spreads inserts across N different storage partitions, eliminating the hot-write bottleneck.

The third mitigation is **batch inserts**. Rather than doing 20 million individual SQL inserts, your fan-out worker should batch them into groups of 100-500 rows per insert statement. Most databases handle `INSERT INTO ... VALUES (...), (...), (...)` far more efficiently than 1,000 individual inserts because the overhead of parsing, planning, and committing a transaction is paid once per batch rather than once per row.

*So, the connection is:* write amplification is also why the notification table needs a partitioning and archival strategy (A39) — 20 million rows per campaign × 5 campaigns per day = 100 million rows per day, which must be rotated out to cold storage.

---

### A19. Making fan-out restartable — idempotency under failure

A fan-out job processing 20 million users will take somewhere between 5 and 30 minutes depending on your database and worker speed. In that window, your worker process could crash for any number of reasons: a deploy, an OOM kill, a network partition. Without a restart strategy, you either re-process everything from the beginning (causing duplicate sends) or give up (causing a partial campaign).

The solution has two parts working together. The first part is **checkpointing**: after every batch of 1,000 users, the worker writes the last successfully processed user ID back to the campaign record. This checkpoint is the resume point. On restart, the new worker reads the checkpoint and queries `WHERE user_id > checkpoint_user_id`, skipping all users already processed. The checkpoint write is cheap (one row update) and happens every 1,000 users — in the worst case, a crash causes at most 999 users to be re-processed.

The second part is the **unique database constraint** on `(campaign_id, user_id)`. Even with perfect checkpointing, there is a race condition: what if the worker saved the checkpoint but the commit for the notification inserts failed? The re-processing would try to insert the same `(campaign_id, user_id)` pairs again. The unique constraint rejects these duplicate inserts at the database level — the worker sees a constraint violation error, logs it, and continues. The user is not enqueued twice.

These two mechanisms together mean the fan-out is *idempotent*: you can re-run it as many times as needed, and the end result is always exactly one per-user notification job in the queue for each target user.

*So, the connection is:* this checkpoint-plus-constraint pattern is the fan-out equivalent of the idempotency key pattern used at the provider dispatch level (A22). Both solve the same problem — safe retries — at different stages of the pipeline.

---

### A20. Send windows and time zones — the scheduling complexity

When a promotional campaign specifies "deliver at 9 AM in the user's local time zone," you have taken on a distributed scheduling problem that spans 26 time zones and requires understanding the difference between UTC offsets and IANA time zones.

The naive implementation — scheduling all messages for 9 AM UTC — delivers messages at completely different local times for users around the world (9 AM UTC is 2:30 PM in India and 1 AM in San Francisco). The correct implementation uses each user's stored IANA time zone (e.g., `America/Los_Angeles`) to compute the correct UTC delivery time for that specific user.

The fan-out worker does this by computing a `visible_after` timestamp for each notification job: the queue message is placed in the queue immediately but becomes visible to workers only at the calculated UTC delivery time. This uses the message queue's scheduled delivery feature (Kafka doesn't support this natively, but SQS, Pub/Sub, and most managed queues do — for Kafka you would use a time-indexed database as a scheduler).

The critical implementation detail is using IANA time zones rather than raw UTC offsets. UTC offsets change with Daylight Saving Time transitions. A user in `America/New_York` is UTC-5 in winter and UTC-4 in summer. If you store `-5` as their offset and compute delivery time during daylight saving time, you deliver an hour late. Storing `America/New_York` and using a proper time zone library (like `date-fns-tz` or Java's `ZoneId`) handles DST transitions automatically.

*So, the connection is:* scheduled delivery for time zones requires the queue to support delayed message visibility. This is one of the reasons managed queues (SQS, Pub/Sub) are often preferred over raw Kafka for notification dispatch — Kafka requires an additional delay-queue implementation.

---

## Level 5 — Delivery Guarantees & Idempotency

### A21. Preventing duplicate SMS after a worker crash — the outbox pattern

The hardest correctness problem in a notification dispatch system is the scenario where a worker successfully calls Twilio (the SMS is sent) but then crashes before it can update the database to record that it was sent. On restart or when another worker picks up the same job, it will see the notification status as `queued` and call Twilio again — sending the user two identical SMS messages.

The outbox pattern solves this by making the status transition itself the indicator of work in progress. Before calling Twilio, the worker atomically transitions the notification from `queued` to `dispatching` using a SQL update that only succeeds if the current status is `queued`. This atomic claim ensures only one worker is processing the notification at a time. The `dispatching` state is the "work in progress" flag.

After the Twilio call succeeds, the worker writes the Twilio SID (the provider's message identifier) to the notification record and transitions the status to `dispatched`. The critical detail is that the Twilio SID must be logged to the database *even if the subsequent status update fails* — because the SID is your recovery key.

If the worker crashes after calling Twilio but before completing the database update, a recovery process (a background job that runs every 30 seconds) finds all notifications stuck in `dispatching` for more than 30 seconds. For each one, if a Twilio SID was recorded, the recovery process calls the Twilio API to check the actual delivery status of that SID. If Twilio confirms the message was delivered, the recovery process marks it `dispatched`. If Twilio has no record of the SID (the call never completed), the recovery process transitions back to `queued` for retry — this time using the same idempotency key so Twilio deduplicates on their side if needed.

*So, the connection is:* the outbox pattern works in conjunction with the idempotency key (A22) to provide the complete at-least-once + no-duplicate guarantee. The outbox handles crashes; the idempotency key handles the retry after recovery.

---

### A22. Idempotency keys — what they are and how to construct them correctly

An idempotency key is a unique string that you attach to a provider API call to tell the provider: "if you see this key twice, it means I am retrying a call you may have already processed — please return the same result without doing the work again." Provider-side idempotency is the mechanism that makes retrying safe from the user's perspective.

The construction of the key matters more than it might seem. A common mistake is to use `notification_id + attempt_number` as the key. This is wrong because each retry gets a different key, which means the provider processes all of them as new requests. The user receives one SMS per retry. The correct approach is to use a key derived from the logical identity of the notification — something like `hash(campaign_id + user_id + channel)` — which is stable across all retry attempts. Every retry for the same logical notification uses the same key.

The provider's deduplication window is also important. Twilio deduplicates identical idempotency keys for up to 4 hours. SendGrid provides similar protection. This means that if you retry a notification 4 hours and 1 minute after the first attempt, the idempotency key has expired and the provider will process it as a new request. For DLQ replays (where a notification might be retried days later), you should use `notification_id` alone as the key — stable forever, with no attempt counter — rather than including a timestamp or attempt counter.

*So, the connection is:* the idempotency key is the provider-side complement to the outbox pattern (A21). The outbox handles your internal state consistency; the idempotency key handles the provider's state. Together, they make the entire end-to-end at-least-once delivery safe from duplicates.

---

### A23. Push notification sent to APNs successfully but never received — root cause analysis

One of the trickiest support tickets in a notification system is: "The user says they didn't receive their push notification, but our logs show APNs returned HTTP 200." A HTTP 200 from APNs does not mean the user received the notification — it means APNs accepted it into their infrastructure. There are five distinct root causes for the gap between those two events.

**Stale device token:** The user reinstalled the app since the token was registered. APNs would return `BadDeviceToken` (not HTTP 200) in this case, so if you're seeing HTTP 200, this is probably not the cause. However, if you're seeing HTTP 410 (Gone) on earlier attempts that were retried, this is it. The fix is to invalidate the token in your database immediately upon receiving this error.

**Unregistered token (app uninstalled):** APNs returns `Unregistered` when the app has been uninstalled from the device. The fix is the same: remove the token from your database so future notifications don't waste a provider call.

**User disabled push permissions at the OS level:** This is the invisible case. The user went to Settings → Notifications → Your App and turned off notifications. APNs still returns HTTP 200 because it accepted the payload and attempted delivery. The device receives the payload but the OS drops it silently because the user disabled notifications. There is no feedback from APNs. The only way to detect this is to look at the long-term pattern: a user who has disabled notifications will have a delivery rate of 0% over the past N days.

**Device offline past the TTL:** APNs stored the notification but the device came back online after the TTL expired. APNs discarded the notification silently. This is why you log the TTL you sent — when debugging, you can correlate the device's last-active timestamp with the notification's TTL to confirm this was the cause.

**App handled the notification internally:** Some apps, when they are in the foreground, intercept the push notification and handle it without displaying an OS-level banner. The notification was delivered but not "shown" in the traditional sense. This is expected behavior, not a bug.

*So, the connection is:* these five root causes all require different fixes at different layers. Token staleness is fixed in the webhook handler (A11). TTL mismatch is fixed in the routing layer (A7). Permission disabling is a UX problem, not a system problem.

---

### A24. Dead-letter queues — when to stop retrying

Exponential backoff with retries is the right strategy for transient failures. But there are specific categories of failures where retrying is not just unhelpful — it is actively wasteful or harmful. Recognizing these cases and routing them to a dead-letter queue (DLQ) rather than back to the main queue is a critical operational practice.

The first category is **permanent provider rejection**. When APNs returns `BadDeviceToken` or `Unregistered`, retrying will produce exactly the same error. The token is invalid. There is nothing your system can do to fix this through retrying. The correct action is to immediately invalidate the token in your database (so future notifications for this user don't waste provider calls) and record a `failed` status on the notification. Putting this in the DLQ gives your on-call team visibility into the volume of stale tokens, which is a signal that your token refresh mechanism may need attention.

The second category is **expired TTL**. If a notification's `expires_at` timestamp has passed, sending it is harmful. An OTP that expired 5 minutes ago should not be delivered — the user would enter the code, get an "invalid OTP" error, and be confused and frustrated. Your dispatch worker should check `expires_at` at the beginning of every attempt and route expired notifications to the DLQ rather than discarding them silently. The DLQ preserves the record for auditing without delivering the stale content.

The third category is **max retries exceeded**. After a configurable number of attempts (typically 5-10 for most notification types), you must accept that the delivery failed and stop trying. Continued retrying consumes worker capacity, wastes money on provider API calls, and provides no benefit to the user. Moving to the DLQ with a `max_retries_exceeded` reason triggers an alert that signals systemic provider issues worth investigating.

*So, the connection is:* the DLQ is the final state in the notification status machine, and DLQ depth is one of the four SLOs you should monitor (A33). A rising DLQ is the early warning signal for provider health issues.

---

### A25. Exponential backoff with jitter — preventing the thundering herd

When a provider like SendGrid has a brief 30-second outage, hundreds of your dispatch workers will simultaneously start failing on their API calls. Without a carefully designed retry strategy, all of those workers will retry at the same time — either immediately, or at exactly the same future time — causing a "thundering herd" that overwhelms the provider the moment it comes back online, causing another failure, causing another simultaneous retry, and so on.

**Exponential backoff** alone solves the "retry immediately" problem by increasing the wait time with each failed attempt: wait 1 second after the first failure, 2 seconds after the second, 4 seconds after the third, and so on. This gives the provider time to recover before your next attempt. The maximum backoff is capped (typically at 5 minutes) to prevent notifications from waiting an unreasonably long time.

**Jitter** solves the "all workers retry at exactly the same time" problem. Even with exponential backoff, if all 500 workers are on their third retry and are waiting exactly 4 seconds, they will all retry at the exact same millisecond. Jitter adds a random multiplier: instead of waiting exactly 4 seconds, each worker waits a random amount between 0 and 4 seconds. The retry attempts spread out over the 4-second window rather than spiking at one point, giving the provider a smooth ramp-up of traffic rather than an instant 500-request spike.

The formula `delay = random() * min(cap, base * 2^attempt)` combines both: the base delay doubles with each attempt, but the actual delay is a random fraction of that maximum. This is called "full jitter" and is the industry standard.

The critical operational detail is: always check `expires_at` before each retry, not just before the first attempt. A notification that was valid when it was enqueued might be expired by the time the 5th retry fires.

*So, the connection is:* the thundering herd problem during provider recovery is the same pattern as the coordinated 429 backoff (A32) — both require workers to share state about when it's safe to retry, rather than each making independent decisions.

---

## Level 6 — Priority, Rate Control & User Preferences

### A26. The two-tier priority system — how to guarantee critical notifications are never delayed by promotional ones

The most common operational failure in a notification system that doesn't use priority queues is this: a marketing team launches a large campaign targeting 50 million users at the same time that a fraud detection system is trying to send security alerts. The fraud alerts sit behind 50 million promotional messages in a single shared queue and arrive 20 minutes late — after the user's account has been compromised.

The solution is strict queue separation with dedicated worker pools. Critical notifications go into `notifications.critical`, promotional notifications go into `notifications.promotional`. These are separate Kafka topics (or separate queues in any queue technology you choose) with completely separate consumer groups. Critical consumers never read from the promotional queue, and promotional consumers never read from the critical queue.

The worker allocation ratio matters: 80% of your dispatch worker fleet should be permanently assigned to the critical queue, with 20% on the promotional queue. During a crisis (provider outage, traffic spike), you can dynamically re-assign promotional workers to the critical queue. The reverse should never happen — you should never sacrifice critical notification capacity to speed up a marketing campaign.

The monitoring is also different for each tier. The critical queue should alert if depth exceeds 1,000 messages (which at normal throughput should drain in seconds — a depth of 1,000 signals something is wrong). The promotional queue can tolerate depths of millions during large campaigns and should only alert if it has been growing without draining for an extended period.

*So, the connection is:* the two-tier system is what makes the "critical notifications bypass all user preferences and rate caps" rule (A28) operationally enforceable. If both tiers share a queue, there is no mechanism to prioritize one over the other.

---

### A27. Per-user notification rate cap — preventing notification fatigue

Even with the best intentions, a user receiving 50 push notifications in 5 minutes from different features of your platform will disable push notifications entirely — and once disabled, they are gone as a push channel forever. Protecting the per-user notification rate is not just a UX courtesy; it is a long-term retention strategy for your notification channel health.

The implementation uses Redis as a sliding counter. The key is structured as `notif:cap:{userId}:{channel}:{dayBucket}` — which means a separate counter per user, per channel (push/email/SMS), per day. When a notification is about to be routed, the routing service calls `INCR` on this key and checks if the count has exceeded the daily cap. If it has, the promotional notification is silently dropped (with a log entry — never silently without any trace). The Redis key has a 24-hour TTL set on first increment, so counters automatically reset each day.

The "silently dropped" behavior for promotional notifications is correct. If you returned an error to the caller instead, every internal service that wants to send a notification would need to handle "user is at cap" as a business logic error rather than a system error — which creates ugly error handling throughout your codebase. The routing service is the right place to absorb this decision.

Critical notifications must bypass the rate cap entirely. An OTP must be sent even if the user has already received 50 notifications today. Applying the rate cap to critical notifications would be a safety and security failure.

*So, the connection is:* the per-user rate cap is checked in the routing layer (A15), before the notification is enqueued into the channel queue. Once a notification is in the channel queue, it is committed to be sent.

---

### A28. Quiet hours with critical override — the policy that can never be wrong

Quiet hours are a user preference that says "don't notify me between 10 PM and 8 AM." Implementing this correctly requires getting two things right: how to enforce it, and when to override it.

The enforcement mechanism is not to reject the notification but to **delay** it. When the routing service detects that the current time falls within the user's quiet window, it calculates the UTC time at which the user's quiet period ends (e.g., 8 AM in their IANA time zone) and schedules the notification job with a `visible_after` timestamp set to that time. The notification sits in the queue and becomes visible to workers at exactly 8 AM local time. This means a user who gets a promotional notification at 9 PM will receive it at 8:00 AM the next morning — which is fine for marketing purposes.

The critical override is non-negotiable and applies to all critical notifications without exception. An OTP for a login attempt is needed right now, not at 8 AM tomorrow. A fraud alert should wake the user if necessary. A security code for account recovery cannot wait 8 hours. Any notification with `priority: 'critical'` bypasses the quiet-hours check entirely, regardless of the user's preference.

The subtle implementation detail is using IANA time zones rather than UTC offsets (same reason as A20). You must store `America/New_York`, not `-5`, to correctly handle DST transitions.

*So, the connection is:* quiet hours are checked in the routing service alongside unsubscribe preferences (A29). Both are "should we send this?" checks that happen before the notification enters the dispatch pipeline.

---

### A29. Where to enforce unsubscribe — dispatch time, not ingestion time

A common mistake is to check whether the user has unsubscribed from email marketing at the moment the notification is created (ingestion time). This seems logical — why create a notification job for someone who won't receive it? The problem is that the user might unsubscribe at any point between when the campaign is created and when the notification is actually dispatched, which could be hours later for a large campaign.

**The correct enforcement point is at dispatch time** — specifically, as the very last check the dispatch worker performs before calling the provider. This is the only check point that guarantees the user's current preferences are respected, regardless of when they changed.

This has three important implications. First, late opt-outs are always honored: a user who unsubscribes 30 minutes into a 4-hour fan-out will not receive the notification when it eventually reaches their turn in the dispatch queue. Second, DLQ replays are always correct: if a notification fails and sits in the DLQ for 24 hours before being replayed, the dispatch-time check reads the user's current preferences — which may have changed since the original failure. Third, it is the correct location for GDPR deletion checks: a user who has requested data deletion will have their account deactivated or deleted in the preferences store, and the dispatch worker checking current preferences will correctly skip them.

A useful mental model: think of the dispatch-time preference check as the last gate on an assembly line. Everything upstream is about getting the notification ready. This gate is the final "is it actually OK to send?" check.

*So, the connection is:* this check reads from the same preference store as the routing check (A15). The routing check is an optimization (why create a job we'll drop at dispatch?), but the dispatch check is the correctness guarantee.

---

### A30. Per-product, per-channel preferences — the data model

User notification preferences are not a simple boolean. In a mature product with multiple sub-products (Uber, Uber Eats, Uber Freight), a user might want "push for my Uber ride updates, email-only for Uber Eats promotions, nothing from Uber Freight." Modeling this requires a hierarchical preference structure.

The preference schema is structured as a nested object: at the top level, a user has global on/off switches for each channel (push, email, SMS). Below that, each product can override the global setting for specific notification categories (transactional, marketing, updates). This hierarchy means that a user turning off all marketing emails at the global level automatically applies to all products, without requiring N product-specific preference writes.

Storing this structure in a relational database works at small scale but becomes a query bottleneck at large scale (a notification for user 123 requires joining across the preferences table for the right product and category). The correct approach is to store the entire preference graph as a JSON blob in a low-latency key-value store (Redis or DynamoDB), keyed by `user_id`. Reads at dispatch time (`GET user_prefs:{userId}`) complete in sub-millisecond times. Writes flow through the primary DynamoDB record and asynchronously invalidate the Redis cache.

The operational risk is cache staleness: if a user unsubscribes and the Redis cache isn't invalidated for 60 seconds, the next 60 seconds of notifications might still be sent. For marketing preferences, a 60-second window is acceptable. For legal-critical preferences (e.g., GDPR consent withdrawal), the TTL should be zero — always read from the authoritative store, not the cache.

*So, the connection is:* the preference model is what the routing check (A15) and the dispatch-time check (A29) both read from. The performance of those checks depends entirely on how efficiently this data is stored and cached.

---

## Level 7 — Failure Modes & Observability

### A31. SMS provider failover — designing for the outage you know will happen

Every external provider will eventually have an outage. Twilio has had multi-hour outages; SendGrid has had deliverability incidents; APNs has had regional degradations. Designing your system as if the primary provider is always available is a latent production incident waiting to happen.

The circuit breaker pattern is the standard mechanism for detecting and responding to provider failures. A circuit breaker wraps every outbound provider call and tracks the error rate over a rolling window. When consecutive failures exceed a threshold (for example, 5 failures in a row), the circuit "opens" — meaning the breaker stops forwarding calls to the provider entirely and immediately returns an error to the caller. Workers receiving this error route the notification to a secondary provider instead.

After a configurable timeout (typically 30 seconds), the circuit moves to a "half-open" state: it allows one probe request through to check if the provider has recovered. If the probe succeeds, the circuit closes and traffic flows normally again. If the probe fails, the circuit reopens and the timeout resets with exponential backoff.

The key design decisions are: what is the failure threshold (too sensitive causes unnecessary failovers; too lenient causes long delays during real outages), what is the fallback provider (you need pre-configured credentials and integration for at least one backup provider), and what happens during the failover period to messages that were already in-flight to the primary provider (they should be requeued with the secondary provider's dispatch tag).

For critical notifications (OTPs), failover must happen within 5 seconds — which means the circuit breaker threshold should be set aggressively (3 failures) and the failover routing should be instantaneous. For promotional notifications, a longer failover window is acceptable — you can queue up SMS messages until the primary recovers.

*So, the connection is:* the circuit breaker is per-channel (not global) because push, email, and SMS use different providers with different reliability profiles. A Twilio outage should not trigger failover for your FCM push delivery.

---

### A32. Coordinating 429 backoff across hundreds of workers

When SendGrid returns `HTTP 429 Too Many Requests`, it is telling you that you are sending faster than your rate limit allows. The `Retry-After` header tells you exactly how long to wait. The naive implementation — each worker independently reads the 429, waits the specified time, and retries — causes a thundering herd at the end of the wait period: all 500 workers retry simultaneously, likely triggering another 429 immediately.

The coordinated approach uses Redis as a shared backoff signal. When any worker receives a 429 from SendGrid, it writes a `backoff_until` timestamp to Redis: `SET sendgrid:backoff_until {currentTime + retryAfterSeconds}`. Before every dispatch attempt, every worker checks this key: if the current time is before `backoff_until`, the worker requeues the job with a visibility delay set to `backoff_until` and moves on without calling SendGrid. Only after `backoff_until` has passed does any worker attempt another call.

The result is that the very first worker to see the 429 effectively communicates "wait until time T" to all other workers through Redis. Workers don't pile up retrying — they schedule their jobs for time T and consume other jobs in the meantime. When time T arrives, jobs become visible and workers resume — but now staggered because the queue processes them one at a time, not all simultaneously.

This pattern works for any kind of temporary provider-level signal that should be shared across your entire worker fleet: rate limits, circuit breaker states, and maintenance windows can all be communicated via a shared Redis key.

*So, the connection is:* coordinated 429 backoff is a specialized instance of the circuit breaker concept (A31). The circuit breaker handles hard failures; 429 coordination handles soft rate-limiting. Both prevent workers from independently making decisions that are correct individually but harmful collectively.

---

### A33. The four SLOs you need for a notification system

An SLO (Service Level Objective) is a measurable commitment about system behavior that, when violated, pages your on-call engineer and demands immediate investigation. For a notification system, four SLOs cover the most important reliability dimensions.

**Critical notification end-to-end P95 latency < 5 seconds** measures the time from when a notification is created to when it is delivered to the provider. This catches queue buildup, worker slowdowns, and provider degradation before users start missing OTPs. P95 (not P99 or average) is the right percentile because you want to catch the long tail without being sensitive to occasional outliers.

**Dispatch error rate < 0.1%** measures the percentage of provider API calls that return 5xx errors. An error rate above 0.1% indicates a systematic provider problem or a configuration issue — not just random noise. This alert fires before users start complaining but after normal noise is filtered.

**Critical DLQ depth < 100 messages** is the most alarming SLO. Any critical notification that has exhausted all retries and landed in the DLQ represents a user who is not receiving time-sensitive information. A DLQ depth above 100 for critical notifications (OTPs, security alerts) warrants immediate investigation regardless of the time of day.

**Fan-out lag < 10 minutes for a 10M-recipient campaign** measures how long it takes for the fan-out worker to expand a large campaign into per-user jobs. If this takes longer than 10 minutes, it means there is a bottleneck in the fan-out path (slow DB queries, write contention) that will cause campaigns to deliver significantly later than scheduled — which is a business problem as much as a technical one.

*So, the connection is:* these four SLOs map directly to the four major failure modes of the system: slow dispatch (latency SLO), provider errors (error rate SLO), delivery failures (DLQ SLO), and slow fan-out (lag SLO). Each SLO has a corresponding component in the architecture.

---

### A34. Debugging duplicate notifications — the investigation path

When a user reports receiving the same notification three times, this is almost always one of three root causes, and the investigation path is the same regardless of which it is.

The first step is to query the notification database for all records associated with that user and that campaign: `SELECT * FROM notifications WHERE user_id = X AND campaign_id = Y`. If you see three distinct rows with different IDs, the fan-out worker created three separate notification records for this user — which means the unique constraint on `(campaign_id, user_id)` is missing or was bypassed. If you see one row with three attempts recorded, the dispatch worker retried three times and each retry actually reached the provider — which means the idempotency key was not being passed correctly or the provider's deduplication window expired.

The second step is to check the dispatch logs for all three send events and compare their idempotency keys. If all three sends used the same idempotency key and the provider still delivered three times, the provider's deduplication is not working (rare, but worth checking the provider's support docs). If all three sends used different idempotency keys (e.g., including the attempt number in the key), that is the root cause — retries should use a stable key, not an attempt-number-based key.

The third step is to check whether the user appears in multiple overlapping audience segments for the campaign. Some campaign systems allow a user to qualify for a campaign through multiple targeting criteria simultaneously (e.g., "users in New York" AND "users who spent over $100" — if the user meets both criteria, the campaign system might fan-out twice). The fix is to deduplicate audience segments before fan-out.

*So, the connection is:* this investigation path is only possible because of the schema decisions in A13 — the `campaign_id`, `attempts`, and `provider_message_id` fields are what make the investigation tractable. Without those fields, the incident is undebuggable.

---

### A35. Testing notification delivery without spamming real users

One of the hardest operational problems in notification systems is: how do you validate that your new dispatch code works correctly without accidentally sending test messages to millions of real users? The answer requires infrastructure that exists alongside your production pipeline.

**Shadow mode** is the most powerful tool: every notification that flows through the production pipeline is simultaneously copied to a shadow pipeline that calls a no-op sink instead of the real provider. The sink logs the notification payload in exactly the format it would be sent to the provider, allowing you to verify the rendered content, routing decisions, and idempotency key construction without any external calls. Shadow mode can be enabled via a feature flag, making it easy to validate new dispatch code paths before enabling them for real traffic.

**Provider sandbox environments** are offered by most providers (Twilio has a test API key, SendGrid has a sandbox mode, APNs has a development environment). Calls to the sandbox behave identically to production calls — they return success responses, generate provider message IDs, and fire webhooks — but no actual messages are delivered. Using the sandbox for automated tests gives you high confidence in your integration code without ever risking delivery to real users.

**Canary user cohorts** are a small group of real users (typically internal employees or opted-in beta testers, 0.1% of total users) who receive notifications through new code paths first. Their feedback and delivery metrics validate that the system works end-to-end in production before rollout to the full user base.

*So, the connection is:* shadow mode in particular requires that the dispatch worker has a routing flag (`dispatch_mode: real | shadow | sandbox`) that is resolvable per-user or per-environment. This is an additional parameter in the routing logic (A15) that must be designed in from the start — retrofitting shadow mode into an existing system is very painful.

---

## Level 8 — Scale & Multi-Region Design

### A36. Capacity math for 1M notifications/sec — working through the numbers

When asked to design a system for 1M notifications/sec, most candidates acknowledge that it's "a lot" and propose scaling horizontally without quantifying how much. Working through the actual math demonstrates senior-level thinking and uncovers the specific bottlenecks.

Start by splitting the 1M/sec across channels based on typical distribution: 70% push (700K/sec), 20% email (200K/sec), 10% SMS (100K/sec). Each channel has different provider throughput limits, which determines the number of workers and queue partitions needed.

For **push notifications**, FCM supports approximately 1,000 requests per second per HTTP/2 connection. To handle 700K push/sec, you need 700 concurrent FCM connections. At 2 connections per worker pod, that's 350 push worker pods.

For **email**, SendGrid's enterprise tier allows approximately 600 API calls per second per API key. To handle 200K emails/sec, you need approximately 333 API keys. Since you don't want 333 separate SendGrid accounts, you use 333 worker pods each with their own API key credential.

For **SMS**, Twilio's 10DLC A2P campaign supports approximately 500 messages/sec per registered campaign. To handle 100K SMS/sec, you need 200 registered campaigns (each assigned to a dedicated worker thread or pool).

For **Kafka partitions**, each partition can handle roughly 50K messages/sec with small notification payloads. The push queue needs 14 partitions (round up to 16 for headroom), the email queue needs 4 (use 8), the SMS queue needs 2 (use 4).

For **database writes**, 1M notification records/sec at 512 bytes each = 512 MB/sec of sustained write I/O — well beyond the capacity of any single relational database instance. This mandates a write-optimized distributed store: Cassandra (3 nodes at 200 MB/sec per node → 6+ nodes) or DynamoDB on-demand capacity.

*So, the connection is:* this capacity math directly determines your Kafka topic partitioning strategy, your worker fleet sizing, and your database technology choice — three of the most consequential architectural decisions.

---

### A37. Multi-region routing — keeping user data in the right geography

For a global notification system, routing is not just about choosing which provider to call — it is about ensuring that a notification for a German user is processed entirely within EU infrastructure, not US infrastructure. This is both a latency optimization and a GDPR legal requirement.

The architecture separates globally consistent data from region-local data. **Region-local data** includes device tokens (registered to a user from their home region), user preferences (stored in the region where the user signed up), and dispatch workers with region-appropriate provider credentials (an EU-region worker uses EU-region FCM endpoints and EU-based SendGrid credentials). This data never leaves its home region.

**Globally consistent data** includes campaign metadata (what template to send, which cohort to target) and the user-to-region mapping (user ID 123 lives in the EU). These are replicated globally because they need to be readable from any region. Campaign creation happens anywhere; the fan-out job routes per-user jobs to the correct regional queue based on the user's home region.

The routing logic for a campaign fan-out is: for each user in the campaign cohort, look up their `home_region`, produce a notification job to the queue of that region (e.g., `notifications.critical.eu-west-1`), and let the EU-based workers process it. The EU workers read from region-local EU DynamoDB, call EU-region APNs/FCM endpoints, and write delivery status back to EU storage. The entire dispatch chain for a EU user runs in EU infrastructure — not just for performance, but for GDPR compliance.

*So, the connection is:* multi-region routing requires the notification record schema (A13) to include a `home_region` field, and the fan-out worker (A16) to be region-aware when producing jobs.

---

### A38. Absorbing 10x traffic spikes — the queue as the shock absorber

A flash sale that drives a 10x notification volume spike in 30 seconds is the stress test that exposes every assumption about your system's scalability. The key insight is that the message queue is specifically designed to absorb spikes — it separates the rate at which notifications are created from the rate at which they are dispatched.

When traffic spikes 10x, your API layer writes to the queue 10x faster than normal. The queue depth grows, but no notifications are dropped. The dispatch workers continue draining at the rate the providers allow. The queue acts as a buffer, and over time (minutes to hours depending on spike magnitude), the backlog drains.

The active scaling response uses KEDA (Kubernetes Event-Driven Autoscaling) or similar tooling to watch the Kafka consumer lag metric and automatically add dispatch workers when lag exceeds a threshold. This is reactive scaling — it kicks in within minutes of the spike and provides additional drainage capacity.

For promotional notifications, intentional delay is acceptable. A "50% off flash sale" notification arriving 3 minutes late is still valuable. During a spike, you can configure promotional workers to drain their queue at a reduced rate, preserving all worker capacity for critical notifications. The promotional backlog clears once the spike subsides.

The provider-side consideration is equally important. If you know a flash sale is planned in advance, contact your provider account manager to pre-negotiate a burst allowance — an agreement that Twilio/SendGrid will allow higher than normal throughput for a defined time window. Without this pre-negotiation, the provider's rate limiting will be the binding constraint regardless of how many workers you have.

*So, the connection is:* the "queue as shock absorber" principle is why the decoupling of ingestion from dispatch (A12) is so valuable. Without the queue, a 10x spike would immediately overwhelm dispatch workers and cause failures — with the queue, it becomes a managed backlog.

---

### A39. Notification table partitioning and archival — managing 100M rows/day

A notification system at scale generates an enormous number of database rows. At 1M notifications/sec, that's 86 billion rows per day — but even at more modest scale (50 notifications/sec), you accumulate 4.3 million rows per day. Without a partitioning and archival strategy, your query performance degrades continuously as the table grows.

**Table partitioning by time** (specifically by week) keeps each physical partition to a manageable size. PostgreSQL's declarative partitioning makes this clean: the `notifications` table is partitioned by `created_at` range, with one partition per week. A query like "find all notifications for user X in the last 7 days" only touches the current and previous week's partitions, not the entire multi-year table history.

**Dropping old partitions** is dramatically faster than running `DELETE FROM notifications WHERE created_at < '2026-01-01'`. Dropping a partition is a metadata operation (milliseconds); deleting old rows from a large table can take hours and generates massive write I/O. A weekly automated job that drops the oldest partition eliminates stale data cleanly and quickly.

**Archiving before dropping** ensures that old notification data is not lost permanently. A weekly Spark job exports the oldest partition to S3 as Parquet files, organized by year/month/day. This gives your data analytics team access to historical notification data for reporting without burdening the production database.

**The compound index** `(user_id, created_at DESC)` within each partition makes the most common query — "show me the 20 most recent notifications for user X" — a fast index scan on a small partition rather than a full table scan.

*So, the connection is:* partitioning is the long-term complement to the write-optimized store (A18). The write-optimized store handles the ingestion rate; partitioning handles the accumulation over time.

---

### A40. Multi-tenant architecture with optional dedicated dispatch workers

A notification platform that serves multiple products or multiple enterprise customers faces a tenancy design challenge: how do you ensure that one tenant's high-volume campaign doesn't degrade notification delivery for all other tenants?

The answer is a tiered isolation model with three levels of separation.

**Soft isolation** (the default for all tenants) means all tenants share the same Kafka topics and the same worker pools. Fairness is enforced through the priority queue system (A26) and per-tenant rate caps. One tenant's 10-million-user campaign doesn't block another tenant's OTPs because OTPs are on the critical queue and campaigns are on the promotional queue. This works for most tenants most of the time.

**Medium isolation** is for enterprise customers who have SLA requirements. They get a dedicated consumer group on the shared Kafka topic, which means their jobs are processed by a dedicated pool of workers that scale independently. A large campaign from another tenant that saturates the shared worker pool doesn't affect this tenant's dedicated workers. The Kafka brokers are still shared (cheaper to operate), but the processing is isolated.

**Hard isolation** is for regulated industries (healthcare, finance) where data from one tenant must never touch infrastructure shared with another tenant. These customers get a private Kafka topic, private worker pods with their own autoscaling policy, and private provider credentials. The cost is higher (dedicated infrastructure), but the isolation is complete — a security audit of their data flow never touches shared infrastructure.

The billing model typically hooks into the `attempt_count` metric per tenant per channel. Each API call to a provider represents a chargeable event, and tracking attempts (rather than just successes) gives a fair billing signal even in retry scenarios.

*So, the connection is:* the multi-tenant model directly determines which SLO (A33) applies to which tenant — enterprise tenants with medium or hard isolation have private SLOs that are independent of the shared-tier SLOs.

---

*End of conducive-sentences.md — all 40 answers from answers.md rendered as complete, connected prose.*
