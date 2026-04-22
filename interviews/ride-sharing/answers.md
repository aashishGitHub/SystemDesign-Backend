# Answers: Ride Sharing (Uber / Lyft)

> Keyed to [questions.md](./questions.md). Read questions first.
> Every answer includes either code or a comparison table so you can defend tradeoffs clearly.

---

## Level 1 — Core Problem

### A1. Core steps from request to driver arrival

```text
1. Rider opens app → app sends rider's GPS coordinates
2. Rider enters destination, requests ride
3. System receives request with (pickup, destination, ride_type)
4. System queries nearby available drivers
5. Matching algorithm scores drivers, selects best
6. System sends ride offer to selected driver
7. Driver accepts (or timeout → try next driver)
8. System creates trip record, notifies rider
9. Driver navigates to pickup point
10. Rider tracks driver in real-time on map
```

---

### A2. Why naive SQL spatial query fails

```sql
SELECT * FROM drivers 
WHERE distance(lat, lng, rider_lat, rider_lng) < 2000
ORDER BY distance;
```

**Problems**:

| Issue | Impact |
|---|---|
| Full table scan | 1M rows scanned per query |
| No spatial index | O(n) complexity per request |
| Distance function | Computed for every row |
| Concurrent queries | 1000 req/sec × 1M rows = 1 billion computations/sec |

**Solution**: Geospatial indexing (geohash, R-tree, S2) reduces search to O(1) cell lookups.

---

### A3. Write throughput calculation

```text
1,000,000 drivers × 1 update / 4 seconds = 250,000 writes/sec

Traditional DB challenges:
- PostgreSQL max: ~10K-50K writes/sec (tuned)
- Each write requires disk fsync for durability
- B-tree index updates on every write
- Connection pool saturation
```

**Solution**: Use Redis (in-memory, 100K+ writes/sec per node) for ephemeral location data.

---

### A4. Nearest vs best driver

| Factor | Nearest | Best |
|---|---|---|
| Distance | ✓ Wins | Considers other factors |
| Direction | Ignored | Driver heading matters |
| ETA | Assumed proportional to distance | Computed with traffic |
| Ratings | Ignored | Higher rating preferred |
| Vehicle type | Ignored | Must match request |
| Acceptance rate | Ignored | High acceptance = reliable |

**Example**: Driver A is 500m away but stuck in traffic. Driver B is 1km away on a clear road. B has lower ETA.

```python
def score_driver(driver, rider):
    distance_score = 1 / (1 + driver.distance_to(rider))  # 0-1
    direction_score = driver.heading_toward(rider)  # 0-1
    rating_score = driver.rating / 5.0  # 0-1
    acceptance_score = driver.acceptance_rate  # 0-1
    
    return (
        distance_score * 0.4 +
        direction_score * 0.3 +
        rating_score * 0.2 +
        acceptance_score * 0.1
    )
```

---

### A5. Impact of 2-minute downtime

```text
Scenario: Matching service down for 2 minutes

Impact:
- 1000 requests/sec × 120 sec = 120,000 ride requests failed
- Riders see "No drivers available" or spinner
- Drivers sit idle, lose earnings
- Riders switch to competitor (Lyft)
- Brand damage, Twitter complaints

Why 99.9% availability matters:
- 0.1% downtime = 8.7 hours/year
- For real-time service, even 10 minutes is a PR crisis
```

---

## Level 2 — Geospatial Indexing

### A6. Geohash explanation

**Geohash** encodes (lat, lng) into a string by:
1. Divide world into 32 cells (base32 encoding)
2. Recursively subdivide chosen cell
3. Each character adds precision

```text
Precision examples:
- "9q8y"   → ~40km × 20km cell
- "9q8yyk" → ~1.2km × 0.6km cell
- "9q8yykv" → ~150m × 150m cell

Property: Nearby locations share prefix
- "9q8yyk8" and "9q8yyk9" are neighbors
```

```python
import geohash

# Encode
gh = geohash.encode(37.7749, -122.4194, precision=6)  # "9q8yyk"

# Decode
lat, lng = geohash.decode("9q8yyk")  # (37.775, -122.419)
```

---

### A7. Finding drivers within 2km using geohash

```text
Cell size at precision 6: ~1.2km × 0.6km

To cover 2km radius, need rider's cell + neighbors:
┌───┬───┬───┐
│ 1 │ 2 │ 3 │
├───┼───┼───┤
│ 4 │ R │ 5 │  ← R = rider's cell
├───┼───┼───┤
│ 6 │ 7 │ 8 │
└───┴───┴───┘

Query 9 cells: rider's cell + 8 adjacent cells
```

```python
import geohash

def get_nearby_drivers(rider_lat, rider_lng, redis):
    rider_geohash = geohash.encode(rider_lat, rider_lng, precision=6)
    neighbors = geohash.neighbors(rider_geohash)
    cells_to_check = [rider_geohash] + neighbors  # 9 cells
    
    drivers = []
    for cell in cells_to_check:
        drivers.extend(redis.smembers(f"drivers:{cell}"))
    
    return drivers
```

