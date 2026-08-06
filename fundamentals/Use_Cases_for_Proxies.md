# Use Cases for Proxies

A **proxy** is a **middleman** that sits between a client and a backend server and manages the traffic between them — turning messy, hostile, or bursty network traffic into something **secure, fast, and reliable**. There are three families, and the *only* thing you must get right first is **who the proxy is protecting**:

- **Forward Proxy** — sits in front of **clients**. Hides/filters *outbound* traffic.
  - *In plain words:* a **personal assistant who makes calls on your behalf** so the outside world never sees your real number. (Corporate web filter, a web-crawler's IP-rotation pool, a VPN.)
- **Reverse Proxy** — sits in front of **servers**. Balances load, terminates TLS, routes, shields the backend.
  - *In plain words:* the **receptionist at the front desk** — every visitor talks to them, and they decide which office (server) handles you. The offices are never exposed. (NGINX, Envoy, a load balancer, an API gateway.)
- **Sidecar / Service Mesh** — sits **beside each microservice**. Manages service-to-service calls (mTLS, retries, traces).
  - *In plain words:* giving **every employee their own translator** who handles all their inter-office calls identically. (Envoy in Istio/Linkerd.)

> **One-line difference to remember:** *A **forward** proxy hides the **client**; a **reverse** proxy hides the **server**; a **sidecar** sits between **two services**.* Same technology (a proxy), three positions — the position is the whole point.

>
> **How to use this in the repo:** this elaborates *§4 API Gateway* and *§5 Load Balancer* in [`key-technologies-notes.md`](../key-technologies-notes.md). Concept depth: [`interviews/api-design/`](../interviews/api-design/) (the API gateway as an L7 reverse proxy), [`interviews/cdn-edge/`](../interviews/cdn-edge/) (edge proxies), [`interviews/rate-limiting/`](../interviews/rate-limiting/) (inline enforcement), [`interviews/communication-protocols/`](../interviews/communication-protocols/) (L4 vs L7, WebSocket/gRPC). Each system below is cross-linked to its folder in the table at the end.
>
> **Companion series (same 17 systems, same order):** [`Use_Cases_for_Redundancy_and_Replication.md`](./Use_Cases_for_Redundancy_and_Replication.md) (*how it stays correct when machines die*), [`Use_Cases_for_Caching.md`](./Use_Cases_for_Caching.md) (*how it stays fast*), and this doc (*how traffic reaches it safely*). Read a system's rows across all three for its whole story. See also [`Use_Cases_for_Databases.md`](./Use_Cases_for_Databases.md).
>
> ⚠️ **Accuracy note:** system→technology mappings (e.g. Facebook's **Proxygen / Wangle**, Envoy's **Singleflight**) are **illustrative teaching heuristics**, not verified current architectures. Trust the **patterns**; verify the **tech** against primary sources before citing it.

---

## 1. Core Proxy Fundamentals & Patterns

**The traffic funnel** — most large systems chain three proxy positions, outermost first:

```
                    [ Client ]
                        │
                        ▼
   ┌───────────────────────────────────────────────┐
   │                 FORWARD PROXY                   │   (optional, client-side)
   │  • Shields & hides client IP    • Filters       │
   │  • Caches outbound web requests   outbound      │
   └───────────────────────┬───────────────────────┘
                        │  (public internet)
                        ▼
   ┌───────────────────────────────────────────────┐
   │            EDGE PROXY / API GATEWAY             │   (L7 reverse proxy at the edge)
   │  • Terminates SSL/TLS   • Rate-limit / anti-DDoS│
   │  • Auth & login checks  • Geo / path routing    │
   └───────────────────────┬───────────────────────┘
                        │  (internal network)
                        ▼
   ┌───────────────────────────────────────────────┐
   │                 REVERSE PROXY                   │   (L4/L7 load balancer)
   │  • Balances L4/L7 load  • Route by path/header  │
   │  • Request collapsing (Singleflight)            │
   └───────────────────────┬───────────────────────┘
              ┌─────────────┴─────────────┐
              ▼                           ▼
        [ Service A (reads) ]       [ Service B (writes) ]
```

*Read it as a story:* your request leaves through a **forward** proxy (which hides you), crosses the internet to an **edge/API gateway** (which does the heavy security + auth once, for everyone), then an internal **reverse** proxy load-balances it to the right service. Three middlemen, three jobs.

### A. The Three Families — *"who am I protecting?"*

| Family | Protects… | Its job | Example tech | Real use |
|---|---|---|---|---|
| **Forward proxy** | the **client** | mask client IP, filter/cache *outbound* traffic | Squid, corporate filter, residential IP pools | web crawler egress, VPN, content filter |
| **Reverse proxy** | the **server** | load-balance, TLS, route, shield backend | NGINX, HAProxy, Envoy, ELB | every web backend on earth |
| **Sidecar / mesh** | the **service-to-service** call | mTLS, retries, traffic-split, tracing | Envoy (Istio/Linkerd) | microservice fleets |

### B. Proxy Topologies / Roles — *the reverse-proxy family tree*

The reverse proxy has increasingly-smart variants:

1. **Plain reverse proxy / load balancer:** forwards and balances; may be L4 (dumb+fast) or L7 (smart).
2. **API Gateway = an *advanced L7 reverse proxy*.** It centralizes **cross-cutting concerns** so services don't each reimplement them: **auth, access control, rate limiting, request transformation, analytics logging**.
   - *In plain words:* the **one security checkpoint at the building entrance** — check ID once, don't make every office recheck.
3. **Service Mesh Sidecar (e.g. Envoy):** a proxy deployed *next to* each service instance; handles **mTLS**, **traffic splitting** (canary/A-B), and **distributed tracing** transparently.
   - *In plain words:* move all the networking smarts *out of your app code* into a standard co-pilot process.

### C. Protocol Layers — L4 vs L7 — *"how deep does it look?"*

This is the single most-asked proxy interview distinction:

| | **L4 proxy (Transport)** | **L7 proxy (Application)** |
|---|---|---|
| Looks at | IP + port only (TCP/UDP packets) | HTTP/gRPC/WebSocket — headers, path, cookies, body |
| Speed / CPU | **Very fast, tiny CPU** (no payload inspection) | Heavier — it **decrypts TLS + parses** the request |
| Routes by | connection (5-tuple) | content (URL path, header, method) |
| *In plain words* | *"forward the sealed envelope by its address"* | *"open the letter, read it, then decide where it goes"* |
| Use when | raw TCP/UDP, WebSockets, max throughput | smart routing, auth, path-based routing, canary |
| Examples | HAProxy (TCP mode), AWS **NLB** | NGINX, **Envoy**, Traefik, AWS **ALB** |

> 🎯 **Recall:** *L4 = fast + dumb (address only). L7 = smart + heavier (reads the content).* Persistent connections (WebSockets) often start L4; anything needing header/path logic or auth is L7.

### D. Jargon Decoder — *the proxy words in the matrix, in plain English*

| Term | In plain words | Appears in |
|---|---|---|
| **SSL/TLS termination** | The proxy does the expensive **decryption** so backend servers don't have to. | Instagram, Typeahead |
| **Request collapsing / Singleflight** | 1,000 identical requests in the same instant become **one** call to the origin; all 1,000 get that answer. Kills the **thundering herd**. | Twitter |
| **Scatter-gather (fan-out proxy)** | Send one query to **many shards in parallel**, then **merge** the results. | Twitter Search |
| **Session pinning / sticky routing** | Always send a given user to the **same** backend that holds their live connection/state. | FB Messenger, Uber |
| **Connection multiplexing** | Hold **millions of idle client sockets** on a few boxes without one-thread-per-connection. | Dropbox, Messenger |
| **mTLS (mutual TLS)** | Both sides prove identity with certs — services trust each other, not the network. | service mesh |
| **Geo-IP routing** | Route by the user's **location** to the nearest edge/PoP. | YouTube, Netflix |
| **HTTP Range request** | Ask for **just bytes 1024–2048** of a file (a 2-s video chunk), cacheable natively. | YouTube |
| **Long-polling gateway** | Hold a client's HTTP request **open** until there's news — a proxy manages millions of idle ones. | Dropbox |
| **Virtual waiting room** | A gatekeeper queue that **holds users in line** and releases a metered stream to protect checkout. | TicketMaster |
| **Egress / IP rotation** | Outbound requests exit through a **pool of rotating IPs** to avoid being blocked. | WebCrawler |
| **QUIC / HTTP/3** | TLS-over-UDP; faster connection setup at the edge, great for far-away users. | Typeahead |

### E. Decision Guide — *which proxy do I reach for?* (for PRDs & interviews)

1. **Who am I protecting?** *My clients / outbound traffic* → **forward proxy**. *My servers / inbound traffic* → **reverse proxy**. *Calls between my own services* → **sidecar / mesh**.
2. **Do I need to read the request content to route it?** *No — just balance TCP/WebSockets fast* → **L4**. *Yes — route by path/header, or do auth/TLS* → **L7**.
3. **Are cross-cutting concerns (auth, rate-limit, transforms) repeated across services?** → put an **API Gateway** at the edge and do them **once**.
4. **Is there a specific traffic hazard?** thundering herd → **request collapsing**; ticket drop → **virtual waiting room**; getting IP-blocked → **egress IP rotation**; millions of idle sockets → **connection-multiplexing gateway**.

> 📝 **PRD sentence template:** *"Inbound traffic hits an **{L4/L7} reverse proxy / API gateway** that does **{TLS termination, auth, rate-limiting, routing}**; it protects **{backend}** and mitigates **{specific hazard}** via **{technique}**."*
>
> *Filled example (viral feed):* "Inbound traffic hits an **L7 edge API gateway** that terminates TLS and enforces rate limits; it protects the feed services and mitigates the **celebrity thundering herd** via **Singleflight request collapsing**."

---

## 2. Comparative Architectural Summary Matrix

> Read each row: *proxy pattern → protocol layer → the operational benefit it buys.*

| # | System | Primary Proxy Pattern | Protocol Layer | Key benefit & architecture role |
|---|---|---|---|---|
| 1 | **TinyURL** | Reverse Proxy / API Gateway | L7 (HTTP) | Separates read (GET) and write (POST) traffic; routes by key hash. |
| 2 | **Pastebin** | Reverse Proxy / Edge Gateway | L7 (HTTP) | Routes small metadata to SQL/NoSQL, large paste BLOBs straight to object storage. |
| 3 | **Instagram** | Edge Proxy / Service Mesh | L7 (gRPC / HTTP/2) | Offloads SSL at edge PoPs; aggregates microservice payloads in parallel. |
| 4 | **Dropbox** | Streaming Reverse Proxy | L7 (Chunked HTTP) | Manages persistent chunked file transfers + long-poll notification channels. |
| 5 | **FB Messenger** | Stateful Connection Proxy | L4 / L7 (WebSockets) | Holds millions of persistent WS connections; routes messages to active-session nodes. |
| 6 | **Twitter** | Reverse Proxy (Envoy) | L7 (gRPC / HTTP) | **Singleflight** request collapsing prevents thundering herds on viral tweets. |
| 7 | **YouTube** | Edge CDN Reverse Proxy | L7 (HTTP Byte-Range) | Serves adaptive video segments from ISP edge PoPs via HTTP Range requests. |
| 8 | **Netflix** | Edge API Gateway | L7 (HTTP/2) | Dynamic routing, device-specific payload transforms, canary testing. |
| 9 | **Typeahead** | Edge API Gateway | L7 (HTTP/3 / QUIC) | Terminates TLS near the user for sub-20 ms; routes prefixes to Trie shards. |
| 10 | **API Rate Limiter** | Gateway Enforcement Filter | L7 (HTTP Filter) | Evaluates limits at the perimeter, returns HTTP 429 when breached. |
| 11 | **Twitter Search** | Scatter-Gather Search Proxy | L7 (HTTP / TCP) | Fans a query across inverted-index shards, merges ranked results. |
| 12 | **WebCrawler** | Egress Forward Proxy Pool | L4 / L7 (SOCKS5 / HTTP) | Rotates outbound IPs to bypass anti-bot blocks; enforces domain politeness. |
| 13 | **FB NewsFeed** | Edge Aggregation Gateway | L7 (GraphQL / gRPC) | Aggregates feed vectors + post content + author profiles + ad insertion. |
| 14 | **Yelp** | Geospatial Routing Proxy | L7 (HTTP) | Decodes Geohashes, routes to localized spatial DB shards. |
| 15 | **Nearby Friends** | High-Throughput Ingestion Proxy | L4 / L7 (UDP / WS) | Ingests high-frequency GPS pings, streams into location pipelines. |
| 16 | **Uber Backend** | Telemetry Gateway & Stateful Router | L4 / L7 (gRPC / TCP) | Ingests driver telemetry every 4 s; manages persistent WS for matching. |
| 17 | **TicketMaster** | Virtual Waiting Room Queue Proxy | L7 (HTTP Gatekeeper) | Queues drop traffic, releases a metered stream to checkout nodes. |

---

## 3. System-by-System Proxy Architectures

> Each group: **roles → how it works → 🧭 Plain words + interview hook** (the proxy pattern to recall + the folder that owns it).

### TinyURL & Pastebin — *URL shorteners & text pastes*
- **Roles:** L7 API Gateway, read/write traffic splitting, hash-based routing.
- **How:** the L7 proxy reads the HTTP method — `GET /{key}` → read-optimized cache clusters; `POST /shorten` → write workers. For Pastebin it computes `hash(paste_id) % N` at the edge and routes straight to the owning shard, skipping app hops.
- **🧭 Plain words + hook:** *Split reads from writes and route by key right at the door.* — the **L7 read/write-splitting reverse proxy**. → [url-shortener](../interviews/url-shortener/), [file-storage](../interviews/file-storage/).

### Instagram & FB NewsFeed — *social feeds & media*
- **Roles:** edge API gateways, SSL termination, fan-out routing, media aggregation.
- **How:** edge reverse proxies (Proxygen/Envoy) do TLS decryption off the core; the gateway queries Feed + Profile + Media services **in parallel via gRPC** and stitches one JSON payload for the client.
- **🧭 Plain words + hook:** *Do the crypto once at the edge, then gather many services into one response.* — the **aggregation / fan-out API gateway**. → [social-feed](../interviews/social-feed/).

### Twitter & Twitter Search — *real-time timeline & search*
- **Roles:** request collapsing (Singleflight), protocol translation, search-shard routing.
- **How:** when a celebrity tweets, thousands request the same tweet in the same millisecond — Envoy **collapses** them into one origin call. For search, an L7 proxy **scatter-gathers** across hundreds of inverted-index shards and merges the ranked lists.
- **🧭 Plain words + hook:** *Collapse duplicate reads (herd defense); fan out + merge for search.* — **Singleflight** + **scatter-gather**. → [social-feed](../interviews/social-feed/), [search-autocomplete](../interviews/search-autocomplete/).

### Dropbox — *cloud sync & file storage*
- **Roles:** chunked transfer proxy, long-polling notification gateway, bandwidth control.
- **How:** reverse proxies terminate client TCP and **stream 4 MB chunks** to storage workers (app stays light); a specialized gateway holds **millions of idle long-poll connections** to push "file changed" without exhausting thread pools.
- **🧭 Plain words + hook:** *Stream big files through, and park millions of waiting connections cheaply.* — **streaming proxy + long-poll connection gateway**. → [file-storage](../interviews/file-storage/).

### FB Messenger — *real-time messaging*
- **Roles:** WebSocket/state router, connection multiplexing, session pinning.
- **How:** edge connection proxies (Wangle/Proxygen) hold **millions of open WebSocket/MQTT sockets** and route each message to the **specific node holding the recipient's live session** (sticky routing).
- **🧭 Plain words + hook:** *Keep the socket open and always send to the box that holds that user's session.* — **stateful connection proxy + session pinning**. → [chat-system](../interviews/chat-system/).

### YouTube & Netflix — *global video streaming*
- **Roles:** dynamic edge video routing, adaptive-bitrate proxy, geo-IP routing.
- **How:** on Play, an L7 smart proxy checks location/ISP/health and returns an `.m3u8` manifest pointing to the nearest edge; the edge serves **HTTP Range** byte-chunks natively without hitting origin.
- **🧭 Plain words + hook:** *Send the viewer to the nearest edge and serve just the byte-range they asked for.* — **geo-IP edge proxy + range-request caching**. → [video-streaming](../interviews/video-streaming/), [cdn-edge](../interviews/cdn-edge/).

### Typeahead / Autocomplete — *search prefix matching*
- **Roles:** low-latency edge routing, keypress throttling, memory-locality routing.
- **How:** API gateways in edge PoPs terminate **HTTP/3 (QUIC)** near the user; the edge inspects the prefix (`q=sys`) and routes via **consistent hashing** to the in-memory Trie shard for that alphabetical partition.
- **🧭 Plain words + hook:** *Terminate the connection next to the user and route each prefix to its Trie shard.* — **edge L7 (QUIC) + prefix routing**. → [search-autocomplete](../interviews/search-autocomplete/).

### API Rate Limiter — *traffic control & defense*
- **Roles:** inline traffic control, token-bucket enforcement, fraud/DDoS protection.
- **How:** limits are evaluated **inside the gateway** (Envoy filters / NGINX Lua) *before* traffic reaches app servers; each request does an **atomic counter check** in RAM/Redis, returning **429** on breach.
- **🧭 Plain words + hook:** *Count and block at the perimeter, before the request costs you anything.* — **inline gateway enforcement filter**. → [rate-limiting](../interviews/rate-limiting/).

### WebCrawler — *scalable web indexing*
- **Roles:** forward-proxy pools, IP rotation, anti-bot bypass, egress shaping.
- **How:** workers send outbound requests through a large pool of **forward proxies with rotating residential IPs**; outbound proxies enforce **per-domain politeness** (e.g. ≤1 req/s/host) to avoid DoS-ing targets.
- **🧭 Plain words + hook:** *Go out through a rotating pool of IPs and stay polite per site.* — the canonical **forward-proxy** use (protect/mask the client). → [web-crawler](../interviews/web-crawler/).

### Yelp, Nearby Friends & Uber Backend — *geospatial & location*
- **Roles:** spatial shard routing, high-frequency telemetry ingestion, protocol translation.
- **How:** an edge proxy ingests raw **UDP/TCP GPS pings every 4 s**, batches them, and streams into Kafka/location services; proxies decode **Geohashes** and forward to the in-memory spatial shard for that bounding box.
- **🧭 Plain words + hook:** *Swallow the location firehose at the edge and route by geo-cell.* — **telemetry ingestion gateway + geospatial routing**. → [ride-sharing](../interviews/ride-sharing/).

### TicketMaster — *high-concurrency ticketing*
- **Roles:** virtual waiting rooms, queue management, bot protection.
- **How:** during a drop, the edge proxy is a **gatekeeper queue** — it holds users in a virtual line and releases a throttled stream (e.g. 500 req/s) to checkout, shielding the primary DB from collapse.
- **🧭 Plain words + hook:** *Put everyone in a line and drip a safe rate through to checkout.* — the **virtual-waiting-room queue proxy**. → [seat-reservation](../interviews/seat-reservation/).

---

## Where these systems live in this repo

| # | System | Repo topic folder(s) |
|---|---|---|
| 1–2 | TinyURL / Pastebin | [url-shortener](../interviews/url-shortener/) · [file-storage](../interviews/file-storage/) |
| 3, 6, 13 | Instagram / Twitter / FB NewsFeed | [social-feed](../interviews/social-feed/) |
| 4 | Dropbox | [file-storage](../interviews/file-storage/) |
| 5 | FB Messenger | [chat-system](../interviews/chat-system/) |
| 7–8 | YouTube / Netflix | [video-streaming](../interviews/video-streaming/) + [cdn-edge](../interviews/cdn-edge/) |
| 9, 11 | Typeahead / Twitter Search | [search-autocomplete](../interviews/search-autocomplete/) |
| 10 | API Rate Limiter | [rate-limiting](../interviews/rate-limiting/) |
| 12 | WebCrawler | [web-crawler](../interviews/web-crawler/) |
| 14–16 | Yelp / Nearby Friends / Uber | [ride-sharing](../interviews/ride-sharing/) |
| 17 | TicketMaster | [seat-reservation](../interviews/seat-reservation/) |
| *concepts* | API Gateway · edge · L4/L7 | [api-design](../interviews/api-design/) · [cdn-edge](../interviews/cdn-edge/) · [communication-protocols](../interviews/communication-protocols/) |

> Each mapped folder's `deep-dive.md` ends with a **"🔀 Proxies — how *this* system uses them"** callout that expands its row above.

---

## Interview Recall Card (memorize these)

- **Position is everything:** forward proxy hides the **client**, reverse proxy hides the **server**, sidecar sits between **services**.
- **L4 vs L7:** L4 = fast + dumb (IP/port only); L7 = smart + heavier (reads headers/path, does TLS + auth). Persistent/raw → L4; content routing/auth → L7.
- **API Gateway = advanced L7 reverse proxy** that does cross-cutting concerns (auth, rate-limit, TLS, transforms) **once** at the edge.
- **Name the hazard → name the proxy trick:** thundering herd → **Singleflight** collapsing; ticket drop → **virtual waiting room**; IP bans → **egress rotation**; millions of idle sockets → **connection-multiplexing gateway**; search → **scatter-gather**.
- **SSL termination + geo-IP routing + range requests** are why the edge proxy is where video/feeds get fast.
