# Answers: Notification System (Push, Email, SMS)

> Keyed to [questions.md](./questions.md). Read questions first.
> Code examples use TypeScript where helpful.

---

## Level 1 — Fundamentals & Requirements

### A1. The three guarantees, ordered by user impact

1. **Delivery** — the notification reaches the user (or fails visibly, so the sender knows).
2. **Timeliness** — critical messages arrive within seconds; promotional messages may tolerate minutes.
3. **Relevance** — opt-outs, preferences, and quiet hours are respected.

Delivery first because a notification that never arrives is worse than a late one. Timeliness second because a 2-minute OTP that expires is effectively lost. Relevance third because sending to an opted-out user is a compliance violation.

---

### A2. Delivery semantics for notifications

| Semantic | Definition | Correct for notifications? |
|---|---|---|
| At-most-once | Send once, no retry; may drop | No — dropped critical messages are unacceptable |
| At-least-once | Retry until acknowledged; may duplicate | Yes — with deduplication at dispatch |
| Exactly-once | Guaranteed single delivery, no duplicates | Ideal but impractical — requires distributed transactions |

**Use at-least-once + idempotent dispatch.** The provider call is the hard-to-control step; deduplication logic (see A22) prevents the user from seeing duplicates.

---

### A3. Three clarifying questions for bulk sends

1. **Exact recipient count and selection criteria** — "all users" vs a filtered cohort changes the fan-out architecture by orders of magnitude.
2. **Delivery window and time-zone sensitivity** — 9 AM for each user locally vs 9 AM UTC matters for quiet-hours compliance and provider load.
3. **Priority tier** — if this is a marketing blast, it must be queued behind any pending critical notifications and may be throttled; if it's a transactional alert, it bypasses marketing queues.

---

### A4. Why each channel needs its own pipeline

| Channel | External constraint | Failure mode if shared |
|---|---|---|
| Mobile Push (APNs/FCM) | Connection-pooled persistent HTTP/2 | Email backlog blocks push delivery |
| Email (SendGrid/SES) | Per-day domain quota, reputation scoring | SMS delays pollute email throughput |
| SMS (Twilio) | Per-second rate limit, cost per message | Expensive bulk sends compete with cheap push |

Each provider has different rate limits, retry semantics, error codes, and authentication. A shared queue means one slow provider drains worker threads and starves the others.

---

### A5. Transactional vs marketing notifications

| Dimension | Transactional | Marketing |
|---|---|---|
| User consent | Implicit (service relationship) | Explicit opt-in required |
| Urgency | Seconds (OTP expiry) | Minutes to hours acceptable |
| Volume | Low, event-driven | High, scheduled batch |
| Compliance | Must send (OTP, password reset) | Must honor unsubscribe |
| Queue priority | Critical queue | Bulk queue |

Architectural implication: transactional notifications skip the fan-out stage; they target one user directly. Marketing notifications always go through the fan-out/campaign pipeline.

---

## Level 2 — Channel Architecture

### A6. APNs and FCM roles

Your server sends a **push payload** (JSON) to APNs (for iOS) or FCM (for Android/web) over an authenticated HTTP/2 connection. The provider holds a persistent connection to the device and delivers the payload when the device is online.

```
Your server → APNs/FCM (your payload) → Apple/Google infra → User device
```

Your system never connects directly to the device — you only control the APNs/FCM call. The payload must include:
- `device_token`: opaque token identifying the device+app install
- `alert`: title + body text
- `apns-expiration` / `ttl`: when to discard if device is offline

---

### A7. Offline device and TTL behavior

When a device is offline, APNs/FCM **stores the notification** up to the TTL you specify. On reconnect, the device receives it. If TTL expires before reconnect, the notification is silently dropped — no error to your server.

**Configuration rule:**
- OTPs: `ttl=60` seconds (code expires anyway; stale delivery is harmful)
- Critical alerts: `ttl=86400` (24h — deliver when possible)
- Promotional: `ttl=3600` or match your campaign expiry

Always log the `apns-expiration` and `fcm-ttl` you sent so you can correlate delivery failures against TTL settings.

---

### A8. SMS burst handling

Twilio long codes are limited to ~1 SMS/sec per number. For 100K SMSes in 10 seconds you need:

