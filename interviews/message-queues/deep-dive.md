# Deep Dive: Message Queues & Event Streaming

> Three-tiered depth: 🟢 Phone Screen → 🟡 Onsite → 🔴 Staff+ deep dive

---

## 🟢 Phone Screen Essentials (10 min read)

**What you must know cold**:
1. Why async over sync
2. Queue vs topic
3. At-least-once with idempotency
4. Kafka partition ordering
5. Consumer lag concept

### Why Message Queues?

```text
Synchronous:
  User → Order Service → [wait] → Payment Service → [wait] → Inventory
  Total latency: sum of all service latencies
  One failure = entire request fails

Asynchronous:
  User → Order Service → [return] (200ms)
       ↓ (async)
  [Queue] → Payment Service (processes later)
         → Inventory Service (processes later)
  User gets fast response, failures are isolated
```

### The Three Guarantees

| Guarantee | Behavior | Use When |
|---|---|---|
| At-most-once | May lose, no duplicates | Metrics, logs (loss OK) |
| At-least-once | No loss, may duplicate | Most use cases |
| Exactly-once | No loss, no duplicates | Payments (complex to achieve) |

**Interview tip**: Always default to "at-least-once + idempotent consumer" as your answer.

### Kafka Partition Model

```text
Topic: orders (3 partitions)

Partition 0: [order1, order4, order7] ← ordered within partition
Partition 1: [order2, order5, order8] ← ordered within partition
Partition 2: [order3, order6, order9] ← ordered within partition

Partition key = user_id
  → same user's orders always in same partition
  → ordering guaranteed for that user
```

### Phone Screen Sample Q&A

**Q**: "How would you ensure order events for the same customer are processed in order?"

**A**: "Use the customer ID as the Kafka partition key. All events for a customer will go to the same partition, and Kafka guarantees ordering within a partition. The consumer will process them in order."

---

## 🟡 Onsite Deep Dive (30 min read)

### Transactional Outbox Pattern

**The Problem**: Dual-write inconsistency.

```python
# DANGEROUS
def create_order(order):
    db.save(order)  # What if this succeeds...
    kafka.send("order.created", order)  # ...and this fails?
    # DB has order, but no event was sent!
```

**The Solution**: Single atomic write to DB.

```sql
-- Orders table
CREATE TABLE orders (
    id UUID PRIMARY KEY,
    user_id UUID,
    amount DECIMAL,
    status VARCHAR(20)
);

-- Outbox table (same transaction boundary)
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(50),  -- 'Order'
    aggregate_id UUID,           -- order.id
    event_type VARCHAR(100),     -- 'order.created'
    payload JSONB,               -- full event data
    created_at TIMESTAMP,
    published BOOLEAN DEFAULT FALSE
);
```

```python
# SAFE
def create_order(order):
    with db.transaction():
        db.save(order)
        db.save(OutboxEvent(
            aggregate_type='Order',
            aggregate_id=order.id,
            event_type='order.created',
            payload=order.to_json()
        ))
    # Both writes succeed or both fail
```

**Outbox Processor** (separate service):
```python
def poll_and_publish():
    events = db.query("""
        SELECT * FROM outbox_events 
        WHERE published = FALSE 
        ORDER BY created_at 
        LIMIT 100 
        FOR UPDATE SKIP LOCKED
    """)
    
    for event in events:
        kafka.send(event.event_type, event.payload)
        db.update(event.id, published=True)
```

### Exactly-Once in Practice

**Myth**: "Kafka has exactly-once, so I don't need to worry about duplicates."

**Reality**: Kafka EOS is only broker-internal. For end-to-end exactly-once:

```text
Producer → Kafka (EOS) → Consumer → External System
                                         ↑
                           External call can still duplicate!
```

**Solution**: Consumer-side idempotency.

```python
def process_payment(event):
    idempotency_key = f"payment_{event['order_id']}"
    
    # Idempotency check BEFORE external call
    if redis.exists(idempotency_key):
        log.info(f"Already processed: {idempotency_key}")
        return
    
    # Set key with TTL (prevents reprocessing if crash before completion)
    redis.set(idempotency_key, "processing", ex=3600)
    
    try:
        # External call with idempotency key
        stripe.charges.create(
            amount=event['amount'],
            idempotency_key=idempotency_key
        )
        redis.set(idempotency_key, "completed")
    except Exception:
        redis.delete(idempotency_key)  # Allow retry
        raise
```

### Dead Letter Queue Strategy

```text
Main Topic: orders
       ↓
Consumer processes
       ↓
Failure? ──→ Retry topic (with backoff)
              ↓
          Retry consumer
              ↓
          Failure (max retries)? ──→ DLQ topic
                                        ↓
                                    Manual review + alerts
```

