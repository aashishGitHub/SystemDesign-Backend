# System Design: WhatsApp / Slack (Chat System)

> **Target:** Senior / Staff Engineers at Google, Meta, Amazon, Microsoft, Uber
> **Style:** Interview-grill format — every concept is introduced as a question first, then answered.

---

## How to Use This Guide

1. First pass — attempt every question yourself before reading the answer.
2. Second pass — read the answers, compare, note what you missed.
3. Third pass — whiteboard the full system from memory. No notes.

---

## Learning Path

| Level | Topic | You'll Learn |
|-------|-------|-------------|
| 1 | Chat Fundamentals | 1:1 messaging, message storage, basic delivery |
| 2 | Real-Time Transport | WebSocket vs Long Polling vs SSE, connection management |
| 3 | Message Delivery Guarantees | At-least-once, exactly-once, ordering, acknowledgments |
| 4 | Presence & Typing Indicators | Online/offline status, "last seen", typing notifications |
| 5 | Group Messaging | Fan-out strategies, group metadata, member management |
| 6 | Media & Attachments | Image/video upload, thumbnails, CDN delivery |
| 7 | Offline & Push Notifications | APNs, FCM, message queuing for offline users |
| 8 | Production Operations | Monitoring, failure modes, encryption, scale |

---

## Files

| File | Purpose |
|------|---------|
| [questions.md](./questions.md) | All questions, organized by level. Read first. |
| [answers.md](./answers.md) | Full answers with code examples and tradeoff tables. |
| [deep-dive.md](./deep-dive.md) | In-depth explanations — beginner to architect level. |

---

## The Problem Statement

> Design a real-time chat messaging system like WhatsApp or Slack that supports 1:1 messaging, group chats, online presence, read receipts, and media sharing.

**Key Constraints:**
- 2 billion users, 500 million DAU
- 100 billion messages per day (~1.2 million messages/second)
- Message delivery latency < 500ms (real-time feel)
- 99.99% availability
- Messages must never be lost
- Support offline message delivery
- End-to-end encryption for 1:1 chats

---

## Core Functional Requirements

✅ **CORE (design these)**
1. Users should be able to **send and receive messages** in real-time (1:1 and group)
2. Users should be able to see **online/offline status** and **read receipts** (single tick, double tick, blue tick)
3. Users should be able to **send media** (images, videos, files) in messages

❌ **BELOW THE LINE (out of scope)**
- Voice/video calling
- Stories/status feature
- Message reactions/emoji
- Full-text message search
- Message editing after send
- Disappearing messages

---

## Core Non-Functional Requirements

✅ **CORE (design these)**
1. **Real-time delivery**: Message latency < 500ms for online users
2. **Reliability**: No message loss, at-least-once delivery guaranteed
3. **Ordering**: Messages within a conversation appear in correct order

❌ **BELOW THE LINE (out of scope)**
- GDPR compliance / data residency
- Detailed audit logging
- Multi-device sync (beyond basic)
- Compliance archival

---

## How a Senior Engineer Thinks About This

The fundamental challenge is **real-time bidirectional communication at scale**. HTTP request-response doesn't work — you need persistent connections (WebSockets) so the server can push messages to clients instantly.

The second insight is **message lifecycle management**. A message goes through states: sent → delivered → read. Each transition requires acknowledgments flowing back to the sender. The system must track which messages reached which devices, especially for group chats.

The third insight is **handling offline users**. Not everyone is connected. Messages must be durably stored and delivered when the user comes online. For mobile users who close the app, you need push notifications (APNs/FCM) as a fallback channel.

The fourth insight is **fan-out for groups**. When Alice sends to a 500-person group, the system must deliver to 500 recipients efficiently. You can't just loop through and send 500 times synchronously.

---

## Core Entities

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Core Data Model                               │
└─────────────────────────────────────────────────────────────────────┘

User
├── user_id (PK)
├── phone_number (unique)
├── display_name
├── avatar_url
├── public_key (for E2E encryption)
├── last_seen_at
├── created_at
└── status_message

Conversation (1:1 or Group)
├── conversation_id (PK)
├── type (direct, group)
├── name (for groups)
├── avatar_url (for groups)
├── created_at
└── created_by

ConversationMember
├── conversation_id (PK, FK)
├── user_id (PK, FK)
├── role (admin, member)
├── joined_at
├── muted_until
└── last_read_message_id

Message
├── message_id (PK, Snowflake ID for ordering)
├── conversation_id (FK)
├── sender_id (FK → User)
├── content (encrypted text)
├── message_type (text, image, video, file, system)
├── media_url (for attachments)
├── reply_to_message_id (for threads)
├── created_at
└── deleted_at (soft delete)

MessageStatus (per recipient)
├── message_id (PK, FK)
├── recipient_id (PK, FK)
├── status (sent, delivered, read)
├── delivered_at
└── read_at

Device (for multi-device)
├── device_id (PK)
├── user_id (FK)
├── device_type (ios, android, web)
├── push_token (APNs/FCM)
├── last_active_at
└── created_at