---

### A8. Edge problem with geohash

**Problem**: Geohash adjacency doesn't match real-world adjacency at boundaries.

```text
"9q8yy" and "9q8yz" might be adjacent, but
"9q8yy" and "9r000" might also be adjacent (different prefix!)

Also: Cells at different latitudes have different physical sizes
```

**Solution**: Always query the 8 neighbors, not just cells sharing prefix.

```python
def neighbors(geohash_str):
    # Returns 8 adjacent cells regardless of prefix
    return geohash.neighbors(geohash_str)
    # Handles edge cases at cell boundaries
```

---

### A9. Geohash vs S2 vs H3

| Feature | Geohash | S2 (Google) | H3 (Uber) |
|---|---|---|---|
| Cell shape | Rectangle | Square (on sphere) | Hexagon |
| Hierarchy | Yes (prefix) | Yes (64-bit ID) | Yes (resolution) |
| Edge neighbors | 8 | 8 | 6 |
| Uniform distance | No (varies by lat) | Better | Best |
| Used by | Many | Google Maps | Uber |

**H3 advantage**: Hexagons have uniform distance from center to all edges. Rectangles don't.

```python
# H3 example
import h3

# Convert lat/lng to H3 cell at resolution 9 (~300m)
cell = h3.geo_to_h3(37.7749, -122.4194, 9)

# Get neighboring cells
neighbors = h3.k_ring(cell, 1)  # 7 cells (center + 6 neighbors)
```

---

### A10. Redis storage for driver locations

**Data structure**: Redis SET per geohash cell

```python
# Store driver location
def update_driver_location(driver_id, lat, lng, redis):
    new_cell = geohash.encode(lat, lng, precision=6)
    old_cell = redis.get(f"driver:{driver_id}:cell")
    
    if old_cell and old_cell != new_cell:
        redis.srem(f"drivers:{old_cell}", driver_id)
    
    redis.sadd(f"drivers:{new_cell}", driver_id)
    redis.set(f"driver:{driver_id}:cell", new_cell)
    redis.hset(f"driver:{driver_id}", mapping={
        "lat": lat,
        "lng": lng,
        "updated_at": time.time()
    })
```

**Alternative**: Redis GEOSPATIAL commands

```bash
# Add driver location
GEOADD drivers:city -122.4194 37.7749 "driver123"

# Find drivers within 2km
GEORADIUS drivers:city -122.4194 37.7749 2 km WITHDIST
```

---

### A11. Variable geohash precision by density

| Area | Density | Geohash Precision | Cell Size |
|---|---|---|---|
| Manhattan | Very high | 7 | ~150m |
| Suburbs | Medium | 6 | ~1.2km |
| Rural | Low | 5 | ~5km |

```python
def get_precision(lat, lng):
    density = get_area_density(lat, lng)  # Precomputed zones
    if density > 1000:  # drivers per km²
        return 7
    elif density > 100:
        return 6
    else:
        return 5
```

**Uber's approach**: Use H3 at consistent resolution, but adjust search radius dynamically.

---

## Level 3 — Location Updates at Scale

### A12. Driver location update flow

```text
Driver App → API Gateway → Location Service → Redis

Step by step:
1. GPS sensor on phone triggers every 4 seconds
2. App batches updates (or sends immediately)
3. HTTPS POST /driver/location {lat, lng, heading, speed}
4. API Gateway authenticates JWT, extracts driver_id
5. Location Service:
   a. Compute new geohash cell
   b. Update Redis: move driver to new cell if changed
   c. Store latest (lat, lng, heading, speed, timestamp)
6. Return 200 OK
```

```python
@app.post("/driver/location")
async def update_location(lat: float, lng: float, driver_id: str = Depends(get_driver)):
    cell = geohash.encode(lat, lng, precision=6)
    
    # Atomic pipeline
    pipe = redis.pipeline()
    
    # Move to new cell if changed
    old_cell = await redis.get(f"driver:{driver_id}:cell")
    if old_cell != cell:
        pipe.srem(f"drivers:{old_cell}", driver_id)
        pipe.sadd(f"drivers:{cell}", driver_id)
        pipe.set(f"driver:{driver_id}:cell", cell)
    
    # Update location
    pipe.hset(f"driver:{driver_id}", mapping={
        "lat": lat, "lng": lng, "ts": time.time()
    })
    
    await pipe.execute()
    return {"ok": True}
```

---

### A13. PostgreSQL vs Redis for locations

| Aspect | PostgreSQL | Redis |
|---|---|---|
| Durability | Yes (disk) | No (memory) |
| Latency | ~5ms | ~0.5ms |
| Throughput | ~10K writes/sec | ~100K writes/sec |
| Spatial query | PostGIS | GEORADIUS |
| Data lifetime | Permanent | Ephemeral |

**Decision**: 
- **Redis**: Current driver locations (hot, ephemeral)
- **PostgreSQL**: Trip history, user data, payments (cold, durable)

