# Answers: WhatsApp / Slack (Chat System)

> Keyed to [questions.md](./questions.md). Read questions first.
> Code examples use Python/TypeScript where helpful.

---

## Level 1 — Chat Fundamentals

### A1. Why HTTP Request-Response Fails for Chat

HTTP is **client-initiated**. The client asks, the server responds. There's no way for the server to spontaneously send data to the client.

When Alice sends "Hello" to Bob:
1. Alice's phone POSTs the message to the server ✅
2. Server stores it ✅
3. Bob's phone is... doing nothing. It has no active request.
4. Bob won't see the message until his phone polls the server.

**Polling** (asking "any new messages?" every N seconds) works but wastes bandwidth and battery. With 1 million users polling every second, that's 1 million requests where 99% return empty.

**Solution**: Persistent connections (WebSockets) where the server can push messages to clients.

---

### A2. What is a WebSocket

WebSocket is a **bidirectional, full-duplex** protocol over a single TCP connection.

```text
HTTP Request-Response:
Client ──── GET /messages ────► Server
Client ◄─── [messages] ───────── Server
       (connection closes)

WebSocket:
Client ──── GET /ws (Upgrade) ──► Server
Client ◄─── 101 Switching ──────── Server
       ═══════════════════════════
       │  Persistent connection   │
       │  Both sides can send     │
       │  anytime                 │
       ═══════════════════════════
```

**Lifecycle**:
1. **Handshake**: HTTP request with `Upgrade: websocket` header
2. **Open**: Connection established, server assigns connection ID
3. **Message**: Either side sends frames (text or binary)
4. **Ping/Pong**: Keep-alive heartbeats
5. **Close**: Either side initiates close handshake

---

### A3. Simple Message Schema

```sql
CREATE TABLE messages (
    message_id BIGINT PRIMARY KEY,  -- Snowflake ID
    conversation_id UUID NOT NULL,
    sender_id UUID NOT NULL,
    content TEXT NOT NULL,          -- Encrypted in production
    message_type VARCHAR(20) DEFAULT 'text',
    created_at TIMESTAMP DEFAULT NOW(),
    
    INDEX idx_conversation_messages (conversation_id, message_id DESC)
);

CREATE TABLE conversations (
    conversation_id UUID PRIMARY KEY,
    type VARCHAR(10) NOT NULL,  -- 'direct' or 'group'
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE conversation_members (
    conversation_id UUID,
    user_id UUID,
    joined_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (conversation_id, user_id)
);
```

When Alice sends "Hello" to Bob:
1. Check/create conversation between Alice and Bob
2. Insert message row
3. Update conversation's `last_message_at` (for sorting in inbox)

---

### A4. Message Ordering

**Sort by `message_id`**, not `created_at`:

| Field | Problem |
|-------|---------|
| `created_at` (timestamp) | Clock skew between servers; two messages at same millisecond |
| Auto-increment ID | Works only on single database; fails in distributed setup |
| **Snowflake ID** | 64-bit, globally unique, sortable, incorporates timestamp |

Snowflake ID structure:
```text
┌─────────────────────────────────────────────────────────────────────┐
│ 1 bit │  41 bits timestamp  │ 10 bits machine │ 12 bits sequence  │
│ (0)   │  (milliseconds)     │  ID             │  (per ms counter) │
└─────────────────────────────────────────────────────────────────────┘
```

IDs generated on the same server in the same millisecond get sequential sequence numbers. IDs are always increasing and sortable.

---

### A5. Snowflake ID Benefits

| Feature | Auto-Increment | UUID | Snowflake |
|---------|----------------|------|-----------|
| Globally unique | ❌ (single DB) | ✅ | ✅ |
| Sortable by time | ❌ | ❌ | ✅ |
| Size | 8 bytes | 16 bytes | 8 bytes |
| No coordination | ❌ | ✅ | ✅ |
| Reveals creation time | ❌ | ❌ | ✅ |

```python
import time

class SnowflakeGenerator:
    def __init__(self, machine_id: int):
        self.machine_id = machine_id & 0x3FF  # 10 bits
        self.sequence = 0
        self.last_timestamp = 0
    
    def generate(self) -> int:
        timestamp = int(time.time() * 1000)  # milliseconds
        
        if timestamp == self.last_timestamp:
            self.sequence = (self.sequence + 1) & 0xFFF
            if self.sequence == 0:  # Overflow, wait for next ms
                while timestamp <= self.last_timestamp:
                    timestamp = int(time.time() * 1000)
        else:
            self.sequence = 0
        
        self.last_timestamp = timestamp
        
        return (
            (timestamp << 22) |
            (self.machine_id << 12) |
            self.sequence
        )
```

---

## Level 2 — Real-Time Transport

### A6. WebSocket vs Long Polling vs SSE

| Feature | WebSocket | Long Polling | SSE |
|---------|-----------|--------------|-----|
| Direction | Bidirectional | Request-response (simulated push) | Server → Client only |
| Latency | Lowest | Higher (HTTP overhead per request) | Low |
| Mobile battery | Good (one connection) | Poor (frequent requests) | Good |
| Browser support | All modern | All | All modern |
| Firewall friendliness | Usually OK (port 443) | Best | Good |
| Complexity | Medium | Low | Low |

