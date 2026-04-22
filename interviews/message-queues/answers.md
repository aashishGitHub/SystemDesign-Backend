# Answers: Message Queues & Event Streaming

> Keyed to [questions.md](./questions.md). Read questions first.
> Every answer includes either code or a comparison table so you can defend tradeoffs clearly.

---

## Level 1 — Fundamentals & Motivation

### A1. Why use a message queue instead of direct HTTP calls

| Concern | Direct HTTP | Message Queue |
|---|---|---|
| Coupling | Tightly coupled — caller knows callee | Decoupled — caller sends, forgets |
| Availability | Callee down = caller fails | Callee down = messages queue up |
| Scaling | 1:1 relationship | N producers : M consumers |
| Backpressure | Caller gets overwhelmed | Queue absorbs spikes |
| Retry | Caller must implement | Built-in retry/DLQ |

**Key insight**: Queues trade **immediate response** for **resilience and decoupling**.

```text
Direct HTTP:
  Order Service → [HTTP] → Payment Service
                           ↓ (if down, order fails)

With Queue:
  Order Service → [Queue] → Payment Service
                    ↓
                (buffered if payment is slow/down)
```

---

### A2. Synchronous vs asynchronous communication

| Aspect | Synchronous | Asynchronous |
|---|---|---|
| Caller blocks | Yes, waits for response | No, fire and forget |
| Response time | Included in caller latency | Separate from caller |
| Failure coupling | Immediate cascade | Isolated |

**Example where async is clearly better**: Sending email after user signup.

```python
# Synchronous (bad) — user waits for email to send
def signup(user_data):
    user = db.create_user(user_data)
    email_service.send_welcome_email(user.email)  # Takes 2 seconds!
    return user

# Asynchronous (good) — user gets instant response
def signup(user_data):
    user = db.create_user(user_data)
    queue.publish("user.created", {"user_id": user.id})  # Instant
    return user
```

---

### A3. Decoupling in message queues

**Decoupling** means the producer doesn't know or care:
- Who the consumers are
- How many consumers exist
- Whether consumers are online
- How fast consumers process

```text
Tight coupling:
  Order Service knows → Inventory Service
  Order Service knows → Payment Service
  Order Service knows → Notification Service
  (Change one = change Order Service)

Decoupled:
  Order Service → publishes "order.created" event
  Inventory Service subscribes
  Payment Service subscribes
  Notification Service subscribes
  (Add/remove services without touching Order Service)
```

---

### A4. Backpressure and how queues help

**Backpressure**: When downstream systems can't keep up with upstream traffic.

```text
Without queue:
  Traffic spike (10x normal) → all requests hit Payment Service
  Payment Service overloaded → timeouts → cascading failures

With queue:
  Traffic spike → messages queue up
  Payment Service processes at steady rate
  Queue depth increases, but nothing crashes
  Eventually catches up
```

Queue acts as a **shock absorber** between producer and consumer speed differences.

---

## Level 2 — Messaging Models

### A5. Point-to-point vs publish-subscribe

| Model | Delivery | Use Case |
|---|---|---|
| Point-to-point (Queue) | Each message to ONE consumer | Work distribution, job processing |
| Pub-sub (Topic) | Each message to ALL subscribers | Event broadcasting, notifications |

```text
Point-to-Point:
  Producer → Queue → Consumer A gets msg1
                  → Consumer B gets msg2
                  → Consumer A gets msg3
                  (load balanced)

Pub-Sub:
  Producer → Topic → Consumer A gets msg1
                  → Consumer B gets msg1
                  → Consumer C gets msg1
                  (broadcast)
```

---

### A6. When to use queue vs topic

| Scenario | Model | Why |
|---|---|---|
| Process uploaded images | Queue | Each image processed once |
| Notify all services of user signup | Topic | All services need the event |
| Distribute video encoding jobs | Queue | Each job handled by one worker |
| Broadcast config changes | Topic | All instances need update |

