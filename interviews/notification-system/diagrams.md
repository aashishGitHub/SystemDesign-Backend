# Notification System — Mermaid Diagrams

> Interview-ready diagrams. Start with Diagram 1 for the whiteboard overview, then drill into the specific area the interviewer probes.
>
> Reference: [answers.md](./answers.md) | [conducive-sentences.md](./conducive-sentences.md)

---

## Diagram 1 — High-Level Architecture (Start Here)

> **When to use:** Opening diagram. Draw this first on any whiteboard. Covers every major component and the two distinct paths (write vs dispatch).

```mermaid
flowchart TD
    subgraph Callers["Callers (Internal Services)"]
        A1[Auth Service\nOTP / 2FA]
        A2[Campaign Manager\nMarketing Blasts]
        A3[Fraud Detection\nSecurity Alerts]
    end

    LB["⚖️ Load Balancer\nAWS ALB / GCP LB\nLayer 7 · HTTPS termination\nHealth-checks API pods"]

    subgraph Ingestion["Write Path — Ingestion (horizontally scaled)"]
        B1[API Pod 1\nAuth · Validate · Rate Limit]
        B2[API Pod 2]
        B3[API Pod N]
        C[Notification Service\nEnrich · Assign Priority\nWrite DB record first]
    end

    subgraph FanOut["Fan-out Layer"]
        D1[Transactional Router\n1 user → 1 job]
        D2[Campaign Fan-out Worker\n1 job → millions of per-user jobs\nBatch 1000 · Checkpoint cursor]
    end

    subgraph Queues["Per-Channel Queues — Kafka acts as load balancer for async path\n(each partition assigned to exactly one consumer at a time)"]
        Q1[🔔 Push Queue\nKafka: 16 partitions]
        Q2[📧 Email Queue\nKafka: 8 partitions]
        Q3[📱 SMS Queue\nKafka: 4 partitions]
    end

    subgraph Workers["Dispatch Workers\n(Kafka consumer group rebalancing distributes partitions across pods)"]
        W1[Push Workers\n350 pods · 2 FCM connections each]
        W2[Email Workers\n333 pods · 1 SendGrid key each]
        W3[SMS Workers\n1000 threads · Twilio 10DLC pool]
    end

    subgraph Providers["External Providers"]
        P1[APNs / FCM\niOS · Android · Web Push]
        P2[SendGrid / AWS SES\nEmail delivery]
        P3[Twilio / Vonage\nSMS delivery]
    end

    subgraph Feedback["Feedback Path"]
        WHLB["⚖️ Load Balancer\nfor Webhook Handler pods"]
        WH[Webhook Handler\nDelivery receipts · Token cleanup]
        DB[(Notification DB\nCassandra / DynamoDB\n512 MB/s write at 1M/sec)]
    end

    A1 & A2 & A3 --> LB
    LB --> B1 & B2 & B3
    B1 & B2 & B3 --> C
    C -->|priority = critical\n1:1 user| D1
    C -->|priority = promotional\n1:N campaign| D2
    D1 --> Q1 & Q2 & Q3
    D2 --> Q1 & Q2 & Q3
    Q1 --> W1
    Q2 --> W2
    Q3 --> W3
    W1 -->|check prefs · render · call| P1
    W2 -->|check prefs · render · call| P2
    W3 -->|check prefs · render · call| P3
    P1 & P2 & P3 -->|async webhooks| WHLB
    WHLB --> WH
    WH --> DB
    C --> DB

    style LB fill:#e0e7ff,stroke:#4338ca,color:#1e1b4b
    style WHLB fill:#e0e7ff,stroke:#4338ca,color:#1e1b4b
    style Q1 fill:#fef9c3,stroke:#ca8a04
    style Q2 fill:#fef9c3,stroke:#ca8a04
    style Q3 fill:#fef9c3,stroke:#ca8a04
    style DB fill:#dbeafe,stroke:#1d4ed8
```

**Key talking points:**
- **Two places where load balancing happens, but they work differently:**
  - **HTTP (sync path):** A real load balancer (ALB/GCP LB) in front of API pods and Webhook Handler pods. Distributes HTTP requests by round-robin or least-connections.
  - **Async dispatch path:** Kafka's consumer group protocol acts as the load balancer — each partition is assigned to exactly one worker pod at a time. No separate LB needed. Workers don't need a LB because they *pull* from Kafka rather than receive pushed requests.