```
Required TPS = 100,000 / 10 = 10,000 SMS/sec
Long codes needed = 10,000 / 1 = 10,000 (impractical)
Short code TPS = ~100/sec → need 100 short codes
Toll-free TPS = ~3/sec → need ~3,333 (impractical for burst)
```

**Real solution:** use a **Twilio Messaging Service** with a pool of short codes, or switch to A2P (Application-to-Person) 10DLC registration which allows ~500/sec per campaign. Queue the 100K messages into a rate-limited dispatch queue that leaks at the provisioned rate. OTP codes must have a 5-minute TTL in the queue — if still undelivered after 5 min, mark failed and don't send.

---

### A9. Email volume warm-up problem

Sending 10M emails from a new domain on day 1 will result in:
1. ISPs (Gmail, Outlook) placing you on a blocklist within hours
2. Your domain's sender reputation permanently damaged
3. 60–80% of emails landing in spam indefinitely

**Prevention:** follow a warm-up ramp:
```
Day 1:    500 emails
Day 2:    1,000
Day 3:    2,000
Day 7:    10,000
Day 14:   100,000
Day 30:   1,000,000+
```
Use dedicated IPs, consistent sending volume, and monitor bounce/spam rates. SendGrid/SES both have automated warm-up tools. Keep marketing and transactional email on separate IPs and domains so a marketing reputation issue doesn't block OTPs.

---

### A10. Delivery vs open tracking

| Event | What it means | Who records it |
|---|---|---|
| Accepted by MTA | Provider's server accepted the message | SendGrid webhook → your system |
| Delivered | Recipient's mail server acknowledged receipt | SendGrid webhook |
| Opened | User opened the email (1x1 tracking pixel loaded) | Your tracking pixel server |
| Clicked | User clicked a tracked link | Your redirect server |

For audit trails, log **delivery** (accepted + delivered). "Opened" is unreliable because email clients increasingly block tracking pixels (Apple Mail Privacy Protection). Never use "opened" as confirmation that a user received a time-sensitive message.

---

## Level 3 — Core Pipeline Design

### A11. High-level components

```
[API Layer]
    ↓
[Notification Service]  ← validates, enriches, assigns priority
    ↓
[Router / Fan-out Service]  ← resolves recipients, channel preference
    ↓
[Per-Channel Queue]  ←─── Push Queue | Email Queue | SMS Queue
    ↓
[Dispatch Workers]  ← call APNs / FCM / SendGrid / Twilio
    ↓
[Provider]
    ↓
[Webhook Handler]  ← receives delivery receipts, updates status
```

Each component is independently scalable. The queue is the durability boundary — a worker crash loses nothing.

**Load balancer placement — two places, two different mechanisms:**

| Layer | Mechanism | Why |
|---|---|---|
| API pods (sync HTTP) | Real LB — AWS ALB / GCP LB | Callers push HTTP requests in; needs a router across stateless pods |
| Webhook Handler (sync HTTP) | Real LB — same pattern | Providers (Twilio, SendGrid) push delivery callbacks in via HTTP |
| Dispatch workers (async) | Kafka consumer group rebalancing | Workers *pull* from partitions; Kafka assigns each partition to exactly one consumer. When pods are added/removed, Kafka rebalances automatically — no LB needed |

Dispatch workers don't need a load balancer because they are consumers, not servers. They reach out to Kafka; nothing reaches in to them.

---

### A12. Why decouple ingestion from dispatch

| Without queue | With queue |
|---|---|
| Provider slowdown stalls API response | Provider slowdown only backs up workers |
| Burst traffic causes API timeouts | Burst absorbed into queue; dispatch runs at provider rate |
| Worker crash loses in-flight messages | Messages persist in queue until acked |
| No retry without blocking caller | Retry is internal to worker loop |

The API call returns as soon as the notification is durable in the queue (typically < 5ms). Dispatch happens asynchronously. This decoupling is what makes the 1M/sec ingestion target achievable.

---

### A13. Notification record schema