UserConnection (WebSocket sessions)
├── connection_id (PK)
├── user_id (FK)
├── device_id (FK)
├── server_id
├── connected_at
└── last_heartbeat_at
```

---

## API Design

### Messaging

```
WebSocket /ws/chat?token={jwt}
// Persistent connection for real-time messaging

// Client → Server messages:
{
  "type": "send_message",
  "conversation_id": "conv_123",
  "content": "Hello!",
  "client_message_id": "uuid-for-dedup"
}

{
  "type": "ack_delivered",
  "message_ids": ["msg_456", "msg_457"]
}

{
  "type": "ack_read",
  "conversation_id": "conv_123",
  "last_read_message_id": "msg_460"
}

{
  "type": "typing",
  "conversation_id": "conv_123",
  "is_typing": true
}

// Server → Client messages:
{
  "type": "new_message",
  "message": { ... }
}

{
  "type": "message_status_update",
  "message_id": "msg_456",
  "status": "delivered",
  "user_id": "user_789"
}

{
  "type": "presence_update",
  "user_id": "user_789",
  "status": "online"
}
```

### REST APIs (for non-real-time operations)

```
GET /conversations -> Conversation[]
// List all conversations for the user

GET /conversations/{id}/messages?before={cursor}&limit=50 -> Message[]
// Paginated message history (cursor-based, newest first)

POST /conversations -> Conversation
Body: { type: "group", name: "Project Team", member_ids: [...] }
// Create a new group conversation

POST /upload/media -> MediaUploadResponse
Body: multipart/form-data with file
// Upload media, returns URL to include in message

GET /users/{id}/profile -> UserProfile
// Get user profile and online status
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Chat System Architecture                        │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   iOS App    │     │ Android App  │     │   Web App    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────── WebSocket ────────────────────┘
                            │
                   ┌────────▼────────┐
                   │  Load Balancer  │
                   │  (L4, sticky)   │
                   └────────┬────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  Chat Server  │   │  Chat Server  │   │  Chat Server  │
│  (WebSocket)  │   │  (WebSocket)  │   │  (WebSocket)  │
│   50K conns   │   │   50K conns   │   │   50K conns   │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│    Redis      │   │    Kafka      │   │   Message     │
│  (Pub/Sub +   │   │  (Message     │   │   Service     │
│   Presence)   │   │   Queue)      │   │  (Routing)    │
└───────────────┘   └───────────────┘   └───────┬───────┘
                                                │
                    ┌───────────────────────────┼───────────┐
                    ▼                           ▼           ▼
            ┌───────────────┐           ┌───────────┐  ┌─────────┐
            │  Cassandra    │           │  User     │  │  Push   │
            │  (Messages)   │           │  Service  │  │ Service │
            └───────────────┘           └───────────┘  └─────────┘
                                                            │
                                                    ┌───────┴───────┐
                                                    ▼               ▼
                                              ┌─────────┐     ┌─────────┐
                                              │  APNs   │     │   FCM   │
                                              └─────────┘     └─────────┘
```

---

## Key Design Decisions

| Decision | Options | Choice | Why |
|----------|---------|--------|-----|
| Real-time transport | WebSocket vs Long Polling vs SSE | WebSocket | Bidirectional, lowest latency, mobile-friendly |
| Message storage | PostgreSQL vs Cassandra vs MongoDB | Cassandra | Write-heavy, time-series access pattern, horizontal scale |
| Message ordering | Timestamp vs Snowflake ID | Snowflake ID | Globally unique, sortable, no clock sync needed |
| Presence tracking | Redis vs dedicated service | Redis Pub/Sub | Low latency, ephemeral data, built-in pub/sub |
| Group fan-out | Sync vs async | Async (Kafka) | Decouple sender from recipients, handle backpressure |
| Connection routing | Broadcast vs direct | Direct via Redis | O(1) routing instead of O(servers) |

---

## What Makes This Problem Hard

1. **Persistent Connection Management**: Maintaining millions of WebSocket connections. Server restarts, network blips, mobile backgrounding all break connections. Need graceful reconnection and message replay.

2. **Message Ordering**: Network delays can cause messages to arrive out of order. Clients display based on ID/timestamp, but handling concurrent messages from multiple senders is tricky.

3. **Exactly-Once Delivery**: Network failures cause retries. Without idempotency, users see duplicate messages. Client-generated message IDs enable deduplication.

4. **Group Scalability**: A 100K member group (common in Telegram) means 100K deliveries per message. Can't be synchronous; needs fan-out worker pool.

5. **Offline → Online Transition**: User comes online after 3 days offline. Must sync hundreds of messages across dozens of conversations without overwhelming the device.

6. **Read Receipts at Scale**: In a 500-person group, tracking who read each message creates 500 status records per message. Storage and query efficiency matters.

---

## Related Topics

- [Message Queues](../message-queues/) — Kafka for async fan-out
- [Distributed Caching](../distributed-caching/) — Redis for presence and routing
- [Rate Limiting](../rate-limiting/) — Protecting against spam
- [Notification System](../notification-system/) — Push notification patterns
