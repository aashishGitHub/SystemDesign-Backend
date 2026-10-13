# Teach Script: Chat System (WhatsApp / Slack)

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the system; don't just recognize the vocabulary.
> **Not a replacement for:** [`answers.md`](./answers.md) (the full Q&A grill) or [`deep-dive.md`](./deep-dive.md) (production depth). This is the narrated version.
> **Every number and fact below is pulled from this repo's own [`answers.md`](./answers.md)** — nothing here is a new claim.

---

## 1. The symptom

You run two chat servers behind a load balancer, purely for redundancy. Alice connects and happens to land on Server A. Bob connects and happens to land on Server B — nothing unusual, that's just which one the load balancer picked for each of them. Alice sends Bob "are you free tonight?" Her app shows a single gray checkmark instantly — sent, no problem.

**Bob's phone never buzzes. The message never appears.** Not now, not five minutes from now, not until he manually reopens the app and happens to pull to refresh. There's no error on either side, because Server A did everything it was asked to do correctly: it received the message, stored it durably, and acknowledged Alice. It simply had no way of knowing that an actual human named Bob was sitting on the other side of a *different* machine.

## 2. Why you should care

This is the single most-asked mechanics question in this topic, and it's not a corner case — it's the default outcome of running more than one chat server, which every real deployment does for redundancy alone. Whoever designs the connection-routing layer of a chat system owns this exact failure, and getting it wrong doesn't crash anything — it just quietly, invisibly loses messages between specific pairs of users depending on which servers they happen to be connected to.

## 3. What / Why / How

1. **What actually has to happen** for a message to travel from Alice's phone to Bob's phone in real time?
2. **Why isn't "the server that received it just forwards it" enough** the moment there's more than one server?
3. **How do you route a message to the right person regardless of which of N servers they're connected to** — and keep it working as people go offline, reconnect, and use multiple devices at once?

## 4. Umbrella words — kill them before using them

**"Real-time."** Decompose it into the actual requirement and the actual number: message delivery latency under **500ms** for online users, and — the detail that decides the transport choice — chat needs traffic flowing in **both directions at once** (Alice sends, Bob receives, and the reverse is just as true a second later). That single fact rules out SSE (server-to-client only) and makes **WebSocket**, a genuinely bidirectional, full-duplex connection over one TCP socket, the right choice — not a default, a consequence of the direction requirement.

**"Reliable delivery" / "never lost."** This decomposes the same way it does for any queue-backed system: true exactly-once delivery isn't achievable, so the real target is **at-least-once plus deduplication**. The variation worth naming here: the deduplication identity is **client-owned**, not server-assigned. The client generates a `client_message_id` once, *before* it ever sends, and reuses the identical id on every retry — because only the client can know for certain whether its own earlier attempt actually landed; the server can only ever guess.

**"Ordering."** Decompose it into why the obvious answer — sort by timestamp — fails: wall-clock time drifts between machines, and two messages generated on different servers can land in the exact same millisecond. The fix is a **Snowflake ID**: one 64-bit number baking in a timestamp, a machine ID, and a per-millisecond sequence counter, so messages generated on different machines at the literal same instant still sort consistently for every client, with zero coordination between those machines required.

## 5. The boxes — built one need at a time

**A client needs the server to be able to push to it at any moment, not just respond to something it asked for.** Plain request-response can't do this — the server has no way to spontaneously reach a client that isn't mid-request. You need a connection that stays open and lets *either* side send *any time*. That's a **WebSocket**.

```
HTTP: Client asks → Server answers → connection closes → repeat
WebSocket: one handshake → connection stays open → either side sends whenever it wants
```