```text
Driver location at 10:05:23 → Redis (replaced at 10:05:27)
Trip record → PostgreSQL (permanent)
```

---

### A14. Handling stale location data

```python
STALE_THRESHOLD = 30  # seconds

def is_driver_available(driver_id, redis):
    location = redis.hgetall(f"driver:{driver_id}")
    if not location:
        return False
    
    updated_at = float(location["ts"])
    if time.time() - updated_at > STALE_THRESHOLD:
        # Mark driver as offline
        redis.srem(f"drivers:{location['cell']}", driver_id)
        return False
    
    return True
```

**Background cleanup job**:
```python
async def cleanup_stale_drivers():
    while True:
        # Scan all driver keys
        for key in redis.scan_iter("driver:*:cell"):
            driver_id = key.split(":")[1]
            if not is_driver_available(driver_id, redis):
                logger.info(f"Removed stale driver {driver_id}")
        
        await asyncio.sleep(10)
```

---

### A15. GPS drift detection

```python
MAX_SPEED_MPS = 50  # 180 km/h max reasonable speed

def validate_location_update(driver_id, new_lat, new_lng, redis):
    old_location = redis.hgetall(f"driver:{driver_id}")
    if not old_location:
        return True  # First update
    
    old_lat, old_lng = float(old_location["lat"]), float(old_location["lng"])
    old_ts = float(old_location["ts"])
    
    distance = haversine(old_lat, old_lng, new_lat, new_lng)  # meters
    time_diff = time.time() - old_ts
    
    if time_diff > 0:
        speed = distance / time_diff  # meters per second
        if speed > MAX_SPEED_MPS:
            logger.warning(f"GPS drift detected for {driver_id}: {speed} m/s")
            return False  # Reject update
    
    return True
```

---

### A16. Batching vs immediate location updates

| Approach | Pros | Cons |
|---|---|---|
| Immediate | Freshest data | High network, battery drain |
| Batched (5 updates) | Lower overhead | Up to 20s stale |
| Smart batching | Best of both | Complex logic |

**Smart batching**:
```python
def should_send_immediately(new_location, last_sent_location):
    # Send immediately if:
    # - Significant movement (> 50m)
    # - Heading change > 30°
    # - Status change (available → busy)
    distance = haversine(new_location, last_sent_location)
    heading_change = abs(new_location.heading - last_sent_location.heading)
    
    return distance > 50 or heading_change > 30
```

---

### A17. Thundering herd at driver login

**Problem**: 100K drivers login at 8 AM, all send location update immediately.

**Solutions**:

| Strategy | Implementation |
|---|---|
| Jitter | Each driver waits random(0, 30) seconds before first update |
| Rate limiting | API Gateway limits 10K req/sec, rejects excess with 429 |
| Staggered startup | App staggers initial sync based on driver_id hash |

```python
# Client-side jitter
async def start_location_updates():
    # Random delay up to 30 seconds
    await asyncio.sleep(random.uniform(0, 30))
    while True:
        send_location_update()
        await asyncio.sleep(4)
```

---

## Level 4 — Matching Algorithm

### A18. Scoring 50 nearby drivers

```python
def match_rider_to_driver(rider, available_drivers):
    scored_drivers = []
    
    for driver in available_drivers:
        score = compute_score(rider, driver)
        scored_drivers.append((driver, score))
    
    scored_drivers.sort(key=lambda x: x[1], reverse=True)
    return scored_drivers[0][0]  # Best driver

def compute_score(rider, driver):
    # ETA (lower is better)
    eta = compute_eta(driver, rider.pickup)
    eta_score = 1 / (1 + eta / 60)  # Normalize by 60 seconds
    
    # Distance (lower is better)
    distance = haversine(driver.lat, driver.lng, rider.lat, rider.lng)
    distance_score = 1 / (1 + distance / 1000)  # Normalize by 1km
    
    # Direction (higher is better if heading toward rider)
    direction_score = compute_heading_alignment(driver, rider)
    
    # Rating (higher is better)
    rating_score = driver.rating / 5.0
    
    # Acceptance rate (higher is better)
    acceptance_score = driver.acceptance_rate
    
    return (
        eta_score * 0.35 +
        distance_score * 0.25 +
        direction_score * 0.15 +
        rating_score * 0.15 +
        acceptance_score * 0.10
    )
```

---

### A19. Formal matching problem definition

```text
Inputs:
- R = set of ride requests {r₁, r₂, ...}
- D = set of available drivers {d₁, d₂, ...}
- ETA(dᵢ, rⱼ) = estimated time for driver i to reach rider j
- Score(dᵢ, rⱼ) = weighted scoring function

Constraints:
- Each driver assigned to at most one ride
- Each ride assigned to at most one driver
- Driver must have matching vehicle type
- Driver must be within max distance threshold

Objective:
Maximize Σ Score(dᵢ, rⱼ) for all (dᵢ, rⱼ) assignments
(Or minimize Σ ETA — depends on business goals)
```

