# Ride Sharing — Simple Component Diagram

> The bare-minimum mental model. Three flows: **location ingest (write-heavy)**, **matching**, and **trip + live tracking**.
> Everything else (surge, pooling, fraud, ETA ML, multi-region) hangs off these boxes.

```mermaid
flowchart LR
    Driver([Driver app])
    Rider([Rider app])

    subgraph HOT["Live location layer — hot, ephemeral (Redis)"]
        LOC[Location Service<br/>ingest GPS every 4s]
        GEO[(Geospatial index<br/>drivers bucketed by cell)]
    end

    MATCH[Matching Service<br/>find nearby → score → offer]

    subgraph DURABLE["Trip layer — durable (SQL)"]
        TRIP[Trip Service<br/>state machine + fare]
        DB[(Trips DB<br/>history, payments)]
    end

    Driver -->|1. GPS every 4s| LOC
    LOC -->|move driver to new cell| GEO
    Rider -->|2. request ride| MATCH
    MATCH -->|query rider's cell + neighbors| GEO
    MATCH -->|3. offer to best driver| Driver
    MATCH -->|4. on accept → create trip| TRIP
    TRIP --> DB
    Driver -->|5. live GPS during trip| TRIP
    TRIP -->|6. push driver position| Rider
```

## The 6 components to remember

| Component | Job (one line) |
|---|---|
| **Location Service** | Absorbs ~250K GPS updates/sec and keeps each driver in the right geo-cell. |
| **Geospatial index** | In-memory map of "which drivers are in which cell" so "who's near me?" is a handful of cell lookups, not a table scan. |
| **Matching Service** | Turns "drivers near the rider" into *one* chosen driver via a scoring function, then runs the offer/accept dance. |
| **Trip Service** | The durable state machine: `REQUESTED → MATCHED → ARRIVED → IN_PROGRESS → COMPLETED → PAID`. |
| **Trips DB** | Cheap-to-query, permanent record: trip history, fares, disputes, payments. |
| **Rider / Driver apps** | Stream GPS up; receive offers and live position down (push + WebSocket). |

## The one idea that ties it together

**Split the hot ephemeral layer from the durable layer.** A driver's location is worthless in 4 seconds — it lives in memory (Redis), churns at 250K writes/sec, and never needs to survive a restart. A trip is a financial record — it lives in a durable SQL store, is written far less often, and must never be lost. Matching is the bridge: it reads the hot layer to pick a driver, then writes a durable trip. Putting locations in your trips database (or trips in Redis) is the single most common way this design falls over.

---

# Detailed Diagram — with Services & Protocols

> Same three flows, now labeled with concrete service/technology picks and protocols you'd name in a senior interview.
> Note: these are *defensible* picks, not the only valid ones (e.g. DynamoDB/Cassandra instead of PostgreSQL for trips at global scale, MSK/Kinesis instead of one another). Pick and defend — don't memorize as gospel.

```mermaid
flowchart TB
    Driver([Driver app])
    Rider([Rider app])
    GW[API Gateway<br/>JWT auth · rate limit]

    %% ---------- LOCATION INGEST ----------
    subgraph INGEST["LOCATION INGEST — write-heavy, ~250K/s, ephemeral"]
        direction TB
        LOC[Location Service]
        REDIS[(Redis<br/>GEO / cell sets<br/>driver:id → lat,lng,ts)]
        KAFKA[[Kafka / Kinesis<br/>raw location stream<br/>replay · analytics · ML]]
    end

    %% ---------- MATCHING ----------
    subgraph MATCHING["MATCHING — latency-bound, &lt; 1s"]
        direction TB
        MATCH[Matching / Dispatch Service<br/>H3 cell query → score → offer]
        SURGE[Surge Service<br/>supply/demand per zone]
        PUSH[[APNs / FCM<br/>ride offer to driver]]
    end

    %% ---------- TRIP + TRACKING ----------
    subgraph TRIP["TRIP + TRACKING — durable + real-time"]
        direction TB
        TSVC[Trip Service<br/>state machine]
        PG[(PostgreSQL / Cassandra<br/>trips, fares, history<br/>sharded by city/region)]
        WS[WebSocket fleet<br/>~50K conns/server]
        PUBSUB[[Redis Pub/Sub<br/>trip:id:location]]
        PAY[Payment Service<br/>idempotent charge]
    end

    %% ---------- INGEST EDGES ----------
    Driver -->|GPS every 4s over HTTP/2| GW
    GW --> LOC
    LOC -->|move to new cell| REDIS
    LOC -->|append event| KAFKA

    %% ---------- MATCHING EDGES ----------
    Rider -->|POST /ride/request| GW
    GW --> MATCH
    MATCH -->|nearby drivers| REDIS
    MATCH -->|read multiplier| SURGE
    SURGE -->|demand/supply counters| REDIS
    MATCH -->|offer, 15s TTL| PUSH --> Driver

    %% ---------- TRIP EDGES ----------
    MATCH -->|on accept| TSVC
    TSVC --> PG
    TSVC -->|on COMPLETED| PAY
    Driver -->|live GPS| LOC
    LOC -->|publish| PUBSUB --> WS
    Rider -->|WebSocket subscribe trip:id| WS
    TSVC -->|trip events| KAFKA
```

## Service cheat-sheet (what maps to what)

| Concept | Service | One-line why |
|---|---|---|
| Ingest 250K GPS/s | **Redis** (GEO or cell-keyed sets) | In-memory; a single node does ~100K writes/s, so shard by city — durability not needed for a value that's stale in 4s |
| Geospatial query | **H3 (Uber) / S2 / geohash** in Redis | "Drivers near me" = rider's cell + ring of neighbors, O(1)-ish lookups instead of a scan |
| Raw location firehose | **Kafka / Kinesis** | Durable log for analytics, ETA-model training, and trip-route replay — *not* the live match path |
| Ride offer to a backgrounded app | **APNs / FCM push** (+ WebSocket when foregrounded) | The driver's app may be closed; a push wakes it for the 15s offer |
| Trip state + history | **PostgreSQL** (→ Cassandra/DynamoDB at global scale) | Durable, queryable ("my last 50 trips"), sharded by city/region |
| Live driver position to rider | **WebSocket fleet + Redis Pub/Sub** | Fan a driver's GPS out to the one rider watching, ~50K sockets/server |
| Surge multiplier | **Surge Service** over Redis counters, **H3 zones** | Precompute per-zone every ~30s; riders in a zone see one consistent price |
| Payment | **Payment Service** with idempotency key = trip id | A retry must never double-charge a completed trip |

## Protocols worth naming

- **HTTP/2** — driver location POSTs and rider API calls; multiplexes over one warm connection.
- **WebSocket** — bidirectional, long-lived channel for live trip tracking (and in-app rider↔driver messaging). SSE would do for tracking-only, but WebSocket covers both.
- **APNs / FCM push** — delivers a ride offer to a driver whose app is backgrounded; the live path can't assume an open socket.
- **gRPC** — typical east-west protocol between internal services (Matching ↔ Trip ↔ Surge).
- **Protobuf** — compact wire format for high-frequency location messages (~12 bytes vs ~100 bytes JSON).
