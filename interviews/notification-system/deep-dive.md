# Deep Dive: Notification System (Push, Email, SMS)

> Three reading levels per section:
> 🟢 Beginner — analogy-based, no jargon
> 🟡 Senior — mechanics, code, tradeoffs
> 🔴 Architect — failure modes, capacity math, design review depth

---

## Table of Contents

1. [What a Notification System Does](#1-what-a-notification-system-does)
2. [Channel Architecture: Push, Email, SMS](#2-channel-architecture-push-email-sms)
3. [The Core Pipeline: Ingestion to Dispatch](#3-the-core-pipeline-ingestion-to-dispatch)
4. [Fan-out and Bulk Targeting](#4-fan-out-and-bulk-targeting)
5. [Delivery Guarantees and Idempotency](#5-delivery-guarantees-and-idempotency)
6. [Priority, Rate Control, and User Preferences](#6-priority-rate-control-and-user-preferences)
7. [Failure Modes and Provider Reliability](#7-failure-modes-and-provider-reliability)
8. [Scale and Multi-Region Design](#8-scale-and-multi-region-design)
9. [Quick Recall Cheat Sheet](#9-quick-recall-cheat-sheet)

---

## 1. What a Notification System Does

### 🟢 Beginner — The Post Office Analogy

Imagine you work at a giant post office. People drop off letters all day (notifications come in). Some letters are urgent telegrams — they must reach the recipient in minutes. Others are promotional flyers — they can arrive tomorrow. Your job is to sort each piece of mail by urgency and delivery method (email, text, app notification), hand it to the right delivery driver (email provider, SMS carrier, push service), and track whether it was delivered. If a delivery fails, you retry. If the address is wrong (user unsubscribed or device token is stale), you throw it away and note why.

The key insight: **your post office never drives the truck itself** — it hands the mail to UPS, FedEx, or the postal service. Your job is sorting, tracking, and knowing when to hand off.

---

### 🟡 Senior — Notification System Responsibilities

A notification system is responsible for four things:

1. **Accepting** notifications from internal services (API ingest)
2. **Routing** them to the right channel(s) per user preference
3. **Dispatching** them through the right external provider
4. **Tracking** delivery state and surfacing it back to callers

```
                        ┌──────────────────────────────────────────────────────┐
                        │ Notification System                                   │
                        │                                                       │
  API ──► [LB] ────────►│ Ingest ─► Enrich ─► Route ─► [Push Queue]  ─► FCM   │
  calls   (ALB)         │    (stateless pods,            [Email Queue] ─► SES  │
                        │     scale behind LB)           [SMS Queue]   ─► Twilio│
                        │                                                       │
                        │  [LB] ◄── provider receipts ──► Webhook Handler      │
                        │  (ALB)   (Twilio/SendGrid push                        │
                        │           HTTP callbacks in)                          │
                        │                                                       │
                        │  Dispatch workers: NO LB needed — they pull from      │
                        │  Kafka partitions; consumer group rebalances pods     │
                        └──────────────────────────────────────────────────────┘
```

**Load balancer rule of thumb:** any component that *receives* inbound HTTP connections needs an LB (API pods, Webhook Handler). Any component that *pulls* work (dispatch workers, fan-out workers) does not — the queue handles work distribution.

Two hard requirements that shape every design decision:
- **Durability**: a notification enqueued must not be lost if any single component crashes
- **Provider abstraction**: the caller says "notify user X", not "call Twilio with payload Y"

---

### 🔴 Architect — Scope What You're Building

Before designing, scope the system to what the interview actually requires. Three common scoping mistakes in interviews:

1. **Over-scoping** to inbox/feed UX (pagination, read/unread state) when the problem is about delivery
2. **Under-scoping** by ignoring provider constraints (TTL, rate limits, domain reputation)
3. **Missing the fan-out problem** — treating 50M-user campaigns the same as single-user sends

**Meta's production insight:** Meta's notification system (2023) processes ~1 billion notifications/day across 3 billion users. Their architecture separates "candidate generation" (fan-out), "scoring/personalization" (which notifications to actually send to this user), and "dispatch" (calling the provider) as three independent services with separate scaling. Most interview answers conflate all three — separating them is what earns the senior signal.

---

## 2. Channel Architecture: Push, Email, SMS

### 🟢 Beginner — Three Delivery Trucks

Think of push, email, and SMS as three different delivery trucks with different rules:
- **Push** (APNs/FCM): fastest, free, but the recipient must have your app installed and give permission
- **Email**: universal (everyone has it), never expires, but may land in spam and takes longer
- **SMS**: highest open rate (98%), costs money, limited to short messages, strict speed limits

You don't own the trucks — Apple, Google, email providers, and phone carriers do. You're the dispatcher giving them packages to deliver.

---

### 🟡 Senior — Channel Constraints and Configuration

#### Push (APNs / FCM)

```typescript
// FCM payload (Android/Web)
{
  "message": {
    "token": "device_registration_token_here",
    "notification": { "title": "New message", "body": "Hey, how are you?" },
    "android": { "ttl": "86400s", "priority": "HIGH" },
    "apns": {
      "headers": { "apns-expiration": "1714000000", "apns-priority": "10" },
      "payload": { "aps": { "alert": { "title": "New message" }, "sound": "default" } }
    }
  }
}
```

| Property | APNs | FCM |
|---|---|---|
| Auth | JWT (ES256) or certificate | OAuth2 service account |
| Protocol | HTTP/2, persistent connections | HTTP/2 |
| Max payload | 4KB | 4KB |
| TTL | `apns-expiration` (Unix timestamp) | `ttl` in seconds, max 4 weeks |
| Priority | 5 (normal) or 10 (high / wakes device) | `normal` or `high` |
| Token freshness | Tokens expire on app uninstall/reinstall | Same |

**Token management is operational hygiene:** stale tokens return `BadDeviceToken` (APNs) or `UNREGISTERED` (FCM). Store `last_active_at` per token. Tokens not used in 90 days should be tentatively disabled and removed after first confirmed error.

#### Email (SendGrid / SES)

| Concern | Configuration |
|---|---|
| From domain | SPF + DKIM + DMARC — required or Gmail will reject |
| IP reputation | Dedicated IP per sending category (transactional vs marketing) |
| Bounce rate | Keep hard bounces < 0.5% or ISPs penalize the domain |
| Warm-up | New IP starts at 500/day, doubles weekly over 4–6 weeks |
| Unsubscribe | `List-Unsubscribe` header + one-click unsubscribe required (Gmail 2024) |

#### SMS (Twilio / Bandwidth)

| Number type | Throughput | Best for |
|---|---|---|
| Long code (10DLC) | ~500/sec per campaign (registered) | Conversational, OTPs |
| Short code | ~100/sec | Mass marketing |
| Toll-free | ~3/sec | Low-volume alerts |
| International | Varies by country | Cross-border OTPs |

---

### 🔴 Architect — Real Production Incidents

**APNs connection exhaustion (Airbnb, 2019-style):** A deploy doubled notification volume without increasing HTTP/2 connection count. APNs limits connections per certificate; the queue backed up, critical booking alerts were delayed by 8 minutes. Fix: monitor `apns_connection_pool_wait_ms` and auto-scale connections with notification volume.

**Email domain blacklisting:** A bug in a fan-out job sent the same promotional email 3x to 2M users. Bounce complaints spiked from 0.2% to 3.1%. Gmail placed the sending domain on a temporary blocklist within 2 hours. Recovery took 3 weeks of gradual warm-up with a new subdomain. Prevention: unique constraint `(campaign_id, user_id)` in the notification table, enforced at insert.

**SMS carrier filtering:** OTP messages containing certain promotional keywords ("offer", "deal") were filtered by US carriers as spam even when sent on a registered 10DLC campaign. OTP delivery rate dropped from 99.2% to 78%. Fix: OTP templates must be on a separate short code registered explicitly for authentication use.

---

## 3. The Core Pipeline: Ingestion to Dispatch

### 🟢 Beginner — The Assembly Line

Imagine a car factory assembly line. When a new car order comes in, a worker writes it on a ticket and places it on the conveyor belt. The car isn't built the moment the order is placed — it moves down the line, each station doing its part: paint, engine, wheels. The customer doesn't wait at the factory — they're notified when the car is ready.

Your notification pipeline works the same way. The API call "places the order" (enqueues the notification). The queue is the conveyor belt. Workers at each station (enrich, route, dispatch) process it asynchronously. The original caller gets an immediate response and the notification is delivered in the background.

---

### 🟡 Senior — Pipeline State Machine

Every notification transitions through a defined set of states:

```
queued → dispatching → dispatched → [delivered | failed | expired]
```

```typescript
// State transition rules
const transitions: Record<Status, Status[]> = {
  'queued':      ['dispatching', 'expired'],
  'dispatching': ['dispatched', 'failed', 'queued'],  // 'queued' on crash recovery
  'dispatched':  ['delivered', 'failed'],             // provider webhook
  'delivered':   [],                                  // terminal
  'failed':      ['queued'],                          // if attempts < maxAttempts
  'expired':     [],                                  // terminal
}
```

The `dispatching` state is the "in-flight" state. Any notification stuck in `dispatching` for > 30 seconds is a candidate for recovery — the worker that claimed it may have crashed.

**Notification service data flow:**

```typescript
// Ingest: fast path
async function ingest(req: NotificationRequest): Promise<string> {
  validate(req)                               // fail fast on bad input
  const id = crypto.randomUUID()
  await db.insert({ id, status: 'queued', ...req })  // durable write
  await queue.publish(channelTopic(req), { id })      // enqueue job
  return id                                  // return immediately to caller
}

// Dispatch worker: runs async
async function dispatch(job: Job) {
  const notif = await db.get(job.id)
  if (notif.status !== 'queued') return     // already processed
  if (notif.expires_at && Date.now() > notif.expires_at) {
    await db.update(job.id, { status: 'expired' }); return
  }
  await db.update(job.id, { status: 'dispatching' })
  try {
    const result = await provider.send(notif)
    await db.update(job.id, { status: 'dispatched', provider_message_id: result.id })
  } catch (err) {
    await handleFailure(notif, err)
  }
}
```

---

### 🔴 Architect — Pipeline Performance Review Checklist

A design review should verify these seven properties:

| Property | What to check | Risk if missing |
|---|---|---|
| Durability boundary | Notification persisted to DB *before* queue publish | Lost notifications on API crash |
| Idempotent ingest | Duplicate API calls return same `id`, not two records | Double fan-out, double send |
| Atomic status transitions | `UPDATE ... WHERE status='queued'` to claim work | Two workers process same notification |
| Expiry before dispatch | Check `expires_at` as first step in worker | Stale OTPs reach users |
| Provider response logging | Log `provider_message_id` + status synchronously | Unrecoverable on crash between send and DB update |
| DLQ alerting | DLQ depth metric with alert | Silent failure accumulation |
| Retry without re-fan-out | Only re-dispatch, never re-fan-out | Duplicate notifications to all campaign users |

**Capacity note:** at 1M notifications/sec, the DB write for "enqueue" alone is 1M rows/sec. At 512 bytes/row = 512 MB/sec of write I/O — this requires a write-optimized store (Cassandra, DynamoDB, or a Kafka-backed event log rather than a relational DB).

---

## 4. Fan-out and Bulk Targeting

### 🟢 Beginner — Sending a Party Invitation to 1,000 People

Imagine you're throwing a party and need to invite 1,000 people. You don't call everyone at once — you'd exhaust yourself. Instead, you write out 1,000 invitations (fan-out), give them to a mail service, and the mail service delivers them over the next hour. You don't wait on hold while each letter is delivered — you just hand them off and the mail service handles the rest.

The "fan-out" in a notification system is exactly that: turn one "invite everyone" job into thousands of individual invitations, then let the delivery workers handle each one separately.

---

### 🟡 Senior — Fan-out Architecture

```
Campaign: { id: "c1", cohort_query: "users.country='US' AND plan='premium'", template_id: "t1" }

Fan-out Worker:
  1. Execute cohort query in small pages (cursor-based, 1,000 users at a time)
  2. For each page, batch-write N notification jobs to queue
  3. Checkpoint last processed user_id to allow restartable progress
  4. Campaign finishes when cursor reaches end of result set

Per-user Dispatch Worker:
  Reads from notification queue, calls provider, updates status
```

**Fan-out write pattern comparison:**

| Pattern | Write target | Throughput | Recovery |
|---|---|---|---|
| Synchronous DB insert | Relational DB | ~10K rows/sec | Partial on crash |
| Batch Kafka produce | Kafka topic | ~1M msgs/sec | Exactly-once with transactions |
| Write to object store (S3 partitioned) | S3 | Unlimited | Replay by re-reading file |

For campaigns > 1M users, write job IDs to Kafka (no DB round-trip per user); the dispatch consumer reads from Kafka and does the individual DB status update only when it has a result to record.

---

### 🔴 Architect — Fan-out Failure Scenarios

**Scenario 1: Fan-out job crashes at user 5M of 20M**

Without checkpointing, restart re-fans-out from user 0 → 10M duplicate notifications to the first 5M users. With checkpointing (last processed `user_id` persisted every batch), restart continues from user 5M. Combined with the `(campaign_id, user_id)` unique constraint, even a partial double-fan-out produces no duplicate sends — the DB rejects the duplicate insert.

**Scenario 2: Campaign targeting changes mid-fan-out**

A product manager updates the cohort filter 5 minutes into a 30-minute fan-out. Decision: **take a snapshot of the cohort at job start time** (materialize the user IDs to an S3 file or temp table), fan out from that. Never re-query the live cohort during fan-out — it causes non-deterministic send counts and audit nightmares.

**Scenario 3: Fan-out queue grows faster than dispatch workers can drain**

During a major product launch, 10 campaigns start simultaneously totaling 200M notifications. Fan-out writes 10M jobs/minute; dispatch workers process 500K/minute per channel. Queue depth grows.

Mitigation: **campaign-level admission control** — limit concurrent fan-outs in progress. Queue depth SLO triggers a scale-out of dispatch workers via KEDA. Promotional campaigns are paused (queue paused) to protect critical notification capacity. After the fan-out, promotional workers resume and process the queue at full rate.

**Google's approach:** Google's notification system uses a token bucket at the campaign level — each campaign is allocated a dispatch rate, and the fan-out worker produces jobs at that rate. This means the queue never grows unbounded; fan-out is naturally throttled to the dispatch rate.

---

## 5. Delivery Guarantees and Idempotency

### 🟢 Beginner — The Certified Mail Analogy

Standard mail (at-most-once): you drop a letter in a box. If the postal truck catches fire, the letter is gone. No retry.

Certified mail (at-least-once): the postal service keeps a copy until they have a signature from the recipient. If delivery fails, they try again the next day. You might get the letter twice (if the first arrived but the signature was lost) — that's the cost of guaranteed delivery.

Exactly-once delivery is like certified mail where duplicates are physically impossible — it doesn't exist in practice for distributed systems, but you can *simulate* it by building idempotency on top of at-least-once.

---

### 🟡 Senior — Idempotency Implementation

**The outbox pattern** solves the "wrote to queue but didn't commit to DB" race condition:

```typescript
// WRONG — non-atomic
await db.insert(notification)   // committed
await queue.publish(notification) // crash here → notification never dispatched

// WRONG — opposite
await queue.publish(notification)  // queued
await db.insert(notification)      // crash here → dispatched but no record

// RIGHT — outbox pattern
await db.transaction(async (tx) => {
  await tx.insert('notifications', notification)
  await tx.insert('outbox', { notification_id: notification.id })  // same transaction
})
// Separate outbox relay process reads from outbox table and publishes to queue
// Marks outbox row 'published' after successful queue write
// This makes the DB the source of truth; queue is derived state
```

**Provider-level idempotency:**

```typescript
// Twilio: pass idempotency key as HTTP header
await twilioClient.messages.create({
  to: user.phone,
  from: twilioNumber,
  body: renderedSMS,
  // Twilio deduplicates same key within 4 hours
  headers: { 'X-Twilio-Idempotency-Token': `${notificationId}-${attempt}` }
})

// SendGrid: idempotency key per API call
await sgMail.send(msg, false, (err, result) => { ... }, {
  headers: { 'X-Idempotency-Key': notificationId }
})
```

---

### 🔴 Architect — Delivery Guarantee Failure Mode Analysis

| Failure | Without idempotency | With idempotency |
|---|---|---|
| Worker crash after provider call, before DB update | User receives message; status shows "queued"; retry sends again → duplicate | Provider deduplicates on retry via idempotency key |
| Fan-out job restarts mid-campaign | Duplicate per-user jobs in queue | `(campaign_id, user_id)` DB constraint rejects duplicates at insert |
| Queue message delivered twice (at-least-once semantics) | Worker processes same notification twice | `UPDATE ... WHERE status='queued'` — only one worker claims it |
| APNs returns timeout (may or may not have delivered) | Unknown state — retry risks duplicate | Log `apns-id` response header; on timeout, APNs can be queried by that ID to check actual status |

**The deduplication window problem:** Twilio's idempotency window is 4 hours. If a notification is retried after 4+ hours (e.g., from a DLQ replay), the key expires and Twilio will send again. Design: idempotency keys for DLQ replays should include the original `notification_id` (stable forever), not `attempt_number` (changes on retry). This gives indefinite deduplication as long as the `notification_id` is passed.

**Netflix's approach (2022):** Netflix solved the "APNs delivered but we don't know" problem by implementing a **delivery receipt service**: after dispatching, a background job polls for device receipts via APNs feedback service (APNs maintains a list of tokens that failed after delivery). Cross-referencing dispatch logs with feedback logs gives a ground-truth delivery rate, independent of the "success" HTTP response.

---

## 6. Priority, Rate Control, and User Preferences

### 🟢 Beginner — The Emergency Lane on a Highway

Imagine a highway with two lanes: a regular lane and an emergency vehicle lane. Ambulances (critical notifications) always use the emergency lane — they skip all traffic. Regular cars (promotional notifications) stay in the normal lane, which may be slow or congested.

Your notification system has the same structure: critical messages (OTPs, security alerts) always dispatch immediately, even if the system is busy with promotional traffic. Marketing emails wait in line.

---

### 🟡 Senior — Priority Queue Implementation

```
Kafka Topic: notifications.critical   (3 partitions, 200 consumers)
Kafka Topic: notifications.promotional (3 partitions, 50 consumers)

Consumer allocation:
  - 80% of dispatch worker pool listens to critical topic
  - 20% listens to promotional topic
  - On critical queue depth > 10K: steal workers from promotional temporarily
```

**Per-user notification frequency cap (Redis):**

```typescript
const DAILY_CAPS: Record<Channel, number> = {
  push: 10,
  email: 3,
  sms: 5,
}

async function checkAndIncrementCap(userId: string, channel: Channel): Promise<boolean> {
  const key = `notif:cap:${userId}:${channel}:${todayUTC()}`
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, 86400)  // set TTL on first increment only
  return count <= DAILY_CAPS[channel]
}
// Returns false if cap exceeded — caller should drop or delay promotional notification
```

**Quiet hours implementation:**

```typescript
function nextDeliveryTime(user: User, now: Date): Date {
  const localHour = getLocalHour(user.iana_timezone, now)
  const isQuiet = localHour >= QUIET_START || localHour < QUIET_END  // e.g., 22:00–08:00
  if (!isQuiet) return now  // deliver now
  // Schedule for end of quiet window
  return nextOccurrenceOfLocalHour(user.iana_timezone, QUIET_END, now)
}

// Queue the message with visibility delay
await queue.publish(topic, job, { visible_after: nextDeliveryTime(user, now).getTime() })
```

---

### 🔴 Architect — Preference System Design Review

**Scale challenge:** 500M users, each with per-product/per-channel preferences = 500M × 20 products × 3 channels = 30 billion preference bits. Reading from a relational DB on every notification is not feasible.

**Solution: tiered preference store**

```
Tier 1 (hot): Redis cluster — stores active users' preferences, 30-day TTL
Tier 2 (warm): DynamoDB — source of truth, all users
Tier 3 (cold): S3 — archive for GDPR audit trail of preference changes

Read path:
  1. Redis cache (< 1ms)
  2. On miss: DynamoDB read + populate Redis (< 10ms)

Write path:
  1. DynamoDB write (authoritative)
  2. Redis invalidation (async, best-effort)
  3. Preference change event published to audit log topic
```

**Compliance risk:** If Redis is serving stale preferences and a user unsubscribes via their email client (List-Unsubscribe header), the next email may still send before the Redis TTL expires. Mitigate: Redis TTL ≤ 60 seconds for marketing email preferences; critical notifications don't consult marketing preferences.

**Uber's architecture:** Uber's notification preferences system uses a "preference graph" — a directed graph where inheritance rules flow from global preferences → app preferences → product preferences → category preferences. A user opting out at the app level propagates to all products without requiring 100 individual preference writes. This reduces storage and simplifies the unsubscribe UX.

---

## 7. Failure Modes and Provider Reliability

### 🟢 Beginner — What Happens When the Truck Breaks Down

If the UPS truck breaks down, your post office doesn't close — it routes packages to FedEx. If FedEx is also down, the urgent packages go out first when service resumes; the junk mail can wait.

Your notification system needs the same fallback: if your primary SMS provider goes down, route to the backup. If both are down, queue messages until one recovers, but prioritize the urgent ones when you restart.

---

### 🟡 Senior — Circuit Breaker Implementation

```typescript
class ProviderCircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed'
  private failureCount = 0
  private lastFailureTime: number = 0
  private readonly threshold = 5
  private readonly timeout = 30_000  // 30 seconds

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'half-open'  // probe
      } else {
        throw new Error('Circuit open — routing to fallback')
      }
    }
    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  private onSuccess() {
    this.failureCount = 0
    this.state = 'closed'
  }

  private onFailure() {
    this.failureCount++
    this.lastFailureTime = Date.now()
    if (this.failureCount >= this.threshold) this.state = 'open'
  }
}
```

**Provider failover registry:**

```typescript
const smsProviders: ProviderConfig[] = [
  { name: 'twilio', priority: 1, breaker: new ProviderCircuitBreaker() },
  { name: 'vonage', priority: 2, breaker: new ProviderCircuitBreaker() },
  { name: 'bandwidth', priority: 3, breaker: new ProviderCircuitBreaker() },
]

async function sendSMS(notification: Notification) {
  for (const p of smsProviders) {
    if (p.breaker.state === 'open') continue
    try {
      return await p.breaker.call(() => providers[p.name].send(notification))
    } catch { continue }
  }
  throw new Error('All SMS providers unavailable')
}
```

---

### 🔴 Architect — Failure Mode Taxonomy

| Failure | Detection | Recovery | SLO impact |
|---|---|---|---|
| Provider returns 5xx | HTTP status code | Circuit breaker → failover | High — all new sends affected |
| Provider accepts message but doesn't deliver | Delivery webhook missing after SLA window | Alert on "dispatched but not delivered > 5min" | Medium — silent loss |
| Stale device tokens causing APNs 410 | APNs response code | Invalidate token immediately | Low — expected at small rate |
| Queue consumer lag | Kafka consumer lag metric | Add consumers / pause promotional | High if critical queue lags |
| DB write bottleneck during fan-out | Write latency P99 spike | Batch writes, use write-optimized store | Medium — delays fan-out |
| Clock skew causing quiet-hours miscalculation | Monitor "notifications sent during quiet hours" rate | Use IANA timezone + proper time library | Low but compliance risk |
| GDPR deletion race | User deleted between fan-out and dispatch | Check user existence at dispatch before calling provider | Compliance critical |

**Real production incident (WhatsApp-adjacent, 2021):** A notification system ran a fan-out for a re-engagement campaign targeting "users inactive for 30 days". The query ran against a replica with 45-minute replication lag. Users who had deleted their accounts in the last 45 minutes received a "we miss you" notification — including users who had explicitly requested data deletion. Fine risk: GDPR Article 17. Fix: the user deletion check at dispatch time must read from the primary DB, not replica, for any campaign involving deleted-user-sensitive logic.

---

## 8. Scale and Multi-Region Design

### 🟢 Beginner — The Global Post Office Network

Imagine your post office handles mail for the entire world. You don't process all mail at a single building in New York — you have sorting facilities in Europe, Asia, and the Americas. A letter from Berlin goes through the Frankfurt facility; it's faster, and European postal regulations require it stay in Europe.

Your notification system works the same way: a user in Germany's notifications are processed in the EU data center, not US. This is faster (lower latency to EU providers), legally required (GDPR data residency), and more reliable (EU outage doesn't affect US users).

---

### 🟡 Senior — Capacity Math

```
Requirements: 1M notifications/sec peak, 80/20 critical/promotional split

STEP 1 — Queue partitioning
  Each Kafka partition handles ~50K msg/sec
  Push (70%): 700K/sec ÷ 50K = 14 → use 16 partitions
  Email (20%): 200K/sec ÷ 50K = 4 → use 8 partitions
  SMS (10%): 100K/sec ÷ 50K = 2 → use 4 partitions

STEP 2 — Dispatch workers
  FCM: supports 600K sends/sec per project globally
    Each connection handles 1,000 msgs/sec
    700K/sec ÷ 1,000 = 700 connections
    At 2 connections per pod: 350 push worker pods

  SendGrid: 600 API calls/sec per API key (Enterprise plan)
    200K/sec ÷ 600 = 333 API keys
    1 key per worker pod: 333 email worker pods

  Twilio (10DLC): 500 SMS/sec per registered campaign
    100K/sec ÷ 500 = 200 registered campaigns
    1 campaign per worker thread, 10 threads per pod: 20 SMS worker pods

STEP 3 — Storage write throughput
  Notification record: ~512 bytes average
  1M records/sec × 512 bytes = 512 MB/sec write I/O
  → Cassandra: 3-node cluster, 200 MB/sec per node → 6+ nodes for headroom
  → Or DynamoDB with on-demand capacity (auto-scales)

STEP 4 — Status DB reads
  Each dispatch worker reads notification record before dispatch
  1M reads/sec → Redis read cache in front of Cassandra (< 1ms per read)
```

---

### 🔴 Architect — Multi-Region Architecture

```
Global infrastructure:
  ┌─────────────────────────────────────────────────────────────┐
  │ Global Tier                                                  │
  │   - Campaign metadata DB (CockroachDB / DynamoDB Global)    │
  │   - User → home_region mapping (low-write, global read)     │
  └─────────────────┬───────────────────────────────────────────┘
                    │ fan-out jobs routed by home_region
         ┌──────────┼──────────┐
         ▼          ▼          ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐
   │ US-East  │ │ EU-West  │ │ AP-South │
   │ Kafka    │ │ Kafka    │ │ Kafka    │
   │ Workers  │ │ Workers  │ │ Workers  │
   │ APNs/FCM │ │ APNs/FCM │ │ APNs/FCM │
   │ SES      │ │ SES EU   │ │ SES AP   │
   │ Twilio   │ │ Twilio   │ │ Twilio   │
   └──────────┘ └──────────┘ └──────────┘
```

**Data residency rules:**
- User device tokens → stored only in home region
- User preferences → stored only in home region
- Notification content → may be globally replicated (template data)
- Delivery receipts → written to home region, optionally aggregated globally for analytics

**Cross-region failure handling:**
If EU-West is fully unavailable, critical notifications (OTPs) for EU users can be routed to US-East with an explicit audit log entry. Promotional notifications are paused until EU-West recovers. This requires pre-authorization from the legal team and is configured as a "disaster mode" switch, not automatic failover (due to GDPR implications).

**Capacity planning for flash events:**
For a known high-volume event (Super Bowl, New Year's), pre-provision:
- 2x normal worker capacity in the affected region
- Pre-negotiated burst allowances with Twilio/SendGrid (called "burst credits")
- Promotional queue paused 30 min before and during the event
- On-call engineer with runbook for manual queue pause/resume

---

## 9. Redundancy & No Single Points of Failure

### 🟢 Beginner — Hot Standby vs Cold Standby

Think of it like backup power. A cold standby generator sits in a shed — when the power goes out, someone has to physically go flip a switch. You're in the dark for 10 minutes. A hot standby generator runs continuously in parallel, detects the outage in milliseconds, and takes over automatically. You don't even notice.

Every layer in a well-designed notification system uses hot standby, not cold. Kafka replicas are already in sync when a broker dies — leadership transfers in 30 seconds with zero data loss. Kubernetes replacement pods start before you even get paged. You never need to "go flip a switch."

---

### 🟡 Senior — Redundancy at Every Layer

**Infrastructure redundancy chain:**

| Layer | Mechanism | Survives | Recovery |
|---|---|---|---|
| Load Balancer | Cloud LB spans all AZs (AWS ALB, GCP LB) | 1 AZ failure | Instant |
| API / Webhook pods | K8s Deployment, `minReplicas=3` across 3 AZs | Pod crash; AZ failure | < 60s pod restart |
| Kafka | RF=3, `min.insync.replicas=2` | 1 broker failure | Leader re-election < 30s, zero data loss |
| Dispatch / Fan-out workers | K8s + Kafka consumer group rebalancing | Pod crash | Partition reassigned < 10s |
| Redis | Sentinel (3 nodes) or Cluster; auto-failover | 1 master failure | < 30s; brief writes may be lost (acceptable) |
| Cassandra | RF=3 across 3 AZs, W=2/R=2 quorum | 1 node or 1 AZ failure | Transparent; anti-entropy repairs on recovery |
| DynamoDB | Managed multi-AZ + global tables | AZ / region failure | Transparent |

**Application-level redundancy — channel fallback chain:**

Infrastructure redundancy keeps your pipeline alive when *your* components fail. It cannot help when an external provider permanently can't reach a specific user (app uninstalled, token recycled). For that, you need the fallback chain:

```
Critical notification → push fails permanently (Unregistered / BadDeviceToken)
  → fallback to SMS
  → if SMS fails permanently (invalid number)
    → fallback to email
```

```typescript
const FALLBACK_CHAIN: Record<NotificationPriority, Record<Channel, Channel[]>> = {
  critical:    { push: ['sms', 'email'], sms: ['email'], email: [] },
  promotional: { push: [], sms: [], email: [] },  // no fallback for promotional
}

async function onPermanentFailure(notif: NotificationRecord, failedChannel: Channel) {
  const nextChannels = FALLBACK_CHAIN[notif.priority][failedChannel]
  const nextChannel  = nextChannels.find(c => user.hasVerified(c))
  if (!nextChannel) { moveToDLQ(notif, 'no_fallback_channel'); return }

  await db.insert({
    ...notif,
    id:                     crypto.randomUUID(),
    parent_notification_id: notif.id,   // audit trail back to original
    channel:                nextChannel,
    status:                 'queued',
    // idempotency_key = hash(notif.id + nextChannel) — new key, stable across retries
  })
}
```

**Two rules:**
1. Trigger only on **permanent** rejection (`Unregistered`, `BadDeviceToken`) — not on 5xx (those retry via A25).
2. Fallback applies to **critical notifications only** — promotional fallback bypasses the user's explicit channel preferences.

---

### 🔴 Architect — SPOF Analysis

A single point of failure (SPOF) is any component whose failure takes down the entire system. Walk through the pipeline and explicitly identify them:

| Component | Is it a SPOF? | Why not / Mitigation |
|---|---|---|
| Load Balancer | No | Cloud LBs are regionally distributed and managed; multi-AZ |
| API pods | No | `minReplicas=3`; K8s reschedules crashed pods |
| Kafka | No | RF=3; cluster survives minority broker failures |
| Notification DB | No | Cassandra RF=3 / DynamoDB managed |
| Redis | **Partial** | Sentinel failover < 30s; brief window of lost writes acceptable for rate caps; **not** acceptable if Redis stores durable state |
| External providers | **Yes — by design** | You cannot make APNs/FCM/Twilio redundant at infra level. Mitigations: circuit breaker (A31) + secondary provider + channel fallback (A42) |
| Fan-out worker | No | K8s + Kafka checkpoint + idempotent restart |
| Webhook Handler | No | `minReplicas=3`; loss of a webhook = eventual consistency on delivery status, not data loss |

**The residual SPOF is always the external provider.** The correct interview answer acknowledges this explicitly: "We cannot eliminate provider-level risk through infrastructure. We mitigate it through circuit breakers, secondary providers, and channel fallback — and we accept that some small percentage of critical notifications may require manual recovery via the DLQ."

---

## 10. Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| System purpose | Accept notifications → route by channel/preference → dispatch via provider → track status |
| Two paths | Write path (fast, durable): ingest + enqueue. Dispatch path (async): consume + call provider |
| Channel isolation | Push/email/SMS on separate queues — one slow provider can't starve others |
| APNs/FCM role | Your server sends payload to Apple/Google; they deliver to device — you never connect directly |
| TTL configuration | OTP: 60s. Alerts: 86400s. Promotional: match campaign window |
| Email warm-up | New sending IP starts at 500/day; doubles weekly over 4–6 weeks |
| Domain reputation | Separate IPs for transactional vs marketing email — one bounce spike can't kill OTPs |
| Fan-out pattern | 1 campaign job → worker pages DB in 1K-user batches → writes per-user queue jobs |
| Fan-out checkpointing | Persist `last_fanned_out_user_id` every batch; restart resumes from checkpoint |
| Fan-out deduplication | `(campaign_id, user_id)` unique DB constraint — crash + restart can't double-send |
| Render at dispatch | Store template + var keys; render per-user just before provider call |
| Outbox pattern | DB write and outbox row in same transaction; relay publishes to queue from outbox |
| At-least-once + idempotency | Retry until ACK; pass idempotency key to provider so they deduplicate |
| Idempotency key | `hash(notification_id + channel)` — stable across retries, survives DLQ replays |
| Status transition | `UPDATE ... WHERE status='queued'` ensures exactly one worker claims a job |
| Expiry check | First thing in dispatch worker — never send stale OTPs |
| Two-tier priority | Dedicated Kafka topics; 80% worker capacity on critical, 20% on promotional |
| Per-user cap | Redis INCR by `user_id:channel:day`; promotional only; critical bypasses |
| Quiet hours | Delay promotional to quiet-end using queue visibility delay; never delay critical |
| Unsubscribe enforcement | At dispatch time, not ingestion — catches late opt-outs and DLQ replays |
| Circuit breaker | 5 consecutive failures → OPEN; 30s probe → HALF-OPEN; success → CLOSED |
| 429 coordination | First worker writes `backoff_until` to Redis; all workers check before dispatching |
| Dead-letter queue | Permanent rejection + expired TTL + max retries exceeded |
| Backoff formula | `random() * min(cap, base * 2^attempt)` — full jitter prevents thundering herd |
| Delivery vs open | Log delivery (MTA accepted); "opened" unreliable due to privacy protections |
| Multi-region routing | `user_id → home_region` global map; notification job dispatched in that region |
| Data residency | Device tokens + preferences stay in home region; campaign metadata is global |
| Capacity rule of thumb | 1M notif/sec needs ~350 FCM pods, ~333 SendGrid keys, Cassandra/DynamoDB for writes |
| Table partitioning | Partition by week; index by `(user_id, created_at DESC)`; drop partitions > 90 days |
| Testing in production | Shadow mode (log-only sink) + provider sandbox + canary cohort (0.1% real users) |