```python
class RobustConsumer:
    MAX_RETRIES = 5
    RETRY_TOPIC = "orders.retry"
    DLQ_TOPIC = "orders.dlq"
    
    def consume(self, message):
        retry_count = message.headers.get('retry_count', 0)
        
        try:
            self.process(message)
        except RecoverableError:
            if retry_count < self.MAX_RETRIES:
                self.send_to_retry(message, retry_count + 1)
            else:
                self.send_to_dlq(message, "max_retries_exceeded")
        except UnrecoverableError as e:
            self.send_to_dlq(message, str(e))
    
    def send_to_retry(self, message, retry_count):
        delay = 2 ** retry_count  # Exponential backoff
        kafka.send(
            self.RETRY_TOPIC,
            value=message.value,
            headers={'retry_count': retry_count, 'retry_at': time() + delay}
        )
```

### Consumer Group Rebalancing

**The problem**: Rebalancing causes **stop-the-world** pause.

```text
Normal operation:
  Consumer A → Partition 0, 1
  Consumer B → Partition 2, 3

Consumer C joins:
  STOP all consumers
  Reassign: 
    Consumer A → Partition 0, 1
    Consumer B → Partition 2
    Consumer C → Partition 3
  RESUME
```

**Mitigation strategies**:

| Strategy | How | Benefit |
|---|---|---|
| Static membership | Set `group.instance.id` | No rebalance on restart |
| Cooperative rebalancing | `partition.assignment.strategy=cooperative-sticky` | Incremental, no stop-the-world |
| Longer session timeout | `session.timeout.ms=60000` | Fewer false rebalances |

```java
// Cooperative rebalancing config
props.put("partition.assignment.strategy", 
    "org.apache.kafka.clients.consumer.CooperativeStickyAssignor");
```

### Onsite System Design: Event-Driven Order Flow

**Requirements**:
- Process 10K orders/sec
- Ensure inventory consistency
- Handle payment failures gracefully
- Support order status queries

```text
┌─────────────────────────────────────────────────────────────────┐
│                    Event-Driven Order System                    │
└─────────────────────────────────────────────────────────────────┘

API Gateway → Order Service (stateless)
                   │
                   ▼
             ┌─────────────┐
             │ PostgreSQL  │ ← Write order + outbox event
             │ (orders DB) │
             └─────────────┘
                   │
                   ▼
         ┌────────────────────┐
         │ Outbox Processor   │ ← Poll + publish
         └────────────────────┘
                   │
                   ▼
         ┌────────────────────┐
         │  Kafka: orders     │ ← 10 partitions
         └────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
Inventory     Payment        Notification
Consumer      Consumer        Consumer
    │              │              │
    ▼              ▼              ▼
Reserve       Charge         Send email
stock         card           (async, best-effort)
    │              │
    ▼              ▼
┌─────────────┐  ┌─────────────┐
│ inventory.  │  │ payment.    │
│ reserved    │  │ completed   │
└─────────────┘  └─────────────┘
        │              │
        └──────┬───────┘
               ▼
         Order Saga
         Coordinator
               │
               ▼
       ┌───────────────┐
       │ Update order  │
       │ status to     │
       │ 'completed'   │
       └───────────────┘
```

---

## 🔴 Staff+ Deep Dive (60 min read)

### Real-World Case Studies

#### 1. LinkedIn: Activity Stream Processing

**Scale**: 7 trillion messages/day, 4+ million messages/sec peak.

**Architecture**:
```text
User actions → Samza (stream processing)
                   │
                   ├─→ Activity Feed (aggregation)
                   ├─→ Notifications (filtering)
                   ├─→ Analytics (real-time metrics)
                   └─→ Search Index (updates)
```

**Key decisions**:
- **Custom Kafka deployment**: LinkedIn wrote Kafka, operates largest cluster
- **Samza for stateful processing**: State stored in RocksDB with changelog backup
- **Multi-datacenter**: Kafka MirrorMaker replicates across DCs

**Ordering guarantee**: Activity events partitioned by member ID. All activities for a user are ordered.

#### 2. Uber: Event-Driven Marketplace

**Use case**: Real-time surge pricing, driver-rider matching.

**Architecture**:
```text
             ┌─────────────────┐
             │  uEvent (Kafka) │
             └─────────────────┘
                     │
    ┌────────────────┼────────────────┐
    ▼                ▼                ▼
Surge Pricing    Matching        ETA Service
(Flink)          Engine          (Flink)
    │                │                │
    ▼                ▼                ▼
Price updates    Trip created     ETA updates
```

**Key patterns**:
- **Event-carried state transfer**: Events contain full state (rider location, driver availability)
- **Schema registry**: Avro schemas with strict compatibility rules
- **Multi-region**: Kafka clusters per region with cross-region replication for analytics

**Lesson**: For Uber, **freshness > consistency**. A slightly stale surge price is acceptable; a delayed surge price is not.