---

### A7. Kafka consumer groups

A **consumer group** is a set of consumers that cooperatively consume a topic.

```text
Topic: orders (3 partitions)
Consumer Group: order-processors

Partition 0 → Consumer A
Partition 1 → Consumer B
Partition 2 → Consumer C

Each message goes to ONE consumer in the group.
Multiple groups = each group gets ALL messages.
```

**Problem solved**: Parallel consumption while maintaining per-partition ordering.

```python
# Python Kafka consumer in a group
consumer = KafkaConsumer(
    'orders',
    group_id='order-processors',  # Consumer group
    bootstrap_servers=['kafka:9092']
)
```

---

### A8. Offline subscriber in pub-sub

| System | Behavior |
|---|---|
| Kafka | Messages retained (configurable). Subscriber reads from last committed offset on reconnect. |
| RabbitMQ (non-durable) | Messages lost if no active subscriber |
| RabbitMQ (durable queue) | Messages persist until consumed |
| AWS SNS | Messages lost if no subscriber endpoint receives |

Kafka's log-based architecture means **messages don't disappear after consumption** — they're retained by time or size limit.

---

### A9. Fan-out pattern

**Fan-out**: One message triggers multiple downstream actions.

```text
Order Created Event
      │
      ├─→ Inventory Service (reserve stock)
      ├─→ Payment Service (charge card)
      ├─→ Email Service (send confirmation)
      └─→ Analytics Service (record event)
```

**Use cases**:
- User signup → create profile, send email, provision resources
- Payment received → update balance, send receipt, trigger fulfillment

---

## Level 3 — Delivery Guarantees

### A10. Three delivery guarantees

| Guarantee | Definition | Data Loss | Duplicates |
|---|---|---|---|
| At-most-once | Message delivered 0 or 1 time | Possible | None |
| At-least-once | Message delivered 1 or more times | None | Possible |
| Exactly-once | Message delivered exactly 1 time | None | None |

```text
At-most-once: Fire and forget (UDP-like)
  send → done (no ack, no retry)

At-least-once: Retry until ack (TCP-like)
  send → wait for ack → if no ack, retry → may duplicate

Exactly-once: At-least-once + deduplication
  send → retry if needed → consumer deduplicates
```

---

### A11. Why exactly-once is hard

**The two generals problem**: In a distributed system, you cannot guarantee that both producer and consumer agree on message state.

```text
Producer sends message → Broker receives → Broker acks → ACK lost in network
Producer thinks: "Message not delivered" → retries
Broker thinks: "Message already stored" → duplicate

OR

Consumer processes message → commits offset → CRASH before commit
Consumer restarts → reprocesses same message
```

**Exactly-once requires**:
1. Idempotent producer (dedup on send)
2. Transactional consumer (atomic process + commit)
3. End-to-end cooperation between producer, broker, consumer

---

### A12. Double payment problem

**What happened**: Consumer processed payment, then crashed before committing offset. On restart, it reprocessed the same message.

```text
1. Consumer reads: "charge customer $100"
2. Consumer calls payment API (success)
3. Consumer crashes BEFORE committing offset
4. Consumer restarts, reads same message (offset not advanced)
5. Consumer calls payment API again — DOUBLE CHARGE
```

**Prevention — Idempotency key**:
```python
def process_payment(event):
    idempotency_key = event['order_id']  # Use order_id as dedup key
    
    # Check if already processed
    if db.payment_exists(idempotency_key):
        return  # Already processed, skip
    
    # Process payment
    payment = payment_api.charge(
        amount=event['amount'],
        idempotency_key=idempotency_key  # Payment API also deduplicates
    )
    
    # Record as processed (inside same transaction as business logic)
    db.record_payment(idempotency_key, payment.id)
```

---

### A13. Kafka exactly-once semantics (EOS)