**For chat: WebSocket**. Chat requires bidirectional (sending + receiving) with lowest latency. SSE is server-to-client only — you'd need separate HTTP for sending.

---

### A7. Multiple Connections Per User

```python
# Redis structure for user connections
# Key: user:{user_id}:connections
# Value: Set of (server_id, connection_id, device_type)

async def on_connect(user_id: str, device_id: str, connection_id: str):
    server_id = get_current_server_id()
    
    # Register this connection
    await redis.sadd(f"user:{user_id}:connections", json.dumps({
        "server_id": server_id,
        "connection_id": connection_id,
        "device_id": device_id
    }))
    
    # Set TTL (cleaned up if server crashes)
    await redis.expire(f"user:{user_id}:connections", 300)

async def send_to_user(user_id: str, message: dict):
    connections = await redis.smembers(f"user:{user_id}:connections")
    
    for conn_info in connections:
        info = json.loads(conn_info)
        if info["server_id"] == get_current_server_id():
            # Local connection
            await local_connections[info["connection_id"]].send(message)
        else:
            # Remote server — publish via Redis
            await redis.publish(f"server:{info['server_id']}:messages", json.dumps({
                "connection_id": info["connection_id"],
                "payload": message
            }))
```

---

### A8. Heartbeat / Ping-Pong

WebSocket has built-in ping/pong frames:

```python
import asyncio
import websockets

async def chat_handler(websocket):
    try:
        # Server sends ping every 30 seconds
        asyncio.create_task(heartbeat(websocket))
        
        async for message in websocket:
            await handle_message(websocket, message)
    except websockets.exceptions.ConnectionClosed:
        await handle_disconnect(websocket)

async def heartbeat(websocket):
    while True:
        await asyncio.sleep(30)
        try:
            pong_waiter = await websocket.ping()
            await asyncio.wait_for(pong_waiter, timeout=10)
        except asyncio.TimeoutError:
            # Client didn't respond — connection dead
            await websocket.close()
            break
```

**Client-side**: If no messages or pongs received in 45 seconds, assume connection dead and reconnect.

---

### A9. Reconnection Sync Protocol

```python
# Client reconnect flow

# 1. Client connects with last known message ID
ws.connect(f"/ws/chat?last_message_id={last_received_id}")

# 2. Server sends missed messages
async def handle_reconnect(websocket, user_id: str, last_message_id: int):
    # Fetch messages since last seen
    missed_messages = await db.query("""
        SELECT * FROM messages m
        JOIN conversation_members cm ON m.conversation_id = cm.conversation_id
        WHERE cm.user_id = $1 AND m.message_id > $2
        ORDER BY m.message_id ASC
        LIMIT 1000
    """, user_id, last_message_id)
    
    # Send sync batch
    await websocket.send(json.dumps({
        "type": "sync",
        "messages": missed_messages,
        "has_more": len(missed_messages) == 1000
    }))
```

Client handles `sync` message, inserts into local database, updates UI.

---

### A10. Scaling WebSocket Servers

**Problem**: Alice → Server A, Bob → Server B. How does Alice's message reach Bob?

**Solution**: Message broker (Redis Pub/Sub or Kafka).

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    WebSocket Routing with Redis                      │
└─────────────────────────────────────────────────────────────────────┘

Alice (Server A)                                     Bob (Server B)
      │                                                    │
      ├─── send("Hello Bob") ──────────────────────────────┤
      │         │                                          │
      ▼         ▼                                          │
   Server A receives message                               │
      │                                                    │
      ├─── Look up Bob's connection in Redis               │
      │    → Returns: Server B, conn_123                   │
      │                                                    │
      ├─── Publish to Redis: server:B:messages             │
      │                                                    │
      │                   Redis Pub/Sub                    │
      │                        │                           │
      │                        ▼                           │
      │                   Server B subscribes              │
      │                   to server:B:messages             │
      │                        │                           │
      │                        ├─── Find conn_123 ────────►│
      │                        │                           │
      │                        └─── Forward message ──────►│ Bob receives
```

---

## Level 3 — Message Delivery Guarantees

### A11. At-Least-Once vs Exactly-Once

| Guarantee | Meaning | Implementation | User Impact |
|-----------|---------|----------------|-------------|
| At-most-once | Message sent once, may be lost | Fire and forget | Missing messages |
| **At-least-once** | Retry until ack; may duplicate | Retry + Dedup | May see duplicates |
| Exactly-once | Each message delivered exactly once | Very complex | None |

**At-least-once** is practical: If delivery fails, retry. Accept that duplicates may occur. Handle duplicates via idempotency (client-generated message IDs).

---

### A12. Preventing Duplicate Messages

Client generates a unique `client_message_id` (UUID) before sending:

```python
# Client
message = {
    "type": "send_message",
    "client_message_id": str(uuid.uuid4()),  # Generated once
    "conversation_id": "conv_123",
    "content": "Hello!"
}

# First attempt
ws.send(message)
# No ack received (timeout) → retry
ws.send(message)  # Same client_message_id

# Server
async def handle_send_message(data):
    # Deduplicate using client_message_id
    existing = await redis.get(f"dedup:{data['client_message_id']}")
    if existing:
        # Already processed — return existing message
        return json.loads(existing)
    
    # Process new message
    message = await create_message(data)
    
    # Store dedup key (expire after 24 hours)
    await redis.setex(
        f"dedup:{data['client_message_id']}", 
        86400,
        json.dumps(message)
    )
    
    return message