- API pods are stateless → easy horizontal scale behind the LB
- Webhook Handler also needs a LB because providers call back via HTTP (same pattern as the API layer)
- Fan-out workers and dispatch workers are Kafka consumers — they self-organize via consumer group rebalancing when pods are added or removed

---

## Diagram 2 — Transactional vs Campaign Flow (Two Paths)

> **When to use:** When asked "how does an OTP vs a marketing blast differ?"

```mermaid
sequenceDiagram
    participant C as Caller<br/>(Auth Service)
    participant API as API Layer
    participant NS as Notification Service
    participant DB as Database
    participant Q as Channel Queue
    participant W as Dispatch Worker
    participant P as Provider (Twilio/APNs)

    rect rgb(220, 252, 231)
        Note over C,P: PATH 1 — Transactional (OTP, 2FA, Password Reset)
        C->>API: POST /notify {user:123, type:OTP, channel:SMS}
        API->>NS: validate + enrich
        NS->>DB: INSERT notification (status=queued, priority=critical)
        NS->>Q: enqueue job (no fan-out needed — 1 user)
        API-->>C: 202 Accepted {notification_id}

        W->>Q: poll job
        W->>DB: check preferences (critical → skip opt-out check)
        W->>W: check expires_at (OTP: 90s window)
        W->>P: call provider with idempotency_key
        P-->>W: HTTP 200 + provider_message_id
        W->>DB: UPDATE status=dispatched, provider_message_id=...
    end

    rect rgb(219, 234, 254)
        Note over C,P: PATH 2 — Campaign (Marketing Blast to 20M Users)
        C->>API: POST /campaigns {cohort: premium_users, template: promo_v3}
        API->>NS: validate + enrich
        NS->>DB: INSERT campaign (status=pending)
        NS->>Q: enqueue 1 fan-out job
        API-->>C: 202 Accepted {campaign_id}

        Note over W,DB: Fan-out worker runs asynchronously
        W->>DB: SELECT users WHERE premium LIMIT 1000 (cursor-based)
        W->>Q: batch enqueue 1000 per-user jobs
        W->>DB: UPDATE campaign SET cursor=last_user_id (checkpoint)
        Note over W: Repeat until all 20M users processed
    end
```

**Key talking points:**
- Transactional: 1 DB row → 1 queue job → 1 provider call
- Campaign: 1 DB row → 1 fan-out job → 20M queue jobs → 20M provider calls
- Both return `202 Accepted` immediately — caller never waits for delivery

---

## Diagram 3 — Fan-out State Machine with Checkpointing

> **When to use:** When asked "how do you handle crashes during fan-out?" or "how do you send to 20M users without duplicates?"

```mermaid
flowchart TD
    Start([Campaign Created\nstatus = pending]) --> Enqueue

    Enqueue[Enqueue 1 fan-out job\nto fan-out queue] --> FW

    subgraph FW["Fan-out Worker Loop"]
        R[Read checkpoint\ncursor = last_fanned_out_user_id]
        Q1[Query DB\nSELECT user_id WHERE cohort\nAND id > cursor\nLIMIT 1000]
        Create[Create 1000 per-user\nnotification jobs]
        Upsert[DB INSERT notification\nON CONFLICT campaign_id+user_id\nDO NOTHING ← dedup guard]
        Enq[Enqueue 1000 jobs\nto channel queues]
        Save[Checkpoint cursor\nUPDATE campaign SET\nlast_fanned_out_user_id = batch.last]
        Check{More users?}
        Done([Campaign status = dispatched])
    end

    subgraph Crash["Worker Crash Recovery"]
        Restart[New worker picks up job\nfrom queue]
        Resume[Read checkpoint from DB\nResume from cursor]
    end

    FW --> R --> Q1 --> Create --> Upsert --> Enq --> Save --> Check
    Check -->|yes| Q1
    Check -->|no| Done

    Enq -.->|worker crashes here| Restart
    Restart --> Resume
    Resume --> Q1

    style Upsert fill:#fef9c3,stroke:#ca8a04
    style Save fill:#dcfce7,stroke:#16a34a
    style Restart fill:#fee2e2,stroke:#dc2626
```