```typescript
interface NotificationRecord {
  id: string;                   // UUID, idempotency key
  created_at: Date;
  scheduled_at?: Date;          // for delayed/scheduled sends
  expires_at?: Date;            // null = never expire (critical)

  // routing
  user_id: string;
  channel: 'push' | 'email' | 'sms';
  priority: 'critical' | 'promotional';

  // payload
  template_id: string;
  template_vars: Record<string, string>;
  rendered_body?: string;       // populated at dispatch time

  // provider
  provider: 'fcm' | 'apns' | 'sendgrid' | 'ses' | 'twilio';
  provider_message_id?: string; // returned by provider on success

  // state machine
  status: 'queued' | 'dispatched' | 'delivered' | 'failed' | 'expired';
  attempts: number;
  last_error?: string;
  delivered_at?: Date;
}
```

---

### A14. Render at dispatch, not at creation

For a campaign targeting 20M users:
- **Render at creation**: 20M render operations, 20M full payloads stored → 20GB+ storage per campaign for a 1KB message
- **Render at dispatch**: store template once, render once per worker invocation → tiny queue entries

Render at dispatch also means the rendered content reflects the user's current locale and preferences at delivery time, not at the time the campaign was created 2 hours earlier.

```typescript
// Queue entry: small
{ template_id: "promo_v3", vars: { user_name_key: "user_id:123" } }

// Dispatch worker: render from template + user data just-in-time
const body = render(template, await userService.get(userId))
```

---

### A15. Routing logic

The routing service reads:
1. **User's registered channels**: does `user_id:123` have a valid FCM token? An email address? A verified phone number?
2. **User's channel preferences**: opted out of email marketing? Push only during work hours?
3. **Notification priority**: critical → always deliver; promotional → respect preferences
4. **Channel availability**: if FCM token is stale (last active > 90 days), skip push or fall back to email

```typescript
function route(notification: Notification, user: User): Channel[] {
  const available = user.channels.filter(c => c.isVerified && !c.isExpired)
  if (notification.priority === 'critical') return available  // ignore prefs
  return available.filter(c => user.preferences.allows(c, notification.category))
}
```

---

## Level 4 — Fan-out and Bulk Targeting

### A16. Async fan-out pattern

```
Campaign API Request
  → Write Campaign record (status: pending)
  → Enqueue 1 FanOut job (job_id, cohort_query, campaign_id)
  → Return 202 Accepted

Fan-out Worker:
  loop:
    cursor = last_processed_user_id
    batch = DB.query("SELECT user_id FROM users WHERE <cohort> AND id > cursor LIMIT 1000")
    for each user in batch:
      enqueue(NotificationJob { user_id, campaign_id, template_id })
    checkpoint(cursor = batch.last.id)
    if batch.size < 1000: mark campaign dispatched
```

The API never waits for fan-out. Fan-out writes jobs to the per-channel queue in batches of 1000. Checkpointing allows restart without re-processing completed users.

---

### A17. Push fan-out vs pull fan-out for notifications

| Model | Push fan-out | Pull fan-out |
|---|---|---|
| How it works | Write to each user's inbox at send time | User fetches unread notifications on load |
| Best for | Small recipient lists (<10K), real-time alerts | Activity feeds, large lists, async reads |
| DB writes | N writes immediately (hot at send time) | 1 write to campaign, N reads amortized |
| Read latency | Zero (pre-computed) | Query cost at read time |
| Consistency | Stale if notification updated after fan-out | Always current |

For notification **delivery** (push/email/SMS), you always push fan-out since you're calling an external provider per user. For in-app notification **feeds**, pull fan-out is better. Hybrid: fan-out for < 1M recipients, pull for celebrity/viral scenarios.

---

### A18. Write amplification mitigation

| Problem | Mitigation |
|---|---|
| 20M row inserts hammer primary DB | Write to append-only Kafka topic; worker batch-inserts into DB |
| Hot partition on `created_at` index | Shard by `user_id % N`, not timestamp |
| Notification table grows unbounded | Partition by week; archive to cold storage after 30 days |
| Foreign key lookups slow bulk insert | Denormalize: store user_id + channel_address inline in notification row |

Fan-out writes should target a **write-optimized store** (Cassandra, DynamoDB) rather than a relational DB for high-velocity campaigns.

---

### A19. Idempotent fan-out restart

Checkpoint after every batch with the last `user_id` processed:

```sql
UPDATE campaigns
SET last_fanned_out_user_id = :cursor, status = 'in_progress'
WHERE campaign_id = :id
```

On restart, resume from `last_fanned_out_user_id`. To prevent duplicate notifications:
- Notification record has a unique key: `(campaign_id, user_id)` — DB constraint prevents double-insert
- OR use idempotency key in the queue: if already enqueued, queue deduplication discards duplicates