**Requirements**:
1. `enable.idempotence=true` on producer
2. `transactional.id` set on producer
3. `isolation.level=read_committed` on consumer

```java
// Producer config
props.put("enable.idempotence", true);
props.put("transactional.id", "order-processor");

// Transactional produce
producer.initTransactions();
producer.beginTransaction();
try {
    producer.send(new ProducerRecord<>("orders", key, value));
    producer.commitTransaction();
} catch (Exception e) {
    producer.abortTransaction();
}
```

**How it works**:
- Producer assigns sequence numbers to messages
- Broker deduplicates by producer ID + sequence
- Transactions ensure atomic writes across partitions

---

### A14. Idempotency for at-least-once

**Idempotency**: Applying the same operation multiple times has the same effect as applying it once.

```python
# Non-idempotent (dangerous)
def process_order(order_id):
    balance -= order.amount  # Each call deducts again!

# Idempotent (safe)
def process_order(order_id):
    if order_id in processed_orders:
        return  # Already done
    balance -= order.amount
    processed_orders.add(order_id)
```

**Idempotency strategies**:
| Strategy | How |
|---|---|
| Unique constraint | DB rejects duplicate insert |
| Idempotency key | Check key before processing |
| Version/ETag | Only apply if version matches |
| UPSERT | Insert or update (same result) |

---

## Level 4 — Kafka Deep Dive

### A15. Kafka architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                    Kafka Cluster                            │
├─────────────────────────────────────────────────────────────┤
│  Broker 1           Broker 2           Broker 3            │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐       │
│  │ Topic: orders│   │ Topic: orders│   │ Topic: orders│      │
│  │ Partition 0 │   │ Partition 1 │   │ Partition 2 │       │
│  │ (leader)    │   │ (leader)    │   │ (leader)    │       │
│  │             │   │             │   │             │       │
│  │ Partition 1 │   │ Partition 2 │   │ Partition 0 │       │
│  │ (replica)   │   │ (replica)   │   │ (replica)   │       │
│  └─────────────┘   └─────────────┘   └─────────────┘       │
└─────────────────────────────────────────────────────────────┘

Topic: Logical channel (e.g., "orders")
Partition: Ordered, immutable log of messages
Segment: Physical file storing partition data
Broker: Kafka server hosting partitions
```

---

### A16. Kafka message ordering

**Ordering is guaranteed ONLY within a partition**.

```text
Partition 0: msg1 → msg2 → msg3 (ordered)
Partition 1: msg4 → msg5 → msg6 (ordered)

Global order across partitions? NOT guaranteed.
msg1 might be consumed after msg4.
```

**Implication**: If you need order for related messages, they must go to the same partition (use partition key).

---

### A17. Partition key

The partition key determines which partition receives the message:

```
partition = hash(key) % num_partitions
```

```python
# Messages with same key go to same partition → ordered
producer.send('orders', key='user_123', value=order1)
producer.send('orders', key='user_123', value=order2)
# Guaranteed: order1 before order2 for user_123

# Different keys may go to different partitions
producer.send('orders', key='user_456', value=order3)
# order3 may be consumed before order1 or order2
```

---

### A18. Kafka offsets

| Concept | Definition |
|---|---|
| Log offset | Position of message in partition (0, 1, 2, ...) |
| Current position | Where consumer is currently reading |
| Committed offset | Last offset consumer confirmed as processed |

```text
Partition: [msg0, msg1, msg2, msg3, msg4, msg5]
                                    ↑        ↑
                           committed   current (reading)

Consumer crashes → restarts at committed offset (msg3)
May reprocess msg3, msg4 if not committed
```

```python
# Manual offset commit
consumer.poll()
process_messages()
consumer.commit()  # Mark as processed
```

---

### A19. Kafka replication and ISR

```text
Partition 0:
  Leader: Broker 1
  Followers: Broker 2, Broker 3

Write flow:
  Producer → Leader (Broker 1)
  Leader → replicates to Followers
  Leader acks producer based on acks setting