This is a **bipartite matching problem** — solvable with Hungarian algorithm or greedy heuristics.

---

### A20. ETA vs distance — direction matters

```text
Driver A: 500m away, heading AWAY from rider
  - Must U-turn, deal with traffic
  - ETA: 5 minutes

Driver B: 1km away, heading TOWARD rider
  - Direct path, no turns
  - ETA: 3 minutes

Winner: Driver B (despite being farther)
```

```python
def compute_heading_alignment(driver, rider):
    # Angle from driver to rider
    desired_heading = calculate_bearing(
        driver.lat, driver.lng,
        rider.lat, rider.lng
    )
    
    # How close is driver's current heading to desired?
    diff = abs(driver.heading - desired_heading)
    if diff > 180:
        diff = 360 - diff
    
    # 0° diff = 1.0, 180° diff = 0.0
    return 1 - (diff / 180)
```

---

### A21. Incorporating ratings, acceptance, vehicle type

```python
def compute_score(rider, driver, ride_request):
    # Hard filters (must match)
    if ride_request.vehicle_type != driver.vehicle_type:
        return -1  # Disqualify
    
    if driver.rating < ride_request.min_rating:
        return -1  # Disqualify (e.g., premium riders)
    
    # Soft scoring
    base_score = compute_eta_distance_score(rider, driver)
    
    # Rating bonus (4.9+ rating gets 10% bonus)
    rating_bonus = max(0, (driver.rating - 4.5) * 0.1)
    
    # Acceptance penalty (low acceptance = less reliable)
    acceptance_penalty = (1 - driver.acceptance_rate) * 0.2
    
    return base_score + rating_bonus - acceptance_penalty
```

---

### A22. Batch matching vs sequential

| Approach | Pros | Cons |
|---|---|---|
| Sequential | Simple, immediate | Suboptimal global assignment |
| Batch (every 2s) | Globally optimal | 2s delay, complexity |

**Example**:
```text
Sequential:
  Request 1 arrives → Assign Driver A
  Request 2 arrives → Assign Driver B
  (But B was closer to Request 1, A to Request 2!)

Batch:
  Wait 2 seconds, collect: Request 1, Request 2
  Optimal matching: Request 1 → Driver B, Request 2 → Driver A
```

**Uber's approach**: Hybrid — sequential for low-load, batch during surge.

---

### A23. The "offer" system (one driver at a time)

**Why not broadcast?**
- 50 drivers all see the same ride → 49 race conditions
- Driver A accepts, but Drivers B-Z already drove toward pickup
- Frustration, wasted gas, complaints

**Offer system**:
```text
1. Select best driver (score = 100)
2. Send offer to Driver 1, wait 15 seconds
3. If no response → Driver 1 gets acceptance rate penalty
4. Select next best driver (score = 95)
5. Repeat until accepted or timeout
```

```python
async def dispatch_ride(ride_request, drivers):
    for driver in sorted(drivers, key=score, reverse=True):
        offer_sent = await send_offer(driver, ride_request)
        
        if offer_sent:
            response = await wait_for_response(driver, timeout=15)
            if response == "accepted":
                return create_trip(ride_request, driver)
            else:
                penalize_acceptance_rate(driver)
    
    return {"error": "no_drivers_available"}
```

---

### A24. Handling driver timeout

```python
async def wait_for_response(driver, ride_request, timeout=15):
    try:
        response = await asyncio.wait_for(
            driver_response_channel.get(driver.id),
            timeout=timeout
        )
        return response
    except asyncio.TimeoutError:
        # Driver didn't respond
        record_timeout(driver.id)
        update_acceptance_rate(driver.id, accepted=False)
        
        # Move to next driver
        return "timeout"
```

**Acceptance rate calculation**:
```text
acceptance_rate = accepted_offers / total_offers (last 30 days)

Impact:
- < 80%: Warning notification
- < 70%: Lower priority in matching
- < 50%: Account review
```

---

## Level 5 — Trip State Machine

### A25. Trip state machine

```text
          ┌─────────────────────────────────────────────────────────────┐
          │                      Trip State Machine                      │
          └─────────────────────────────────────────────────────────────┘

                              ┌─────────────┐
                              │  REQUESTED  │
                              └──────┬──────┘
                                     │ driver_accepts
                                     ▼
          rider_cancels        ┌─────────────┐      no_driver_found
         ┌─────────────────────│  MATCHED    │─────────────────────┐
         │                     └──────┬──────┘                      │
         │                            │ driver_arrives              │
         │                            ▼                             ▼
         │                     ┌─────────────┐              ┌──────────────┐
         │                     │   ARRIVED   │              │  CANCELLED   │
         │                     └──────┬──────┘              └──────────────┘
         │                            │ trip_starts
         │                            ▼
         │   driver_cancels    ┌─────────────┐
         │ ◄───────────────────│ IN_PROGRESS │
         │                     └──────┬──────┘
         │                            │ trip_ends
         │                            ▼
         │                     ┌─────────────┐
         │                     │  COMPLETED  │
         │                     └──────┬──────┘
         │                            │ payment_processed
         │                            ▼
         │                     ┌─────────────┐
         └────────────────────►│    PAID     │
                               └─────────────┘
```