---

### A20. Send windows and time zones

A "9 AM local" send window means:
- Sort recipients by UTC offset (GMT-12 to GMT+14)
- Fan-out in offset order, scheduling each batch for the right UTC time
- User at GMT+5:30 IST → UTC 03:30; user at GMT-8 PST → UTC 17:00

```typescript
const sendAtUTC = toUTC(userTimezone, scheduledLocalHour)
enqueue(job, { visible_after: sendAtUTC })
```

This requires storing the user's IANA timezone (`America/Los_Angeles`), not just UTC offset (offsets change with DST).

---

## Level 5 — Delivery Guarantees & Idempotency

### A21. Preventing duplicate SMS after worker crash

Use the **outbox pattern**:

```
Transaction:
  1. UPDATE notifications SET status='dispatching' WHERE id=:id AND status='queued'
  2. Call Twilio (outside transaction)
  3. UPDATE notifications SET status='sent', provider_message_id=:sid WHERE id=:id
```

If the worker crashes between steps 2 and 3, the status is `'dispatching'`. A recovery job finds rows stuck in `'dispatching'` for > 30 seconds and checks Twilio's API for the actual delivery status by `provider_message_id` (which was logged to a side-channel before the call). If Twilio confirms delivered, mark sent. If unknown, retry with the **same idempotency key** so Twilio deduplicates on their side.

---

### A22. Idempotency key construction

A good idempotency key uniquely identifies one logical notification attempt:

```
idempotency_key = hash(notification_id + channel + attempt_number)
```

Or for campaign sends:
```
idempotency_key = hash(campaign_id + user_id + channel)
```

Pass this as `Idempotency-Key` header to Twilio/SendGrid. If the same key arrives twice within their deduplication window (usually 24h), they return the original response without resending.

---

### A23. Push delivered to APNs but not received by user

| Root cause | How to investigate |
|---|---|
| Device token is stale | APNs returns `BadDeviceToken` — log and invalidate token |
| App is uninstalled | APNs returns `Unregistered` — remove token from DB |
| User disabled push permissions in OS settings | APNs returns `200` but device silently drops — no feedback |
| Device has been offline > TTL | APNs discards after TTL with no error to sender |
| App is in foreground and handles notification internally | Delivered, but no OS notification shown — expected |

Log: `apns_request_id`, `apns_status`, `device_token_hash`, `ttl_configured`. If APNs returns 200 and token is valid, the delivery gap is on the device — outside your system's control.

---

### A24. Dead-letter queue categories

Route to DLQ instead of retrying when:

1. **Permanent provider rejection**: `InvalidDeviceToken`, `Unregistered` (APNs), `invalid_email` (SendGrid) — retrying will always fail
2. **Expired TTL**: notification's `expires_at` has passed — delivering stale OTP is harmful
3. **Max retries exceeded**: after N attempts with exponential backoff, accept failure and alert on-call

DLQ entries must be inspectable and replayable. Alerting on DLQ depth > threshold is a leading indicator of provider or data quality issues.

---

### A25. Retry with exponential backoff + jitter

```typescript
function retryDelay(attempt: number): number {
  const base = 1_000  // 1 second
  const cap = 300_000 // 5 minutes max
  const expo = Math.min(cap, base * Math.pow(2, attempt))
  // Add full jitter to prevent thundering herd
  return Math.random() * expo
}

// attempt 0 → 0–1s
// attempt 1 → 0–2s
// attempt 2 → 0–4s
// attempt 5 → 0–32s
// attempt 8 → 0–256s (capped at 300s)
```

Jitter prevents multiple workers from retrying simultaneously after a provider outage ("thundering herd"). Always check `expires_at` before each retry — don't retry an expired notification.

---

## Level 6 — Priority, Rate Control & User Preferences

### A26. Two-tier priority system

| Property | Critical queue | Promotional queue |
|---|---|---|
| Queue | Dedicated, higher consumer count | Separate, can be paused |
| Consumer ratio | 80% of worker fleet | 20% of worker fleet |
| TTL | Long (24h+) | Short (campaign window) |
| Throttle | None — deliver as fast as possible | Subject to per-user daily cap |
| Monitoring | Alert if queue depth > 1K | Alert if queue depth > 1M |