```

| acks | Behavior | Durability | Latency |
|---|---|---|---|
| 0 | Don't wait | Lowest | Lowest |
| 1 | Wait for leader | Medium | Medium |
| all | Wait for all ISR | Highest | Highest |

**ISR (In-Sync Replicas)**: Replicas that are caught up with the leader. If a replica falls behind, it's removed from ISR.

---

### A20. ZooKeeper and KRaft

**ZooKeeper's role** (legacy):
- Broker registration and discovery
- Controller election
- Topic/partition metadata
- Consumer group coordination

**KRaft mode** (new):
- Kafka manages its own metadata
- No external ZooKeeper dependency
- Simpler operations, faster recovery

```text
ZooKeeper mode:           KRaft mode:
Kafka → ZooKeeper         Kafka (self-managed)
(external dependency)     (internal consensus)
```

---

### A21. Consumer lag remediation

**Consumer lag**: The difference between the latest message offset and the consumer's committed offset.

```text
Partition latest offset: 10,000,000
Consumer committed offset: 0
Lag: 10,000,000 messages
```

**Remediation**:
| Strategy | How |
|---|---|
| Add consumers | More parallelism (up to partition count) |
| Increase partitions | More parallelism (requires rebalance) |
| Optimize processing | Faster consumer code, batch processing |
| Skip/reset offset | Accept data loss if acceptable |

```bash
# Check consumer lag
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group order-processors
```

---

### A22. Log compaction

**Log compaction** retains only the **latest value for each key**, deleting older versions.

```text
Before compaction:
  offset 0: key=A, value=1
  offset 1: key=B, value=2
  offset 2: key=A, value=3  ← newer value for A
  offset 3: key=C, value=4

After compaction:
  offset 1: key=B, value=2
  offset 2: key=A, value=3  (offset 0 deleted)
  offset 3: key=C, value=4
```

**Use cases**:
- Changelog topics (latest state per entity)
- Kafka Streams state stores
- CDC (latest row state)

---

## Level 5 — Other Queue Technologies

### A23. Kafka vs RabbitMQ vs SQS

| Dimension | Kafka | RabbitMQ | AWS SQS |
|---|---|---|---|
| Model | Log (replay OK) | Broker (consume once) | Queue (consume once) |
| Ordering | Per-partition | Per-queue (FIFO option) | FIFO or best-effort |
| Persistence | Disk (configurable retention) | Optional | Always |
| Throughput | Very high (100K+/sec) | High (10K/sec) | Moderate |
| Operations | Complex | Moderate | Managed |
| Replay | Yes (offset reset) | No | No |

---

### A24. When to choose RabbitMQ over Kafka

| Use Case | Why RabbitMQ |
|---|---|
| Complex routing | Exchanges, bindings, header-based routing |
| Request-reply pattern | Built-in RPC support |
| Message-level TTL | Per-message expiry |
| Priority queues | Message priorities |
| Smaller scale | Simpler ops, lower resource footprint |

```text
RabbitMQ routing example:
  Exchange: orders
    ├─ Binding: routing_key=order.created → Queue: new-orders
    ├─ Binding: routing_key=order.paid → Queue: paid-orders
    └─ Binding: routing_key=order.* → Queue: all-order-events
```

---

### A25. When to choose SQS over Kafka

| Use Case | Why SQS |
|---|---|
| AWS-native workload | No ops overhead |
| Simple queue semantics | Don't need replay, partitioning |
| Lambda integration | Direct trigger, no connector |
| Pay-per-use | No idle cluster cost |
| Small team | No Kafka expertise needed |

---

### A26. Apache Pulsar advantages

| Feature | Pulsar | Kafka |
|---|---|---|
| Multi-tenancy | Built-in | DIY with ACLs |
| Geo-replication | Built-in | MirrorMaker (complex) |
| Storage separation | BookKeeper (separate) | Broker-local |
| Tiered storage | Native | Requires add-on |
| Queuing + Streaming | Both | Primarily streaming |

---

### A27. Job processing queue choice

**Requirement**: Each job processed by exactly one worker.

**Best choice**: **RabbitMQ** or **AWS SQS** (classic queue semantics).

```text
RabbitMQ:
  - Competing consumers on single queue
  - Acknowledgment-based (ack after success)
  - Built-in redelivery on failure