```

---

### A13. Three-Tick System (WhatsApp)

```text
Message States:
┌────────────────────────────────────────────────────────────────────┐
│  ✓     (Single gray)  — Sent: Server received message              │
│  ✓✓    (Double gray)  — Delivered: Recipient's device got it      │
│  ✓✓    (Double blue)  — Read: Recipient opened conversation       │
└────────────────────────────────────────────────────────────────────┘

Timeline:
1. Alice sends "Hello"
2. Server receives → stores → ACKs to Alice → ✓ shown
3. Server pushes to Bob's device (or queues for push notification)
4. Bob's device receives → sends delivery ACK → Server updates status
5. Server notifies Alice's device → ✓✓ shown
6. Bob opens conversation → sends read ACK → Server updates status  
7. Server notifies Alice → ✓✓ turns blue
```

**Database tracking**:

```sql
CREATE TABLE message_status (
    message_id BIGINT,
    recipient_id UUID,
    status VARCHAR(10) DEFAULT 'sent',  -- sent, delivered, read
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    PRIMARY KEY (message_id, recipient_id)
);
```

---

### A14. Tie-Breaking Concurrent Messages

Snowflake IDs already handle this:

```text
Alice sends at 2024-01-15 10:30:00.123 UTC
Bob sends at   2024-01-15 10:30:00.123 UTC

Alice's message: generated by Server A (machine_id=1)
Bob's message:   generated by Server B (machine_id=2)

IDs:
Alice: timestamp|machine_1|seq_0 → smaller
Bob:   timestamp|machine_2|seq_0 → larger

Display order: Alice's message first (lower ID)
```

The machine_id component ensures uniqueness; sorting by ID gives consistent order across all clients.

---

### A15. Tracking Delivered/Read Status Efficiently

```python
# On message delivery (to recipient's device)
async def acknowledge_delivery(user_id: str, message_ids: list[int]):
    await db.execute("""
        UPDATE message_status
        SET status = 'delivered', delivered_at = NOW()
        WHERE message_id = ANY($1) AND recipient_id = $2 AND status = 'sent'
    """, message_ids, user_id)
    
    # Notify senders
    for msg_id in message_ids:
        sender_id = await get_sender(msg_id)
        await send_to_user(sender_id, {
            "type": "status_update",
            "message_id": msg_id,
            "status": "delivered"
        })

# On conversation opened (read receipts)
async def mark_conversation_read(user_id: str, conversation_id: str, up_to_message_id: int):
    # Batch update all unread messages in conversation
    affected = await db.execute("""
        UPDATE message_status
        SET status = 'read', read_at = NOW()
        WHERE message_id <= $1 
          AND recipient_id = $2
          AND conversation_id = $3
          AND status != 'read'
        RETURNING message_id, sender_id
    """, up_to_message_id, user_id, conversation_id)
    
    # Batch notify senders
    # Group by sender to reduce notifications
    ...
```

---

## Level 4 — Presence & Typing Indicators

### A16. Online Status Determination

```python
ONLINE_THRESHOLD_SECONDS = 30

class PresenceService:
    def __init__(self, redis):
        self.redis = redis
    
    async def heartbeat(self, user_id: str):
        """Called on any user activity (message sent, app foregrounded)"""
        await self.redis.setex(f"presence:{user_id}", ONLINE_THRESHOLD_SECONDS, "online")
        await self.publish_presence_change(user_id, "online")
    
    async def is_online(self, user_id: str) -> bool:
        return await self.redis.exists(f"presence:{user_id}")
    
    async def get_last_seen(self, user_id: str) -> datetime:
        last_seen = await self.redis.get(f"last_seen:{user_id}")
        return datetime.fromisoformat(last_seen) if last_seen else None
    
    async def on_disconnect(self, user_id: str):
        # Don't immediately mark offline — connection might reconnect
        await self.redis.setex(f"presence:{user_id}", 10, "online")  # Grace period
        await self.redis.set(f"last_seen:{user_id}", datetime.utcnow().isoformat())
```

---

### A17. Grace Period Before Marking Offline

**Problem**: WebSocket connections flicker — network blip causes disconnect/reconnect in 2 seconds. Don't broadcast "Bob went offline" and "Bob came online" rapidly.

```python
async def on_disconnect(user_id: str, connection_id: str):
    # Remove this specific connection
    await redis.srem(f"user:{user_id}:connections", connection_id)
    
    # Check if user has other connections
    remaining = await redis.scard(f"user:{user_id}:connections")
    
    if remaining == 0:
        # Schedule offline check in 10 seconds
        await task_queue.schedule(
            task="check_user_offline",
            user_id=user_id,
            run_at=datetime.utcnow() + timedelta(seconds=10)
        )

async def check_user_offline(user_id: str):
    # If still no connections after grace period, mark offline
    connections = await redis.scard(f"user:{user_id}:connections")
    if connections == 0:
        await redis.set(f"last_seen:{user_id}", datetime.utcnow().isoformat())
        await publish_presence_change(user_id, "offline")