#### 3. Netflix: Asynchronous Microservices

**Challenge**: 200+ microservices, billions of inter-service messages/day.

**Solution**: Three-tier messaging:
```text
Tier 1: Kafka (durable, high-throughput)
  - Event sourcing
  - Analytics pipelines
  
Tier 2: SQS (simple queueing)
  - Job distribution
  - Background tasks
  
Tier 3: Hermes (Netflix internal pub-sub)
  - Fine-grained subscriptions
  - Low-latency notifications
```

**Idempotency pattern**: Every service has idempotency layer.

```java
@IdempotentOperation(keyExpression = "#request.requestId")
public void processRequest(Request request) {
    // If requestId seen before, method is skipped
    // Netflix's idempotency library handles this
}
```

### Failure Mode Analysis

#### Failure Mode 1: Consumer Lag Explosion

**Scenario**: Traffic spike causes consumer lag to grow unbounded.

**Detection**:
```yaml
# Prometheus alert
- alert: KafkaConsumerLagCritical
  expr: kafka_consumer_group_lag > 1000000
  for: 5m
  labels:
    severity: critical
```

**Remediation decision tree**:
```text
Lag growing?
    │
    ├─ Consumer throughput low?
    │       │
    │       ├─ Optimize consumer code
    │       ├─ Increase consumer instances (up to partition count)
    │       └─ Increase partitions (if above limit)
    │
    └─ Producer throughput spiked?
            │
            ├─ Apply backpressure at producer
            ├─ Drop non-critical messages
            └─ Temporarily skip to latest (accept data loss)
```

#### Failure Mode 2: Poison Messages

**Scenario**: Malformed message repeatedly crashes consumer.

**Detection**:
```python
# Track processing attempts per message
class PoisonMessageDetector:
    def __init__(self, redis, threshold=5):
        self.redis = redis
        self.threshold = threshold
    
    def is_poison(self, message_id):
        attempts = self.redis.incr(f"attempts:{message_id}")
        self.redis.expire(f"attempts:{message_id}", 3600)
        return attempts > self.threshold
```

**Remediation**:
1. Send to DLQ
2. Alert on-call
3. Investigate payload
4. Fix consumer or producer

#### Failure Mode 3: Broker Failure

**Scenario**: One Kafka broker goes down.

**Impact**:
- Partitions with leader on that broker become unavailable
- Affected consumers cannot read until new leader elected

**Recovery**:
1. **Automatic leader election**: Controller elects new leader from ISR
2. **If broker in ISR < min.insync.replicas**: Partition rejected writes
3. **Broker returns**: Rejoins as follower, catches up

**Prevention**:
```properties
# Ensure durability
replication.factor=3
min.insync.replicas=2
acks=all
```

### End-to-End Exactly-Once Design

**Problem**: Financial transactions require no duplicates, no losses.

**Architecture**:
```text
┌────────────────────────────────────────────────────────────────┐
│           End-to-End Exactly-Once Payment Processing           │
└────────────────────────────────────────────────────────────────┘

Payment Request
       │
       ▼
┌──────────────────┐
│ API Gateway      │ ← Generate idempotency_key (hash of request)
│ (Deduplication)  │
└──────────────────┘
       │
       ▼
┌──────────────────┐
│ Payment Service  │ ← Check idempotency_key in Redis
│ (Pre-dedup)      │   If exists, return cached response
└──────────────────┘
       │
       ▼
┌──────────────────┐
│ PostgreSQL       │ ← Transaction:
│ (Transactional   │     1. Insert payment record (UNIQUE on idempotency_key)
│  Outbox)         │     2. Insert outbox event
└──────────────────┘
       │
       ▼
┌──────────────────┐
│ Outbox Processor │ ← Poll + publish to Kafka
│ (Exactly-once    │   Use Kafka transactions
│  to Kafka)       │
└──────────────────┘
       │
       ▼
┌──────────────────┐
│ Kafka            │ ← EOS settings:
│ (EOS enabled)    │     enable.idempotence=true
│                  │     transactional.id=payment-processor
└──────────────────┘
       │
       ▼
┌──────────────────┐
│ Ledger Consumer  │ ← Transaction:
│ (Transactional   │     1. Check processed table
│  consumption)    │     2. Update ledger
│                  │     3. Insert into processed table
│                  │     4. Commit Kafka offset
└──────────────────┘
```

**Key invariants**:
1. Every write is idempotent (keyed by idempotency_key)
2. DB writes and event publishing are atomic (outbox)
3. Kafka broker deduplicates (producer idempotency)
4. Consumer deduplicates (processed table)

### Multi-Datacenter Event Streaming

**Pattern 1: Active-Passive**
```text
DC1 (Primary)          DC2 (Standby)
┌─────────┐            ┌─────────┐
│ Kafka   │ ──────────→│ Kafka   │
│ (writes)│  MirrorMaker│ (reads) │
└─────────┘            └─────────┘
```
- All writes to primary
- Failover: promote DC2, redirect traffic