Kafka:
  - Would need exactly one consumer per partition
  - Offset-based (more complex for job queues)
  - Better for event streams than job queues
```

---

## Level 6 — Reliability Patterns

### A28. Transactional outbox pattern

**The dual-write problem**:
```python
# DANGEROUS: dual write
def create_order(order_data):
    db.save(order)            # Step 1: DB write
    kafka.send("order.created", order)  # Step 2: Queue write
    # If step 2 fails, DB has order but no event!
    # If step 1 fails after step 2, event exists but no order!
```

**Solution**: Write everything to DB in one transaction.

```python
# SAFE: transactional outbox
def create_order(order_data):
    with db.transaction():
        order = db.save(order_data)
        outbox_event = db.save(OutboxEvent(
            topic="order.created",
            payload=order.to_json()
        ))
    # Single atomic transaction
```

---

### A29. Transactional outbox implementation

```text
1. Application writes:
   ┌─────────────────────┐
   │ BEGIN TRANSACTION   │
   │ INSERT INTO orders  │
   │ INSERT INTO outbox  │
   │ COMMIT              │
   └─────────────────────┘

2. Outbox processor (separate service):
   ┌─────────────────────────────────────┐
   │ SELECT * FROM outbox WHERE sent=false │
   │ For each event:                      │
   │   kafka.send(event)                  │
   │   UPDATE outbox SET sent=true        │
   └─────────────────────────────────────┘
```

```python
# Outbox processor
class OutboxProcessor:
    def process(self):
        events = db.query("SELECT * FROM outbox WHERE sent = false LIMIT 100")
        for event in events:
            try:
                kafka.send(event.topic, event.payload)
                db.update(event.id, sent=True)
            except Exception:
                # Will retry on next poll
                pass
```

---

### A30. Dead letter queue (DLQ)

**DLQ**: A holding queue for messages that repeatedly fail processing.

```text
Main Queue
    │
    └─→ Consumer processes
            │
            ├─ Success → ack, done
            │
            └─ Failure (after N retries) → DLQ
                                             │
                                             └─→ Manual review / alerts
```

**When to use DLQ**:
- Message format errors (poison messages)
- Unrecoverable business logic errors
- Dead external dependencies (after retries exhausted)

---

### A31. Retry with exponential backoff

```python
class PaymentWebhookConsumer:
    MAX_RETRIES = 5
    
    def process(self, message):
        retry_count = message.headers.get('retry_count', 0)
        
        try:
            self.handle_payment(message)
            self.commit(message)
        except TransientError as e:
            if retry_count >= self.MAX_RETRIES:
                self.send_to_dlq(message)
            else:
                delay = self.calculate_backoff(retry_count)
                self.requeue_with_delay(message, delay, retry_count + 1)
        except PermanentError as e:
            self.send_to_dlq(message)
    
    def calculate_backoff(self, retry_count):
        # Exponential: 1s, 2s, 4s, 8s, 16s
        base = 1
        return base * (2 ** retry_count) + random.uniform(0, 1)  # Add jitter
```

---

### A32. Event sourcing

**Traditional**: Store current state, emit events as side effect.
**Event sourcing**: Store events as source of truth, derive state.

```text
Traditional:
  Account balance = 1000 (stored)
  Events emitted for notifications

Event Sourcing:
  Events stored:
    AccountCreated(id=1)
    Deposited(amount=500)
    Withdrawn(amount=200)
    Deposited(amount=700)
  Balance = replay events = 0 + 500 - 200 + 700 = 1000