```

---

### A18. Typing Indicator Implementation

```python
# Client sends typing events
{
    "type": "typing",
    "conversation_id": "conv_123",
    "is_typing": true
}

# Server with debouncing
class TypingManager:
    def __init__(self):
        self.typing_users = {}  # conversation_id -> {user_id: expires_at}
    
    async def handle_typing(self, user_id: str, conversation_id: str, is_typing: bool):
        key = (conversation_id, user_id)
        
        if is_typing:
            # Set/update typing flag with 5-second expiry
            self.typing_users[key] = datetime.utcnow() + timedelta(seconds=5)
            
            # Broadcast to conversation (throttled — max once per 3 seconds)
            if should_broadcast(key):
                await broadcast_typing(conversation_id, user_id, True)
        else:
            # User stopped typing
            self.typing_users.pop(key, None)
            await broadcast_typing(conversation_id, user_id, False)

# Pitfalls:
# 1. Don't send on every keystroke — throttle to every 3 seconds
# 2. Auto-expire after 5 seconds (user may close app without sending stop)
# 3. Don't persist — purely ephemeral
```

---

### A19. "Last Seen" Privacy Settings

```sql
-- User settings
CREATE TABLE user_privacy_settings (
    user_id UUID PRIMARY KEY,
    last_seen_visibility VARCHAR(20) DEFAULT 'everyone',  -- everyone, contacts, nobody
    read_receipts_enabled BOOLEAN DEFAULT TRUE
);
```

```python
async def get_user_last_seen(viewer_id: str, target_id: str) -> dict:
    settings = await get_privacy_settings(target_id)
    
    if settings.last_seen_visibility == "nobody":
        return {"last_seen": None, "status": "hidden"}
    
    if settings.last_seen_visibility == "contacts":
        if not await are_contacts(viewer_id, target_id):
            return {"last_seen": None, "status": "hidden"}
    
    # Allowed to see
    last_seen = await redis.get(f"last_seen:{target_id}")
    is_online = await redis.exists(f"presence:{target_id}")
    
    return {
        "last_seen": last_seen,
        "status": "online" if is_online else "offline"
    }
```

---

### A20. Redis for Presence

Redis is ideal for presence because:
- Low latency (in-memory)
- Built-in expiry (TTL for online status)
- Pub/Sub for real-time updates
- Ephemeral by nature (presence isn't critical data)

```python
# Redis data structures for presence

# 1. Online status (String with TTL)
SET presence:user_123 "online" EX 30

# 2. Last seen (String)
SET last_seen:user_123 "2024-01-15T10:30:00Z"

# 3. User connections (Set)
SADD user:user_123:connections "server1:conn_abc"
SADD user:user_123:connections "server2:conn_def"

# 4. Pub/Sub for presence changes
SUBSCRIBE presence:updates
PUBLISH presence:updates '{"user_id": "user_123", "status": "online"}'

# 5. Subscribers for a user (who wants to know when user_123's status changes)
SADD presence:user_123:subscribers "user_456" "user_789"
```

---

## Level 5 — Group Messaging

### A21. Group Fan-Out Process

```text
Alice sends to 200-person group:

Synchronous (BAD):
for recipient in group.members:
    send_to_user(recipient, message)
    # 200 iterations × 10ms each = 2 seconds latency for Alice

Asynchronous (GOOD):
1. Alice → Server: receives message, stores, ACKs immediately
2. Server → Kafka: publishes fan-out task
3. Fan-out workers consume, deliver to recipients' devices in parallel
```

```python
# Async fan-out with Kafka
async def handle_group_message(message: Message):
    # 1. Store message
    await db.insert(message)
    
    # 2. Acknowledge to sender immediately
    await send_to_user(message.sender_id, {
        "type": "message_ack",
        "message_id": message.id,
        "status": "sent"
    })
    
    # 3. Queue fan-out
    await kafka.produce("group-fanout", {
        "message_id": message.id,
        "conversation_id": message.conversation_id,
        "content": message.content
    })

# Fan-out worker (multiple instances)
async def fanout_worker():
    async for record in kafka.consume("group-fanout"):
        message = record.value
        members = await get_group_members(message["conversation_id"])
        
        # Parallel delivery
        await asyncio.gather(*[
            deliver_to_user(member_id, message)
            for member_id in members
        ])
```

---

### A22. Scaling Read Receipts for Large Groups

**Problem**: 1,000 members × 1,000 messages = 1,000,000 status records per day.

**Solutions**:

| Approach | Trade-off |
|----------|-----------|
| **No read receipts for large groups** | WhatsApp does this (groups >100 don't show read receipts) |
| **Sample read receipts** | Show "Read by 15 of 200" instead of listing everyone |
| **Aggregate storage** | Store `{message_id: [reader_ids]}` as array/set |
| **On-demand computation** | Only compute when user requests "who read this?" |

```sql
-- Aggregated approach (store reader IDs as array)
CREATE TABLE group_message_reads (
    message_id BIGINT PRIMARY KEY,
    reader_ids UUID[] DEFAULT '{}'
);

-- Add reader
UPDATE group_message_reads
SET reader_ids = array_append(reader_ids, 'user_456')
WHERE message_id = 123;

