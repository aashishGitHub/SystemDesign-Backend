# Polling Techniques Comparison

A comprehensive guide to **Short Polling** vs **Long Polling** and how they compare to other real-time communication methods.

## Table of Contents
- [What is Polling?](#what-is-polling)
- [Short Polling](#short-polling)
- [Long Polling](#long-polling)
- [Visual Comparison](#visual-comparison)
- [Code Examples](#code-examples)
- [Performance Comparison](#performance-comparison)
- [When to Use What](#when-to-use-what)
- [Protocols & Wire Formats](#protocols--wire-formats)
- [Complete Comparison Table](#complete-comparison-table)

---

## What is Polling?

**Polling** is a technique where the client **repeatedly requests data** from the server to check for updates. It's the simplest way to achieve "real-time" communication without special protocols.

---

## Short Polling

### How It Works

```
Client                          Server
  |                               |
  |-------- Request ----------->  |
  |<------- Response (empty) ---  | ⚡ Responds immediately
  |                               |
  | ⏰ Wait 5 seconds              |
  |                               |
  |-------- Request ----------->  |
  |<------- Response (empty) ---  | ⚡ Responds immediately
  |                               |
  | ⏰ Wait 5 seconds              |
  |                               |
  |-------- Request ----------->  |
  |<------- Response (data!) ---  | ⚡ Responds immediately
  |                               |
```

### Characteristics

- ✅ **Very simple** to implement
- ✅ Works with **any HTTP server**
- ❌ **Wasteful** - many unnecessary requests
- ❌ **High latency** - updates delayed by polling interval
- ❌ **High bandwidth** usage
- ❌ **Bad for mobile** - drains battery

### Short Polling Example (JavaScript)

```javascript
// Client-side short polling
function shortPolling() {
  setInterval(async () => {
    const response = await fetch('http://api.example.com/updates');
    const data = await response.json();
    
    if (data.hasUpdate) {
      console.log('New data:', data);
    }
  }, 5000); // Poll every 5 seconds
}
```

### Short Polling Example (Server - Node.js)

```javascript
app.get('/updates', (req, res) => {
  // Check for updates
  const updates = checkForUpdates();
  
  // Respond immediately regardless
  res.json({
    hasUpdate: updates.length > 0,
    data: updates
  });
});
```

### Metrics
- **Request frequency**: Every 5-30 seconds (configurable)
- **Latency**: 2.5-15 seconds (average of interval)
- **Efficiency**: Very low (< 10%)
- **Bandwidth**: High
- **Battery impact**: High

---

## Long Polling

### How It Works

```
Client                          Server
  |                               |
  |-------- Request ----------->  |
  |                               | 🕐 Holds connection...
  |                               | 🕑 Still waiting...
  |                               | 🕒 Still waiting...
  |                               | 🕓 Data available!
  |<------- Response (data!) ---  | ⚡ Sends immediately
  |                               |
  |-------- Request ----------->  | 🔄 Reconnect immediately
  |                               | 🕐 Holds connection...
```

### Characteristics

- ✅ **More efficient** than short polling
- ✅ **Lower latency** - near real-time
- ✅ **Universal support** - works everywhere
- ✅ **Firewall friendly**
- ❌ Still more overhead than SSE/WebSocket
- ❌ Server holds connections (resource intensive)
- ❌ Complex timeout/reconnect logic

### Long Polling Example (JavaScript)

```javascript
// Client-side long polling
async function longPolling() {
  while (true) {
    try {
      // Server holds this request until data is available
      const response = await fetch('http://api.example.com/poll');
      const data = await response.json();
      
      if (data.notifications.length > 0) {
        console.log('New data:', data.notifications);
      }
      
      // Immediately reconnect
    } catch (error) {
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}
```

### Long Polling Example (Server - Node.js)

```javascript
const pendingRequests = [];

app.get('/poll', (req, res) => {
  // Check if data is available
  if (hasData()) {
    return res.json({ notifications: getData() });
  }
  
  // No data, hold the request
  const timeoutId = setTimeout(() => {
    res.json({ notifications: [] });
    removePending(res);
  }, 30000); // 30 second timeout
  
  pendingRequests.push({ res, timeoutId });
  
  // Clean up on disconnect
  req.on('close', () => {
    clearTimeout(timeoutId);
    removePending(res);
  });
});

// When new data arrives
function broadcast(data) {
  pendingRequests.forEach(({ res, timeoutId }) => {
    clearTimeout(timeoutId);
    res.json({ notifications: [data] });
  });
  pendingRequests.length = 0;
}
```

### Metrics
- **Request frequency**: Only when needed
- **Latency**: < 1 second
- **Efficiency**: Medium (~50-70%)
- **Bandwidth**: Medium
- **Battery impact**: Medium

---

## Visual Comparison

### Timeline Comparison

```
TIME ────────────────────────────────────────────────────────>

SHORT POLLING (5s interval):
│     │     │     │     │     │     │     │     │     │     │
req   req   req   req   req   req   req   req   req   req   req
 ↓     ↓     ↓     ↓     ↓     ↓     ↓     ↓     ↓     ↓     ↓
empty empty empty DATA! empty empty empty DATA! empty empty empty

Requests: 11 in 50 seconds
Data received: 2 messages
Latency: 0-5 seconds per message


LONG POLLING:
│                                   │                    │
req                                 req                  req
 ↓←──────── holding ────────────→   ↓                    ↓
DATA!                              DATA!               (timeout)

Requests: 3 in 50 seconds
Data received: 2 messages
Latency: < 1 second per message
```

### Resource Usage Over Time

```
CONNECTIONS
    │
100 │  Short Polling: ─┐  ┌─┐  ┌─┐  ┌─┐  ┌─┐  ┌─
    │                  └──┘ └──┘ └──┘ └──┘ └──┘
    │
    │  Long Polling:   ─────────────────────────
 0  └─────────────────────────────────────────>
                                          TIME

BANDWIDTH
    │
    │  Short Polling: ████████████████████████████
    │  Long Polling:  ████░░░░░░░░░░████░░░░░░░░░
 0  └─────────────────────────────────────────>
                                          TIME
```

---

## Code Examples

### Client Implementation Comparison

```typescript
// SHORT POLLING
class ShortPollingClient {
  start() {
    setInterval(async () => {
      const data = await fetch('/api/updates');
      this.handleData(await data.json());
    }, 5000);
  }
}

// LONG POLLING
class LongPollingClient {
  async start() {
    while (this.running) {
      try {
        const response = await fetch('/api/poll');
        const data = await response.json();
        this.handleData(data);
        // Immediately poll again
      } catch (error) {
        await this.sleep(3000); // Backoff on error
      }
    }
  }
}
```

### Server Implementation Comparison

```javascript
// SHORT POLLING - Simple
app.get('/api/updates', (req, res) => {
  const data = getLatestData();
  res.json(data); // Always respond immediately
});

// LONG POLLING - Complex
app.get('/api/poll', (req, res) => {
  if (hasNewData()) {
    return res.json(getNewData());
  }
  
  // Hold connection
  const timeout = setTimeout(() => {
    res.json({ data: [] });
  }, 30000);
  
  pendingRequests.push({ res, timeout });
  
  req.on('close', () => {
    clearTimeout(timeout);
    removeFromPending(res);
  });
});
```

---

## Performance Comparison

### Network Efficiency

| Metric | Short Polling | Long Polling |
|--------|--------------|--------------|
| Requests per minute (idle) | 12 | 2 |
| Requests per minute (active) | 12 | 60 |
| Bandwidth (idle) | High | Low |
| Bandwidth (active) | High | Medium |
| Connection time | 50-200ms | 30s |
| Overhead | ~95% | ~30% |

### Server Resource Usage (1000 clients)

| Resource | Short Polling | Long Polling |
|----------|--------------|--------------|
| Concurrent connections | 0-100 | 1000 |
| Memory | 10-50 MB | 50-200 MB |
| CPU usage | Medium (spikes) | Low (constant) |
| File descriptors | Low | High |

### Real-World Latency Example

**Scenario**: Message sent at T=0

```
Short Polling (5s interval):
  Best case:   ~0.1s (just polled)
  Worst case:  ~5.0s (just missed poll)
  Average:     ~2.5s

Long Polling:
  Best case:   ~0.1s (connected)
  Worst case:  ~0.5s (reconnecting)
  Average:     ~0.2s
```

---

## When to Use What

### Use Short Polling When:

✅ **Simple use case** with infrequent updates
✅ Updates **don't need** to be real-time (5-30s delay OK)
✅ Server can't hold connections (very limited resources)
✅ Quick **prototype** or **demo**
✅ Legacy systems that can't be modified

**Examples:**
- Weather updates (every 10 minutes)
- Stock prices (delayed quotes OK)
- System health checks
- Low-priority notifications

---

### Use Long Polling When:

✅ Need **near real-time** updates
✅ Must work through **strict firewalls/proxies**
✅ Need to support **old browsers** (IE8/9)
✅ Can't use WebSocket/SSE (infrastructure limitations)
✅ Moderate number of concurrent users (< 10,000)

**Examples:**
- Chat applications (fallback)
- Live score updates
- Order status tracking
- Notification systems
- Collaborative tools

---

### Don't Use Polling When:

❌ Building modern **chat applications** → Use **WebSocket**
❌ Server-to-client **notifications only** → Use **SSE**
❌ Need **bidirectional** communication → Use **WebSocket**
❌ High-frequency updates (> 1/second) → Use **WebSocket**
❌ Building for **modern browsers only** → Use **SSE**

---

## Protocols & Wire Formats

> **The headline:** short polling, long polling, and SSE **all run over plain HTTP**.
> Only WebSocket leaves HTTP — and even it *starts* as an HTTP request.
> This is the single most commonly misunderstood point about SSE: it is **not** its own protocol.

### The Layering

```
                Short Polling    Long Polling     SSE              WebSocket
              ┌──────────────┬───────────────┬────────────────┬──────────────────┐
Wire format   │ yours (JSON) │ yours (JSON)  │ text/event-    │ RFC 6455 frames  │
              │ — no spec    │ — no spec     │ stream (spec'd)│ (binary, masked) │
              ├──────────────┼───────────────┼────────────────┼──────────────────┤
Application   │     HTTP/1.1 · HTTP/2 · HTTP/3                 │ ws:// · wss://   │
              │                                               │ (after HTTP      │
              │                                               │  handshake)      │
              ├───────────────────────────────────────────────┴──────────────────┤
Security      │ TLS (https / wss)                                                │
              ├──────────────────────────────────────────────────────────────────┤
Transport     │ TCP    (or QUIC over UDP when HTTP/3)                             │
              └──────────────────────────────────────────────────────────────────┘
```

**Read this top-down:** the further left, the more you hand-build. The further right,
the more a spec hands you for free — and the more infrastructure has to cooperate.

---

### 1. Short Polling — HTTP, nothing more

`GET /updates` → complete response → connection returns to the keep-alive pool (or closes).
Every poll is an ordinary, independent request/response cycle.

There is **no specification for "short polling."** It is a *usage pattern*, not a protocol.
The JSON shape (`{ hasUpdate, data }`) is entirely your own invention.

```http
GET /updates HTTP/1.1
Host: api.example.com
Cookie: session=abc123

HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 27

{"hasUpdate":false,"data":[]}
```

---

### 2. Long Polling — also HTTP, nothing more

**Byte-for-byte identical on the wire to short polling.** The only difference is
server-side control flow: the handler doesn't call `res.json()` until data arrives
or a timer fires. The client genuinely cannot distinguish a slow server from a
deliberately-held one.

Also unspecified — it belongs to the **Comet** family of patterns (the ~2006 umbrella
term for long polling + HTTP streaming).

```http
GET /poll?since=1042 HTTP/1.1
Host: api.example.com

        ⏳ ... 27 seconds of nothing on the socket ...

HTTP/1.1 200 OK
Content-Type: application/json

{"notifications":[{"id":1043,"msg":"hello"}]}
```

> **Why the server code above is so complex:** the `pendingRequests` array, the
> `timeoutId`, the `req.on('close')` cleanup — all of it exists *because there is no
> protocol helping you*. You are hand-rolling connection lifecycle management that
> SSE and WebSocket receive from a spec.

---

### 3. SSE — HTTP plus a standardized wire format

The first one that is genuinely different. Specified in the **WHATWG HTML Living
Standard** ("Server-sent events" section; originally a W3C spec).

**Transport mechanics:** one HTTP response that *never completes*.
Under HTTP/1.1 that means `Transfer-Encoding: chunked`; under HTTP/2+ it's simply an
open stream.

```http
GET /events HTTP/1.1
Host: api.example.com
Accept: text/event-stream
Last-Event-ID: 42          ← sent automatically on reconnect

HTTP/1.1 200 OK
Content-Type: text/event-stream        ← UTF-8 text ONLY, never binary
Cache-Control: no-cache
Connection: keep-alive
Transfer-Encoding: chunked

: this is a comment — used as a heartbeat to defeat idle proxies

retry: 3000
id: 43
event: notification
data: {"msg":"hello"}
data: a second data line joins the same message with \n
                                       ← blank line terminates the message
id: 44
data: next message
```

**Framing rules:**

| Field | Meaning |
|-------|---------|
| `data:` | Payload. Multiple `data:` lines are joined with `\n`. |
| `event:` | Custom event name → `es.addEventListener('notification', …)`. Defaults to `message`. |
| `id:` | Sets the client's *last event ID*, replayed via `Last-Event-ID` on reconnect. |
| `retry:` | Reconnect backoff in **milliseconds**. |
| `:` prefix | Comment / keep-alive. Ignored by the client. |
| blank line | **Terminates a message.** |

**Client API:** `EventSource` — this is where the built-in auto-reconnect comes from.
On drop it re-issues the same `GET` with a `Last-Event-ID` header carrying the last
`id:` it saw. You get replay-from-cursor for free.

---

### 4. WebSocket — HTTP handshake, then a genuinely different protocol

The only one that **leaves HTTP**. Specified in **RFC 6455** (2011).

#### Phase 1 — The HTTP Upgrade handshake

```http
GET /chat HTTP/1.1
Host: api.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==      ← random 16 bytes, base64
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: graphql-transport-ws     ← optional subprotocol negotiation
Sec-WebSocket-Extensions: permessage-deflate     ← optional (RFC 7692 compression)
Origin: https://app.example.com

HTTP/1.1 101 Switching Protocols                 ← 101, not 200
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
Sec-WebSocket-Protocol: graphql-transport-ws
```

`Sec-WebSocket-Accept` = `base64( SHA1( Sec-WebSocket-Key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11" ) )`

That magic GUID is a constant baked into the RFC. It is **not** security — it's a proof
that the server actually understands WebSocket and isn't a confused HTTP cache being
tricked into replaying a response.

#### Phase 2 — After 101, HTTP is gone

The same TCP connection now carries RFC 6455 binary frames. No more headers, no more
methods, no more status codes.

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-------+-+-------------+-------------------------------+
|F|R|R|R| opcode|M| Payload len |    Extended payload length    |
|I|S|S|S|  (4)  |A|     (7)     |            (16 or 64)         |
|N|V|V|V|       |S|             |  (present if len == 126/127)  |
| |1|2|3|       |K|             |                               |
+-+-+-+-+-------+-+-------------+-------------------------------+
|          Masking-key (4 bytes, present if MASK == 1)          |
+---------------------------------------------------------------+
|                        Payload Data ...                       |
+---------------------------------------------------------------+
```

**Minimum frame header: 2 bytes.** Compare that to the several hundred bytes of headers
and cookies every HTTP request drags along. *This* is where WebSocket's bandwidth win
actually comes from — not from "being persistent" (SSE is persistent too), but from
having almost no per-message overhead.

**Opcodes:**

| Opcode | Meaning |
|--------|---------|
| `0x0` | Continuation (fragmented message) |
| `0x1` | **Text** frame (UTF-8) |
| `0x2` | **Binary** frame |
| `0x8` | Close |
| `0x9` | Ping |
| `0xA` | Pong |

Control frames (`0x8`–`0xA`) must be ≤ 125 bytes and cannot be fragmented.

**Masking:** every client→server frame **must** be XOR-masked with a per-frame random
32-bit key; server→client frames **must not** be. This is not confidentiality (the key
travels in the clear) — it exists purely to stop a malicious page from crafting bytes
that a transparent proxy would misread as an HTTP request (cache-poisoning defence).

**Over HTTP/2 and HTTP/3:** the `Upgrade` mechanism doesn't exist. Instead the handshake
uses *extended CONNECT* with a `:protocol` pseudo-header — **RFC 8441** for HTTP/2,
**RFC 9220** for HTTP/3.

---

### What Each Protocol Choice Costs You

| | Because the protocol is… | You inherit… |
|---|---|---|
| **Short / long polling** | undefined | Total control, but *you* build reconnect, dedup, ordering, and cursoring by hand |
| **SSE** | a text format over HTTP | Proxies/CDNs may **buffer** the stream (nginx needs `X-Accel-Buffering: no`); **UTF-8 only** — binary must be base64'd (~33% inflation) |
| **WebSocket** | a separate framed protocol | Loses **all** HTTP machinery: no caching, no conditional requests, no standard auth, no per-message status codes. L7 proxies must explicitly support `Upgrade` |

#### Three protocol-level gotchas worth knowing cold

**1. Neither `EventSource` nor `WebSocket` can set request headers in the browser.**

```javascript
new EventSource('/events')                    // no options for headers
new WebSocket('/chat', ['subprotocol'])       // 2nd arg is subprotocols, NOT headers
```

So **no `Authorization: Bearer …`** on either. Your options are cookies, a query
parameter (which leaks into access logs), or — for WebSocket — an
auth-as-first-message handshake after connect. Same constraint, same workarounds.

**2. The ~6-connections-per-origin cap bites long polling and SSE, not WebSocket.**

Under HTTP/1.1, browsers cap concurrent connections per origin at roughly 6. Six tabs
holding an SSE stream or a long poll and the seventh silently hangs.
**HTTP/2 multiplexing eliminates this** — and it is the single strongest argument for
running SSE over h2 today. WebSocket is governed by a separate, much higher limit
(*Chrome reportedly allows 255 per host — verify against current browser docs before
relying on the exact number*).

**3. Browsers cannot send WebSocket pings from JavaScript.**

The `WebSocket` API exposes no `ping()`. The browser auto-replies to server pings, but
your app can't initiate one — so **application-level heartbeat messages are mandatory**
to keep load balancers from reaping idle connections. (AWS ALB's default idle timeout
is 60s; *confirm current defaults for your own LB*.) SSE has the same problem and solves
it with `:` comment lines.

---

## Complete Comparison Table

### All Real-Time Technologies

| Feature | Short Polling | Long Polling | SSE | WebSocket |
|---------|--------------|--------------|-----|-----------|
| **Protocol** | HTTP | HTTP | HTTP | HTTP handshake → `ws://`/`wss://` |
| **Wire format** | Yours (usually JSON) | Yours (usually JSON) | `text/event-stream` | RFC 6455 binary frames |
| **Specified by** | — (pattern only) | — (pattern, "Comet") | WHATWG HTML Standard | RFC 6455 (+8441/9220) |
| **Per-message overhead** | Full HTTP headers | Full HTTP headers | ~ bytes of field prefixes | **2–14 bytes** |
| **Client API** | `fetch` / `XHR` | `fetch` / `XHR` | `EventSource` | `WebSocket` |
| **Direction** | Pull | Pull | Push | Push/Pull |
| **Connection type** | Request per poll | Request per message | Persistent | Persistent |
| **Latency** | High (2-15s) | Low (<1s) | Very low (<100ms) | Very low (<50ms) |
| **Bandwidth efficiency** | Very low | Medium | High | Very high |
| **Server load** | Medium (spiky) | High ¹ | Medium ¹ | Low |
| **Browser support** | 100% | 100% | 98% | 98% |
| **Mobile friendly** | ❌ No | ⚠️ OK | ✅ Yes | ✅ Yes |
| **Proxy/firewall** | ✅ Yes | ✅ Yes | ✅ Yes | ⚠️ Sometimes |
| **Complexity** | Very low | Medium | Low | High |
| **Auto-reconnect** | N/A | Manual | Built-in | Manual |
| **Binary data** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| **Max connections** | N/A | 5,000-10,000 | 10,000-50,000 | 50,000+ |
| **Best use case** | Rare updates | Legacy compatibility | Notifications | Chat, gaming |

> **¹ On "server load" — the High/Medium split is subtler than it looks.**
> Long polling and SSE both hold **one connection per client**, so their memory and
> file-descriptor costs are broadly comparable. The real difference is *per message*:
> long polling re-runs the entire request path — TLS session resumption, routing,
> auth middleware, logging — for **every single message**, then forces a reconnect.
> SSE pays that path **once at connect** and then writes bytes into an already-open
> stream. WebSocket pays it once too, and its per-message cost drops to a 2-byte
> frame header.
>
> Rule of thumb: they cost the same to *hold*, and very different amounts to *use*.

---

## Decision Tree

```
Need real-time updates?
  │
  ├─ No → Regular HTTP requests
  │
  └─ Yes → Need bidirectional?
      │
      ├─ Yes → WebSocket
      │
      └─ No (Server→Client only)
          │
          ├─ Modern browsers only? 
          │   └─ Yes → SSE
          │
          └─ No → Must support old browsers/proxies?
              │
              ├─ Yes + Low latency needed → Long Polling
              │
              └─ Yes + Latency OK → Short Polling
```

---

## Summary

### Short Polling
- **Simplest** but **most wasteful**
- Good for: **Infrequent updates, simple systems**
- Bad for: **Real-time, mobile, high traffic**

### Long Polling
- **Good balance** of compatibility and performance
- Good for: **Real-time with universal support**
- Bad for: **Very high scale, bidirectional**

### SSE
- Plain HTTP with a **standardized text format** (`text/event-stream`)
- Good for: **Server→client push, with free reconnect + event replay via `Last-Event-ID`**
- Bad for: **Binary payloads, client→server traffic, HTTP/1.1 at multi-tab scale**

### WebSocket
- The only one that **leaves HTTP** — 101 Upgrade, then RFC 6455 frames
- Good for: **Bidirectional, high-frequency, binary, lowest per-message overhead**
- Bad for: **Anything wanting HTTP semantics** (caching, standard auth, proxy-friendliness)

### Protocol Cheat Sheet
```
Short Polling → HTTP          (no spec — a usage pattern)
Long Polling  → HTTP          (no spec — a usage pattern, "Comet")
SSE           → HTTP          + text/event-stream  (WHATWG HTML Standard)
WebSocket     → HTTP 101      → RFC 6455 frames    (ws:// | wss://)

All four sit on TCP — or QUIC/UDP when carried by HTTP/3.
```

### General Rule
```
Legacy/Simple → Short Polling
Universal Real-time → Long Polling
Modern Notifications → SSE
Chat/Gaming → WebSocket
```

---

## Project Implementations

This repository contains working examples:

1. **`notification-demo/`** - SSE implementation (Go + React)
2. **`long-polling-nodejs/`** - Long polling with Node.js
3. **`long-polling-golang/`** - Long polling with Go

Each folder has complete server + client code with detailed READMEs!