Implementation: two separate Kafka topics (`notifications.critical`, `notifications.promotional`) with separate consumer groups. Critical consumers never block on promotional work.

---

### A27. Per-user notification rate cap

Cap enforcement: **at the routing layer**, before enqueuing to channel queues.

```typescript
async function checkRateCap(userId: string, channel: Channel): Promise<boolean> {
  const key = `notif:cap:${userId}:${channel}:${dayBucket()}`
  const count = await redis.incr(key)
  await redis.expire(key, 86400)  // TTL = 1 day
  return count <= USER_DAILY_CAP[channel]  // push: 10/day, email: 3/day, SMS: 5/day
}
```

The cap is checked at routing. If exceeded, the promotional notification is **silently dropped** (with a log entry). Critical notifications bypass the cap entirely.

---

### A28. Quiet hours + critical override

```typescript
function shouldDelayForQuietHours(
  user: User,
  notification: Notification,
  now: Date
): Date | null {
  if (notification.priority === 'critical') return null  // never delay OTPs
  const localHour = toLocalHour(user.timezone, now)
  if (localHour >= user.quietHoursEnd && localHour < user.quietHoursStart) return null
  // It's quiet hours — schedule for end of quiet period
  return nextQuietHoursEnd(user.timezone, user.quietHoursEnd, now)
}
```

The notification is not dropped — it's **delayed** by scheduling the queue message visibility to the end of the quiet window. Log the delay so product can audit actual vs scheduled delivery times.

---

### A29. Unsubscribe enforcement placement

Enforce unsubscribe at **dispatch time** (just before calling the provider), not at ingestion.

| Why not at ingestion? | Why at dispatch? |
|---|---|
| User might unsubscribe between ingestion and dispatch | Always reflects current preference |
| Campaign enqueued before user opted out | Catches late opt-outs in batch jobs |
| Re-processing DLQ entries would bypass the check | DLQ replays still respect current status |

```typescript
// Last check before provider call
const prefs = await userPrefsService.get(userId)
if (!prefs.allows(channel, notificationCategory)) {
  markSkipped(notification, 'unsubscribed')
  return
}
```

This is also the correct position for GDPR deletion checks — a deleted user's data is gone from the prefs store.

---

### A30. Per-product, per-channel preferences schema

```typescript
interface UserNotificationPreferences {
  userId: string
  channels: {
    push: { enabled: boolean }
    email: { enabled: boolean }
    sms: { enabled: boolean }
  }
  productPreferences: {
    [productId: string]: {
      [category: string]: {  // "marketing", "transactional", "updates"
        push: boolean
        email: boolean
        sms: boolean
      }
    }
  }
}
// Example:
// uber_eats.marketing.push = false
// uber_eats.marketing.email = true
// uber_eats.transactional.push = true
```

Store in a low-latency K/V store (Redis or DynamoDB). Read at dispatch time with a `< 5ms` P99 target. Changes propagate within the TTL of the read-through cache (typically 60s).

---

## Level 7 — Failure Modes & Observability

### A31. SMS provider failover strategy

```
Twilio returns 5xx or connection timeout for 3 consecutive attempts
  → circuit breaker OPENS for Twilio
  → dispatch worker routes new SMS jobs to secondary (e.g., Vonage / Bandwidth)
  → monitor secondary error rate
  → circuit breaker HALF-OPEN after 30s: probe with 1 request
  → if probe succeeds → CLOSE circuit, route back to Twilio
  → if probe fails → extend open window (exponential backoff)
```

Failover is per-channel; push and email dispatch are unaffected. Critical SMS (OTPs) should have a hard failover SLA < 5 seconds; promotional SMS can tolerate queueing until the primary recovers.

---

### A32. Coordinated backoff on 429

Use a **shared rate-limit state in Redis**:

```typescript
// When a worker receives 429 from SendGrid:
const retryAfter = response.headers['retry-after']  // seconds
await redis.set('sendgrid:backoff_until', Date.now() + retryAfter * 1000, 'EX', retryAfter + 10)

// Before every dispatch attempt, workers check:
const backoffUntil = await redis.get('sendgrid:backoff_until')
if (backoffUntil && Date.now() < Number(backoffUntil)) {
  requeue(job, { visible_after: Number(backoffUntil) })
  return
}
```