**Pattern 2: Active-Active**
```text
DC1                    DC2
┌─────────┐            ┌─────────┐
│ Kafka   │←──────────→│ Kafka   │
│ (R/W)   │ (bidirectional) │ (R/W)   │
└─────────┘            └─────────┘
```
- Both DCs accept writes
- Need conflict resolution (e.g., last-write-wins)

**Pattern 3: Event Mesh**
```text
         ┌──────────────────┐
         │ Global Router    │
         └──────────────────┘
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
  DC1        DC2        DC3
  Kafka      Kafka      Kafka
```
- Intelligent routing based on event type/audience
- Local consumers get local events, cross-DC events aggregated

### Schema Evolution Strategy

**Compatibility matrix**:

| Change Type | Backward | Forward | Full |
|---|---|---|---|
| Add optional field | ✅ | ✅ | ✅ |
| Remove optional field | ✅ | ✅ | ✅ |
| Add required field | ❌ | ✅ | ❌ |
| Remove required field | ✅ | ❌ | ❌ |
| Rename field | ❌ | ❌ | ❌ |

**Best practice**: Always add fields as optional with defaults.

```protobuf
// Version 1
message Order {
  string id = 1;
  decimal amount = 2;
}

// Version 2 (backward compatible)
message Order {
  string id = 1;
  decimal amount = 2;
  string currency = 3 [default = "USD"];  // New optional field
}
```

### Capacity Planning Formula

```text
Messages/sec: 100,000
Message size (avg): 1 KB
Replication factor: 3
Retention: 7 days

Ingest rate = 100,000 × 1 KB = 100 MB/sec
Total write rate (with replication) = 100 MB/sec × 3 = 300 MB/sec

Storage per day = 100 MB/sec × 86,400 = 8.64 TB
Total storage (7 days) = 8.64 TB × 7 = 60.5 TB

Brokers (for write throughput):
  Each broker handles ~100 MB/sec (conservative)
  300 MB/sec / 100 MB/sec = 3 brokers minimum
  Add 50% buffer = 5 brokers

Storage per broker = 60.5 TB / 5 = 12.1 TB
RAM per broker = 32 GB (for page cache)
Cores per broker = 16 (for network/disk I/O)

Final sizing:
- 5 brokers
- 12 TB disk each (SSD preferred)
- 32 GB RAM each
- 16 cores each
```

---

## Interview Patterns & Anti-Patterns

### Pattern: Answer with Trade-offs

❌ **Bad**: "I would use Kafka because it's the best."

✅ **Good**: "I would use Kafka because we need message replay for analytics and high throughput. If we only needed simple job queueing without replay, RabbitMQ or SQS would be operationally simpler."

### Pattern: Start with Requirements

❌ **Bad**: Jump straight to Kafka architecture.

✅ **Good**: 
1. "What's the throughput requirement?"
2. "Do we need ordering? For all messages or by key?"
3. "What's the latency tolerance?"
4. "Do we need replay capability?"
5. "What's the failure tolerance?"

### Pattern: Address Failure Modes

Always mention:
- What happens if producer fails?
- What happens if broker fails?
- What happens if consumer fails?
- How do you detect and recover?

### Anti-Pattern: Ignoring Idempotency

❌ Never say: "Kafka has exactly-once, so we're fine."

✅ Always say: "Even with Kafka EOS, we need consumer-side idempotency because the consumer might call external systems."

---

## Quick Recall Cheat Sheet

### When to Use What

| Scenario | Technology | Why |
|---|---|---|
| High-throughput event stream | Kafka | Log-based, replay, partitioning |
| Complex routing | RabbitMQ | Exchanges, bindings, headers |
| AWS-native simple queue | SQS | Managed, pay-per-use |
| Stream processing (Kafka source) | Kafka Streams | Library, no cluster |
| Complex stream processing | Flink | Cluster, powerful windowing |

### Delivery Guarantee Decision

```text
Is data loss acceptable? 
  YES → at-most-once
  NO → 
    Are duplicates acceptable?
      YES → at-least-once (default choice)
      NO → at-least-once + idempotent consumer
```

### Kafka Sizing Quick Reference

| Metric | Formula |
|---|---|
| Throughput capacity | brokers × 100 MB/sec |
| Storage needed | MB/sec × 86400 × retention_days × replication |
| Min brokers | replication_factor |
| Max consumers | partition_count |

### Commands to Know

```bash
# Consumer lag
kafka-consumer-groups.sh --describe --group my-group

# Topic details
kafka-topics.sh --describe --topic my-topic

# Reset offset (dangerous!)
kafka-consumer-groups.sh --reset-offsets --to-earliest --execute
```