```

**Benefits**: Full audit trail, temporal queries, rebuild projections.

---

### A33. Poison message handling

**Poison message**: A message that always fails processing.

```python
def process_with_poison_handling(message):
    attempts = get_attempt_count(message.id)
    
    if attempts > MAX_ATTEMPTS:
        log.error(f"Poison message detected: {message.id}")
        send_to_dlq(message)
        commit(message)  # Remove from main queue
        alert("Poison message", message)
        return
    
    try:
        process(message)
        commit(message)
    except Exception as e:
        increment_attempt_count(message.id)
        # Message will be redelivered
```

---

## Level 7 — Stream Processing

### A34. Stream vs batch processing

| Aspect | Batch | Stream |
|---|---|---|
| Latency | Minutes-hours | Milliseconds-seconds |
| Data | Bounded (known size) | Unbounded (continuous) |
| Processing | Complete dataset | Event-by-event or micro-batch |
| Use case | ETL, reporting | Real-time analytics, alerts |

```text
Batch: Process yesterday's orders at midnight
Stream: Process each order as it arrives
```

---

### A35. Windowing in stream processing

| Window Type | Definition | Use Case |
|---|---|---|
| Tumbling | Fixed, non-overlapping | Hourly aggregates |
| Sliding | Fixed, overlapping | Moving average |
| Session | Gap-based, variable size | User activity sessions |

```text
Tumbling (5 min):
|--window 1--|--window 2--|--window 3--|
0           5           10          15

Sliding (5 min window, 1 min slide):
|--window 1-----|
  |--window 2-----|
    |--window 3-----|
0  1  2  3  4  5  6  7

Session (5 min gap timeout):
|activity|    gap>5min    |activity|
|--session 1--|            |--session 2--|
```

---

### A36. Kafka Streams exactly-once

```java
// Kafka Streams EOS config
props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, 
    StreamsConfig.EXACTLY_ONCE_V2);

// How it works:
// 1. Read from input topic
// 2. Process (transform, aggregate)
// 3. Write to output topic + commit offset atomically
// All three are in one Kafka transaction
```

**Key insight**: EOS in Kafka Streams means "effectively once" — atomic read-process-write cycle.

---

### A37. Stream join with timing mismatch

**Problem**: Order event arrives at T=0, payment event at T=30s. How to join?

**Solution**: Windowed join with grace period.

```java
// Kafka Streams windowed join
KStream<String, Order> orders = ...;
KStream<String, Payment> payments = ...;

orders.join(
    payments,
    (order, payment) -> new OrderWithPayment(order, payment),
    JoinWindows.of(Duration.ofMinutes(5))  // 5 minute window
        .grace(Duration.ofMinutes(1)),     // Allow late events
    StreamJoined.with(Serdes.String(), orderSerde, paymentSerde)
);
```

---

### A38. Watermarks in stream processing

**Watermark**: A timestamp that says "all events before this time have arrived."

```text
Event time: 10:01, 10:03, 10:02, 10:05, 10:04 (out of order)
Watermark: 10:03 (current assumption of completeness)

When watermark passes window end time → emit window results
```

**Why needed**: Handle out-of-order events in distributed systems where processing time ≠ event time.

---

### A39. Kafka Streams vs Apache Flink

| Aspect | Kafka Streams | Flink |
|---|---|---|
| Deployment | Library (embedded in app) | Cluster (standalone) |
| Source/Sink | Kafka only | Many (Kafka, files, DBs) |
| Scaling | Consumer group rebalancing | Task parallelism |
| State | Kafka-backed (RocksDB) | Checkpointed state |
| Complexity | Simpler | More powerful, steeper curve |

**Choose Kafka Streams**: Kafka-to-Kafka, simpler ops, embedded in microservice.
**Choose Flink**: Complex pipelines, non-Kafka sources, SQL interface.

---

## Level 8 — Architect / Production Operations

### A40. Sizing Kafka cluster for 100K msg/sec

```text
Throughput: 100,000 msg/sec × 1 KB = 100 MB/sec