This prevents each of your 500 workers from independently hammering SendGrid with retries. The first worker to see the 429 publishes the backoff signal; all others read and comply.

---

### A33. Notification system SLOs

| SLO | Target | Alert expression |
|---|---|---|
| Critical notification P95 end-to-end latency | < 5 seconds | `histogram_quantile(0.95, rate(notif_e2e_latency_seconds_bucket{priority="critical"}[5m])) > 5` |
| Dispatch error rate (5xx from provider) | < 0.1% | `rate(notif_dispatch_errors_total[5m]) / rate(notif_dispatch_total[5m]) > 0.001` |
| DLQ depth (critical channel) | < 100 messages | `notif_dlq_depth{channel="push",priority="critical"} > 100` |
| Fan-out lag (campaign start to last enqueue) | < 10 minutes for 10M recipients | `notif_fanout_duration_seconds{campaign_size="10M"} > 600` |

---

### A34. Duplicate notification investigation path

```
1. Check notification DB: SELECT * FROM notifications WHERE user_id=X AND campaign_id=Y
   → Are there 3 rows with distinct IDs? → Fan-out wrote duplicates (missing unique constraint)
   → Is there 1 row with attempts=3? → Dispatch retried and each call reached the user

2. Check dispatch logs: did all 3 send events use the same idempotency_key?
   → Same key, 3 sends → idempotency key not passed to provider OR provider dedup window expired

3. Check provider dashboard: did Twilio/SendGrid receive 3 separate message IDs?
   → Yes → duplicate creation upstream (fan-out bug)
   → No → provider delivered once, something else sent the others (e.g., a separate campaign)

4. Check campaign records: is the user in 3 overlapping segments for this campaign?
```

Root causes: missing `(campaign_id, user_id)` unique index, retry without idempotency key, user in overlapping audience segments.

---

### A35. Testing without spamming real users

1. **Shadow mode**: route a copy of all notifications to a test sink that logs but doesn't call providers
2. **Test tenant**: dedicated `test_` prefixed user accounts whose notifications route to a test provider endpoint (`https://example.com/notify`)
3. **Provider sandbox**: Twilio, SendGrid, APNs all have sandbox/test modes that accept requests without delivering
4. **Canary cohort**: 0.1% of real users who have opted into being canaries — receive new notification code paths

Infrastructure required: a routing flag (`dispatch_mode: real | shadow | sandbox`) resolvable per user or per environment, and a test sink service that logs and asserts on notification payloads.

---

## Level 8 — Scale & Multi-Region

### A36. Capacity math for 1M notifications/sec

```
Channels split (typical):
  Push:  70% = 700K/sec
  Email: 20% = 200K/sec
  SMS:   10% = 100K/sec

Queue partitions:
  Each Kafka partition can handle ~50K msg/sec with small payloads
  Push queue:  700K / 50K = 14 partitions (use 16 with headroom)
  Email queue: 200K / 50K = 4 partitions (use 8)
  SMS queue:   100K / 50K = 2 partitions (use 4)

Dispatch workers:
  FCM HTTP/2 connections: ~1,000 reqs/sec per connection → 700 connections for push
  Workers: 350 pods × 2 HTTP/2 connections each = 700 connections
  Email workers: SendGrid API 600 reqs/sec/key → 333 keys needed
  SMS workers: Twilio 100 SMS/sec with 10DLC pool → 1,000 worker threads

DB write throughput:
  1M notification rows/sec × 512 bytes = 512 MB/s writes
  → Use Cassandra or DynamoDB (designed for this write volume)
  → Shard by user_id to distribute hot users
```

---

### A37. Multi-region routing

