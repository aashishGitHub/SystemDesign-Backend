# Pattern: Real-Time Updates

> **Interviewer signal:** "users should see this *immediately*", "live", "without refreshing", "collaborative", "presence", "as the driver moves".

The pattern is about pushing state changes to clients with sub-second-to-few-second latency. The mistake almost everyone makes is treating it as *one* problem — picking WebSockets and moving on. It is **two independent problems**, and the second one is where senior candidates separate themselves.

📖 Source outline: [hellointerview.com — Real-time Updates](https://www.hellointerview.com/learn/system-design/patterns/realtime-updates) (their prose is paywalled; the depth below is this repo's own).

---

## Table of Contents

1. [The Problem: Two Hops, Not One](#1-the-problem-two-hops-not-one)
2. [Hop 1: Client ⇄ Server Transports](#2-hop-1-client--server-transports)
3. [Hop 2: Event Source → The Right Server](#3-hop-2-event-source--the-right-server)
4. [Delivery Guarantees Over a Channel That Drops](#4-delivery-guarantees-over-a-channel-that-drops)
5. [Connection Capacity Math](#5-connection-capacity-math)
6. [The Fan-Out Problem](#6-the-fan-out-problem)
7. [Decision Framework](#7-decision-framework)
8. [Where This Shows Up in This Repo](#8-where-this-shows-up-in-this-repo)
9. [Real-World Cases](#9-real-world-cases)
10. [Interview Questions](#10-interview-questions)
11. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Problem: Two Hops, Not One

HTTP is request/response. The server cannot originate a message to a browser that hasn't asked for one. So "live updates" needs a channel the client opens and holds — that's **hop 1**.

But there's a second, less obvious problem. Once you have 20 servers each holding 50,000 connections, an event produced *anywhere* has to reach *the one specific server* holding *that user's* connection:

```
                          ┌──────────────┐
   Alice's phone ─────────►│  WS Server 3 │  ← Alice's connection lives HERE
                          └──────▲───────┘
                                 │  ??? how does the event get here ???
   Bob posts a comment           │
        │                        │
        ▼                        │
   ┌─────────────┐         ┌─────┴─────────┐
   │ API Server  │────────►│  ???          │
   │  (server 7) │         └───────────────┘
   └─────────────┘
```

Bob's write landed on API server 7. Alice's socket is on WS server 3. Server 7 has no idea server 3 exists, let alone that Alice is on it. **Hop 2 is the routing problem**, and it exists *because* the connection made your servers stateful.

> If you only answer hop 1 in an interview, you've answered the easy half. Interviewers at senior+ level are almost always probing hop 2 — that's where consistent hashing, pub/sub, and service discovery come in.

---

## 2. Hop 1: Client ⇄ Server Transports

### 2.1 Short Polling — the baseline

```javascript
setInterval(() => fetch('/api/updates').then(render), 5000)
```

| | |
|---|---|
| **Latency** | 0 to `interval`; average `interval / 2` |
| **Server load** | `clients / interval` QPS, *constant*, regardless of whether anything changed |
| **Wins because** | Zero new infrastructure. Stateless servers. Works through every proxy, every browser, every corporate firewall. Trivially horizontally scalable. |
| **Loses because** | ~95%+ of requests return "nothing new" at typical change rates. Latency floor = the interval. |

**Do not dismiss this in an interview.** If the requirement is "within 10 seconds" and you have 10k users, polling is 1,000 QPS of trivially-cacheable requests, needs no stateful tier, and no deploy-drain story. Choosing it deliberately and *saying why* is a strong signal. Choosing it by default is not.

### 2.2 Long Polling — real-time on plain HTTP

Client sends a request; the server **holds it open** until either an event arrives or a timeout (~30s) fires; then it responds and the client immediately re-requests.

```
Client                          Server
  │──── GET /poll?cursor=42 ───────►│
  │                                 │ (holds… no data yet)
  │                                 │  ← event arrives
  │◄─── 200 {events, cursor: 45} ───│
  │──── GET /poll?cursor=45 ───────►│   (immediately reconnects)
```

The critical design detail is the **cursor**. Between the response and the next request there is a real gap in which events can be produced. If the client says "give me everything after 45" rather than "give me new stuff", that gap is harmless. Without a cursor, long polling silently loses messages under load — a very common interview miss.

Cost profile depends entirely on the server's concurrency model: a held request is nearly free on Go (goroutine, a few KB) or Node (event loop), and ruinous on thread-per-request (a 1MB stack per idle client).

→ This repo has **two working implementations** to reason from: [`long-polling-nodejs/`](../long-polling-nodejs/) and [`long-polling-golang/`](../long-polling-golang/), plus the comparison writeups [`SHORT_VS_LONG_POLLING.md`](../SHORT_VS_LONG_POLLING.md) and [`REAL_WORLD_LONG_POLLING.md`](../REAL_WORLD_LONG_POLLING.md).

### 2.3 Server-Sent Events — the efficient one-way street

One long-lived HTTP response with `Content-Type: text/event-stream`, streamed forever:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

id: 1043
event: comment
data: {"user":"bob","text":"hi"}

: heartbeat comment to keep intermediaries from timing out

id: 1044
event: comment
data: {"user":"carol","text":"hello"}
```

What you get for free from the browser's native `EventSource`:
- **Automatic reconnection** with backoff.
- **`Last-Event-ID`** — on reconnect the browser resends the last `id:` it saw, so the server can replay the gap. This is the cursor mechanism from long polling, standardized into the protocol.

What bites you:

| Gotcha | Why | Mitigation |
|---|---|---|
| HTTP/1.1 caps ~6 connections per origin | 6 tabs = 7th tab hangs entirely | Serve over **HTTP/2+** (multiplexed, limit effectively gone), or share one connection across tabs via `BroadcastChannel`/`SharedWorker` |
| Proxies/load balancers buffer the response | Events arrive in clumps or never | `X-Accel-Buffering: no`, disable proxy buffering, send periodic `:` heartbeat comments |
| Idle-connection timeouts kill the stream | LB/ALB idle timeout is often 60s | Heartbeat comment every 15–30s |
| Text only (UTF-8) | No binary frames | Base64, or use WebSocket |
| One-way | Client→server needs a separate POST | Usually fine — that's just a normal API call |

SSE is the **default correct answer for notification feeds, dashboards, live comments, progress bars, and job status** — anything where the client mostly listens.

→ This repo has a production-shaped SSE walkthrough: [`interviews/sse/sse-deep-dive-qa.md`](../interviews/sse/sse-deep-dive-qa.md) — goroutine-per-client, the nested-map broker, per-event RBAC, multi-tab behaviour, and Kubernetes graceful shutdown. Plus a runnable demo in [`notification-demo/`](../notification-demo/).

### 2.4 WebSockets — the full-duplex champion

An HTTP request with `Upgrade: websocket` that, after a 101 response, becomes a raw bidirectional frame-based channel on the same TCP connection.

Use it when **the client also sends at high frequency**: chat typing, cursor positions, game input, collaborative edits, a driver app streaming GPS every 4 seconds.

The bill you pay for that:

| Cost | Detail |
|---|---|
| **Stateful servers** | Session state lives in a specific process → hop 2 becomes mandatory, and so does sticky routing |
| **Deploys are hard** | Every deploy severs every connection. You need connection draining + client reconnect with **jittered** backoff, or a rolling restart reconnect-storms your own cluster |
| **No free reconnect** | Unlike `EventSource`, you implement backoff, resubscribe, and gap-fill yourself |
| **Auth is connection-scoped** | A token valid at connect time may be revoked 40 minutes into the connection — *see the per-event authorization discussion in the SSE deep dive; the same argument applies* |
| **Liveness needs ping/pong** | A TCP connection through a NAT that silently died looks perfectly healthy until you write to it. Protocol-level ping/pong at ~30s, close on N misses |
| **Middlebox hostility** | Some corporate proxies block the upgrade → keep a long-polling fallback (this is exactly what Socket.IO's transport fallback is for) |

### 2.5 WebRTC — peer-to-peer

Direct browser↔browser data/media channels, with STUN for NAT discovery and TURN as a relay fallback when NAT traversal fails.

Right answer for: video/voice calls, screen sharing, and genuinely latency-critical peer interactions. Mostly **wrong** for typical CRUD-ish real-time features — you inherit signalling servers, TURN bandwidth costs (a TURN relay is a full media proxy you pay for), and no server-side record of what was exchanged. Note the common half-truth: WebRTC is "peer-to-peer" until NAT forces a relay, and in practice a meaningful fraction of connections need TURN, so budget for it.

### 2.6 The comparison table

| | Short Poll | Long Poll | SSE | WebSocket | WebRTC |
|---|---|---|---|---|---|
| Direction | C→S pull | C→S pull | S→C push | Bidirectional | Peer↔peer |
| Latency | `interval/2` | <1s | <1s | <1s | lowest |
| Server state | None | Minimal | Per-connection | Per-connection | Signalling only |
| Reconnect/replay | N/A | Manual cursor | **Built-in** (`Last-Event-ID`) | Manual | Manual |
| Binary | Yes | Yes | No | Yes | Yes |
| Proxy-friendly | ✅ | ✅ | ✅ (mind buffering) | ⚠️ upgrade may be blocked | ⚠️ needs STUN/TURN |
| Deploy pain | None | Low | Medium | High | High |
| Use when | Updates can lag | Real-time, plain HTTP only | Server→client feed | High-rate two-way | Media / P2P |

---

## 3. Hop 2: Event Source → The Right Server

Three approaches, in increasing order of scale and complexity.

### 3.1 Pull from the database (server-side polling)

Each connection-holding server periodically queries for changes relevant to its connected users, then pushes over the open channel.

```
WS Server 3, every 1s:
  SELECT * FROM events
   WHERE user_id IN (…50,000 connected user ids…)
     AND id > last_seen_id
```

Simple, no new infrastructure, and the DB is already the source of truth. But you've just moved the polling problem from 1M clients to 20 servers with enormous `IN` clauses — the query cost grows with connections *and* you still pay the latency floor of the poll interval. Viable at small scale or when the event set is naturally narrow (one busy table, one tenant).

### 3.2 Pub/Sub — the pragmatic default

Every connection-holding server subscribes to a channel per connected entity; producers publish to that channel.

```
Bob comments on post 99
        │
        ▼
   PUBLISH post:99  {comment}          ← Redis / NATS / Kafka
        │
        ├──► WS Server 1 (subscribed to post:99 — 2 viewers)
        ├──► WS Server 3 (subscribed to post:99 — 1 viewer: Alice)
        └──► WS Server 8 (not subscribed — gets nothing)
```

- The producer needs **zero knowledge** of topology — no registry, no "which server has Alice".
- Membership changes are self-healing: a server that dies just stops being subscribed.
- Scaling the connection tier and scaling the event bus are independent concerns.

The limits worth naming out loud:

| Limit | Detail |
|---|---|
| **Topic cardinality** | A channel per *user* at 50M users is a lot of subscriptions. Channel-per-*room*/*post*/*trip* is usually the right granularity |
| **Redis Pub/Sub is fire-and-forget** | Not durable. A message published while a server is reconnecting is *gone*. Fine for presence and cursors, not for "you have a new payment" — pair with a durable store + catch-up read |
| **Redis Pub/Sub fans out to the whole cluster** | In Redis Cluster, published messages propagate across nodes regardless of where subscribers are, so raw pub/sub doesn't shard cleanly. Redis **Streams** (consumer groups) or NATS/Kafka are the better fit past moderate scale |
| **Ordering** | Only per-partition/per-channel at best. Never assume global order |

→ The [`sse`](../interviews/sse/sse-deep-dive-qa.md#q6-what-is-nats-and-why-is-it-needed) deep dive covers exactly why the in-memory broker needed NATS the moment there was more than one replica — that Q&A *is* hop 2.

### 3.3 Directed routing via consistent hashing

Make the mapping user→server **computable** instead of stored: hash the user/room ID onto a ring of connection servers, and clients connect to (or get routed to) the server that owns their key. Producers hash the same key and send the event directly to that one server.

```
hash("alice") → ring → WS Server 3     (producer computes this, no lookup)
```

- **No broker in the path** — one network hop, lowest latency, no pub/sub fan-out waste.
- Each server only ever holds keys it owns, so per-server state stays bounded and cache-local.

Costs: you need cluster membership + failure detection (gossip/heartbeats), and on any topology change ~1/N of clients must reconnect to a different server. This is real machinery — reach for it when the broker fan-out or latency actually justifies it.

→ Full depth in [`consistent-hashing/deep-dive.md`](../interviews/consistent-hashing/deep-dive.md) and the 32-question [`answers.md`](../interviews/consistent-hashing/answers.md); the membership half is [`fundamentals/gossip-protocol.md`](../fundamentals/gossip-protocol.md) + [`fundamentals/heartbeat.md`](../fundamentals/heartbeat.md).

### 3.4 Choosing between them

| Situation | Hop 2 choice |
|---|---|
| Low scale, one DB already the source of truth | Poll from DB |
| Default — most systems, most interviews | **Pub/Sub** (channel per room/topic) |
| Very high message rate, latency-critical, or per-connection state is expensive | Consistent-hash directed routing |
| Events must survive a subscriber being briefly down | Durable log (Kafka/Redis Streams) + cursor replay, not raw pub/sub |

---

## 4. Delivery Guarantees Over a Channel That Drops

Every persistent connection eventually breaks — deploys, NAT timeouts, a train tunnel, an LB rotation. So the honest design question is not "how do I push?" but **"what does the client do about the events it missed?"**

The universal shape:

1. Every event carries a **monotonic per-stream sequence number** (or a global ordered ID like Snowflake).
2. The client tracks the highest contiguous ID it has processed.
3. On reconnect, the client sends that ID (`Last-Event-ID` for SSE, an app-level `resume` frame for WebSocket).
4. The server replays from a **durable** buffer, or — if the gap exceeds retention — returns a `resync` signal telling the client to re-fetch full state via a normal REST call.
5. The client detects gaps *while connected too* (received 47 after 45 → request 46) because push channels can drop individual messages, not just whole connections.

That last fallback matters: **a push channel is an optimization on top of a pull API, not a replacement for one.** If your design has no way to reconstruct state without the socket, it is broken. Say this out loud in interviews.

Delivery semantics inherit the usual rule: you get **at-least-once**, so events must be idempotent at the client (dedupe by ID). Exactly-once push does not exist.

→ [`communication-protocols/deep-dive.md §10`](../interviews/communication-protocols/deep-dive.md#10-reliability-at-least-once-idempotency-backpressure--contracts) · [`chat-system/deep-dive.md §2`](../interviews/chat-system/deep-dive.md#2-message-delivery--ordering)

---

## 5. Connection Capacity Math

Interviewers love this because it's concrete and most candidates hand-wave it.

```
Target: 1,000,000 concurrent connections

Per-connection cost (rough, tuned Go/Node server):
   socket buffers + app state ≈ 10–50 KB
   → 50,000 conns/server × ~30 KB ≈ 1.5 GB RAM   ✔ fits comfortably

Per-server ceiling is set by whichever binds first:
   • file descriptors      → ulimit -n must be raised (default 1024 is nothing)
   • ephemeral ports       → only a limit on the OUTBOUND side (server-side
                             accepts are keyed by the 4-tuple, so inbound is
                             NOT capped at 65k — a very common misconception)
   • memory per connection
   • GC pressure / event-loop latency

→ 1,000,000 / 50,000 = 20 servers, then add headroom for
  reconnect storms (see below) → ~30
```

**The reconnect storm is the failure mode to name.** If one server holding 50k connections dies, those 50k clients reconnect *at the same instant*. Without jittered exponential backoff, they synchronize into a repeating thundering herd that can walk through your remaining servers one at a time. Also: your auth service and session lookups get 50k simultaneous cold requests — the reconnect path must be cheap, or capacity-planned for the spike, not the steady state.

Real reference points (publicly reported, treat as order-of-magnitude): WhatsApp reported reaching ~2M TCP connections on a single tuned FreeBSD/Erlang box in the early 2010s; typical production JVM/Node/Go services land in the 10k–100k-per-instance range. The gap is language runtime and how much per-connection state you keep — cite the range, not a single number.

→ Kernel-tuning specifics (`sysctl`, `limits.conf`) appear in [`chat-system/deep-dive.md §1`](../interviews/chat-system/deep-dive.md#1-real-time-communication) and [`ride-sharing/deep-dive.md §5`](../interviews/ride-sharing/deep-dive.md#5-real-time-tracking).

---

## 6. The Fan-Out Problem

Real-time and fan-out are the same conversation once one event has many recipients.

```
Ratio decides the architecture:

  1 event → 5 recipients        push to all, trivially
  1 event → 5,000 recipients    push via pub/sub, fine
  1 event → 50,000,000 recipients   ← DO NOT push
```

For celebrity-scale fan-out you invert it: **push a tiny invalidation/notification, let clients pull the payload**, or pre-compute for active users only and let inactive users pull on next open. The hybrid model (push for normal users, pull for celebrity-followed content) is the standard answer.

→ This is covered in full in [`social-feed/deep-dive.md §1 Fan-Out Models`](../interviews/social-feed/deep-dive.md#1-fan-out-models) and [`§2 The Celebrity Problem`](../interviews/social-feed/deep-dive.md#2-the-celebrity-problem); the bulk-targeting variant is [`notification-system/deep-dive.md §4`](../interviews/notification-system/deep-dive.md#4-fan-out-and-bulk-targeting).

---

## 7. Decision Framework

```
How stale can the data be?
│
├─ > 10 seconds is fine ─────────────────────► SHORT POLLING. Stop here.
│                                              (stateless, no deploy pain)
│
└─ needs to feel instant
   │
   ├─ Does the client send at high frequency too?
   │  │
   │  ├─ No (client mostly listens: feeds, notifications,
   │  │      dashboards, job progress) ───────► SSE
   │  │                                         (free reconnect + replay)
   │  │
   │  └─ Yes (chat, cursors, game input,
   │          GPS streaming) ─────────────────► WEBSOCKET
   │
   ├─ Is it media, or genuinely peer-to-peer? ► WEBRTC (+ TURN budget)
   │
   └─ Blocked by proxies / must work everywhere
      with zero new infra ────────────────────► LONG POLLING + cursor

Then — always — answer hop 2:
   small scale ──────────► poll the DB
   default ──────────────► pub/sub, channel per room/topic
   extreme rate/latency ─► consistent-hash directed routing
   must not lose events ─► durable log + cursor replay
```

---

## 8. Where This Shows Up in This Repo

| System | How the pattern appears | Go read |
|---|---|---|
| **SSE reference implementation** | Goroutine-per-client, in-memory broker → NATS for hop 2, per-event RBAC, multi-tab, K8s graceful shutdown | [`sse/sse-deep-dive-qa.md`](../interviews/sse/sse-deep-dive-qa.md) |
| **Chat (WhatsApp/Slack)** | WebSocket tier, ordering, presence — the canonical bidirectional case | [`chat-system §1`](../interviews/chat-system/deep-dive.md#1-real-time-communication) · [`§2`](../interviews/chat-system/deep-dive.md#2-message-delivery--ordering) · [`§3 Presence`](../interviews/chat-system/deep-dive.md#3-presence-system) |
| **Social feed (Twitter/X)** | Real-time timeline injection + the celebrity fan-out limit | [`social-feed §5`](../interviews/social-feed/deep-dive.md#5-real-time-updates) · [`§1`](../interviews/social-feed/deep-dive.md#1-fan-out-models) |
| **Ride sharing (Uber)** | Driver GPS every few seconds (write-heavy push *up*) + rider tracking (push *down*) | [`ride-sharing §2`](../interviews/ride-sharing/deep-dive.md#2-location-updates-at-scale) · [`§5`](../interviews/ride-sharing/deep-dive.md#5-real-time-tracking) |
| **Collaborative editing (Docs/Sheets)** | Transport + presence layered under OT/CRDT convergence | [`collaborative-editing §7`](../interviews/collaborative-editing/deep-dive.md#7-real-time-transport--presence) · [`§3 OT vs CRDT`](../interviews/collaborative-editing/deep-dive.md#3-convergence-ot-vs-crdt) |
| **Notification system** | Push/email/SMS as the *offline* counterpart when no channel is open | [`notification-system §2`](../interviews/notification-system/deep-dive.md#2-channel-architecture-push-email-sms) · [`§5`](../interviews/notification-system/deep-dive.md#5-delivery-guarantees-and-idempotency) |
| **Protocol survey** | WebSocket vs SSE vs long poll side by side, and the WebSocket-vs-Kafka category error | [`communication-protocols §9`](../interviews/communication-protocols/deep-dive.md#9-websockets--real-time) · [`§1`](../interviews/communication-protocols/deep-dive.md#1-synchronous-vs-asynchronous) |
| **Food delivery** | Live order tracking + composite ETA on the same transport | [`food-delivery §7`](../interviews/food-delivery/deep-dive.md#7-real-time-tracking--composite-eta) |
| **File sync (Dropbox)** | Change notification so clients know *when* to sync | [`file-storage §6`](../interviews/file-storage/deep-dive.md#6-real-time-notifications) |
| **Runnable code** | Long polling in Node and Go; SSE in Go | [`long-polling-nodejs/`](../long-polling-nodejs/) · [`long-polling-golang/`](../long-polling-golang/) · [`notification-demo/`](../notification-demo/) |
| **Comparison writeups** | Polling tradeoffs with timelines and efficiency math | [`POLLING_COMPARISON.md`](../POLLING_COMPARISON.md) · [`SHORT_VS_LONG_POLLING.md`](../SHORT_VS_LONG_POLLING.md) · [`REAL_WORLD_LONG_POLLING.md`](../REAL_WORLD_LONG_POLLING.md) |

---

## 9. Real-World Cases

| System | What they actually do | The transferable lesson |
|---|---|---|
| **WhatsApp** | Erlang/BEAM connection tier; famously extreme connections-per-box | Per-connection cost is a *runtime* choice as much as an architecture one |
| **Slack** | Persistent WebSocket per client for events; clients still fetch history over HTTP | Push tells you *what changed*; REST tells you *what is true*. Both always exist |
| **Uber** | Long-lived connections from driver and rider apps, with membership/routing machinery in front of a stateful tier | Hop 2 at scale converges on directed routing, not broadcast |
| **Google Docs** | Historically long polling before WebSockets were ubiquitous; OT for convergence | Transport and convergence are orthogonal — don't let a WebSocket answer substitute for a conflict-resolution answer |
| **Facebook Live comments** | Pub/sub fan-out to viewer connections, with aggressive sampling/aggregation on very large streams | At extreme fan-out you stop delivering *every* event and start delivering a *representative* stream |
| **Ticketmaster-style drops** | Waiting-room + queue position pushed to clients | The real-time channel is sometimes used to make *waiting* tolerable rather than to deliver data — see [`seat-reservation §7`](../interviews/seat-reservation/deep-dive.md#7-thundering-herd-and-the-virtual-waiting-room) |
| **Stock tickers / trading UIs** | Conflated/throttled updates — send latest price per symbol per tick, drop intermediate values | When updates outpace human perception *and* the client's ability to render, **coalescing is a feature**, not data loss |

---

## 10. Interview Questions

**Q1. Walk me through why HTTP can't just push, and name your options.**
HTTP is strictly request/response — the server has no addressable channel to an arbitrary browser, and NAT/firewalls mean the client generally isn't reachable inbound anyway. So the client must open and hold the channel. The options are: poll repeatedly (short polling), hold a request open until data exists (long polling), hold a *response* open and stream many events down it (SSE), or upgrade the connection to a bidirectional frame protocol (WebSocket). WebRTC sidesteps the server entirely for peer traffic but needs signalling plus STUN/TURN.

**Q2. Requirement is "notifications appear within 30 seconds" for 100k users. What do you build?**
Short polling, deliberately. At a 20-second interval that's ~5,000 QPS of cacheable requests against a stateless tier — no connection state, no sticky routing, no drain-on-deploy problem, no reconnect-storm risk. The engineering budget saved goes to things that matter more. I'd only escalate to SSE if the latency requirement tightened, the payload got expensive to compute per poll, or per-user poll cost started dominating.

**Q3. SSE or WebSocket for a live notification feed?**
SSE. The traffic is server→client only, so full duplex buys nothing, and `EventSource` gives me automatic reconnection plus `Last-Event-ID` replay — which is exactly the gap-recovery machinery I'd otherwise hand-roll on WebSocket. Client→server actions stay ordinary POSTs. I'd switch to WebSocket only if the client started sending at high frequency (typing indicators, cursors) or I needed binary frames.

**Q4 (depth). Your WebSocket tier has 20 servers. A user's event is produced on an API server. How does it reach the right socket?**
That's the routing hop, and it needs an explicit answer. Three options: (a) each connection server polls the DB for its connected users' changes — simple, doesn't scale past modest connection counts; (b) pub/sub — each connection server subscribes to a channel per room/topic it has viewers for, producers publish blind to topology, which is the pragmatic default and self-heals on server death; (c) consistent-hash directed routing — hash the user ID to a ring of connection servers so the producer *computes* the destination and sends one direct message, which is lowest-latency but requires membership management and forces ~1/N reconnects on topology change. I'd start with pub/sub and name the migration trigger.

**Q5 (depth). A client's connection drops for 90 seconds during a deploy. What did they miss, and how do you fix it?**
Whatever was published in that window, if the transport was fire-and-forget. The fix is a cursor protocol: every event carries a monotonic per-stream ID, the client remembers the highest contiguous ID it processed, and on reconnect it sends that ID so the server replays from a durable buffer. If the gap exceeds the buffer's retention, the server returns a `resync` instruction and the client re-fetches full state over the normal REST API. Crucially, the client must also detect gaps *while connected* — if it sees 47 after 45, it asks for 46 — because individual messages can drop without the connection dying.

**Q6 (depth). Why is Redis Pub/Sub a risky choice for "you have a new payment" notifications?**
Because it's fire-and-forget with no persistence and no acknowledgement: a message published while a subscriber is momentarily disconnected is simply gone, with nothing to replay from. That's acceptable for ephemeral signals like presence or cursor position, where the next update supersedes the lost one. For anything a user must eventually see, the durable record has to live in a database or a log with retention (Redis Streams, Kafka), with pub/sub serving only as the low-latency nudge and the store as the source of truth for catch-up.

**Q7 (senior). You need 1M concurrent connections. Size the tier and tell me what breaks first.**
At roughly 10–50KB of socket buffers plus app state per connection, 50k connections per instance is ~1.5GB — comfortable — so ~20 instances, provisioned to ~30 for headroom. First things to break: file descriptor limits, since the default `ulimit -n` of 1024 is meaningless here; then memory or GC/event-loop latency depending on runtime. I'd explicitly *reject* the common claim that a server is capped at ~65k connections by ephemeral ports — that limit applies to outbound connections per destination tuple, not inbound accepts. The real operational hazard is the reconnect storm: losing one instance means 50k clients reconnecting simultaneously, so I need jittered exponential backoff on the client and a cheap reconnect path, and I capacity-plan auth/session lookups for that spike rather than the steady state.

**Q8 (senior). Deploys sever every connection. How do you ship code without a self-inflicted outage?**
Rolling restarts with connection draining: on `SIGTERM` the instance stops accepting new connections, sends a "please reconnect" frame so clients migrate proactively rather than discovering the break via timeout, then closes gracefully after a grace period while the load balancer removes it from rotation. Clients reconnect with jittered exponential backoff so the herd spreads rather than synchronizing. Batch size matters: draining 1/20th of connections at a time is a 5% blip; restarting everything at once is an outage. The [SSE deep dive's graceful-shutdown Q&A](../interviews/sse/sse-deep-dive-qa.md#q9-how-does-graceful-shutdown-work-during-a-kubernetes-deployment) works through the Kubernetes specifics.

**Q9 (senior). A user was authorized when they connected. Forty minutes later their access is revoked, and the connection is still open. What happens?**
With connection-time-only authorization, they keep receiving events they're no longer entitled to for as long as the socket lives — a real security bug, not a theoretical one, because long-lived connections outlive permission changes by design. The fix is to authorize **per event** at push time rather than once at handshake, accepting the per-event check cost (usually a cached permission lookup), and to additionally revalidate the session periodically so a revoked token forces a disconnect. This repo works the tradeoff through in [SSE Q5](../interviews/sse/sse-deep-dive-qa.md#q5-how-does-the-per-event-rbac-check-work-and-why-not-check-once-at-connection-time).

**Q10 (staff). A celebrity with 50M followers posts. Your real-time pipeline needs to not fall over.**
I don't push 50M messages. Fan-out ratio determines architecture: below a few thousand recipients, push per-recipient is fine; at 50M it's a self-inflicted DDoS. The hybrid model is the answer — pre-compute and push for normal-fanout authors, and for celebrity content push nothing (or a tiny invalidation hint) while clients merge that author's timeline in at read time from a cached, shared copy. Only currently-connected/active users need the live path at all; everyone else discovers the post on next open. At extreme viewer counts on a single stream (live comments), the further step is to stop delivering every event and deliver a sampled or aggregated stream instead, since no human can read 100k comments/second anyway. [`social-feed §1–2`](../interviews/social-feed/deep-dive.md#1-fan-out-models) has the full treatment.

**Q11 (staff). Interviewer says "just use Kafka to push updates to the browser." Respond.**
That's a category error worth correcting politely. Kafka is a durable, partitioned log for **server-to-server** transport — it's not a client-facing protocol, browsers can't hold Kafka consumer group membership, and exposing it publicly would mean per-browser consumer groups and offsets, which the broker isn't designed to carry at web-client cardinality. The correct composition uses **both**: Kafka carries the event server-side (durable, replayable, the hop-2 backbone), and a connection tier translates it to per-client SSE/WebSocket frames. Naming which hop each technology serves is the actual answer here — [`communication-protocols §9`](../interviews/communication-protocols/deep-dive.md#9-websockets--real-time) covers this explicitly.

**Q12 (staff). Updates arrive faster than the client can render — 500 price ticks/second on a symbol. Design for it.**
Coalesce server-side and treat that as correct behaviour, not data loss. For state-replacing updates like a price, only the latest value per key matters, so the connection tier keeps a per-client dirty-set and flushes at a fixed cadence (say 10Hz), collapsing 50 intermediate ticks into one frame. That bounds both bandwidth and client CPU regardless of market volatility. The distinction to state explicitly: this works for **state-conveying** streams where later values supersede earlier ones, and is *invalid* for **event-conveying** streams like chat messages or ledger entries, where every item is independently meaningful — there, backpressure means slowing the producer, buffering with a bounded queue, or disconnecting a client that can't keep up, never silently dropping. Getting this distinction right is the whole answer.

---

## Quick Recall Cheat Sheet

| Term | One-line answer |
|---|---|
| **The two hops** | Client⇄server transport, *and* event-source→correct-server routing. Both need answers |
| **Short polling** | Fixed-interval requests; latency `interval/2`; stateless; correct more often than people admit |
| **Long polling** | Server holds the request until data or timeout; needs a **cursor** or you lose the inter-request gap |
| **SSE** | One streamed `text/event-stream` response; free auto-reconnect + `Last-Event-ID` replay; server→client only |
| **`Last-Event-ID`** | Browser resends last seen event ID on reconnect → server replays the gap. SSE's killer feature |
| **WebSocket** | `Upgrade:` → bidirectional frames. Use when the *client* also sends fast. You own reconnect, auth refresh, ping/pong |
| **WebRTC** | Peer-to-peer media/data; needs signalling + STUN, and TURN relay when NAT traversal fails |
| **Hop-2: DB poll** | Servers query for their users' changes. Simplest, doesn't scale |
| **Hop-2: pub/sub** | Channel per room/topic; producer needs no topology knowledge. **The default** |
| **Hop-2: consistent hash** | Hash user→server so producers compute the destination. Fastest, needs membership management |
| **Redis Pub/Sub caveat** | Fire-and-forget, no persistence. Never the source of truth for must-see events |
| **Cursor / sequence number** | Monotonic per-stream ID + client's high-water mark = gap detection and replay |
| **`resync` fallback** | Gap bigger than retention → tell client to re-fetch full state via REST |
| **Push is an optimization** | If state can't be rebuilt without the socket, the design is broken |
| **Delivery semantics** | At-least-once; dedupe by event ID at the client. Exactly-once push doesn't exist |
| **Per-connection cost** | ~10–50KB → ~50k connections/instance; 1M conns ≈ 20–30 instances |
| **Not a real limit** | The 65k ephemeral-port ceiling applies to *outbound*, not inbound accepts |
| **Real first limit** | `ulimit -n` file descriptors, then memory/GC |
| **Reconnect storm** | Instance death → all its clients reconnect at once. Jittered exponential backoff, cheap reconnect path |
| **Deploy draining** | SIGTERM → stop accepting → tell clients to migrate → close after grace. Roll in small batches |
| **Connection-time auth bug** | Long connections outlive permission changes → authorize **per event**, revalidate periodically |
| **HTTP/1.1 6-connection cap** | Breaks SSE in the 7th tab; fix with HTTP/2 or share one stream via `SharedWorker`/`BroadcastChannel` |
| **Heartbeats** | SSE `:` comments / WS ping-pong — beat the LB idle timeout and detect silently-dead TCP |
| **Proxy buffering** | Kills SSE streaming; disable buffering (`X-Accel-Buffering: no`) |
| **Fan-out threshold** | ~5 recipients: push. ~5k: pub/sub. 50M: don't push — invalidate and let clients pull |
| **Coalescing** | Legitimate for state-conveying streams (latest price wins); invalid for event-conveying streams (every message matters) |
| **WebSocket vs Kafka** | Different hops, not alternatives. Kafka server↔server; WebSocket server↔browser |

---

## Related

- **Patterns:** [Scaling Writes](./scaling-writes.md) (high-rate ingest like driver GPS) · [Long-Running Tasks](./long-running-tasks.md) (pushing job progress) · [Scaling Reads](./scaling-reads.md) (the pull API the push channel sits on top of)
- **Fundamentals:** [heartbeat](../fundamentals/heartbeat.md) · [gossip-protocol](../fundamentals/gossip-protocol.md) · [consistent-hashing](../fundamentals/consistent-hashing.md)
- **Topics:** [`sse`](../interviews/sse/sse-deep-dive-qa.md) · [`chat-system`](../interviews/chat-system/README.md) · [`communication-protocols`](../interviews/communication-protocols/README.md) · [`social-feed`](../interviews/social-feed/README.md) · [`collaborative-editing`](../interviews/collaborative-editing/README.md) · [`ride-sharing`](../interviews/ride-sharing/README.md)