---

### A26. Cancellation handling

| Scenario | Who Cancels | Penalty |
|---|---|---|
| Before match | Rider | None |
| After match, before arrival | Rider | Small fee ($5) |
| After 5 min wait | Rider | No-show fee charged |
| Driver cancels after match | Driver | Acceptance rate hit |
| After pickup started | Rider | Partial fare |

```python
def handle_cancellation(trip, cancelled_by, reason):
    if trip.state == "REQUESTED":
        trip.state = "CANCELLED"
        return {"fee": 0}
    
    elif trip.state == "MATCHED":
        if cancelled_by == "rider":
            minutes_since_match = (now() - trip.matched_at).minutes
            if minutes_since_match > 2:
                fee = 5.00  # Cancellation fee
            else:
                fee = 0
            trip.state = "CANCELLED"
            charge_rider(trip.rider_id, fee)
            return {"fee": fee}
        
        elif cancelled_by == "driver":
            trip.state = "CANCELLED"
            penalize_driver(trip.driver_id)
            # Re-dispatch to new driver
            redispatch_ride(trip)
```

---

### A27. Driver no-show handling

```python
async def monitor_driver_arrival(trip):
    matched_at = trip.matched_at
    max_arrival_time = trip.estimated_arrival + timedelta(minutes=10)
    
    while True:
        await asyncio.sleep(30)
        
        if trip.state == "ARRIVED":
            return  # Driver arrived
        
        if datetime.now() > max_arrival_time:
            # Driver no-show
            trip.state = "CANCELLED"
            penalize_driver(trip.driver_id)
            notify_rider(trip.rider_id, "Driver didn't arrive. Finding new driver...")
            redispatch_ride(trip)
            return
```

---

### A28. Payment failure after trip

```python
def process_trip_payment(trip):
    try:
        charge = stripe.charges.create(
            amount=trip.fare_cents,
            currency="usd",
            customer=trip.rider.stripe_id,
            idempotency_key=f"trip_{trip.id}"
        )
        trip.state = "PAID"
        trip.payment_id = charge.id
        
    except stripe.CardError:
        trip.state = "PAYMENT_FAILED"
        trip.payment_attempts += 1
        
        # Retry logic
        if trip.payment_attempts < 3:
            schedule_retry(trip, delay_minutes=60)
        else:
            # Block rider from new rides
            suspend_rider(trip.rider_id, reason="payment_failed")
```

**State after failure**: `PAYMENT_FAILED` (trip completed but not paid)

---

### A29. Trip history storage

**Access patterns**:
- Read-heavy: "Show me my last 50 trips"
- Time-range: "Trips this month"
- Rarely updated after completion

**Database**: PostgreSQL with proper indexing

```sql
CREATE TABLE trips (
    id UUID PRIMARY KEY,
    rider_id UUID NOT NULL,
    driver_id UUID,
    state VARCHAR(20) NOT NULL,
    pickup_lat DECIMAL(10, 7),
    pickup_lng DECIMAL(10, 7),
    dropoff_lat DECIMAL(10, 7),
    dropoff_lng DECIMAL(10, 7),
    fare_cents INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    
    INDEX idx_rider_trips (rider_id, created_at DESC),
    INDEX idx_driver_trips (driver_id, created_at DESC)
);
```

---

### A30. Fare dispute support

```python
# Store detailed trip data for disputes
class TripRoute:
    trip_id: UUID
    route_points: list[LatLng]  # GPS breadcrumbs every 5 seconds
    distance_meters: int
    duration_seconds: int
    surge_multiplier: float
    
def calculate_fare(trip_route):
    base_fare = 2.50
    per_km = 1.50
    per_minute = 0.25
    
    fare = (
        base_fare +
        (trip_route.distance_meters / 1000) * per_km +
        (trip_route.duration_seconds / 60) * per_minute
    ) * trip_route.surge_multiplier
    
    return fare

# Dispute resolution
def investigate_fare_dispute(trip_id):
    trip = get_trip(trip_id)
    route = get_trip_route(trip_id)
    
    # Recalculate fare from stored route
    expected_fare = calculate_fare(route)
    
    # Compare with charged fare
    overcharge = trip.fare_cents - expected_fare
    
    if overcharge > 100:  # > $1 overcharge
        return {"refund": overcharge, "reason": "routing_error"}
```

---

## Level 6 — Real-Time Tracking

### A31. Real-time tracking implementation

```text
Rider's app ──WebSocket──► Tracking Service ◄── Driver location updates

Flow:
1. Trip starts, rider subscribes to trip_id channel
2. Driver sends GPS every 4 seconds to Location Service
3. Location Service publishes to Redis Pub/Sub channel
4. Tracking Service receives, pushes to rider's WebSocket
5. Rider's map updates driver position
```