**Key talking points:**
- Checkpoint after every 1000-user batch → at most 999 users re-processed on crash
- `UNIQUE(campaign_id, user_id)` constraint blocks duplicate notification rows even if re-processed
- Two-part idempotency: checkpoint (skip already-processed users) + DB constraint (prevent duplicate rows)

---

## Diagram 4 — Notification Status State Machine

> **When to use:** When asked "how do you model notification state?" or "how do you detect stuck workers?"

```mermaid
stateDiagram-v2
    [*] --> queued : API ingests notification\nDB write (durability anchor)

    queued --> dispatching : Worker claims job\nATOMIC UPDATE WHERE status=queued\n(only one worker wins)

    dispatching --> dispatched : Provider call succeeds\nWrite provider_message_id to DB

    dispatched --> delivered : Provider webhook fires\n(SendGrid delivery event / APNs feedback)

    dispatching --> queued : Recovery job\nstuck > 30s + no provider_message_id\n→ safe to retry

    dispatching --> dispatched : Recovery job\nstuck > 30s + provider_message_id exists\n→ query provider API to confirm

    dispatched --> failed : Webhook: permanent rejection\n(BadDeviceToken, Unregistered)

    queued --> expired : expires_at has passed\nbefore worker picks it up

    dispatching --> expired : expires_at passed\nduring retry window

    queued --> dlq : max_retries exceeded\nor permanent error

    dispatching --> dlq : Repeated failures\nafter recovery attempts

    delivered --> [*]
    expired --> [*]
    dlq --> [*] : Alert on-call if\ncritical DLQ depth > 100

    note right of dispatching
        This is the "in-flight" state.
        A notification stuck here > 30s
        signals a crashed worker.
        Recovery checks provider_message_id
        to determine if provider was called.
    end note
```

**Key talking points:**
- `dispatching` is the "in-flight" flag — prevents two workers from claiming the same job
- `provider_message_id` is the recovery key: lets you query the provider to confirm delivery after a crash
- Critical DLQ alert fires at depth > 100 (should be near-zero in healthy system)

---

## Diagram 5 — Priority Queue System (Critical vs Promotional)

> **When to use:** When asked "how do you guarantee OTPs are never delayed by a marketing blast?"

```mermaid
flowchart TD
    Incoming[Incoming Notification Jobs] --> PriorityCheck{Priority?}

    PriorityCheck -->|critical\nOTP · Security · Fraud| CQ
    PriorityCheck -->|promotional\nMarketing · Recs| PQ

    subgraph CQ["Critical Queue\n(Kafka: notifications.critical)"]
        CQ1[Partition 0]
        CQ2[Partition 1]
        CQ3[Partition ...]
    end

    subgraph PQ["Promotional Queue\n(Kafka: notifications.promotional)"]
        PQ1[Partition 0]
        PQ2[Partition 1]
        PQ3[Partition ...]
    end

    subgraph WorkerFleet["Dispatch Worker Fleet (100 pods total)"]
        CW["🟥 Critical Workers\n80 pods permanently assigned\nALERT if queue depth > 1K"]
        PW["🟦 Promotional Workers\n20 pods\nCan be paused during incidents\nALERT if no drain for 30 min"]
    end

    CQ --> CW
    PQ --> PW

    CW -->|check preferences\nskip opt-out check for critical| Provider
    PW -->|check preferences\nhonor opt-out · rate cap · quiet hours| Provider

    Provider[External Providers\nAPNs · FCM · SendGrid · Twilio]

    subgraph Rules["Critical Bypass Rules"]
        R1[✅ Bypasses user rate cap]
        R2[✅ Bypasses quiet hours\nwill wake the user if needed]
        R3[✅ Bypasses marketing opt-out]
        R4[✅ Never delayed or throttled]
    end

    subgraph PromRules["Promotional Rules"]
        P1[❌ Blocked if daily cap reached\nRedis INCR check]
        P2[❌ Delayed during quiet hours\nvisible_after = end of quiet window]
        P3[❌ Blocked if unsubscribed\ncheck at dispatch time]
        P4[❌ Dropped if expires_at passed]
    end

    CW -.-> Rules
    PW -.-> PromRules

    style CQ fill:#fee2e2,stroke:#dc2626
    style PQ fill:#dbeafe,stroke:#1d4ed8
    style CW fill:#fee2e2,stroke:#dc2626
    style PW fill:#dbeafe,stroke:#1d4ed8
```