Single broker capacity: ~50 MB/sec (conservative)
Brokers needed: 100 / 50 = 2 (for throughput)

Replication factor: 3
Storage: 100 MB/sec × 86400 sec/day × 7 days = 60 TB
Per broker: 60 TB / 3 brokers = 20 TB

Final sizing:
- 3 brokers minimum (for replication)
- 20 TB disk per broker
- 32 GB RAM recommended
- 8+ cores per broker
```

---

### A41. Kafka monitoring metrics

| Metric | Why |
|---|---|
| Under-replicated partitions | Data durability risk |
| Consumer lag | Processing falling behind |
| Request latency (produce/fetch) | Performance |
| Bytes in/out | Throughput |
| Active controller count | Should be 1 |
| ISR shrink rate | Replication issues |
| Log flush time | Disk performance |
| JVM heap usage | Memory pressure |

```yaml
# Prometheus alert example
- alert: KafkaUnderReplicatedPartitions
  expr: kafka_server_replicamanager_underreplicatedpartitions > 0
  for: 5m
  labels:
    severity: critical
```

---

### A42. Under-replicated partition impact

**Definition**: A partition where not all replicas are in sync with the leader.

```text
Normal: Leader (Broker 1) ←sync→ Replicas (Broker 2, 3)
Under-replicated: Leader (Broker 1) ←sync→ Replica (Broker 2)
                                   ←NOT sync→ Replica (Broker 3)
```

**Impact**:
- Reduced fault tolerance (fewer copies)
- If leader fails, may lose data or have slower recovery
- Indicates broker health issue, network problem, or disk bottleneck

---

### A43. Consumer group rebalancing

**Rebalancing**: Redistributing partitions among consumers when group membership changes.

**Triggers**:
- Consumer joins/leaves
- Consumer crashes (session timeout)
- Topic partition count changes

**Impact**: **Stop-the-world pause** — no consumption during rebalance.

**Mitigation**:
| Strategy | How |
|---|---|
| Sticky assignor | Minimize partition movement |
| Longer session timeout | Fewer false rebalances |
| Static membership | Persist consumer identity |
| Cooperative rebalancing | Incremental, non-blocking |

---

### A44. E-commerce order flow design

```text
┌─────────────────────────────────────────────────────────────┐
│                    Order Flow Architecture                  │
└─────────────────────────────────────────────────────────────┘

Order Service
    │
    ├─→ [orders topic]
    │       │
    │       ├─→ Inventory Service
    │       │       │
    │       │       ├─→ [inventory.reserved topic]
    │       │       └─→ [inventory.failed topic] → Compensation
    │       │
    │       ├─→ Payment Service
    │       │       │
    │       │       ├─→ [payment.charged topic]
    │       │       └─→ [payment.failed topic] → Compensation
    │       │
    │       └─→ Notification Service (async, best-effort)
    │
    └─→ Orchestrator / Saga Coordinator
            │
            ├─→ Happy path: inventory → payment → shipping → done
            └─→ Failure: compensating transactions (reverse order)
```

**Failure handling**:

| Step | Failure | Compensation |
|---|---|---|
| Inventory reserve | Out of stock | Cancel order, notify customer |
| Payment charge | Card declined | Release inventory, cancel order |
| Shipping create | Address invalid | Refund payment, release inventory |

```python
# Saga orchestrator
class OrderSaga:
    def execute(self, order):
        # Step 1: Reserve inventory
        reserved = self.inventory.reserve(order)
        if not reserved:
            return self.fail("out_of_stock")
        
        # Step 2: Charge payment
        try:
            payment = self.payment.charge(order)
        except PaymentFailed:
            self.inventory.release(order)  # Compensate
            return self.fail("payment_failed")
        
        # Step 3: Create shipment
        try:
            shipment = self.shipping.create(order)
        except ShippingFailed:
            self.payment.refund(payment)  # Compensate
            self.inventory.release(order)  # Compensate
            return self.fail("shipping_failed")
        
        return self.success(order)