```python
# Tracking Service
@websocket.route("/track/{trip_id}")
async def track_trip(websocket, trip_id):
    trip = get_trip(trip_id)
    if not authorize(websocket.user_id, trip):
        await websocket.close()
        return
    
    pubsub = redis.pubsub()
    await pubsub.subscribe(f"trip:{trip_id}:location")
    
    async for message in pubsub.listen():
        if message["type"] == "message":
            location = json.loads(message["data"])
            await websocket.send_json({
                "type": "driver_location",
                "lat": location["lat"],
                "lng": location["lng"],
                "heading": location["heading"]
            })
```

---

### A32. WebSocket vs SSE vs Polling

| Method | Direction | Overhead | Best For |
|---|---|---|---|
| WebSocket | Bidirectional | Low | Interactive (chat) |
| SSE | Server → Client | Low | Read-only updates |
| Polling | Client → Server | High | Simple, fallback |

**For tracking**: SSE is sufficient (rider only receives updates).
**For messaging**: WebSocket (rider might send messages to driver).

**Uber's choice**: WebSocket (supports both tracking and in-app messaging).

---

### A33. Scaling to 1M concurrent WebSocket connections

```text
1M concurrent riders tracking rides
÷ 50K connections per server (optimized)
= 20 WebSocket servers

Architecture:
┌─────────────────────────────────────────────────────────┐
│                   Load Balancer                          │
│         (sticky sessions by trip_id hash)               │
└────────────────────────┬────────────────────────────────┘
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
      ┌─────────┐   ┌─────────┐   ┌─────────┐
      │ Tracker │   │ Tracker │   │ Tracker │
      │Server 1 │   │Server 2 │   │Server N │
      └────┬────┘   └────┬────┘   └────┬────┘
           │             │             │
           └─────────────┼─────────────┘
                         ▼
                  ┌─────────────┐
                  │   Redis     │
                  │   Pub/Sub   │
                  └─────────────┘
```

---

### A34. Reconnection handling

```python
@websocket.route("/track/{trip_id}")
async def track_trip(websocket, trip_id):
    # On connect, send current state
    trip = get_trip(trip_id)
    driver_location = get_driver_location(trip.driver_id)
    
    # Immediate sync
    await websocket.send_json({
        "type": "sync",
        "trip_state": trip.state,
        "driver_location": driver_location,
        "eta": trip.eta
    })
    
    # Then subscribe to updates
    async for update in subscribe_to_trip(trip_id):
        await websocket.send_json(update)
```

---

### A35. Reducing WebSocket data

```python
def should_send_location(new_location, last_sent, trip_state):
    if trip_state == "IN_PROGRESS":
        # During trip: send every update (important)
        return True
    
    # Pre-pickup: only send if moved significantly
    distance = haversine(new_location, last_sent)
    if distance > 20:  # meters
        return True
    
    # Or if 10 seconds passed
    if time.time() - last_sent.timestamp > 10:
        return True
    
    return False
```

**Compression**: Use binary protocol (Protobuf) instead of JSON.

```protobuf
message DriverLocation {
  float lat = 1;
  float lng = 2;
  uint32 heading = 3;  // 0-359
  uint32 speed = 4;    // m/s
}
// ~12 bytes vs ~100 bytes JSON
```

---

## Level 7 — Surge Pricing

### A36. Surge pricing inputs

```python
def compute_surge_multiplier(zone, time_window_minutes=5):
    # Supply: available drivers in zone
    supply = count_available_drivers(zone)
    
    # Demand: ride requests in last N minutes
    demand = count_recent_requests(zone, minutes=time_window_minutes)
    
    # Completed rides in last N minutes (actual capacity)
    capacity = count_completed_rides(zone, minutes=time_window_minutes)
    
    # Demand/supply ratio
    if supply == 0:
        ratio = float('inf')
    else:
        ratio = demand / supply
    
    # Map ratio to multiplier
    if ratio < 1:
        return 1.0  # No surge
    elif ratio < 1.5:
        return 1.2
    elif ratio < 2:
        return 1.5
    elif ratio < 3:
        return 2.0
    else:
        return min(ratio, 5.0)  # Cap at 5x
```

---

### A37. Zone-based surge (not per-ride)

**Why zones?**
- Computing surge per-ride is expensive (query supply/demand each time)
- Zones allow batch computation (every 30 seconds)
- Riders in same area see same surge (fairness)

**Zone definition**:
```python
# Use H3 hexagons at resolution 7 (~5km²)
def get_surge_zone(lat, lng):
    return h3.geo_to_h3(lat, lng, resolution=7)

# Pre-compute surge for all zones
async def compute_all_surges():
    while True:
        zones = get_active_zones()  # Zones with recent activity
        for zone in zones:
            surge = compute_surge_multiplier(zone)
            redis.set(f"surge:{zone}", surge, ex=60)  # 60s TTL
        await asyncio.sleep(30)
```