**Key talking points:**
- Separate Kafka topics = physical isolation, not just logical priority
- 80/20 worker split: can temporarily reassign promotional workers to critical during an incident
- Critical notifications skip ALL gating: no opt-out, no quiet hours, no rate cap

---

## Diagram 6 — Dispatch Worker Internal Flow

> **When to use:** When asked "what does a dispatch worker actually do?" or "where do you check user preferences?"

```mermaid
flowchart TD
    Start([Worker picks job\nfrom channel queue]) --> Claim

    Claim["Atomic claim\nUPDATE notifications\nSET status = 'dispatching'\nWHERE id = :id\nAND status = 'queued'"]

    Claim -->|"UPDATE rows = 0\n(another worker won)"| Drop([Discard — safe to ignore])
    Claim -->|"UPDATE rows = 1\n(this worker won)"| ExpCheck

    ExpCheck{expires_at\npassed?}
    ExpCheck -->|yes| Expire[Mark status = expired\nMove to DLQ\nNo provider call]
    ExpCheck -->|no| PrefCheck

    PrefCheck["Check user preferences\nfrom Redis/DynamoDB\nIs channel allowed?\nIs user subscribed?\nGDPR deleted?"]
    PrefCheck -->|blocked| Skip[Mark status = skipped\nLog reason]
    PrefCheck -->|allowed| Render

    Render["Render template\nFetch user vars from\nProfile Service cache\nInterpolate message body"]
    Render --> RateCheck

    RateCheck["Shared backoff check\nGET provider:backoff_until\nfrom Redis"]
    RateCheck -->|backoff active| Requeue["Requeue with\nvisible_after = backoff_until"]
    RateCheck -->|clear| Call

    Call["Call provider\nwith idempotency_key =\nhash(campaign_id + user_id + channel)\n\nLog provider_message_id\nBEFORE updating DB"]

    Call -->|HTTP 200| Success["UPDATE status = dispatched\nprovider_message_id = :sid\nACK queue message"]
    Call -->|429 Too Many Requests| Backoff429["Write backoff_until to Redis\nAll workers see this signal\nRequeue with delay"]
    Call -->|4xx permanent| DLQ["Move to DLQ\nInvalidate stale token\nif BadDeviceToken / Unregistered"]
    Call -->|5xx / timeout| Retry["Exponential backoff + jitter\ndelay = random() × min(300s, 1s × 2^attempt)\nRequeue"]

    Retry -->|attempts > max_retries| DLQ

    style Claim fill:#fef9c3,stroke:#ca8a04
    style DLQ fill:#fee2e2,stroke:#dc2626
    style Success fill:#dcfce7,stroke:#16a34a
```

**Key talking points:**
- Atomic claim (`UPDATE WHERE status='queued'`) prevents two workers processing the same job
- Preference check at dispatch time — not at ingestion — catches late unsubscribes
- `provider_message_id` logged before DB update: recovery key if worker crashes after provider call
- Shared Redis backoff signal: first worker to see 429 signals all others

---

## Diagram 7 — Failure Handling: Circuit Breaker + DLQ

> **When to use:** When asked "what happens when Twilio goes down?" or "how do you handle provider outages?"

```mermaid
stateDiagram-v2
    [*] --> CLOSED : Normal operation

    CLOSED --> OPEN : 3 consecutive failures\nor error rate > 5%\nwithin 10s window

    OPEN --> HALF_OPEN : 30 second timeout\n(exponential backoff per reopen)

    HALF_OPEN --> CLOSED : 1 probe request succeeds\nProvider recovered ✅

    HALF_OPEN --> OPEN : Probe request fails\nProvider still down ❌\nTimeout doubles

    note right of CLOSED
        All traffic flows normally.
        Workers call Twilio / SendGrid / APNs.
        Error rate tracked in sliding window.
    end note

    note right of OPEN
        Workers immediately route to
        secondary provider (Vonage / Mailgun).
        No requests sent to primary.
        Critical OTPs: failover < 5 seconds.
        Promotional: queue until primary recovers.
    end note

    note right of HALF_OPEN
        One probe request allowed.
        If success → reopen primary.
        If fail → extend backoff.
    end note
```