-- Count readers
SELECT array_length(reader_ids, 1) FROM group_message_reads WHERE message_id = 123;
```

---

### A23. WhatsApp vs Slack Group Scalability

| Aspect | WhatsApp | Slack |
|--------|----------|-------|
| Group limit | 1,024 | 100,000+ |
| Read receipts | Yes (small groups) | No |
| Media storage | On-device | Server-side |
| Message history | On-device | Server-side (searchable) |
| Real-time sync | All messages | Batched, lazy load |

**Slack's scaling approach**:
- Messages stored server-side, paginated on demand
- No delivery/read receipts
- Notifications batched ("50 new messages in #general")
- Desktop app uses HTTP + SSE, not WebSocket for everything

---

### A24. Handling Member Removal

```python
async def remove_member(group_id: str, admin_id: str, removed_user_id: str):
    # Verify admin permissions
    if not await is_admin(group_id, admin_id):
        raise PermissionDenied()
    
    # Remove from members table
    await db.execute("""
        DELETE FROM conversation_members
        WHERE conversation_id = $1 AND user_id = $2
    """, group_id, removed_user_id)
    
    # Add system message
    await create_system_message(group_id, f"{removed_user_id} was removed")
    
    # Notify the removed user
    await send_to_user(removed_user_id, {
        "type": "removed_from_group",
        "group_id": group_id
    })
    
    # Client handles: disable input, show "You're no longer a member"
    # Message history: Usually retained locally on device (WhatsApp)
    # Future messages: Won't be delivered to removed user
```

---

### A25. Notification Batching for Active Groups

```python
class NotificationBatcher:
    def __init__(self):
        self.pending = {}  # user_id -> {conversation_id: count}
        self.last_notification = {}  # user_id -> timestamp
    
    async def maybe_notify(self, user_id: str, conversation_id: str, message: dict):
        # Check if user is online (WebSocket connected)
        if await is_user_connected(user_id):
            return  # No push needed, delivered via WebSocket
        
        # Check cooldown (don't spam notifications)
        last = self.last_notification.get(user_id)
        if last and (datetime.utcnow() - last).seconds < 60:
            # Batch: increment counter, don't send yet
            self.pending.setdefault(user_id, {})[conversation_id] = \
                self.pending.get(user_id, {}).get(conversation_id, 0) + 1
            return
        
        # Send batched notification
        pending_count = sum(self.pending.get(user_id, {}).values())
        if pending_count > 0:
            await send_push(user_id, {
                "title": f"{pending_count + 1} new messages",
                "body": f"Messages in {len(self.pending[user_id])} conversations"
            })
        else:
            await send_push(user_id, {
                "title": message["sender_name"],
                "body": message["content"][:100]
            })
        
        self.last_notification[user_id] = datetime.utcnow()
        self.pending.pop(user_id, None)
```

---

## Level 6 — Media & Attachments

### A26. Media Upload Flow

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    Media Upload Flow                                 │
└─────────────────────────────────────────────────────────────────────┘

1. Client initiates upload
   POST /upload/init
   Body: { file_size: 10MB, file_type: "image/jpeg" }
   Response: { upload_id, presigned_url }

2. Client uploads directly to blob storage (S3)
   PUT {presigned_url}
   Body: file bytes

3. Client notifies server upload complete
   POST /upload/complete/{upload_id}
   Response: { media_url, thumbnail_url }

4. Client sends message with media reference
   WebSocket: { type: "send_message", content: "", media_id: "..." }
```

**Never embed image bytes in message**. Reference by URL. Enables:
- Progressive loading
- Multiple resolutions
- CDN caching
- Deduplication

---

### A27. Optimistic Media Preview

```javascript
// Client-side
async function sendPhoto(conversationId, imageFile) {
  // 1. Generate local preview immediately
  const localPreview = URL.createObjectURL(imageFile);
  
  // 2. Add to UI with "sending" state
  const tempId = generateUUID();
  addMessageToUI({
    id: tempId,
    content: localPreview,
    status: 'sending',
    isLocal: true
  });
  
  // 3. Upload in background
  const { mediaUrl, thumbnailUrl } = await uploadMedia(imageFile);
  
  // 4. Send message with real URL
  const message = await sendMessage(conversationId, {
    type: 'image',
    mediaUrl,
    thumbnailUrl
  });
  
  // 5. Replace local preview with real message
  replaceMessage(tempId, message);
}
```

---

### A28. Media Processing Pipeline

```text
Processing happens ASYNC after upload:

┌─────────────────┐
│   Raw Upload    │
│   (10 MB JPEG)  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Media Processing Workers                          │
├──────────────────┬─────────────────────┬───────────────────────────┤
│  Thumbnail Gen   │  Compression        │  Multiple Resolutions     │
│  (200x200)       │  (Optimize JPEG)    │  (480p, 720p, 1080p)      │
└────────┬─────────┴─────────┬───────────┴────────────┬──────────────┘
         │                   │                        │
         ▼                   ▼                        ▼
┌─────────────────┐  ┌─────────────────┐  ┌───────────────────────────┐
│  S3: thumbnails │  │  S3: optimized  │  │  S3: resolutions          │
│  /thumb/abc.jpg │  │  /media/abc.jpg │  │  /media/abc_720p.jpg      │
└─────────────────┘  └─────────────────┘  └───────────────────────────┘
```