---

### A38. Real-time surge response (New Year's Eve)

```text
Timeline:
11:50 PM: Normal demand, surge = 1.0x
11:55 PM: Demand increasing, surge recalculated
11:59 PM: Demand spikes 10x, surge = 3.5x
12:00 AM: Demand peaks, surge = 5.0x (capped)
12:15 AM: More drivers come online, supply up
12:30 AM: Surge drops to 2.5x
1:00 AM: Surge returns to 1.0x
```

**System response**:
```python
def update_surge_realtime(zone, event):
    current_surge = redis.get(f"surge:{zone}")
    
    if event == "ride_requested":
        # Increase demand counter
        redis.incr(f"demand:{zone}")
        # If spike detected, recalculate immediately
        if should_recalculate(zone):
            new_surge = compute_surge_multiplier(zone)
            redis.set(f"surge:{zone}", new_surge)
            # Notify pricing service
            publish_surge_update(zone, new_surge)
    
    elif event == "driver_available":
        # Recalculate if significant supply change
        redis.incr(f"supply:{zone}")
```

---

### A39. Preventing surge oscillation

**Problem**: Price goes up → riders cancel → price drops → riders request → price goes up...

**Solutions**:

| Strategy | Implementation |
|---|---|
| Smoothing | New surge = (old × 0.7) + (computed × 0.3) |
| Cooldown | Don't reduce surge within 5 minutes of spike |
| Hysteresis | Increase at 2x threshold, decrease at 1.5x |
| Committed price | Once rider sees price, honor it for 5 minutes |

```python
def update_surge_with_smoothing(zone, computed_surge):
    old_surge = redis.get(f"surge:{zone}") or 1.0
    
    # Smoothing factor
    smoothed = (old_surge * 0.7) + (computed_surge * 0.3)
    
    # Cooldown: don't decrease if recent spike
    if smoothed < old_surge:
        last_spike = redis.get(f"surge_spike:{zone}")
        if last_spike and (now() - last_spike) < timedelta(minutes=5):
            smoothed = old_surge  # Maintain current surge
    
    redis.set(f"surge:{zone}", smoothed)
```

---

### A40. Surge fraud prevention

**Fraud pattern**: Drivers wait for surge before going online.

**Detection**:
```python
def detect_surge_gaming(driver_id):
    online_events = get_driver_online_events(driver_id, days=30)
    
    surge_online_count = 0
    for event in online_events:
        zone_surge = get_surge_at_time(event.zone, event.timestamp)
        if zone_surge > 1.5:
            surge_online_count += 1
    
    surge_online_ratio = surge_online_count / len(online_events)
    
    if surge_online_ratio > 0.8:  # 80% of logins during surge
        flag_for_review(driver_id, "potential_surge_gaming")
```

**Prevention**:
- Require minimum online time to be eligible for surge
- Weight matching against drivers who just came online during surge

---

## Level 8 — Production Operations

### A41. Capacity estimation (100K drivers)

```text
Location Service:
- 100K drivers × 1 update / 4 sec = 25K writes/sec
- Each write: ~200 bytes (lat, lng, heading, speed, timestamp)
- Write throughput: 25K × 200B = 5 MB/sec

Redis sizing:
- Each driver: ~500 bytes (location + metadata)
- 100K drivers = 50 MB
- Add cell indexes: ~20 MB
- Total: ~100 MB (fits in single Redis instance)

For redundancy: 3-node Redis Cluster

Compute:
- Location Service: 25K req/sec ÷ 5K/instance = 5 instances
- Matching Service: 100 matches/sec ÷ 50/instance = 2 instances
- Add 2x buffer: 14 instances total
```

---

### A42. Matching service failover

**Graceful degradation levels**:

| Level | Trigger | Action |
|---|---|---|
| Normal | Health check passes | Full matching algorithm |
| Degraded | High latency (>500ms) | Simplified scoring (distance only) |
| Emergency | Service unreachable | Direct dispatch (first available driver) |
| Failover | Primary DC down | Route to secondary DC |

```python
async def dispatch_ride_with_fallback(ride_request):
    try:
        # Primary: full matching
        async with timeout(1.0):
            return await matching_service.match(ride_request)
    except TimeoutError:
        logger.warning("Matching service slow, degrading")
    
    try:
        # Fallback: simple nearest driver
        drivers = await get_nearby_drivers(ride_request.pickup)
        return drivers[0] if drivers else None
    except Exception:
        logger.error("Complete matching failure")
        return None
```

---

### A43. Key monitoring metrics

| Metric | Why | Alert Threshold |
|---|---|---|
| Match latency p99 | User experience | > 1 second |
| Match success rate | Rider satisfaction | < 95% |
| Driver location freshness | Stale data = bad matches | > 10 seconds |
| ETA accuracy | Trust metric | > 2 min deviation |
| Surge multiplier | Revenue / rider experience | > 3x for > 30 min |
| WebSocket connections | Tracking capacity | > 80% capacity |
| Trip completion rate | Business health | < 90% |
| Payment failure rate | Revenue leakage | > 1% |

