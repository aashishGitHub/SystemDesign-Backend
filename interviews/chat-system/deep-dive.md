# Deep Dive: WhatsApp / Slack (Chat System)

> Three-tiered depth: 🟢 Phone Screen → 🟡 Onsite → 🔴 Staff+ deep dive

---

## Table of Contents

1. [Real-Time Communication](#1-real-time-communication)
2. [Message Delivery & Ordering](#2-message-delivery--ordering)
3. [Presence System](#3-presence-system)
4. [Group Messaging](#4-group-messaging)
5. [Push Notifications](#5-push-notifications)
6. [End-to-End Encryption](#6-end-to-end-encryption)
7. [Production Operations](#7-production-operations)
8. [Real-World Case Studies](#8-real-world-case-studies)
9. [Quick Recall Cheat Sheet](#cheat-sheet)

---

## 1. Real-Time Communication

### 🟢 Beginner — The Intercom Analogy

Imagine an office building with an intercom system. When Alice presses the button in Room 101 and speaks, Bob immediately hears her in Room 202. Neither has to call the other — the connection is always open.

Compare this to mail. Alice writes a letter (HTTP request), sends it, and waits for Bob's reply. This works, but it's slow — you can't have a real-time conversation.

**WebSocket is like the intercom** — a persistent open line between your phone and the server. When someone sends you a message, the server immediately pushes it through that open line.

**HTTP is like mail** — your phone has to keep asking "any new messages?" which wastes resources.

---

### 🟡 Senior — WebSocket Implementation

**Connection establishment**:

```python
import asyncio
import websockets
from dataclasses import dataclass

@dataclass
class Connection:
    user_id: str
    device_id: str
    websocket: websockets.WebSocketServerProtocol
    connected_at: datetime

class ChatServer:
    def __init__(self):
        self.connections: dict[str, list[Connection]] = {}
        self.redis = None
    
    async def handle_connection(self, websocket, path):
        # 1. Authenticate via token
        token = parse_query_param(path, "token")
        user = await verify_jwt(token)
        if not user:
            await websocket.close(4001, "Unauthorized")
            return
        
        # 2. Register connection
        conn = Connection(
            user_id=user.id,
            device_id=parse_query_param(path, "device_id"),
            websocket=websocket,
            connected_at=datetime.utcnow()
        )
        
        self.connections.setdefault(user.id, []).append(conn)
        await self.register_in_redis(conn)
        
        # 3. Sync missed messages
        await self.sync_offline_messages(conn)
        
        try:
            # 4. Handle incoming messages
            async for message in websocket:
                await self.handle_message(conn, json.loads(message))
        except websockets.ConnectionClosed:
            pass
        finally:
            # 5. Cleanup on disconnect
            await self.handle_disconnect(conn)
    
    async def handle_message(self, conn: Connection, data: dict):
        msg_type = data.get("type")
        
        if msg_type == "send_message":
            await self.process_send_message(conn, data)
        elif msg_type == "ack_delivered":
            await self.process_delivery_ack(conn, data)
        elif msg_type == "ack_read":
            await self.process_read_ack(conn, data)
        elif msg_type == "typing":
            await self.process_typing(conn, data)
        elif msg_type == "ping":
            await conn.websocket.send(json.dumps({"type": "pong"}))
```

**Scaling across servers with Redis Pub/Sub**:

```python
class MessageRouter:
    def __init__(self, server_id: str, redis_client):
        self.server_id = server_id
        self.redis = redis_client
    
    async def route_to_user(self, user_id: str, message: dict):
        # Get all connections for user
        connections = await self.redis.hgetall(f"user_conns:{user_id}")
        
        for conn_id, target_server_id in connections.items():
            if target_server_id == self.server_id:
                # Local connection — send directly
                await self.send_local(conn_id, message)
            else:
                # Remote server — publish via Redis
                await self.redis.publish(
                    f"server:{target_server_id}:inbound",
                    json.dumps({
                        "connection_id": conn_id,
                        "payload": message
                    })
                )
    
    async def subscribe_to_inbound(self):
        """Listen for messages routed to this server"""
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(f"server:{self.server_id}:inbound")
        
        async for message in pubsub.listen():
            if message["type"] == "message":
                data = json.loads(message["data"])
                await self.send_local(data["connection_id"], data["payload"])
```

---

### 🔴 Architect — Handling Millions of Connections

**Capacity planning**:

```text
Target: 100 million concurrent connections

Single server capacity (tuned Linux):
- File descriptors: 1 million
- Memory per connection: ~10 KB (socket buffers, metadata)
- Practical limit: 50,000-100,000 connections

Servers needed: 100M / 50K = 2,000 WebSocket servers

Messages per second: 1 million
Routing lookups per second: 2 million (sender + recipient)
Redis Pub/Sub throughput: ~1M msg/sec (well within limits)
```

**Linux tuning for high connections**:

```bash
# /etc/sysctl.conf
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.core.netdev_max_backlog = 65535
fs.file-max = 2000000
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# /etc/security/limits.conf
* soft nofile 1000000
* hard nofile 1000000
```

**Connection persistence across deploys**:

```text
Problem: Deploying new server version disconnects 50K users

Solutions:
1. Rolling deployment: Drain connections from old pod before terminating
2. Connection migration: HAProxy/Envoy handles connection handoff
3. Graceful reconnect: Clients reconnect to new servers seamlessly

WhatsApp approach:
- Erlang hot code reload (change code without restarting)
- Most deployments don't disconnect users
```

**Failure mode: Redis Pub/Sub failure**

```yaml
# Alert
- alert: RedisPubSubDown
  expr: redis_connected_slaves{service="pubsub"} == 0
  for: 30s
  annotations:
    runbook: |
      1. Cross-server messaging will fail
      2. Local messages still work
      3. Check Redis Sentinel failover
      4. If stuck: restart Redis cluster
      5. Clients auto-reconnect; no message loss (stored in DB)
```

---

## 2. Message Delivery & Ordering

### 🟢 Beginner — The Post Office Analogy

When you mail a letter, you get a series of confirmations:
1. **Sent**: Post office accepted your letter
2. **Delivered**: Letter arrived at recipient's mailbox
3. **Read**: Recipient opened and read it

WhatsApp's tick system works the same way:
- ✓ (single gray tick): Server received your message
- ✓✓ (double gray tick): Recipient's phone received it
- ✓✓ (double blue tick): Recipient read it

If the recipient's phone is off, you might see single tick for hours. The post office is holding your letter.

---

### 🟡 Senior — Delivery State Machine

```python
from enum import Enum

class MessageStatus(Enum):
    SENDING = "sending"      # Client generated, not yet sent
    SENT = "sent"            # Server received and stored
    DELIVERED = "delivered"  # Recipient's device received
    READ = "read"            # Recipient opened conversation

class Message:
    id: int                # Snowflake ID
    conversation_id: str
    sender_id: str
    content: str
    status: MessageStatus
    created_at: datetime
    delivered_at: datetime = None
    read_at: datetime = None

async def process_message(conn: Connection, data: dict):
    # 1. Idempotency check
    existing = await redis.get(f"msg_dedup:{data['client_message_id']}")
    if existing:
        await conn.websocket.send(json.dumps({
            "type": "message_ack",
            "client_message_id": data["client_message_id"],
            "message_id": existing,
            "status": "sent"
        }))
        return
    
    # 2. Generate server-side ID and store
    message_id = snowflake.generate()
    message = Message(
        id=message_id,
        conversation_id=data["conversation_id"],
        sender_id=conn.user_id,
        content=data["content"],
        status=MessageStatus.SENT,
        created_at=datetime.utcnow()
    )
    await db.insert(message)
    
    # 3. Store dedup key
    await redis.setex(
        f"msg_dedup:{data['client_message_id']}", 
        86400, 
        str(message_id)
    )
    
    # 4. ACK to sender
    await conn.websocket.send(json.dumps({
        "type": "message_ack",
        "client_message_id": data["client_message_id"],
        "message_id": message_id,
        "status": "sent"
    }))
    
    # 5. Deliver to recipients
    await deliver_to_conversation(message)
```

**Ordering with Snowflake IDs**:

```python
class SnowflakeGenerator:
    EPOCH = 1609459200000  # 2021-01-01 00:00:00 UTC
    
    def __init__(self, datacenter_id: int, worker_id: int):
        self.datacenter_id = datacenter_id & 0x1F  # 5 bits
        self.worker_id = worker_id & 0x1F         # 5 bits
        self.sequence = 0
        self.last_timestamp = -1
        self.lock = asyncio.Lock()
    
    async def generate(self) -> int:
        async with self.lock:
            timestamp = int(time.time() * 1000) - self.EPOCH
            
            if timestamp < self.last_timestamp:
                raise ClockMovedBackwardsError()
            
            if timestamp == self.last_timestamp:
                self.sequence = (self.sequence + 1) & 0xFFF
                if self.sequence == 0:
                    timestamp = self._wait_next_millis(timestamp)
            else:
                self.sequence = 0
            
            self.last_timestamp = timestamp
            
            # 64 bits: 1 unused + 41 timestamp + 5 datacenter + 5 worker + 12 sequence
            return (
                (timestamp << 22) |
                (self.datacenter_id << 17) |
                (self.worker_id << 12) |
                self.sequence
            )
```

---

### 🔴 Architect — Exactly-Once at Scale

**The challenge**: Network failures cause retries, which can create duplicates. True exactly-once requires:

1. **Idempotent writes**: Using `client_message_id` as dedup key
2. **Atomic publish**: Message stored AND published in one transaction
3. **Idempotent delivery**: Recipient ignores duplicate `message_id`

**Transactional outbox pattern**:

```python
async def send_message_transactionally(message: Message):
    async with db.transaction() as tx:
        # 1. Insert message
        await tx.execute(
            "INSERT INTO messages (...) VALUES (...)",
            message
        )
        
        # 2. Insert into outbox (same transaction)
        await tx.execute(
            "INSERT INTO message_outbox (message_id, payload, created_at) VALUES ($1, $2, NOW())",
            message.id,
            json.dumps(message.to_event())
        )
        
        # Transaction commits atomically

# Separate outbox processor (background worker)
async def process_outbox():
    while True:
        events = await db.query(
            "SELECT * FROM message_outbox ORDER BY created_at LIMIT 100"
        )
        
        for event in events:
            try:
                await kafka.produce("messages", event.payload)
                await db.execute(
                    "DELETE FROM message_outbox WHERE message_id = $1",
                    event.message_id
                )
            except:
                # Will retry on next iteration
                pass
        
        await asyncio.sleep(0.1)
```

**Cassandra message storage**:

```cql
-- Partition by conversation + time bucket
CREATE TABLE messages (
    conversation_id uuid,
    bucket_id text,          -- '2024-01-15' day bucket
    message_id bigint,       -- Snowflake ID
    sender_id uuid,
    content text,
    message_type text,
    created_at timestamp,
    PRIMARY KEY ((conversation_id, bucket_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- Query recent messages
SELECT * FROM messages 
WHERE conversation_id = ? AND bucket_id = ?
ORDER BY message_id DESC
LIMIT 50;
```

---

## 3. Presence System

### 🟢 Beginner — The Office Door Sign

Imagine everyone in an office has a door sign: "IN" or "OUT" or "Back at 3:00 PM."

When you arrive, you flip your sign to "IN." When you leave, you flip to "OUT." Your colleagues can peek at your door to see if you're available.

WhatsApp presence works similarly:
- **Online**: Your app is connected (door says "IN")
- **Last seen at 3:42 PM**: You left at 3:42 (door says "OUT - Back soon")
- **Typing...**: You're actively composing a message (door says "BUSY - MEETING")

---

### 🟡 Senior — Redis-Based Presence

```python
class PresenceService:
    ONLINE_TTL = 30  # Consider offline after 30s without heartbeat
    
    def __init__(self, redis_client):
        self.redis = redis_client
    
    async def set_online(self, user_id: str):
        pipe = self.redis.pipeline()
        
        # Set presence with TTL
        pipe.setex(f"presence:{user_id}", self.ONLINE_TTL, "online")
        
        # Update last seen
        pipe.set(f"last_seen:{user_id}", datetime.utcnow().isoformat())
        
        await pipe.execute()
        
        # Notify subscribers
        await self.publish_presence_change(user_id, "online")
    
    async def heartbeat(self, user_id: str):
        # Reset TTL
        await self.redis.expire(f"presence:{user_id}", self.ONLINE_TTL)
    
    async def get_presence(self, viewer_id: str, target_id: str) -> dict:
        # Check privacy settings
        privacy = await self.get_privacy_settings(target_id)
        
        if privacy.last_seen_visibility == "nobody":
            return {"status": "hidden"}
        
        if privacy.last_seen_visibility == "contacts":
            if not await self.are_contacts(viewer_id, target_id):
                return {"status": "hidden"}
        
        # Get presence
        is_online = await self.redis.exists(f"presence:{target_id}")
        
        if is_online:
            return {"status": "online"}
        else:
            last_seen = await self.redis.get(f"last_seen:{target_id}")
            return {
                "status": "offline",
                "last_seen": last_seen
            }
    
    async def publish_presence_change(self, user_id: str, status: str):
        # Get users who should be notified (e.g., open conversation with this user)
        subscribers = await self.redis.smembers(f"presence_subs:{user_id}")
        
        for subscriber_id in subscribers:
            await router.route_to_user(subscriber_id, {
                "type": "presence_update",
                "user_id": user_id,
                "status": status
            })
```

**Typing indicators**:

```python
class TypingService:
    TYPING_TTL = 5  # Auto-expire after 5 seconds
    
    async def set_typing(self, user_id: str, conversation_id: str, is_typing: bool):
        key = f"typing:{conversation_id}:{user_id}"
        
        if is_typing:
            # Check throttle (don't spam typing events)
            last_broadcast = await self.redis.get(f"typing_broadcast:{key}")
            if last_broadcast and time.time() - float(last_broadcast) < 3:
                return  # Skip — already broadcast recently
            
            await self.redis.setex(key, self.TYPING_TTL, "1")
            await self.redis.set(f"typing_broadcast:{key}", str(time.time()))
            
            # Broadcast to conversation members
            await self.broadcast_typing(conversation_id, user_id, True)
        else:
            await self.redis.delete(key)
            await self.broadcast_typing(conversation_id, user_id, False)
    
    async def get_typing_users(self, conversation_id: str) -> list[str]:
        # Scan for typing keys (or use a Set per conversation)
        keys = await self.redis.keys(f"typing:{conversation_id}:*")
        return [key.split(":")[-1] for key in keys]
```

---

### 🔴 Architect — Presence at Scale

**Challenge**: 500 million online users, presence checks happening constantly.

```text
Presence data size:
- Per user: ~100 bytes (key + value + TTL metadata)
- 500M users: 50 GB

Redis capacity:
- Single Redis: 256 GB RAM typical
- Fits in one Redis instance

Presence qps:
- Heartbeat every 15 seconds per user
- 500M / 15 = 33M heartbeats/second
- Too much for single Redis!

Solution: Shard presence by user_id
- 100 Redis instances
- 330K QPS per instance (manageable)
```

**Sharding presence**:

```python
class ShardedPresence:
    def __init__(self, redis_instances: list):
        self.redis_pool = redis_instances
        self.num_shards = len(redis_instances)
    
    def get_shard(self, user_id: str) -> Redis:
        shard_idx = hash(user_id) % self.num_shards
        return self.redis_pool[shard_idx]
    
    async def set_online(self, user_id: str):
        redis = self.get_shard(user_id)
        await redis.setex(f"presence:{user_id}", 30, "online")
    
    async def get_bulk_presence(self, user_ids: list[str]) -> dict[str, str]:
        # Group by shard
        shards = defaultdict(list)
        for user_id in user_ids:
            shard_idx = hash(user_id) % self.num_shards
            shards[shard_idx].append(user_id)
        
        # Parallel queries
        results = {}
        tasks = []
        for shard_idx, shard_user_ids in shards.items():
            tasks.append(self.query_shard(shard_idx, shard_user_ids))
        
        shard_results = await asyncio.gather(*tasks)
        for result in shard_results:
            results.update(result)
        
        return results
```

**Presence fanout optimization**:

```text
Naive: User goes online → notify all their contacts (could be thousands)
Problem: Celebrity goes online → 10 million notifications

Solution: Lazy presence
1. Don't broadcast "online" globally
2. When Bob opens chat with Alice, Bob subscribes to Alice's presence
3. Only active conversations receive presence updates
4. Much smaller fanout (tens, not millions)
```

---

## 4. Group Messaging

### 🟢 Beginner — The Conference Call

Imagine a 10-person conference call. When Alice speaks:
- The phone system doesn't connect Alice to each person one by one
- Instead, her voice goes to a central system that broadcasts to everyone simultaneously

Group chat works similarly. When Alice sends a message:
1. Message goes to the server
2. Server identifies all group members
3. Server delivers to everyone in parallel (not one by one)

For a 500-person group, you can't wait for 500 sequential deliveries — that would take forever!

---

### 🟡 Senior — Fan-Out Implementation

```python
class GroupMessageService:
    # For groups < 100 members: synchronous delivery
    SYNC_THRESHOLD = 100
    
    async def send_group_message(self, message: Message):
        # Store message
        await self.db.insert(message)
        
        # Get group members
        members = await self.get_group_members(message.conversation_id)
        sender_idx = members.index(message.sender_id)
        recipients = members[:sender_idx] + members[sender_idx + 1:]  # Exclude sender
        
        if len(recipients) <= self.SYNC_THRESHOLD:
            # Small group: synchronous fan-out
            await self.sync_fanout(message, recipients)
        else:
            # Large group: async via Kafka
            await self.async_fanout(message, recipients)
        
        # ACK to sender
        await self.ack_message_sent(message)
    
    async def sync_fanout(self, message: Message, recipients: list[str]):
        tasks = [
            self.deliver_to_user(user_id, message)
            for user_id in recipients
        ]
        await asyncio.gather(*tasks, return_exceptions=True)
    
    async def async_fanout(self, message: Message, recipients: list[str]):
        # Publish to Kafka — workers will process
        for user_id in recipients:
            await self.kafka.produce(
                "group-fanout",
                key=user_id.encode(),  # Partition by recipient
                value=json.dumps({
                    "message_id": message.id,
                    "recipient_id": user_id,
                    "content": message.content,
                    "sender_id": message.sender_id,
                    "conversation_id": message.conversation_id
                }).encode()
            )

# Fan-out worker (multiple instances)
class FanoutWorker:
    async def process(self, record):
        data = json.loads(record.value)
        
        # Check if user is online
        if await self.presence.is_online(data["recipient_id"]):
            await self.router.route_to_user(data["recipient_id"], {
                "type": "new_message",
                "message": data
            })
        else:
            # Queue for push notification
            await self.push_service.enqueue(data["recipient_id"], data)
```

**Kafka partitioning for ordering**:

```python
# Partition by recipient_id
# Messages for same user always go to same partition → same consumer → ordering preserved

# But group messages might arrive out of order across consumers
# Solution: Client sorts by message_id (Snowflake) before displaying
```

---

### 🔴 Architect — Large Group Challenges

**Challenge: 100K member group (Telegram-style)**

```text
Message to 100K members:
- 100K Kafka messages produced
- 100K database status records created
- 100K WebSocket deliveries or push notifications

Time budget:
- Kafka produces: 10ms total (batched)
- Consumers process: 100K / 50 workers = 2K each → ~2 seconds
- Target: message visible to most users within 5 seconds
```

**Read receipts don't scale**:

```python
# WhatsApp: No read receipts for groups > 100 members
# Slack: No read receipts at all

# If you MUST have read receipts in large groups:
class GroupReadReceipts:
    def on_message_read(self, user_id: str, message_id: int):
        # Don't store per-user; just increment counter
        await self.redis.pfadd(f"read_count:{message_id}", user_id)  # HyperLogLog
    
    def get_read_count(self, message_id: int) -> int:
        # Approximate count (HyperLogLog has ~0.81% error)
        return await self.redis.pfcount(f"read_count:{message_id}")
```

**Sharding group data**:

```text
Problem: Very active group has 10K messages/day
All go to same Cassandra partition (conversation_id) → hot partition

Solution: Time-bucketed partition key
```

```cql
-- Partition by (conversation_id, day_bucket)
CREATE TABLE messages (
    conversation_id uuid,
    day_bucket date,
    message_id bigint,
    content text,
    ...
    PRIMARY KEY ((conversation_id, day_bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- Query today's messages
SELECT * FROM messages 
WHERE conversation_id = ? AND day_bucket = '2024-01-15'
LIMIT 50;

-- Query across days (for history scroll)
-- Need to query multiple partitions — acceptable for pagination
```

---

## 5. Push Notifications

### 🟢 Beginner — The Doorbell

WebSocket is like having a dedicated phone line to your house. If you're home, calls come through immediately.

But what if you leave the house (close the app)? The phone line is disconnected.

Push notifications are like a doorbell. Even when you're not home, a visitor can ring the bell (notification appears on your lock screen), and you know someone's there.

When you get the notification and open the app, the phone line reconnects, and you get the full message.

---

### 🟡 Senior — Push Notification Pipeline

```python
class PushService:
    # Notification providers
    APNS_ENDPOINT = "https://api.push.apple.com"
    FCM_ENDPOINT = "https://fcm.googleapis.com"
    
    async def send_notification(self, user_id: str, notification: dict):
        devices = await self.get_user_devices(user_id)
        
        for device in devices:
            if device.platform == "ios":
                await self.send_apns(device.push_token, notification)
            elif device.platform == "android":
                await self.send_fcm(device.push_token, notification)
    
    async def send_apns(self, token: str, notification: dict):
        payload = {
            "aps": {
                "alert": {
                    "title": notification["title"],
                    "body": notification["body"]
                },
                "sound": "default",
                "badge": notification.get("badge", 1)
            },
            "data": notification.get("data", {})
        }
        
        # APNs uses HTTP/2
        headers = {
            "apns-topic": "com.yourapp.chat",
            "apns-push-type": "alert",
            "authorization": f"bearer {self.apns_jwt}"
        }
        
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.APNS_ENDPOINT}/3/device/{token}",
                json=payload,
                headers=headers
            ) as resp:
                if resp.status == 410:  # Token invalid
                    await self.invalidate_device_token(token)
    
    async def send_fcm(self, token: str, notification: dict):
        payload = {
            "message": {
                "token": token,
                "notification": {
                    "title": notification["title"],
                    "body": notification["body"]
                },
                "data": notification.get("data", {}),
                "android": {
                    "priority": "high"
                }
            }
        }
        
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.FCM_ENDPOINT}/v1/projects/your-project/messages:send",
                json=payload,
                headers={"Authorization": f"Bearer {self.fcm_token}"}
            ) as resp:
                result = await resp.json()
                if "error" in result:
                    if result["error"]["status"] == "NOT_FOUND":
                        await self.invalidate_device_token(token)
```

**Handling offline message queue**:

```python
class OfflineMessageQueue:
    MAX_QUEUED_MESSAGES = 1000
    QUEUE_TTL = 7 * 24 * 3600  # 7 days
    
    async def queue_for_offline(self, user_id: str, message: dict):
        queue_key = f"offline_queue:{user_id}"
        
        # Add to queue
        await self.redis.rpush(queue_key, json.dumps(message))
        await self.redis.expire(queue_key, self.QUEUE_TTL)
        
        # Trim if too long
        await self.redis.ltrim(queue_key, -self.MAX_QUEUED_MESSAGES, -1)
    
    async def drain_queue(self, user_id: str) -> list[dict]:
        """Called when user reconnects via WebSocket"""
        queue_key = f"offline_queue:{user_id}"
        
        # Atomic get-and-delete
        pipe = self.redis.pipeline()
        pipe.lrange(queue_key, 0, -1)
        pipe.delete(queue_key)
        results = await pipe.execute()
        
        return [json.loads(m) for m in results[0]]
```

---

### 🔴 Architect — Push at Scale

**Capacity planning**:

```text
Daily push notifications:
- 500M DAU × 20 notifications average = 10 billion/day
- Peak: 200K/second

APNs limits:
- No hard rate limit, but throttling above ~50K/sec per topic
- Use multiple provider certificates

FCM limits:
- 500K/second per project
- Should use multiple projects for scale
```

**Batching strategies**:

```python
class PushBatcher:
    BATCH_SIZE = 500          # FCM batch limit
    BATCH_WINDOW_MS = 100     # Maximum delay
    
    def __init__(self):
        self.pending = defaultdict(list)  # platform -> notifications
        self.last_flush = time.time()
    
    async def add(self, platform: str, token: str, notification: dict):
        self.pending[platform].append((token, notification))
        
        if (len(self.pending[platform]) >= self.BATCH_SIZE or
            time.time() - self.last_flush > self.BATCH_WINDOW_MS / 1000):
            await self.flush(platform)
    
    async def flush(self, platform: str):
        batch = self.pending[platform]
        self.pending[platform] = []
        self.last_flush = time.time()
        
        if platform == "ios":
            # APNs: Use HTTP/2 multiplexing (single connection, many requests)
            await self.send_apns_batch(batch)
        else:
            # FCM: Use batch API
            await self.send_fcm_batch(batch)
```

**Silent push for background sync**:

```python
async def send_sync_trigger(user_id: str):
    """Wake up app to sync messages without user-visible notification"""
    devices = await get_user_devices(user_id)
    
    for device in devices:
        if device.platform == "ios":
            await send_apns(device.token, {
                "aps": {
                    "content-available": 1  # Silent push
                },
                "data": {
                    "action": "sync"
                }
            })
        else:
            await send_fcm(device.token, {
                "data": {
                    "action": "sync"
                }
                # No "notification" key = silent/data-only message
            })
```

---

## 6. End-to-End Encryption

### 🟢 Beginner — The Locked Box

Imagine sending a letter, but instead of an envelope, you use a locked box. You put your message inside and lock it with a special padlock that only your friend has the key to.

The post office (server) can carry the box, but they can't open it. Only your friend, with their unique key, can unlock it and read your message.

That's end-to-end encryption (E2EE). The server carries encrypted messages but cannot read them.

---

### 🟡 Senior — Signal Protocol Basics

**Key concepts**:

```text
Each user has:
1. Identity Key Pair (long-term, doesn't change)
2. Signed Pre-Key (medium-term, changes periodically)
3. One-Time Pre-Keys (ephemeral, used once)

Key exchange (X3DH):
- Alice wants to message Bob
- Alice downloads Bob's public keys from server
- Alice performs triple Diffie-Hellman to derive shared secret
- No server can derive this secret

Double Ratchet:
- Each message uses a new encryption key
- Forward secrecy: compromising one key doesn't reveal past messages
- Future secrecy: compromising one key doesn't reveal future messages
```

**Simplified implementation**:

```python
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import os

class E2EESession:
    def __init__(self, shared_secret: bytes):
        # Derive message keys using HKDF
        self.root_key = shared_secret
        self.chain_key = self.derive_chain_key(shared_secret)
        self.message_number = 0
    
    def encrypt(self, plaintext: bytes) -> bytes:
        # Derive message key (changes each message)
        message_key = self.derive_message_key(self.chain_key, self.message_number)
        self.message_number += 1
        
        # Encrypt with AES-GCM
        nonce = os.urandom(12)
        aesgcm = AESGCM(message_key)
        ciphertext = aesgcm.encrypt(nonce, plaintext, None)
        
        return nonce + ciphertext
    
    def decrypt(self, encrypted: bytes) -> bytes:
        nonce = encrypted[:12]
        ciphertext = encrypted[12:]
        
        message_key = self.derive_message_key(self.chain_key, self.message_number)
        self.message_number += 1
        
        aesgcm = AESGCM(message_key)
        return aesgcm.decrypt(nonce, ciphertext, None)

# What the server sees:
# - Encrypted blob (ciphertext)
# - Metadata: sender, recipient, timestamp, size
# - NOT: message content
```

---

### 🔴 Architect — E2EE in Production

**Group E2EE with Sender Keys**:

```text
Challenge: 100-person group
Naive: Encrypt message 100 times (one per member) → expensive

Signal's Sender Keys solution:
1. Each member generates a "sender key" for the group
2. Member distributes sender key to all others (encrypted to each)
3. Messages are encrypted once with sender key
4. All members can decrypt with that sender key

group_message = AES_encrypt(sender_key, plaintext)
// Send once, all members decrypt

Key rotation:
- When member is removed, everyone generates new sender keys
- Removed member doesn't have new keys → forward secrecy
```

**Server's role with E2EE**:

```text
Server CAN see:
- Who messaged whom (metadata)
- When messages were sent
- Message sizes
- Delivery status

Server CANNOT see:
- Message content
- Media content (also encrypted)

Legal implications:
- Server cannot comply with content disclosure orders
- Can provide metadata if required by law
- WhatsApp's approach: transparent about what they can/cannot provide
```

**Key verification**:

```python
# Users can verify each other's keys to prevent MITM attacks

def generate_safety_number(alice_identity_key: bytes, bob_identity_key: bytes) -> str:
    # Combine keys in consistent order
    combined = sorted([alice_identity_key, bob_identity_key])
    
    # Hash and format as readable number
    digest = hashlib.sha256(combined[0] + combined[1]).digest()
    
    # Convert to 60-digit safety number (12 groups of 5 digits)
    numbers = []
    for i in range(12):
        chunk = digest[i * 4 : (i + 1) * 4]
        num = int.from_bytes(chunk, 'big') % 100000
        numbers.append(f"{num:05d}")
    
    return " ".join(numbers)

# Users can compare safety numbers in person or via QR code
# If they match, the E2EE session is verified (no MITM)
```

---

## 7. Production Operations

### 🟢 Beginner — The Hospital Monitoring Room

A hospital has a room where nurses watch screens showing all patients' vital signs. If someone's heart rate spikes, an alarm sounds.

Running a chat system is similar. Engineers watch dashboards showing:
- How many messages per second (heart rate)
- How fast messages are delivered (blood pressure)
- Any errors happening (fever)

When something goes wrong, alerts trigger and engineers investigate.

---

### 🟡 Senior — Monitoring & Alerting

```yaml
# Critical alerts for chat system
alerts:
  - name: HighMessageLatency
    expr: histogram_quantile(0.99, message_delivery_latency_seconds) > 0.5
    for: 2m
    severity: warning
    
  - name: WebSocketConnectionDrop
    expr: rate(websocket_disconnects_total[5m]) / rate(websocket_connects_total[5m]) > 0.1
    for: 5m
    severity: critical
    
  - name: KafkaConsumerLag
    expr: kafka_consumer_group_lag{group="fanout-workers"} > 10000
    for: 5m
    severity: critical
    
  - name: PushNotificationFailures
    expr: rate(push_notification_failures_total[5m]) / rate(push_notification_attempts_total[5m]) > 0.05
    for: 5m
    severity: warning
    
  - name: DatabaseWriteLatency
    expr: histogram_quantile(0.99, cassandra_write_latency_seconds) > 0.1
    for: 2m
    severity: warning
```

**Key metrics to track**:

| Metric | Purpose | Alert Threshold |
|--------|---------|-----------------|
| message_delivery_latency_p99 | User experience | > 500ms |
| websocket_connections_total | Capacity | > 80% of limit |
| messages_per_second | Traffic baseline | Anomaly detection |
| kafka_consumer_lag | Fan-out backlog | > 10K messages |
| push_failure_rate | Offline delivery | > 5% |
| presence_update_latency | Real-time feel | > 200ms |
| error_rate_5xx | System health | > 0.1% |

---

### 🔴 Architect — Incident Response

**Incident: Users report messages not delivering**

```markdown
## Runbook: Message Delivery Failure

### Symptoms
- Users report messages stuck on "sending"
- Delivery confirmation not received
- Rising undelivered message count

### Step 1: Identify scope
- Single user → likely client issue
- Single conversation → possibly group issue
- Global → system-wide problem

### Step 2: Check message pipeline
1. API layer: Are messages being received?
   - Check: API request rate, error rate
   
2. Database: Are messages being stored?
   - Check: Cassandra write latency, errors
   
3. Fan-out: Are messages being routed?
   - Check: Kafka consumer lag, worker errors
   
4. Delivery: Are WebSocket sends failing?
   - Check: WebSocket send errors, connection count

### Step 3: Common causes
- Kafka broker down → messages stuck in queue
- Cassandra overloaded → writes timing out
- Redis Pub/Sub issues → cross-server routing broken
- Certificate expiry → WebSocket connections failing

### Step 4: Mitigation
- Scale up affected component
- Restart unhealthy pods
- If Kafka: manual partition reassignment
- If persistent: engage database team

### Step 5: Recovery
- Verify message delivery resuming
- Clear any backlog (Kafka lag)
- Notify users if outage > 5 minutes
```

---

## 8. Real-World Case Studies

### WhatsApp Architecture

**Scale** (as of 2020):
- 2 billion users
- 100 billion messages/day
- 2 million connections per server (Erlang)

**Key decisions**:
- **Erlang/FreeBSD**: Handles millions of connections efficiently
- **BEAM VM**: Hot code reloading (deploy without disconnecting users)
- **Mnesia**: Distributed database built into Erlang
- **XMPP-based protocol**: Initially, now custom binary protocol
- **E2EE**: Signal Protocol, open-sourced

**Engineering insight**: WhatsApp ran on 50 engineers for 450M users. Erlang's actor model and BEAM's reliability enabled this.

---

### Slack Architecture

**Scale**:
- 12 million DAU (2020)
- Hundreds of thousands of organizations
- Millions of channels

**Key decisions**:
- **PHP + Hack initially**: Monolith for speed
- **MySQL sharded by workspace**: Each workspace isolated
- **Flannel (service mesh)**: For internal routing
- **Job queue**: Async processing for notifications, search indexing
- **Lucene/Elasticsearch**: Message search

**Difference from WhatsApp**:
- Business focus (compliance, search, integrations)
- Larger message limits (no E2EE by default)
- Web-first (desktop/browser primary)
- Read receipts not as critical

---

### Discord Architecture

**Scale**:
- 150 million MAU
- Millions of concurrent voice users
- Large "guilds" with 500K+ members

**Key decisions**:
- **Elixir (Erlang VM)**: Similar benefits to WhatsApp
- **Rust**: Performance-critical paths (particularly voice)
- **Cassandra**: Message storage
- **ScyllaDB**: Hot data (presence, sessions)
- **Custom CDN**: For media with 250ms global latency

**Challenge solved**: "Guild presence" — showing online members in a 500K person server. Solution: sampling and caching (show approximation, not exact list).

---

## Quick Recall Cheat Sheet {#cheat-sheet}

| Concept | One-Line Recall |
|---------|----------------|
| WebSocket | Bidirectional persistent connection; server pushes messages instantly |
| Long Polling | HTTP request held open; higher overhead, simpler firewalls |
| Snowflake ID | 64-bit: timestamp + machine + sequence; sortable, no coordination |
| At-least-once | Retry until ACK; dedupe on client_message_id |
| Message status | sent → delivered (device got it) → read (user opened) |
| Presence | Redis String with TTL; online if key exists |
| Typing | Ephemeral; broadcast throttled; auto-expire 5s |
| Group fan-out | Small group: sync; Large group: Kafka workers |
| Cassandra partition | (conversation_id, day_bucket) to avoid hot partitions |
| Push notification | Fallback channel; wakes app; 4KB limit |
| Silent push | content-available (iOS) or data-only (Android) |
| E2EE | Signal Protocol; server sees ciphertext + metadata only |
| Sender Keys | Group E2EE; encrypt once, all members decrypt |
| Safety Number | Hash of identity keys; verify to prevent MITM |
| Connection routing | Redis maps user → server; Pub/Sub between servers |
| Offline queue | Redis list per user; drain on reconnect |
| Heartbeat | Ping/pong every 30s; no response = dead connection |
| Reconnect sync | Client sends last_message_id; server returns delta |