**Region-local data:**
- User device tokens (FCM/APNs tokens registered in the user's home region)
- User preferences and quiet hours
- Per-channel dispatch workers and provider credentials

**Globally consistent data:**
- Campaign records (who to send, what template)
- User-to-region mapping (`user_id` → `home_region`)

**Routing:**
```
API Request (any region)
  → look up user home_region from global mapping
  → forward notification job to that region's queue
  → dispatch worker in that region calls provider

Why: GDPR requires EU user data stays in EU.
APNs/FCM have regional endpoints — lower latency from same region.
```

Cross-region fan-out uses async replication of campaign metadata; user data never leaves its home region.

---

### A38. Absorbing 10x traffic spikes

The message queue is the spike absorber by design. The API layer writes to the queue at the spike rate; workers drain at the provider-limited rate. Key configurations:

| Component | Setting |
|---|---|
| Queue | Unbounded depth (or very large); monitor lag, not drop |
| Workers | Auto-scale on queue depth metric (KEDA / HPA on Kafka lag) |
| Promotional workers | May be paused to free capacity for critical during spikes |
| Provider limits | Pre-negotiated burst allowances with Twilio/SendGrid for known sale events |

Promotional notifications during a flash sale can be **intentionally delayed** — a "50% off" message arriving 2 minutes late is fine. Critical OTPs cannot be delayed.

---

### A39. Notification table partitioning

```sql
-- Partition by week
CREATE TABLE notifications_2026_w18 PARTITION OF notifications
  FOR VALUES FROM ('2026-04-27') TO ('2026-05-04');

-- Retention: drop partitions older than 90 days
DROP TABLE notifications_2026_w01;  -- automated weekly job

-- Keep recent-notification queries fast:
-- Index on (user_id, created_at DESC) within each partition
-- Query: SELECT * FROM notifications WHERE user_id=X ORDER BY created_at DESC LIMIT 20
--   → hits only current + previous week partition
```

Archive older partitions to S3/Parquet via a weekly Spark job for analytics. Keep only 30 days hot in the primary DB.

---

### A40. Multi-tenant with dedicated dispatch workers

```
Tenant A (standard): shares push/email/sms consumer groups
Tenant B (SLA-isolated): dedicated consumer group on shared topic with separate auto-scaling group
Tenant C (dedicated): private Kafka topic + private consumer group + private provider credentials
```

Isolation levels:
| Level | What's shared | Use case |
|---|---|---|
| Soft isolation | Same workers, priority queue lane | Default for all tenants |
| Medium isolation | Dedicated consumer group, shared brokers | Enterprise tier |
| Hard isolation | Private topic + workers + provider creds | Finance / healthcare regulatory requirements |

Billing hooks into the `attempt_count` metric per tenant per channel.

---

## Level 9 — Redundancy & No Single Points of Failure

### A41. Infrastructure redundancy by layer

Every layer of the pipeline has its own redundancy mechanism. The table below covers the complete chain:

| Layer | Redundancy mechanism | What it survives | Recovery time |
|---|---|---|---|
| **Load Balancer** | Cloud LB is multi-AZ by default (AWS ALB spans all AZs in the region) | 1 AZ failure | Instant — traffic reroutes automatically |
| **API pods** | K8s Deployment: `minReplicas=3` across 3 AZs; K8s restarts crashed pods | 1 pod crash; 1 AZ failure | < 60s for pod restart; instant for AZ (other pods absorb traffic) |
| **Kafka brokers** | Replication factor (RF) = 3; `min.insync.replicas` = 2; controller elected via KRaft | 1 broker failure; partition leader reassignment | Leader re-election < 30s; no messages lost (RF=3 means 2 replicas still alive) |
| **Fan-out workers** | K8s Deployment across AZs + Kafka consumer group rebalancing | Pod crash | Partition reassigned to surviving pod < 10s; job retried from queue |
| **Dispatch workers** | Same as fan-out workers | Pod crash | < 10s rebalance; in-flight job visibility timeout expires, re-queued |
| **Redis** (rate cap, backoff state) | Redis Sentinel (3 nodes) or Redis Cluster; automatic master failover | 1 Redis master failure | Sentinel promotes replica < 30s; brief writes may be lost (acceptable for rate caps) |
| **Database** (Cassandra) | RF = 3 across 3 AZs; quorum write W=2, quorum read R=2 | 1 node failure; 1 AZ failure | Reads/writes continue with remaining 2 nodes; automatic repair when node recovers |
| **Database** (DynamoDB) | Fully managed; multi-AZ by default; global tables for multi-region | AZ failure; region degradation (with global tables) | Transparent — no config needed |
| **Webhook Handler pods** | K8s Deployment behind LB, same as API pods | Pod crash; AZ failure | < 60s |

**The one layer with no automatic redundancy:** external providers (APNs, FCM, Twilio, SendGrid). These are outside your infrastructure. This is why A31 (circuit breaker + secondary provider) and A42 (channel fallback chain) exist — they are the application-level complement to the infrastructure redundancy above.

---

### A42. Channel fallback chain — when push fails, try SMS

A channel fallback chain is a configurable ordered list of channels to attempt for a given notification if the primary channel fails permanently.

**Trigger condition:** permanent provider rejection only — `Unregistered`, `BadDeviceToken` (APNs), `InvalidRegistration` (FCM). Transient 5xx failures use the exponential retry in A25. The fallback fires when a channel is confirmed unreachable for this user, not when it's temporarily slow.

**Fallback order for critical notifications:**
```
push → SMS → email
```
Push is cheapest and fastest. SMS is highest-reliability (98% open rate, works without an app). Email is the last resort — slowest but most universally available.

**Implementation:**
```typescript
// After dispatch worker marks push channel as 'failed' (permanent):
async function triggerFallback(notification: NotificationRecord, failedChannel: Channel) {
  const fallbackChain = FALLBACK_ORDER[notification.priority][failedChannel]
  // e.g. FALLBACK_ORDER.critical.push = ['sms', 'email']
  const nextChannel = fallbackChain.find(c => user.hasVerified(c))
  if (!nextChannel) return  // no fallback available — log and DLQ

  await db.insert({
    ...notification,
    id: crypto.randomUUID(),           // new record, new idempotency root
    parent_notification_id: notification.id,  // links back to original for audit
    channel: nextChannel,
    status: 'queued',
    // idempotency_key = hash(notification.id + nextChannel) — stable across retries
  })
}
```

**Critical rule: only for critical notifications.** Promotional notifications do NOT get a fallback chain. A user who has disabled push has not consented to receive the same marketing message via SMS. Applying fallback to promotional notifications would violate user preferences and likely GDPR.

**Deduplication across channels:** Each fallback attempt is a new notification record with a new idempotency key suffix: `hash(original_notification_id + 'sms')`. The `parent_notification_id` field links the fallback to the original for audit trails and prevents the original from being retried after the fallback succeeds.

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| At-least-once + idempotent dispatch | Retry until ACK; idempotency key prevents user-visible duplicates |
| Decouple ingestion from dispatch | API writes to queue in < 5ms; workers drain asynchronously at provider rate |
| Per-channel queues | Push/email/SMS each have separate queues to prevent cross-channel starvation |
| Fan-out pattern | Enqueue 1 campaign job → worker pages DB in 1K batches → writes per-user jobs |
| Render at dispatch | Store template + vars only; render per-user just before sending |
| Idempotency key | `hash(campaign_id + user_id + channel)` — pass to provider for server-side dedup |
| TTL for push | OTP: 60s. Alerts: 86400s. Promotional: match campaign expiry |
| Email warm-up | Start at 500/day, double weekly; separate IPs for transactional vs marketing |
| Quiet hours | Delay promotional, never delay critical (OTP, security alerts) |
| Unsubscribe check | At dispatch time, not ingestion — catches late opt-outs and DLQ replays |
| Circuit breaker | 3 consecutive 5xx → open; 30s probe → half-open; success → closed |
| Coordinated 429 backoff | First worker writes `backoff_until` to Redis; all workers read and pause |
| Dead-letter queue | Permanent rejections + expired TTL + max retries exceeded |
| Exponential backoff + jitter | `delay = random() * min(cap, base * 2^attempt)` — prevents thundering herd |
| Multi-region routing | User data stays in home region; campaign metadata is global; dispatch is local |
| Partitioning strategy | Partition notifications table by week; index by `(user_id, created_at DESC)` |
| Push fan-out vs pull | Push fan-out for delivery channels; pull fan-out only for in-app feed at celebrity scale |
| Priority queue ratio | 80% of worker fleet on critical queue; 20% on promotional |
| Per-user daily cap | Redis INCR per `user_id:channel:day`; promotional only; critical bypasses |
| 1M/sec capacity | ~16 push partitions, 350 FCM worker pods, Cassandra/DynamoDB for write volume |
| Infra redundancy | Kafka RF=3 (survives 1 broker); Cassandra RF=3 across AZs (W=2/R=2 quorum); Redis Sentinel; K8s minReplicas=3 |
| Channel fallback | Critical only: push → SMS → email; trigger = permanent provider rejection; new notification record with `parent_notification_id` |