---

### A44. Multi-region deployment

```text
Architecture per region:
┌─────────────────────────────────────────────────────────────┐
│                      US-West Region                          │
│  ┌───────────┐  ┌───────────┐  ┌───────────────────────┐   │
│  │  API GW   │  │  Services │  │  Regional Database    │   │
│  │  (local)  │  │  (local)  │  │  (PostgreSQL + Redis) │   │
│  └───────────┘  └───────────┘  └───────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ Cross-region replication
                            │ (async, for analytics only)
                            ▼
               ┌─────────────────────────────┐
               │    Global Analytics / DW    │
               └─────────────────────────────┘
```

**Key decisions**:
- Location data: **Local only** (no need for cross-region)
- Trips: **Local** (rider and driver in same region)
- User accounts: **Global** (for travelers)
- Payments: **Per-region** (compliance)

---

## Bonus Answers

### QB1. Pool rides (UberPool)

**Changes to matching**:
```python
def match_pool_ride(new_rider, active_pools):
    for pool in active_pools:
        if can_add_rider(pool, new_rider):
            # Check detour time
            detour = calculate_detour(pool.current_route, new_rider)
            if detour < MAX_DETOUR_MINUTES:
                # Check seats available
                if pool.seats_available > 0:
                    pool.add_rider(new_rider)
                    pool.recalculate_route()
                    return pool
    
    # No matching pool, create new ride
    return create_new_pool(new_rider)
```

---

### QB2. ETA prediction

**Inputs**:
- Distance to pickup
- Current traffic conditions (real-time)
- Historical data for route/time
- Current driver speed and direction

**Model**:
```python
def predict_eta(driver, pickup):
    # Base ETA from routing engine
    base_eta = routing_service.get_eta(driver.location, pickup)
    
    # Adjust for traffic
    traffic_factor = traffic_service.get_delay_factor(driver.location, pickup)
    
    # ML correction from historical data
    ml_correction = eta_model.predict(
        features=[
            hour_of_day,
            day_of_week,
            driver.historical_speed,
            route_complexity
        ]
    )
    
    return base_eta * traffic_factor * ml_correction
```

---

### QB3. Fraud detection

| Fraud Type | Detection | Prevention |
|---|---|---|
| GPS spoofing | Impossible jumps, sensor data mismatch | Verify with cell tower data |
| Fake trips | Same rider/driver collusion | Pattern detection, velocity checks |
| Driver-rider collusion | Inflated distances | Compare GPS route to billed route |

---

### QB4. Cash payments

```python
def finalize_cash_trip(trip):
    trip.payment_method = "cash"
    trip.state = "AWAITING_CASH"
    
    # Driver confirms cash received in app
    # Rider prompted to rate
    
    # Uber takes commission from driver's balance
    deduct_from_driver_balance(
        trip.driver_id,
        trip.fare * COMMISSION_RATE
    )
```

---

### QB5. Mass event demand spike

```text
Concert ends at 10 PM
10:00 PM: 50,000 ride requests in 10 minutes

Strategy:
1. Pre-event surge activation (predictive)
2. Notification to drivers: "High demand expected at venue at 10 PM"
3. Queueing: "You're #5,432 in line, estimated wait: 25 min"
4. Staged matching: Process 100 matches/sec, not all at once
5. Alternative: "Take transit" suggestions
```

---

### QB6. Fair dispatch to drivers

```python
def select_driver_fairly(drivers, ride_request):
    # Factor in time since last ride
    for driver in drivers:
        driver.fairness_score = (
            time_since_last_ride(driver) * 0.3 +
            proximity_score(driver, ride_request) * 0.5 +
            rating_score(driver) * 0.2
        )
    
    # Randomize among top candidates to avoid always picking same driver
    top_drivers = sorted(drivers, key=lambda d: d.fairness_score)[:5]
    return random.choice(top_drivers)
```

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Geohash | Encode lat/lng to string; nearby = shared prefix |
| S2 (Google) | Hierarchical cell IDs on sphere |
| H3 (Uber) | Hexagonal grid, uniform distance |
| Location storage | Redis (hot/ephemeral), PostgreSQL (cold/durable) |
| Update rate | 1M drivers × 1/4sec = 250K writes/sec |
| Cell query | Rider's cell + 8 neighbors |
| Matching | Bipartite optimization, not just nearest |
| Offer system | One driver at a time, 15s timeout |
| Trip states | REQUESTED → MATCHED → ARRIVED → IN_PROGRESS → COMPLETED → PAID |
| Real-time tracking | WebSocket + Redis Pub/Sub |
| Surge zones | H3 cells, computed every 30s |
| Surge smoothing | Weighted average with cooldown |
| ETA signals | Distance + traffic + history + ML |
| Batch matching | Global optimization vs greedy |
| WebSocket scale | 50K connections per server |
| Stale threshold | Driver offline after 30s no update |