```mermaid
flowchart LR
    subgraph Retry["Retry Strategy"]
        A0["Attempt 0\ndelay: 0–1s"]
        A1["Attempt 1\ndelay: 0–2s"]
        A2["Attempt 2\ndelay: 0–4s"]
        A3["Attempt 3\ndelay: 0–8s"]
        A4["Attempt 4\ndelay: 0–16s"]
        A5["Attempt 5\ndelay: 0–32s"]
        ADLQ["Max retries\nexceeded\n→ DLQ"]

        A0 -->|fail| A1
        A1 -->|fail| A2
        A2 -->|fail| A3
        A3 -->|fail| A4
        A4 -->|fail| A5
        A5 -->|fail| ADLQ
    end

    subgraph DLQ["Dead-Letter Queue"]
        D1["Permanent provider rejection\nBadDeviceToken · Unregistered\ninvalid_email"]
        D2["TTL expired\nOTP 90s window passed\nDelivering would confuse user"]
        D3["Max retries exceeded\nAfter 5–10 attempts"]
    end

    subgraph Alerts["DLQ Alerts"]
        AL1["Critical DLQ > 100\n→ Page on-call immediately"]
        AL2["Promotional DLQ > 10K\n→ Warning: provider issue"]
    end

    DLQ --> Alerts

    style ADLQ fill:#fee2e2,stroke:#dc2626
    style DLQ fill:#fee2e2,stroke:#dc2626
    style Alerts fill:#fef9c3,stroke:#ca8a04
```