When upload completes, queue processing job to Kafka. Workers process in parallel, update media metadata when done.

---

### A29. Progressive Media Loading

```javascript
// Message structure
{
  "type": "image",
  "thumbnail_url": "https://cdn/thumb/abc.jpg",  // 2KB blurred
  "media_url": "https://cdn/media/abc.jpg",      // Full resolution
  "width": 1920,
  "height": 1080,
  "blurhash": "LEHV6nWB2yk8pyo0adR*.7kCMdnj"  // 20-byte placeholder
}

// Client rendering
function renderImage(message) {
  // 1. Show blurhash placeholder immediately (local computation)
  showBlurhash(message.blurhash, message.width, message.height);
  
  // 2. Load thumbnail
  loadImage(message.thumbnail_url).then(thumb => {
    replacePlaceholder(thumb);
    
    // 3. User taps for full resolution
    onTap(() => loadImage(message.media_url));
  });
}
```

---

### A30. Securing Media Access

```python
# Option 1: Signed URLs (time-limited)
def get_media_url(media_id: str, user_id: str) -> str:
    # Verify user has access to this media (member of conversation)
    if not has_access(user_id, media_id):
        raise Forbidden()
    
    # Generate signed URL expiring in 1 hour
    return s3.generate_presigned_url(
        'get_object',
        Params={'Bucket': BUCKET, 'Key': media_id},
        ExpiresIn=3600
    )

# Option 2: CDN with auth tokens
# URL format: https://cdn.example.com/media/{media_id}?token={jwt}
# CDN validates JWT, checks claims include media_id
```

---

## Level 7 — Offline & Push Notifications

### A31. Offline Message Delivery

```python
async def deliver_to_user(user_id: str, message: dict):
    connections = await get_user_connections(user_id)
    
    if connections:
        # User online — deliver via WebSocket
        for conn in connections:
            await send_to_connection(conn, message)
    else:
        # User offline — queue for push notification
        await push_service.queue_for_push(user_id, message)

class PushService:
    async def queue_for_push(self, user_id: str, message: dict):
        # Add to offline message queue
        await redis.rpush(f"offline:{user_id}", json.dumps(message))
        
        # Send push notification (summary, not full message)
        await send_push_notification(user_id, {
            "title": message["sender_name"],
            "body": truncate(message["content"], 100),
            "data": {
                "conversation_id": message["conversation_id"]
            }
        })
    
    async def drain_offline_queue(self, user_id: str):
        """Called when user reconnects via WebSocket"""
        messages = await redis.lrange(f"offline:{user_id}", 0, -1)
        await redis.delete(f"offline:{user_id}")
        return [json.loads(m) for m in messages]
```

---

### A32. Push Notification Payload Limits

```python
# APNs limit: 4 KB
# FCM limit: 4 KB

# Bad: Include full message content
{
    "notification": {
        "title": "Alice",
        "body": "[Entire 5 KB message content...]"  # FAILS
    }
}

# Good: Summary + data for app to fetch
{
    "notification": {
        "title": "Alice",
        "body": "Sent a message"  # Short
    },
    "data": {
        "conversation_id": "conv_123",
        "message_id": "msg_456"
    }
}

# When app opens, it fetches the actual message via API/WebSocket
```

---

### A33. Push Notification Batching

```python
async def decide_push_strategy(user_id: str, new_messages: list[dict]):
    pending_count = len(new_messages)
    
    if pending_count == 1:
        # Single message — show preview
        msg = new_messages[0]
        await send_push(user_id, {
            "title": msg["sender_name"],
            "body": msg["content"][:100]
        })
    elif pending_count <= 5:
        # Few messages — show summary per conversation
        await send_push(user_id, {
            "title": "New messages",
            "body": f"{pending_count} messages from {count_unique_senders(new_messages)} people"
        })
    else:
        # Many messages — collapse to single notification
        await send_push(user_id, {
            "title": "Chat",
            "body": f"You have {pending_count} new messages",
            "collapse_key": "chat_messages"  # Replace previous notification
        })
```

---

### A34. Cleaning Up Stale Push Tokens

```python
async def send_push(user_id: str, payload: dict):
    devices = await get_user_devices(user_id)
    
    for device in devices:
        try:
            if device.type == 'ios':
                await apns.send(device.push_token, payload)
            else:
                await fcm.send(device.push_token, payload)
        except InvalidTokenError:
            # Token no longer valid — user uninstalled or disabled
            await mark_device_inactive(device.id)
            logger.info(f"Removed stale push token for device {device.id}")
        except Exception as e:
            logger.error(f"Push failed: {e}")

# Also: FCM returns canonical token if changed
# Update token when FCM response includes canonical_id
```

---

### A35. Cross-Device Notification Sync

```python
# When message is read on any device, clear notification on others

async def on_message_read(user_id: str, conversation_id: str):
    # Update database
    await mark_conversation_read(user_id, conversation_id)
    
    # Send silent push to other devices
    devices = await get_user_devices(user_id)
    
    for device in devices:
        # "content-available" triggers background update
        await send_silent_push(device, {
            "type": "clear_notifications",
            "conversation_id": conversation_id
        })

# iOS: content-available = 1
# Android: data-only message with high priority
```

---

## Level 8 — Production Operations