**Now — the gap that produces the symptom from section 1.** Each chat server holds up to some tens of thousands of live WebSocket connections in its own memory (this repo's own architecture sizes it at ~50K connections per server). Alice's message arrives at Server A. Bob is connected to Server B. **Server A has zero in-memory knowledge that Bob's socket exists anywhere at all**, because Bob never connected to A — there's nothing wrong with Server A's code, it simply was never told.

**Fix: a shared connection registry, living outside any single server.** For every user, record *which server(s)* they're currently connected to — Redis is the natural fit here (fast, and this data is inherently ephemeral). When Server A receives Alice's message for Bob, it looks Bob up in the registry, learns "Bob is on Server B, connection `conn_123`," and **publishes** the message specifically to a channel Server B is subscribed to. Server B receives it and forwards it to Bob's actual live socket.

```
Alice → Server A: receives message
Server A: look up Bob in the shared registry → "Server B, conn_123"
Server A: publish to channel "server:B:messages"
Server B: subscribed to that channel → receives it → forwards to Bob's live socket
```

This is a **targeted, two-hop route** — look up exactly where to go, then go there — never a broadcast to every server hoping one of them has Bob.

**Gap: what if Bob has three devices open at once** — phone, laptop, tablet, plausibly connected to three *different* servers? The registry can't be "one server per user" — it has to be a **set** of (server, connection, device) entries per user. Delivering a message to Bob now means: for each entry in that set, if it's local to the server handling the send, forward directly; if it's remote, publish once to that specific remote server's channel. Every one of Bob's devices gets the message, and the sender never needs to know how many devices Bob has or where they're connected.

**Gap: Alice sends to a 200-person group.** Looping through all 200 recipients synchronously means Alice's own "sent" indicator waits for the *slowest* of 200 individual deliveries — this repo's own math: 200 iterations at 10ms each is 2 full seconds of visible lag for something that's supposed to feel instant. Fix: **store the message and acknowledge Alice immediately**, then hand the actual fan-out to an async worker pool (via Kafka) that delivers to all 200 recipients in parallel, completely off the critical path of "did my message get sent."

**Gap: Bob's phone is off, or the app is closed** — he's not connected to *any* server right now, and the registry lookup for him comes back empty. This is not a failure case to patch in later — it's an expected, first-class branch of delivery: queue the message (it's already durably stored) and fire a **push notification** through APNs/FCM as the wake-up signal, carrying a *summary* only — never the full message body, both because push payloads are capped around 4KB and because, in an end-to-end-encrypted deployment, the server may not even be able to read the content to summarize beyond the sender's name. When Bob's app reconnects, it sends its last known message ID and the server streams back everything since.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **a message is received by whichever server the sender happens to be connected to, which looks the recipient up in a shared registry rather than assuming they're local, and routes it — directly if they're on the same server, through a publish to their specific server's channel if they're not, to every device they currently have open, or into an offline queue plus a push notification if they have none.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the exact WebSocket handshake headers (`Upgrade: websocket`, the `101 Switching Protocols` response), the specific Redis `SADD`/`SMEMBERS` command syntax for the connection registry, and the exact push payload size limits (4KB for both APNs and FCM) — useful facts to cite, not things to derive.