**Key talking points:**
- Circuit breaker prevents hammering a downed provider (separate per channel — Twilio outage doesn't affect APNs)
- Full jitter formula: `delay = random() × min(cap=300s, 1s × 2^attempt)` — prevents thundering herd on recovery
- DLQ is not just a graveyard — it's observable (depth metric drives alerts)

---

## Diagram 8 — Multi-Region Architecture (GDPR Compliance)

> **When to use:** When asked "how do you handle EU users?" or "how do you scale globally?"

```mermaid
flowchart TD
    subgraph Global["Global Layer (Replicated Everywhere)"]
        GM[(Global Metadata DB\nCampaign records\nUser → home_region mapping)]
    end

    subgraph US["US-East Region"]
        USAPI[API Gateway]
        USNS[Notification Service]
        USQ[Channel Queues]
        USW[Dispatch Workers\nUS provider credentials]
        USDB[(US User Data\nTokens · Preferences\nDelivery status)]
    end

    subgraph EU["EU-West Region (Frankfurt)"]
        EUAPI[API Gateway]
        EUNS[Notification Service]
        EUQ[Channel Queues]
        EUW[Dispatch Workers\nEU provider credentials]
        EUDB[(EU User Data\nTokens · Preferences\nDelivery status\n🔒 GDPR: never leaves EU)]
    end

    subgraph Routing["Routing Logic for Campaign Fan-out"]
        R1["For each user in campaign cohort:\n1. Look up home_region from Global DB\n2. Route job to that region's queue\n3. Dispatch worker in that region calls provider"]
    end

    Campaign[Campaign Created\n(any region)] --> GM
    GM --> Routing
    Routing -->|user.home_region = US| USQ
    Routing -->|user.home_region = EU| EUQ

    USAPI --> USNS --> USQ --> USW --> USDB
    EUAPI --> EUNS --> EUQ --> EUW --> EUDB

    USW -->|APNs US endpoint\nFCM US\nSendGrid US| USProviders[US Providers]
    EUW -->|APNs EU endpoint\nFCM EU\nSendGrid EU| EUProviders[EU Providers]

    style EUDB fill:#dcfce7,stroke:#16a34a
    style EUW fill:#dcfce7,stroke:#16a34a
    style EUQ fill:#dcfce7,stroke:#16a34a
```

**Key talking points:**
- EU user data (tokens, preferences, delivery records) never leaves EU infrastructure — GDPR requirement
- Campaign metadata is global (who to send, what template); user data is region-local
- Fan-out job routes per-user jobs to the correct regional queue
- Lower APNs/FCM latency as a bonus: regional provider endpoints

---

## Diagram 9 — Per-User Preference and Rate Control

> **When to use:** When asked "how do you implement quiet hours?" or "how do you prevent notification fatigue?"

```mermaid
flowchart TD
    Job[Notification Job arrives at Dispatch Worker] --> Step1

    subgraph Step1["Step 1: Priority Check"]
        PC{priority =\ncritical?}
        PC -->|yes| DirectDispatch[Skip all gates below\n→ Go straight to provider]
        PC -->|no| Step2
    end

    subgraph Step2["Step 2: Daily Rate Cap Check\n(Redis INCR)"]
        RC["key: notif:cap:{userId}:{channel}:{dayBucket}\nINCR → compare to daily limit\npush: 10/day · email: 3/day · SMS: 5/day"]
        RC -->|over cap| DropRC[Drop silently\nLog reason: rate_cap_exceeded]
        RC -->|under cap| Step3
    end

    subgraph Step3["Step 3: Quiet Hours Check"]
        QH["Load user IANA timezone\nAmerica/New_York NOT -5\nCompute local hour"]
        QH -->|inside quiet window\n10PM–8AM local| Delay["Delay notification\nSET job visible_after =\nnextQuietHoursEnd in UTC\nJob sits in queue, not dropped"]
        QH -->|outside quiet window| Step4
    end

    subgraph Step4["Step 4: Unsubscribe Check\n(always at dispatch, never at ingestion)"]
        US["Read from Redis/DynamoDB\nuser_prefs:{userId}\ncheck: channel.enabled\nproduct.category.allowed\nGDPR deletion status"]
        US -->|unsubscribed or deleted| DropUS[Mark skipped\nLog reason: unsubscribed]
        US -->|subscribed| Dispatch
    end

    Dispatch[Render template + Call provider] --> Done([Notification sent ✅])

    style DirectDispatch fill:#dcfce7,stroke:#16a34a
    style DropRC fill:#fee2e2,stroke:#dc2626
    style DropUS fill:#fee2e2,stroke:#dc2626
    style Delay fill:#fef9c3,stroke:#ca8a04
```

**Key talking points:**
- Critical notifications skip all 4 gates — OTPs must always get through
- Quiet hours = **delay**, not drop — the notification is rescheduled to 8 AM local time
- Unsubscribe checked at dispatch (not ingestion) — catches users who opt out during a 4-hour campaign fan-out
- Rate cap uses Redis sliding window: `INCR` + 24h TTL = O(1) check

---

## Diagram 10 — Capacity at 1M Notifications/sec

> **When to use:** When asked "how would you scale this to 1M/sec?" Show the math, not just "scale horizontally."

```mermaid
flowchart LR
    subgraph Input["Traffic Split at 1M/sec"]
        I1["🔔 Push\n700K/sec (70%)"]
        I2["📧 Email\n200K/sec (20%)"]
        I3["📱 SMS\n100K/sec (10%)"]
    end

    subgraph KafkaPartitions["Kafka Partitions\n(50K msg/sec per partition)"]
        KP1["Push Queue\n16 partitions\n(14 needed + 2 headroom)"]
        KP2["Email Queue\n8 partitions\n(4 needed + 4 headroom)"]
        KP3["SMS Queue\n4 partitions\n(2 needed + 2 headroom)"]
    end

    subgraph Workers["Dispatch Worker Fleet"]
        W1["Push Workers\n350 pods\n2 FCM HTTP/2 connections each\n= 700 connections @ 1K req/sec = 700K/sec ✅"]
        W2["Email Workers\n333 pods\n1 SendGrid API key each\n@ 600 req/sec = 200K/sec ✅"]
        W3["SMS Workers\n1000 threads\nTwilio 10DLC @ 100 SMS/sec\n= 100K/sec ✅"]
    end

    subgraph Storage["Write Storage\n1M rows/sec × 512 bytes = 512 MB/s"]
        DB["Cassandra or DynamoDB\n6+ nodes (Cassandra @ 200 MB/s/node)\nSharded by user_id % N\nNOT by timestamp (hot partition)"]
    end

    I1 --> KP1 --> W1
    I2 --> KP2 --> W2
    I3 --> KP3 --> W3
    W1 & W2 & W3 --> DB

    style DB fill:#dbeafe,stroke:#1d4ed8
    style W1 fill:#dcfce7,stroke:#16a34a
    style W2 fill:#dcfce7,stroke:#16a34a
    style W3 fill:#dcfce7,stroke:#16a34a
```

**Key numbers to memorize:**
| Resource | Number | Why |
|---|---|---|
| Kafka partitions (push) | 16 | 700K/sec ÷ 50K per partition |
| Push worker pods | 350 | 700 FCM connections ÷ 2 per pod |
| Email worker pods | 333 | 200K/sec ÷ 600 req/sec per API key |
| SMS worker threads | 1000 | 100K/sec ÷ 100 SMS/sec per 10DLC |
| DB write I/O | 512 MB/s | 1M rows × 512 bytes |
| DB technology | Cassandra/DynamoDB | Relational DB maxes out at ~50 MB/s writes |

---

## Quick Interview Reference

### The 5 most important design decisions (and why)

| Decision | Why it matters | Alternative (wrong) |
|---|---|---|
| Queue between ingestion and dispatch | Decouples provider latency from API latency; enables retries without blocking callers | Synchronous dispatch — provider slowdown stalls your API |
| Separate queues per channel | Independent scaling, failure isolation, rate limiting | Shared queue — email backlog starves OTP pushes |
| Check preferences at dispatch, not ingestion | Catches late opt-outs; correct for DLQ replays | Check at ingestion — user who unsubscribes during fan-out still gets notified |
| Write DB record before enqueuing | Notification is durable even if enqueue crashes | Enqueue first — crash between enqueue and DB write → invisible loss |
| `UNIQUE(campaign_id, user_id)` constraint | Prevents fan-out duplicates even if worker re-processes a batch | No constraint — crashed + restarted fan-out sends duplicate notifications |

### The 4 SLOs

| SLO | Target | What it catches |
|---|---|---|
| Critical P95 end-to-end latency | < 5 seconds | Queue buildup, worker slowdown, provider degradation |
| Dispatch error rate | < 0.1% | Systematic provider issues, config errors |
| Critical DLQ depth | < 100 messages | Users not receiving OTPs / security alerts |
| Fan-out lag (10M recipients) | < 10 minutes | Fan-out bottleneck, slow DB queries |

---

## Diagram 11 — Redundancy at Every Layer + Channel Fallback Chain

> **When to use:** When asked "what are your SPOFs?" or "how does this system survive failures?" Two sub-diagrams: infrastructure redundancy by layer, then the application-level channel fallback chain.

### Part A — Infrastructure Redundancy by Layer

```mermaid
flowchart TD
    subgraph LBLayer["Load Balancer\nAWS ALB / GCP LB"]
        LB["⚖️ Multi-AZ by default\nDistributed across all AZs\n✅ Survives: 1 AZ failure\n⏱ Recovery: instant"]
    end

    subgraph APILayer["API Pods + Webhook Handler Pods\nKubernetes Deployment"]
        API["minReplicas=3 across 3 AZs\nK8s restarts crashed pods\n✅ Survives: pod crash · AZ failure\n⏱ Recovery: pod < 60s · AZ instant"]
    end

    subgraph KafkaLayer["Kafka Cluster"]
        KF["Replication Factor = 3\nmin.insync.replicas = 2\nKRaft leader election\n✅ Survives: 1 broker failure\n⏱ Recovery: leader election < 30s\n📌 Zero data loss — W acknowledged\n   to 2 replicas before producer ACK"]
    end

    subgraph WorkerLayer["Dispatch + Fan-out Workers\nKubernetes + Kafka Consumer Groups"]
        WK["minReplicas=3 across 3 AZs\nKafka rebalances partitions on pod crash\n✅ Survives: pod crash\n⏱ Recovery: partition reassigned < 10s\nIn-flight jobs re-queued after visibility timeout"]
    end

    subgraph RedisLayer["Redis\nSentinel (3 nodes) or Cluster"]
        RD["Auto-failover: Sentinel promotes replica\n✅ Survives: 1 master failure\n⏱ Recovery: < 30s\n⚠️ Brief write loss acceptable\n   Redis stores rate caps + backoff signals,\n   NOT notification records"]
    end

    subgraph DBLayer["Notification Database\nCassandra or DynamoDB"]
        DB["Cassandra: RF=3 across 3 AZs\nQuorum write W=2, read R=2\nDynamoDB: managed multi-AZ\n✅ Survives: 1 node failure · 1 AZ failure\n⏱ Recovery: transparent\nAnti-entropy repairs lagging nodes"]
    end

    subgraph ProviderLayer["External Providers\nAPNs · FCM · Twilio · SendGrid"]
        PR["❌ Cannot make redundant\n   at infrastructure level\nMitigations:\n  • Circuit breaker → secondary provider\n  • Channel fallback chain (see Part B)\n  • DLQ for manual recovery"]
    end

    LBLayer --> APILayer --> KafkaLayer --> WorkerLayer --> DBLayer
    WorkerLayer --> ProviderLayer

    style LBLayer fill:#dcfce7,stroke:#16a34a
    style APILayer fill:#dcfce7,stroke:#16a34a
    style KafkaLayer fill:#dcfce7,stroke:#16a34a
    style WorkerLayer fill:#dcfce7,stroke:#16a34a
    style RedisLayer fill:#fef9c3,stroke:#ca8a04
    style DBLayer fill:#dcfce7,stroke:#16a34a
    style ProviderLayer fill:#fee2e2,stroke:#dc2626
```

### Part B — Channel Fallback Chain (Application-level Redundancy)

```mermaid
flowchart TD
    Start([Critical notification\nstatus = queued]) --> PushAttempt

    PushAttempt["Dispatch Worker\nAttempt push via APNs/FCM"]
    PushAttempt -->|"HTTP 200\npush delivered ✅"| Done([Done])
    PushAttempt -->|"5xx / timeout\ntransient failure"| Retry["Retry with\nexponential backoff\nup to max_retries"]
    Retry -->|"success"| Done
    Retry -->|"max retries exceeded"| DLQ1[DLQ — systemic issue]

    PushAttempt -->|"Unregistered\nBadDeviceToken\nPERMANENT failure"| PushFailed

    PushFailed["Mark push channel = failed\nInvalidate stale token in DB\nCreate new notification record:\n  parent_notification_id = original.id\n  channel = 'sms'\n  idempotency_key = hash(original.id + 'sms')"]

    PushFailed --> SMSAttempt["Dispatch Worker\nAttempt SMS via Twilio"]
    SMSAttempt -->|"SMS delivered ✅"| Done
    SMSAttempt -->|"5xx / timeout"| Retry2["Retry with backoff"]
    Retry2 -->|success| Done
    Retry2 -->|max retries| DLQ2[DLQ]

    SMSAttempt -->|"InvalidNumber\nPERMANENT failure"| SMSFailed

    SMSFailed["Create new notification record:\n  parent_notification_id = original.id\n  channel = 'email'\n  idempotency_key = hash(original.id + 'email')"]

    SMSFailed --> EmailAttempt["Dispatch Worker\nAttempt email via SendGrid"]
    EmailAttempt -->|"Email delivered ✅"| Done
    EmailAttempt -->|"All attempts failed"| DLQ3["DLQ\nPage on-call\nNo more channels available"]

    subgraph Rules["Rules"]
        R1["✅ Critical notifications only\n   Promotional = no fallback"]
        R2["✅ Trigger = permanent rejection only\n   Transient 5xx → retry, not fallback"]
        R3["✅ New DB record per fallback\n   parent_notification_id for audit trail"]
        R4["✅ New idempotency key per channel\n   hash(original_id + channel_name)"]
    end

    style Done fill:#dcfce7,stroke:#16a34a
    style DLQ1 fill:#fee2e2,stroke:#dc2626
    style DLQ2 fill:#fee2e2,stroke:#dc2626
    style DLQ3 fill:#fee2e2,stroke:#dc2626
    style PushFailed fill:#fef9c3,stroke:#ca8a04
    style SMSFailed fill:#fef9c3,stroke:#ca8a04
```

**Key talking points:**
- Every green layer in Part A is self-healing — no human intervention required on failure
- The only red layer is external providers — this is the irreducible risk; circuit breaker (Diagram 7) + fallback chain (Part B) are the mitigations
- Redis is yellow: the brief write-loss window on failover is acceptable because Redis stores soft state (rate caps, backoff signals), not notification records
- Part B fallback fires on **permanent** rejection only — transient 5xx goes through the normal retry loop first
- `parent_notification_id` is the audit field that lets you reconstruct "we tried push, it failed permanently, then sent SMS" from the notification table