### A36. Key Monitoring Metrics

| Metric | Alert Threshold | Why |
|--------|-----------------|-----|
| Message send latency p99 | > 500ms | User experience |
| WebSocket connections (per server) | > 80% capacity | Connection saturation |
| Message queue lag (Kafka) | > 10K messages | Fan-out falling behind |
| Push notification failure rate | > 5% | Delivery issues |
| Connection drop rate | > 10%/hour | Network or server issues |
| Database write latency p99 | > 100ms | Storage bottleneck |
| Presence update latency | > 200ms | Real-time feel degraded |
| Memory usage per server | > 80% | Connection memory leak |
| Error rate (5xx) | > 0.1% | System stability |
| Undelivered messages (>1 min old) | > 1000 | Delivery stuck |

---

### A37. Server Crash Recovery

```text
Chat server with 50K connections crashes:

1. Clients detect disconnect (no pong, no messages)
2. Clients enter exponential backoff reconnect:
   - 1s, 2s, 4s, 8s, 16s, 30s max

3. Load balancer routes to other healthy servers

4. On reconnect, client sends: { last_message_id: X }

5. Server queries messages since X from database

6. Server sends sync batch to client

User experience:
- 2-5 seconds of "connecting..."
- Messages during disconnect were stored, now delivered
- User doesn't lose any messages
```

---

### A38. End-to-End Encryption (E2EE) for 1:1 Chats

```text
Signal Protocol (used by WhatsApp):

1. Key Generation:
   - Each user has identity key pair (long-term)
   - Each user has ephemeral key pairs (short-term)

2. Session Establishment:
   - Alice and Bob perform X3DH (Extended Triple Diffie-Hellman)
   - Derive shared secret without server knowing

3. Message Encryption:
   - Alice encrypts message with shared secret + Double Ratchet
   - Server receives encrypted blob

4. What server sees:
   - Ciphertext (unintelligible)
   - Metadata: sender, recipient, timestamp, size
   - NOT: message content

Server's role:
- Route encrypted messages
- Store encrypted messages for offline delivery
- CANNOT read messages
```

---

### A39. E2EE for Group Chats

```text
Option 1: Pairwise Encryption (naive)
- Encrypt message separately for each member
- N members = N encryptions per message
- Expensive for large groups

Option 2: Sender Keys (WhatsApp/Signal)
- Each member generates a "sender key" for the group
- Distributes sender key to all members (encrypted to each)
- Messages encrypted once with sender key
- All members decrypt with same key

Steps:
1. Alice joins group, generates sender key
2. Alice encrypts sender key with Bob's public key, sends to Bob
3. Alice encrypts sender key with Carol's public key, sends to Carol
4. Alice sends message encrypted with sender key
5. Bob and Carol both decrypt with Alice's sender key

Problem: Member removal requires key rotation for all remaining members.
```

---

### A40. Government Data Requests with E2EE

```text
What company CAN provide:
- Account info (phone number, registration date)
- Metadata (who messaged whom, when, message sizes)
- IP addresses, device info

What company CANNOT provide:
- Message content (encrypted, server doesn't have key)
- Media content (encrypted)

Legal reality:
- Some jurisdictions require "lawful intercept" capability
- E2EE makes this technically impossible
- Companies like WhatsApp have faced legal battles over this
- Some countries ban or restrict E2EE services

Technical options (controversial):
- "Ghost user" in the group (adds law enforcement key)
- Client-side scanning before encryption
- Both are backdoors that undermine E2EE
```

---

### A41. Debugging Message Delays

```markdown
## Runbook: Message Delay Investigation

### Alert: Message delivery p99 > 5 seconds

### Step 1: Identify the bottleneck
- Check Kafka consumer lag: `kafka-consumer-groups --describe`
  - If lag growing: Fan-out workers overloaded
- Check Redis latency: `redis-cli --latency`
  - If >5ms: Presence/routing slow
- Check Cassandra latency: Grafana panel
  - If high: Database write bottleneck

### Step 2: Check for hot spots
- Single user sending to massive group?
- Specific conversation with unusual traffic?
- Query: SELECT count(*) FROM messages WHERE created_at > now() - interval '5 minutes'

### Step 3: Check connection state
- WebSocket server error logs
- Connection count per server
- Rejected connections (capacity)?

### Step 4: Verify push notification path
- APNs/FCM error rates
- Push queue depth

### Step 5: Scale if needed
- Add fan-out workers
- Scale WebSocket servers
- Add Cassandra nodes

### Communication
- Post to #incidents with findings
- If customer-facing: draft status page update
```

---

### A42. Zero-Downtime Database Migration

```text
MySQL → Cassandra Migration (500K msg/sec):

Phase 1: Dual Write (2 weeks)
- Modify write path: write to MySQL AND Cassandra
- Monitor Cassandra write success rate

Phase 2: Shadow Read (1 week)  
- Read from MySQL (primary)
- Also read from Cassandra (compare, don't return)
- Measure consistency

Phase 3: Backfill
- Migrate historical data from MySQL to Cassandra
- Batch job, rate-limited
- Track progress: last_migrated_id

Phase 4: Read Cutover
- Switch reads to Cassandra (with MySQL fallback)
- Monitor error rates

Phase 5: Write Cutover
- Stop writes to MySQL
- Cassandra is source of truth

Phase 6: Cleanup
- Decommission MySQL read replicas
- Archive MySQL data
- Remove dual-write code
```