**Understand once, then trust it:** the Snowflake ID's exact bit layout (1 unused bit, 41 for timestamp, 10 for machine ID, 12 for a per-millisecond sequence) — know *that* it guarantees global, coordination-free ordering, you don't need to recompute the bit shifts from memory; the specific 10-second grace period before marking a user "offline" after a disconnect (so a 2-second network blip doesn't flash "online"/"offline" twice) — a tuned number, not a law.

**This is the actual idea — think hard here:** (1) a shared connection registry is what makes "which server is this person on" an answerable question at all — without it, cross-server delivery isn't just unreliable, it's *structurally impossible*, which is exactly the symptom; (2) the retry-deduplication identity is owned by the **client**, not the server, because only the sender can know for certain whether its own prior attempt actually succeeded; (3) synchronous fan-out couples the sender's perceived latency to the *slowest* recipient's delivery — the fix is always "acknowledge first, fan out async, in parallel," the same shape as any fan-out problem; (4) "this user is currently offline" is a normal, expected branch of the delivery logic that every design needs from day one, not a fallback you retrofit after the fact.

## 7. The build — the smallest thing that actually shows the mechanism

No real WebSocket servers or Redis cluster here — the one mechanism that actually matters, "a shared registry is what makes cross-server routing *possible* at all," is visible with two small Python classes:

```python
# save as chat_routing_demo.py, run with: python3 chat_routing_demo.py

class ChatServer:
    """Each server only knows about connections made directly to IT."""
    def __init__(self, name):
        self.name = name
        self.local_connections = {}   # user_id -> list of "delivered" messages

    def connect(self, user_id):
        self.local_connections[user_id] = []

    def receive_locally(self, user_id, message):
        self.local_connections[user_id].append(message)

class NaiveRouting:
    """The sending server only checks ITS OWN local connections."""
    def send(self, from_server, to_user, message):
        if to_user in from_server.local_connections:
            from_server.receive_locally(to_user, message)
            return True
        return False   # silently drops it — the server has no idea where the recipient is

class RegistryRouting:
    """A shared registry says exactly which server(s) each user is connected to."""
    def __init__(self):
        self.registry = {}   # user_id -> [servers they're connected to]

    def register(self, user_id, server):
        server.connect(user_id)
        self.registry.setdefault(user_id, []).append(server)

    def send(self, from_server, to_user, message):
        servers = self.registry.get(to_user)
        if not servers:
            return False   # genuinely offline — a different, expected branch
        for s in servers:
            s.receive_locally(to_user, message)
        return True

server_a, server_b = ChatServer("A"), ChatServer("B")
server_a.connect("alice")
server_b.connect("bob")

# Naive: Server A only knows its own connections.
naive = NaiveRouting()
delivered = naive.send(server_a, "bob", "are you free tonight?")
print(f"Naive routing:    delivered to Bob? {delivered}  | Bob's inbox on Server B: {server_b.local_connections['bob']}")

# Registry-based: Server A looks Bob up before deciding where to send.
registry = RegistryRouting()
registry.register("alice", server_a)
registry.register("bob", server_b)
delivered = registry.send(server_a, "bob", "are you free tonight?")
print(f"Registry routing: delivered to Bob? {delivered}  | Bob's inbox on Server B: {server_b.local_connections['bob']}")
```

Run it. Naive routing reports `delivered? False` and Bob's inbox on Server B stays empty — the exact symptom from section 1, reproduced with two classes. Registry-based routing reports `delivered? True`, and the message actually lands in Bob's inbox, because Server A asked the registry *where Bob actually is* instead of assuming.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** Add a third server and register Bob on it too — simulating Bob's laptop being open alongside his phone: `server_c = ChatServer("C"); registry.register("bob", server_c)` — then send another message and print both `server_b.local_connections["bob"]` and `server_c.local_connections["bob"]`. Watch the message land in **both** inboxes, because the registry now holds two entries for Bob and the send loop delivers to every one of them. This is the multi-device gap from section 5 made concrete: the registry isn't "one server per user," it's a set, and nothing about the sending logic needs to change to support it — it already loops.

**Sabotage 2 (walk it in your head, no code needed).** Now imagine Alice's app sends "Hello," the network stalls, and no acknowledgment arrives within the timeout. The client retries. Walk both versions: if the retry generates a **fresh** `client_message_id` each time (the bug), the server has no way to know this is the *same* logical message as before — it creates a second row, and Bob sees "Hello" twice, exactly the double-message bug this design exists to prevent. If the retry reuses the **exact same** `client_message_id` from the first attempt (the fix), the server's dedup check finds that id already recorded, returns the *original* result, and creates nothing new — Bob sees "Hello" exactly once, regardless of how many times the network forced Alice's client to retry. The difference between those two outcomes is entirely in *whose job* it was to remember the identity of the attempt — and it has to be the client's, because only the client experienced the timeout.

## 9. One-sentence recap

Same words as before, on purpose: **a message is received by whichever server the sender happens to be connected to, which looks the recipient up in a shared registry rather than assuming they're local, and routes it — directly if they're on the same server, through a publish to their specific server's channel if they're not, to every device they currently have open, or into an offline queue plus a push notification if they have none.**

## 10. What transfers

Swap Redis Pub/Sub for Kafka, or WebSocket for a different bidirectional transport, and this lesson is unchanged — those are the incidental, swappable pieces. What transfers to **every** system where clients hold persistent connections to one of many interchangeable servers: a shared registry is mandatory the moment there's more than one server, because "local knowledge only" is structurally blind to anyone connected elsewhere (the identical lesson as [sse](../sse/teach.md)'s multi-pod problem, in a different shape); client-owned idempotency keys for anything the client might retry; decoupling "acknowledge the sender" from "fan out to every recipient," so one slow delivery never becomes everyone's delay; and treating "the recipient isn't reachable right now" as a normal, designed-for branch rather than an edge case.

---

## Recall check — answer these without scrolling up

1. **Describe the data flow in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5.)*
2. **What is each box's job, and what breaks if you delete it?**
   - *Model answers:* delete the shared connection registry → the section 1 symptom returns exactly: any message between two users on different servers silently vanishes, with no error on either side. Delete client-owned deduplication → every network retry becomes a visible duplicate message to the recipient. Delete async fan-out for groups and go back to a synchronous loop → the sender's own "sent" confirmation is held hostage by the slowest of every recipient's delivery, turning an instant action into multi-second lag as group size grows.
3. **What would you look at first if this got slow, or wrong, in production?** *(Model answer, from this repo's own monitoring table: message send latency p99 first — is it past the 500ms feel-real-time threshold; then Kafka consumer lag on the fan-out topic — is delivery falling behind arrival; then Redis latency specifically — since presence and connection routing both run through it, and a slow Redis degrades "real-time" everywhere at once, not just in one place.)*

If you answered all three cold, go read `answers.md` anyway — this script deliberately skipped end-to-end encryption (Signal Protocol, sender keys for groups), read-receipt scaling for large groups, and the crash-recovery/reconnection sync protocol in detail (A22–A41) because piling every idea into one narrative would bury the four that actually matter. Those are the natural next read.