```

---

## Bonus Answers

### QB1. Schema evolution and registry

**Problem**: Producer changes event schema, consumer breaks.

**Solution**: Schema registry (Confluent Schema Registry).

```text
Producer → registers schema → Schema Registry
Consumer → fetches schema → Schema Registry
Both use compatible versions
```

**Compatibility modes**:
| Mode | Allowed Changes |
|---|---|
| Backward | New schema can read old data |
| Forward | Old schema can read new data |
| Full | Both directions |

---

### QB2. Event-carried state vs event notification

| Pattern | Payload | Consumer Action |
|---|---|---|
| Event notification | Minimal (just ID) | Query source for details |
| Event-carried state | Full entity state | Use payload directly |

```json
// Notification
{"event": "order.created", "order_id": "123"}

// Event-carried state
{"event": "order.created", "order": {"id": "123", "amount": 100, "items": [...]}}
```

---

### QB3. Saga pattern for distributed transactions

**Choreography**: Services react to events, no central coordinator.
**Orchestration**: Central saga coordinator directs each step.

```text
Choreography:
  Order → Inventory reacts → Payment reacts → Shipping reacts

Orchestration:
  Saga Coordinator:
    1. Tell Inventory to reserve
    2. Tell Payment to charge
    3. Tell Shipping to create
    (Coordinator tracks state and handles failures)
```

---

### QB4. Dual-write problem

**Problem**: Writing to DB and queue separately can leave them inconsistent.

```text
Success path: DB write OK → Queue write OK (consistent)
Failure 1: DB write OK → Queue write FAIL (DB has data, no event)
Failure 2: DB write FAIL after Queue sent (event without data)
```

**Outbox solution**: Write event to DB in same transaction, then relay to queue.

---

### QB5. Queue migration without downtime

```text
Phase 1: Dual-write
  Producer → Old Queue (RabbitMQ)
          → New Queue (Kafka)
  Consumer reads from Old Queue

Phase 2: Shift consumers
  Consumer starts reading from New Queue
  Old Queue drains

Phase 3: Cutover
  Producer stops writing to Old Queue
  Only New Queue active

Phase 4: Decommission
  Remove Old Queue
```

---

### QB6. Change Data Capture (CDC)

**CDC**: Capture database changes (INSERT, UPDATE, DELETE) as an event stream.

```text
Database WAL → CDC Connector (Debezium) → Kafka

Benefits:
- No application code changes
- Captures all changes (even direct DB writes)
- Consistent with committed transactions
```

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Message queue | Async communication buffer between services |
| Decoupling | Producer doesn't know consumers |
| Backpressure | Queue absorbs traffic spikes |
| Point-to-point | Each message to one consumer |
| Pub-sub | Each message to all subscribers |
| Consumer group | Parallel consumers sharing topic |
| At-most-once | Fire and forget, may lose |
| At-least-once | Retry until ack, may duplicate |
| Exactly-once | At-least-once + idempotency |
| Idempotency | Same op multiple times = same result |
| Partition | Ordered log within topic |
| Partition key | Determines partition, ensures ordering |
| Offset | Message position in partition |
| ISR | Replicas caught up with leader |
| Consumer lag | Behind latest offset |
| Log compaction | Keep only latest value per key |
| Transactional outbox | Write event to DB, relay to queue |
| Dead letter queue | Failed messages for review |
| Poison message | Message that always fails |
| Stream processing | Real-time event processing |
| Tumbling window | Fixed, non-overlapping |
| Sliding window | Fixed, overlapping |
| Watermark | Completeness marker for event time |
| Saga pattern | Distributed transaction via events |
| CDC | DB changes as event stream |