---

## Bonus Answers

### AB1. Connection Routing via Redis

```python
# On WebSocket connect
async def on_connect(user_id: str, connection_id: str):
    server_id = get_server_id()
    await redis.hset(f"user_conns:{user_id}", connection_id, server_id)
    await redis.sadd(f"server_conns:{server_id}", f"{user_id}:{connection_id}")

# To send message to user
async def route_to_user(user_id: str, message: dict):
    connections = await redis.hgetall(f"user_conns:{user_id}")
    
    for conn_id, server_id in connections.items():
        if server_id == get_server_id():
            # Local delivery
            await local_sockets[conn_id].send(message)
        else:
            # Remote: publish to that server's channel
            await redis.publish(f"server:{server_id}", json.dumps({
                "conn_id": conn_id,
                "payload": message
            }))
```

### AB2. Server-Side Snowflake IDs

```python
# Generate message ID on server, not client
async def handle_new_message(client_id: str, content: str, conversation_id: str):
    # Server generates timestamp-based ID
    message_id = snowflake.generate()  
    
    # Guarantees:
    # - Globally unique
    # - Later messages have higher IDs (even from different servers)
    # - ID contains embedded timestamp for debugging
    
    message = Message(
        id=message_id,
        client_id=client_id,  # For dedup
        content=content,
        conversation_id=conversation_id
    )
    await db.insert(message)
    return message
```

### AB3. Kafka Partitioning for Fan-Out

```python
# Partition by recipient_id for parallelism
producer.send(
    "message-fanout",
    key=recipient_id.encode(),  # Partition key
    value=json.dumps(message).encode()
)

# Consumer group "fanout-workers" with 20 consumers
# Each consumer handles 1/20th of recipients
# Messages for same recipient always go to same consumer (ordering)
```

### AB4. Push as Fallback

```python
async def deliver_message(user_id: str, message: dict):
    # Try WebSocket first
    delivered = await try_websocket_delivery(user_id, message)
    
    if not delivered:
        # Queue for push AND store for later WebSocket sync
        await push_service.send(user_id, {
            "title": message["sender_name"],
            "body": "New message"  # Push wakes up app
        })
        
        # When app opens, it reconnects WebSocket
        # WebSocket sync delivers actual message content

# Push notifications:
# - Cost money at scale ($0.01 per 1000?)
# - Have rate limits (APNs: 3 per hour per device per app recommended)
# - Not guaranteed delivery
# - Should trigger app to reconnect, not replace WebSocket
```

### AB5. Rate Limiting Anti-Spam

```python
class MessageRateLimiter:
    # Per-user limits
    MESSAGES_PER_MINUTE = 60
    MESSAGES_PER_HOUR = 500
    
    async def check(self, user_id: str) -> bool:
        minute_key = f"ratelimit:{user_id}:minute"
        hour_key = f"ratelimit:{user_id}:hour"
        
        minute_count = await redis.incr(minute_key)
        if minute_count == 1:
            await redis.expire(minute_key, 60)
        
        hour_count = await redis.incr(hour_key)
        if hour_count == 1:
            await redis.expire(hour_key, 3600)
        
        if minute_count > self.MESSAGES_PER_MINUTE:
            return False
        if hour_count > self.MESSAGES_PER_HOUR:
            return False
        
        return True
```

### AB6. Cassandra Partition Key Design

```cql
-- Bad: Hot partition for active conversations
CREATE TABLE messages (
    conversation_id uuid,
    message_id bigint,
    content text,
    PRIMARY KEY (conversation_id, message_id)
);

-- Good: Time-bucketed to spread load
CREATE TABLE messages (
    conversation_id uuid,
    time_bucket text,  -- '2024-01-15' or '2024-01-15-10' (hour)
    message_id bigint,
    content text,
    PRIMARY KEY ((conversation_id, time_bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- Query: Get messages for conversation in time range
-- Hits multiple partitions in parallel
```

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---------|----------------|
| WebSocket | Bidirectional persistent connection; server can push anytime |
| Long Polling | HTTP request held open until data; high overhead vs WebSocket |
| Snowflake ID | 64-bit: timestamp + machine + sequence; sortable, unique |
| At-least-once | Retry until ACK; dedupe with client_message_id |
| Message status | sent (server got it) → delivered (device got it) → read (user saw it) |
| Presence | Redis with TTL; "online" = heartbeat within 30 seconds |
| Typing indicator | Ephemeral; throttle broadcasts; auto-expire 5 seconds |
| Group fan-out | Async via Kafka; never loop synchronously |
| Large group receipts | Skip read receipts or aggregate to count |
| Media upload | Presigned URL to S3; message references CDN URL |
| Push notification | Fallback for offline; wake app; 4KB limit |
| Connection routing | Redis maps user → server; pub/sub between servers |
| E2EE | Signal Protocol; server sees ciphertext + metadata only |
| Sender keys | Group E2EE; single encryption, all members decrypt |
| Cassandra partition | (conversation_id, time_bucket) to avoid hot partitions |
| Reconnect sync | Client sends last_message_id; server returns missed messages |
