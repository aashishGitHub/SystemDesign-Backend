# Deep Dive: Ride Sharing (Uber / Lyft)

> Three-tiered depth: 🟢 Phone Screen → 🟡 Onsite → 🔴 Staff+ deep dive

---

## Table of Contents

1. [Geospatial Indexing](#1-geospatial-indexing)
2. [Location Updates at Scale](#2-location-updates-at-scale)
3. [Matching Algorithm](#3-matching-algorithm)
4. [Trip Lifecycle & State Machine](#4-trip-lifecycle--state-machine)
5. [Real-Time Tracking](#5-real-time-tracking)
6. [Surge Pricing](#6-surge-pricing)
7. [Production Operations](#7-production-operations)
8. [Real-World Case Studies](#8-real-world-case-studies)
9. [Quick Recall Cheat Sheet](#cheat-sheet)

---

## 1. Geospatial Indexing

### 🟢 Beginner — The Pizza Delivery Grid

Imagine a pizza chain with 1,000 delivery drivers. When you order, they need to find the nearest driver. But checking distance to all 1,000 drivers is slow.

Instead, they overlay a grid on the city map. Each cell is labeled (A1, A2, B1, B2...). When you order from cell B4, they only check drivers in B4 and the 8 cells around it — maybe 20 drivers, not 1,000.

That's exactly what **geohash** does. It divides the planet into cells. Nearby locations get similar labels (both start with "9q8y"). Finding nearby drivers becomes "look in these 9 cells" instead of "check everyone."

---

### 🟡 Senior — Geohash vs S2 vs H3

**Geohash**: Encodes lat/lng into base32 string. Each character adds precision.

```python
import geohash

# Encode location
cell = geohash.encode(37.7749, -122.4194, precision=6)  # "9q8yyk"

# Get neighbors
neighbors = geohash.neighbors("9q8yyk")
# ['9q8yym', '9q8yyt', '9q8yys', '9q8yyw', ...]

# Search nearby drivers
def get_nearby_drivers(rider_lat, rider_lng, redis):
    center_cell = geohash.encode(rider_lat, rider_lng, precision=6)
    cells = [center_cell] + geohash.neighbors(center_cell)
    
    drivers = []
    for cell in cells:
        drivers.extend(redis.smembers(f"drivers:{cell}"))
    
    # Filter by actual distance (geohash is approximate)
    return [d for d in drivers if distance(d, rider) < 2000]
```

**Comparison table**:

| Feature | Geohash | S2 (Google) | H3 (Uber) |
|---|---|---|---|
| Cell shape | Rectangle | Square (on sphere projection) | Hexagon |
| Precision | 1-12 characters | 64-bit ID, 30 levels | 0-15 resolution |
| Edge uniformity | Poor (varies by latitude) | Good | Best |
| Neighbor complexity | 8 neighbors, edge cases | 8 neighbors | 6 neighbors, clean |
| Used by | Many services | Google Maps, S2Geometry | Uber, data science |

**H3 example**:
```python
import h3

# Resolution 9 = ~174m edge length
cell = h3.geo_to_h3(37.7749, -122.4194, resolution=9)

# Get ring of neighbors (radius k=1 = 7 cells)
neighbors = h3.k_ring(cell, k=1)

# Get ring only (not center) — useful for expanding search
ring = h3.hex_ring(cell, k=1)  # Just the 6 surrounding cells
```

---

### 🔴 Architect — Dynamic Precision & Hot Cell Handling

**Problem**: Fixed precision causes issues.

| Area | Issue with precision=6 |
|---|---|
| Manhattan | Cell too large (1.2km), 500 drivers per cell |
| Rural Texas | Cell appropriate, 2 drivers per cell |

**Solution**: Dynamic precision based on density.

```python
class DynamicGeospatialIndex:
    def __init__(self, redis):
        self.redis = redis
        # Pre-computed density zones
        self.density_map = self.load_density_map()
    
    def get_precision(self, lat, lng):
        density = self.density_map.get_zone_density(lat, lng)
        if density > 500:  # High density (downtown)
            return 7  # ~150m cells
        elif density > 100:
            return 6  # ~1.2km cells
        else:
            return 5  # ~5km cells
    
    def update_driver_location(self, driver_id, lat, lng):
        precision = self.get_precision(lat, lng)
        cell = geohash.encode(lat, lng, precision=precision)
        
        # Store driver in cell
        self.redis.sadd(f"drivers:p{precision}:{cell}", driver_id)
        # Also store in lower precisions for fallback
        for p in range(precision - 1, 4, -1):
            coarse_cell = geohash.encode(lat, lng, precision=p)
            self.redis.sadd(f"drivers:p{p}:{coarse_cell}", driver_id)
```

**Hot cell handling** (Super Bowl at stadium):

```python
def handle_hot_cell_query(cell, redis):
    driver_count = redis.scard(f"drivers:{cell}")
    
    if driver_count > 1000:  # Hot cell
        # Sample drivers instead of loading all
        sample = redis.srandmember(f"drivers:{cell}", 100)
        return sample
    
    return redis.smembers(f"drivers:{cell}")
```

**Capacity math**:
```text
Cell at precision 6: ~1.2km × 0.6km ≈ 0.72 km²
Manhattan density: ~5000 drivers/km² at peak
Drivers per cell: 3600

Redis SET operations:
- SADD: O(1)
- SMEMBERS for 3600 items: ~5ms
- Need per-cell rate limiting or sampling
```

---

## 2. Location Updates at Scale

### 🟢 Beginner — The Radio Check-In

Imagine 1,000 taxi drivers, each with a radio. Every few seconds, they report their location to dispatch: "Driver 42, I'm at 5th and Main, heading north."

Dispatch writes it on a big map. When someone needs a taxi, dispatch looks at the map and sees who's nearby.

Uber does this digitally — 1 million drivers sending GPS coordinates every 4 seconds. That's 250,000 "radio check-ins" per second!

---

### 🟡 Senior — The Update Pipeline

```text
┌─────────────────────────────────────────────────────────────────────┐
│              Driver Location Update Pipeline                         │
└─────────────────────────────────────────────────────────────────────┘

Driver App
    │
    ▼ HTTPS POST /driver/location
┌─────────────┐
│ API Gateway │ → Rate limit, authenticate
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ Location Service│ → Validate GPS, detect drift
└──────┬──────────┘
       │
       ├─────────────────────────────────────┐
       ▼                                     ▼
┌─────────────┐                       ┌─────────────┐
│    Redis    │                       │    Kafka    │
│ (live state)│                       │ (analytics) │
└─────────────┘                       └─────────────┘
```

**Location Service implementation**:

```python
from fastapi import FastAPI, Depends
import geohash
import redis
import time

app = FastAPI()
redis_client = redis.Redis()

class LocationUpdate:
    lat: float
    lng: float
    heading: int  # 0-359
    speed: float  # m/s
    accuracy: float  # meters

@app.post("/driver/location")
async def update_location(
    update: LocationUpdate,
    driver_id: str = Depends(get_authenticated_driver)
):
    # 1. Validate update
    if not validate_gps_update(driver_id, update):
        return {"error": "invalid_location"}
    
    # 2. Compute cell
    new_cell = geohash.encode(update.lat, update.lng, precision=6)
    old_cell = redis_client.get(f"driver:{driver_id}:cell")
    
    # 3. Atomic update
    pipe = redis_client.pipeline()
    
    # Move to new cell if changed
    if old_cell and old_cell != new_cell:
        pipe.srem(f"drivers:{old_cell}", driver_id)
    pipe.sadd(f"drivers:{new_cell}", driver_id)
    pipe.set(f"driver:{driver_id}:cell", new_cell)
    
    # Update location details
    pipe.hset(f"driver:{driver_id}", mapping={
        "lat": update.lat,
        "lng": update.lng,
        "heading": update.heading,
        "speed": update.speed,
        "ts": time.time()
    })
    
    pipe.execute()
    
    # 4. Publish for real-time tracking (if on trip)
    trip_id = redis_client.get(f"driver:{driver_id}:trip")
    if trip_id:
        redis_client.publish(f"trip:{trip_id}:location", json.dumps({
            "lat": update.lat,
            "lng": update.lng,
            "heading": update.heading
        }))
    
    return {"ok": True}

def validate_gps_update(driver_id, update):
    old = redis_client.hgetall(f"driver:{driver_id}")
    if not old:
        return True  # First update
    
    # Check for GPS drift (impossible speed)
    old_lat, old_lng = float(old["lat"]), float(old["lng"])
    old_ts = float(old["ts"])
    
    distance = haversine(old_lat, old_lng, update.lat, update.lng)
    time_diff = time.time() - old_ts
    
    if time_diff > 0:
        speed = distance / time_diff
        if speed > 100:  # > 360 km/h
            logger.warning(f"GPS drift: driver={driver_id}, speed={speed}")
            return False
    
    return True
```

---

### 🔴 Architect — Handling 250K Writes/Sec

**Capacity planning**:

```text
Write throughput:
- 1M drivers × 1 update / 4 sec = 250K writes/sec

Redis benchmark:
- Single Redis: ~100K ops/sec (pipelined)
- Need 3 Redis instances minimum
- With replication: 9 Redis instances

Sharding strategy:
- Shard by driver_id hash
- Each shard handles ~85K writes/sec
- Consistent hashing for driver → shard mapping
```

**Redis Cluster configuration**:

```yaml
# redis-cluster.conf
cluster-enabled yes
cluster-node-timeout 5000
cluster-config-file nodes.conf

# Memory optimization
maxmemory 8gb
maxmemory-policy allkeys-lru

# Persistence (optional, locations are ephemeral)
save ""
appendonly no
```

**Failure mode: Redis node failure**

```yaml
# Prometheus alert
- alert: RedisLocationNodeDown
  expr: redis_up{service="location"} == 0
  for: 30s
  labels:
    severity: critical
  annotations:
    summary: "Location Redis node down"
    runbook: |
      1. Check Redis process: systemctl status redis
      2. Check memory: free -m
      3. Failover: redis-cli CLUSTER FAILOVER
      4. If cluster not healing, scale up new node
```

**Graceful degradation**:

```python
class LocationServiceWithFallback:
    def __init__(self, redis_primary, redis_fallback):
        self.primary = redis_primary
        self.fallback = redis_fallback
        self.use_fallback = False
    
    async def update_location(self, driver_id, location):
        try:
            if not self.use_fallback:
                await self.primary.update(driver_id, location)
            else:
                # Degraded: only update driver's own location, not cell index
                await self.fallback.hset(f"driver:{driver_id}", location)
        except RedisError:
            self.use_fallback = True
            logger.error("Primary Redis failed, using fallback")
            metrics.increment("location_service.fallback_activated")
```

---

## 3. Matching Algorithm

### 🟢 Beginner — The Restaurant Host

Imagine a restaurant host seating guests. When a party of 4 arrives, the host doesn't just give them the nearest table — they consider:
- Is it big enough?
- Is it in a good section (well-rated waiter)?
- Is it available soon?

The host "scores" tables and picks the best one. Uber does the same with drivers.

---

### 🟡 Senior — Multi-Factor Scoring

```python
class DriverMatcher:
    def __init__(self, location_service, routing_service):
        self.location_service = location_service
        self.routing_service = routing_service
    
    async def match(self, ride_request: RideRequest) -> Optional[Driver]:
        # 1. Get candidate drivers
        candidates = await self.get_nearby_drivers(
            ride_request.pickup_lat,
            ride_request.pickup_lng,
            radius_km=5
        )
        
        # 2. Filter by hard constraints
        candidates = [
            d for d in candidates
            if d.vehicle_type == ride_request.vehicle_type
            and d.is_available
            and not d.is_suspended
        ]
        
        if not candidates:
            return None
        
        # 3. Score candidates
        scored = []
        for driver in candidates:
            score = await self.score_driver(driver, ride_request)
            scored.append((driver, score))
        
        # 4. Select best
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[0][0]
    
    async def score_driver(self, driver: Driver, request: RideRequest) -> float:
        # ETA score (lower ETA = higher score)
        eta_seconds = await self.routing_service.get_eta(
            driver.lat, driver.lng,
            request.pickup_lat, request.pickup_lng
        )
        eta_score = 1 / (1 + eta_seconds / 300)  # Normalize by 5 minutes
        
        # Distance score
        distance = haversine(
            driver.lat, driver.lng,
            request.pickup_lat, request.pickup_lng
        )
        distance_score = 1 / (1 + distance / 2000)  # Normalize by 2km
        
        # Direction score (is driver heading toward pickup?)
        direction_score = self.compute_direction_alignment(driver, request)
        
        # Driver quality score
        rating_score = driver.rating / 5.0
        acceptance_score = driver.acceptance_rate
        
        # Weighted combination
        return (
            eta_score * 0.35 +
            distance_score * 0.25 +
            direction_score * 0.15 +
            rating_score * 0.15 +
            acceptance_score * 0.10
        )
    
    def compute_direction_alignment(self, driver, request):
        # Bearing from driver to pickup
        desired_heading = calculate_bearing(
            driver.lat, driver.lng,
            request.pickup_lat, request.pickup_lng
        )
        
        # Difference from driver's current heading
        diff = abs(driver.heading - desired_heading)
        if diff > 180:
            diff = 360 - diff
        
        # 0° diff = 1.0, 180° diff = 0.0
        return 1 - (diff / 180)
```

---

### 🔴 Architect — Batch Matching & Global Optimization

**Sequential matching** (naive):
```text
Request 1 arrives → Assign Driver A (nearest)
Request 2 arrives → Assign Driver B (nearest)

But what if Driver A was closer to Request 2, and Driver B to Request 1?
Sequential matching can be suboptimal.
```

**Batch matching** (Uber's approach):

```python
import numpy as np
from scipy.optimize import linear_sum_assignment

class BatchMatcher:
    BATCH_WINDOW_MS = 2000  # Collect requests for 2 seconds
    
    async def match_batch(self, requests: list[RideRequest], drivers: list[Driver]):
        if not requests or not drivers:
            return []
        
        # Build cost matrix
        n_requests = len(requests)
        n_drivers = len(drivers)
        
        # Pad if unequal
        size = max(n_requests, n_drivers)
        cost_matrix = np.full((size, size), 1e9)  # High cost = bad match
        
        for i, request in enumerate(requests):
            for j, driver in enumerate(drivers):
                if self.is_compatible(request, driver):
                    cost_matrix[i][j] = await self.compute_cost(request, driver)
        
        # Hungarian algorithm for optimal assignment
        row_indices, col_indices = linear_sum_assignment(cost_matrix)
        
        # Extract assignments
        assignments = []
        for i, j in zip(row_indices, col_indices):
            if i < n_requests and j < n_drivers:
                if cost_matrix[i][j] < 1e8:  # Valid match
                    assignments.append((requests[i], drivers[j]))
        
        return assignments
    
    async def compute_cost(self, request, driver):
        # Lower cost = better match (invert the score)
        score = await self.score_driver(driver, request)
        return 1 - score
```

**Latency budget**:
```text
Total matching latency target: < 500ms

Breakdown:
- Fetch nearby drivers (Redis): 10ms
- Fetch ETAs (parallel, routing service): 100ms
- Score computation (CPU): 50ms
- Batch optimization (Hungarian): 100ms
- Database write (trip record): 50ms
- Buffer: 190ms
```

**Uber's actual system (Marketplace)**:

```text
Components:
1. Supply Positioning: Predict where drivers should go
2. Dispatch: Match riders to drivers
3. Pricing: Compute surge multiplier
4. Incentives: Bonuses for underserved areas

All integrated into real-time optimization pipeline.
```

---

## 4. Trip Lifecycle & State Machine

### 🟢 Beginner — The Pizza Order Tracker

When you order pizza, you see: "Order received" → "Being prepared" → "Out for delivery" → "Delivered".

A ride has similar stages:
1. **Requested**: You want a ride
2. **Matched**: Driver assigned
3. **Arriving**: Driver heading to you
4. **In Progress**: You're in the car
5. **Completed**: You arrived
6. **Paid**: Money transferred

Each step can fail, and the system needs rules for what happens then.

---

### 🟡 Senior — State Machine Implementation

```python
from enum import Enum
from typing import Optional
from datetime import datetime

class TripState(Enum):
    REQUESTED = "requested"
    MATCHING = "matching"
    MATCHED = "matched"
    DRIVER_ARRIVING = "driver_arriving"
    ARRIVED = "arrived"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    PAYMENT_PENDING = "payment_pending"
    PAID = "paid"
    PAYMENT_FAILED = "payment_failed"

class TripEvent(Enum):
    MATCH_FOUND = "match_found"
    MATCH_TIMEOUT = "match_timeout"
    DRIVER_ACCEPTED = "driver_accepted"
    DRIVER_ARRIVED = "driver_arrived"
    TRIP_STARTED = "trip_started"
    TRIP_ENDED = "trip_ended"
    RIDER_CANCELLED = "rider_cancelled"
    DRIVER_CANCELLED = "driver_cancelled"
    PAYMENT_SUCCESS = "payment_success"
    PAYMENT_FAILED = "payment_failed"

class TripStateMachine:
    TRANSITIONS = {
        TripState.REQUESTED: {
            TripEvent.MATCH_FOUND: TripState.MATCHING,
            TripEvent.MATCH_TIMEOUT: TripState.CANCELLED,
            TripEvent.RIDER_CANCELLED: TripState.CANCELLED,
        },
        TripState.MATCHING: {
            TripEvent.DRIVER_ACCEPTED: TripState.MATCHED,
            TripEvent.MATCH_TIMEOUT: TripState.CANCELLED,
            TripEvent.RIDER_CANCELLED: TripState.CANCELLED,
        },
        TripState.MATCHED: {
            TripEvent.DRIVER_ARRIVED: TripState.ARRIVED,
            TripEvent.RIDER_CANCELLED: TripState.CANCELLED,
            TripEvent.DRIVER_CANCELLED: TripState.CANCELLED,
        },
        TripState.ARRIVED: {
            TripEvent.TRIP_STARTED: TripState.IN_PROGRESS,
            TripEvent.RIDER_CANCELLED: TripState.CANCELLED,
        },
        TripState.IN_PROGRESS: {
            TripEvent.TRIP_ENDED: TripState.COMPLETED,
        },
        TripState.COMPLETED: {
            TripEvent.PAYMENT_SUCCESS: TripState.PAID,
            TripEvent.PAYMENT_FAILED: TripState.PAYMENT_FAILED,
        },
        TripState.PAYMENT_FAILED: {
            TripEvent.PAYMENT_SUCCESS: TripState.PAID,
        },
    }
    
    def transition(self, trip: Trip, event: TripEvent) -> Trip:
        current_state = trip.state
        
        if current_state not in self.TRANSITIONS:
            raise InvalidStateError(f"No transitions from {current_state}")
        
        if event not in self.TRANSITIONS[current_state]:
            raise InvalidTransitionError(f"Cannot {event} from {current_state}")
        
        new_state = self.TRANSITIONS[current_state][event]
        
        # Execute side effects
        self._execute_transition_effects(trip, current_state, new_state, event)
        
        trip.state = new_state
        trip.updated_at = datetime.utcnow()
        
        return trip
    
    def _execute_transition_effects(self, trip, old_state, new_state, event):
        if new_state == TripState.MATCHED:
            # Notify rider
            send_notification(trip.rider_id, "Driver on the way!")
            # Start ETA tracking
            start_eta_updates(trip.id)
        
        elif new_state == TripState.CANCELLED:
            if event == TripEvent.RIDER_CANCELLED and old_state == TripState.MATCHED:
                # Charge cancellation fee
                charge_cancellation_fee(trip)
            elif event == TripEvent.DRIVER_CANCELLED:
                # Penalize driver, re-dispatch
                penalize_driver(trip.driver_id)
                redispatch(trip)
        
        elif new_state == TripState.COMPLETED:
            # Calculate fare
            trip.fare = calculate_fare(trip)
            # Process payment
            process_payment_async(trip)
```

---

### 🔴 Architect — Handling Edge Cases & Failures

**Edge case: Driver no-show**

```python
class DriverArrivalMonitor:
    NO_SHOW_TIMEOUT_MINUTES = 10
    
    async def monitor(self, trip: Trip):
        deadline = trip.matched_at + timedelta(minutes=self.NO_SHOW_TIMEOUT_MINUTES)
        
        while datetime.utcnow() < deadline:
            await asyncio.sleep(30)
            
            # Check if driver arrived
            trip = await self.trip_repo.get(trip.id)
            if trip.state == TripState.ARRIVED:
                return  # Success
            
            # Check driver location
            driver_location = await self.location_service.get(trip.driver_id)
            distance_to_pickup = haversine(
                driver_location.lat, driver_location.lng,
                trip.pickup_lat, trip.pickup_lng
            )
            
            if distance_to_pickup < 50:  # meters
                # Driver is there but didn't mark arrival
                await self.trip_service.transition(trip, TripEvent.DRIVER_ARRIVED)
                return
        
        # Timeout reached
        logger.warning(f"Driver no-show for trip {trip.id}")
        await self.handle_no_show(trip)
    
    async def handle_no_show(self, trip: Trip):
        # Mark driver as unavailable
        await self.driver_service.mark_offline(trip.driver_id)
        
        # Penalize driver
        await self.driver_service.record_no_show(trip.driver_id)
        
        # Notify rider
        await self.notification_service.send(
            trip.rider_id,
            "Your driver couldn't make it. Finding another driver..."
        )
        
        # Re-dispatch
        await self.dispatch_service.redispatch(trip)
```

**Edge case: Payment retry**

```python
class PaymentRetryWorker:
    MAX_RETRIES = 3
    RETRY_DELAYS = [60, 300, 1800]  # 1 min, 5 min, 30 min
    
    async def process_payment(self, trip: Trip):
        for attempt in range(self.MAX_RETRIES):
            try:
                result = await self.payment_service.charge(
                    customer_id=trip.rider.stripe_id,
                    amount_cents=trip.fare_cents,
                    idempotency_key=f"trip_{trip.id}_payment"
                )
                
                await self.trip_service.transition(trip, TripEvent.PAYMENT_SUCCESS)
                return
                
            except PaymentDeclinedError:
                logger.warning(f"Payment declined for trip {trip.id}, attempt {attempt + 1}")
                
                if attempt < self.MAX_RETRIES - 1:
                    await asyncio.sleep(self.RETRY_DELAYS[attempt])
                    # Try alternate payment method
                    if attempt == 1:
                        trip.payment_method = trip.rider.backup_payment_method
        
        # All retries failed
        await self.trip_service.transition(trip, TripEvent.PAYMENT_FAILED)
        await self.suspend_rider_for_payment(trip.rider_id)
```

---

## 5. Real-Time Tracking

### 🟢 Beginner — The Domino's Pizza Tracker

Remember watching your pizza dot move on the map? That's real-time tracking. The delivery driver's tablet sends location updates, and your phone receives them to move the dot.

Uber does the same — the driver's phone sends GPS, and your app gets updates to show the car moving on the map.

---

### 🟡 Senior — WebSocket Architecture

```python
# WebSocket server for ride tracking
import asyncio
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import aioredis

app = FastAPI()

class TrackingManager:
    def __init__(self):
        self.connections: dict[str, WebSocket] = {}  # trip_id -> websocket
        self.redis = None
    
    async def connect(self, trip_id: str, websocket: WebSocket):
        await websocket.accept()
        self.connections[trip_id] = websocket
        
        # Subscribe to trip updates
        asyncio.create_task(self.subscribe_to_trip(trip_id, websocket))
    
    async def subscribe_to_trip(self, trip_id: str, websocket: WebSocket):
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(f"trip:{trip_id}:location")
        
        try:
            async for message in pubsub.listen():
                if message["type"] == "message":
                    await websocket.send_json(json.loads(message["data"]))
        except WebSocketDisconnect:
            pass
        finally:
            await pubsub.unsubscribe(f"trip:{trip_id}:location")
    
    def disconnect(self, trip_id: str):
        self.connections.pop(trip_id, None)

manager = TrackingManager()

@app.on_event("startup")
async def startup():
    manager.redis = await aioredis.from_url("redis://localhost")

@app.websocket("/track/{trip_id}")
async def track_trip(websocket: WebSocket, trip_id: str):
    # Authenticate
    trip = await get_trip(trip_id)
    if not trip or trip.rider_id != websocket.user_id:
        await websocket.close(code=4003)
        return
    
    await manager.connect(trip_id, websocket)
    
    # Send initial state
    driver_location = await get_driver_location(trip.driver_id)
    await websocket.send_json({
        "type": "sync",
        "driver_location": driver_location,
        "trip_state": trip.state,
        "eta_seconds": trip.eta_seconds
    })
    
    try:
        while True:
            # Keep connection alive
            data = await websocket.receive_text()
            # Handle any client messages (ping/pong)
    except WebSocketDisconnect:
        manager.disconnect(trip_id)
```

---

### 🔴 Architect — Scaling to Millions of Connections

**Architecture**:

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    Real-Time Tracking Architecture                   │
└─────────────────────────────────────────────────────────────────────┘

                         ┌─────────────────────────┐
                         │     Load Balancer       │
                         │  (sticky by trip_id)    │
                         └───────────┬─────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌───────────────┐          ┌───────────────┐          ┌───────────────┐
│  WS Server 1  │          │  WS Server 2  │          │  WS Server N  │
│  (50K conns)  │          │  (50K conns)  │          │  (50K conns)  │
└───────┬───────┘          └───────┬───────┘          └───────┬───────┘
        │                          │                          │
        └──────────────────────────┼──────────────────────────┘
                                   ▼
                         ┌─────────────────────────┐
                         │      Redis Pub/Sub      │
                         │    (message broker)     │
                         └───────────┬─────────────┘
                                     │
                         ┌───────────┴─────────────┐
                         │    Location Service     │
                         │  (publishes updates)    │
                         └─────────────────────────┘
```

**Connection scaling math**:
```text
Active trips: 100K concurrent
Connections per trip: 1 rider + 0.5 watchers = 1.5
Total connections: 150K

Connections per server: 50K (tuned Linux + epoll)
Servers needed: 3 + 50% buffer = 5 WebSocket servers
```

**Server tuning**:
```bash
# /etc/sysctl.conf
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
fs.file-max = 1000000

# /etc/security/limits.conf
* soft nofile 1000000
* hard nofile 1000000
```

**Graceful degradation**:
```python
class TrackingServiceWithDegradation:
    MAX_CONNECTIONS_PER_SERVER = 50000
    
    async def connect(self, trip_id, websocket):
        current_connections = len(self.connections)
        
        if current_connections > self.MAX_CONNECTIONS_PER_SERVER:
            # Reject new connections, suggest polling
            await websocket.send_json({
                "error": "server_busy",
                "fallback": f"/api/trip/{trip_id}/location"
            })
            await websocket.close()
            return
        
        await self.manager.connect(trip_id, websocket)
```

---

## 6. Surge Pricing

### 🟢 Beginner — Concert Tickets Economics

When Taylor Swift concert tickets go on sale, prices skyrocket because everyone wants them but supply is limited. Uber surge pricing works the same way.

When it's raining and everyone wants a ride, but few drivers are available, prices go up. This does two things:
1. Some riders decide to wait (reduces demand)
2. More drivers come online (increases supply)

Eventually, supply and demand balance.

---

### 🟡 Senior — Surge Computation

```python
class SurgeService:
    def __init__(self, redis, h3_resolution=7):
        self.redis = redis
        self.h3_resolution = h3_resolution  # ~5km² cells
    
    async def compute_surge(self, zone_id: str) -> float:
        # Get supply (available drivers in zone)
        supply = await self.get_driver_count(zone_id)
        
        # Get demand (requests in last 5 minutes)
        demand = await self.get_request_count(zone_id, minutes=5)
        
        # Compute ratio
        if supply == 0:
            ratio = float('inf')
        else:
            ratio = demand / supply
        
        # Map to multiplier
        return self.ratio_to_multiplier(ratio)
    
    def ratio_to_multiplier(self, ratio: float) -> float:
        # Piecewise linear mapping
        if ratio <= 1.0:
            return 1.0  # No surge
        elif ratio <= 1.5:
            return 1.0 + (ratio - 1.0) * 0.4  # 1.0 - 1.2
        elif ratio <= 2.0:
            return 1.2 + (ratio - 1.5) * 0.6  # 1.2 - 1.5
        elif ratio <= 3.0:
            return 1.5 + (ratio - 2.0) * 1.0  # 1.5 - 2.5
        else:
            return min(2.5 + (ratio - 3.0) * 0.5, 5.0)  # Cap at 5.0
    
    async def update_all_zones(self):
        """Background job runs every 30 seconds"""
        active_zones = await self.get_active_zones()
        
        for zone_id in active_zones:
            surge = await self.compute_surge(zone_id)
            
            # Smoothing to prevent oscillation
            old_surge = await self.redis.get(f"surge:{zone_id}") or 1.0
            smoothed = old_surge * 0.6 + surge * 0.4
            
            await self.redis.set(f"surge:{zone_id}", smoothed, ex=120)
```

---

### 🔴 Architect — Anti-Oscillation & Fraud Prevention

**Oscillation prevention**:

```python
class SurgeStabilizer:
    SMOOTHING_FACTOR = 0.4  # New surge weight
    COOLDOWN_MINUTES = 5     # Min time before reducing surge
    HYSTERESIS = 0.2         # Must drop 20% to reduce
    
    async def stabilize_surge(self, zone_id: str, computed_surge: float) -> float:
        surge_state = await self.get_surge_state(zone_id)
        old_surge = surge_state.multiplier
        
        # Smoothing
        smoothed = old_surge * (1 - self.SMOOTHING_FACTOR) + computed_surge * self.SMOOTHING_FACTOR
        
        # Cooldown: don't reduce if recent spike
        if smoothed < old_surge:
            if surge_state.last_spike and (now() - surge_state.last_spike).minutes < self.COOLDOWN_MINUTES:
                return old_surge  # Maintain
            
            # Hysteresis: only reduce if significant drop
            if (old_surge - smoothed) / old_surge < self.HYSTERESIS:
                return old_surge  # Maintain
        
        # Track spike
        if smoothed > old_surge * 1.2:
            surge_state.last_spike = now()
        
        return smoothed
```

**Fraud detection**:

```python
class SurgeFraudDetector:
    async def detect_gaming(self, driver_id: str) -> bool:
        # Get driver's online events from last 30 days
        events = await self.get_driver_online_events(driver_id, days=30)
        
        if len(events) < 10:
            return False  # Not enough data
        
        surge_online_count = 0
        for event in events:
            zone_surge = await self.get_historical_surge(event.zone_id, event.timestamp)
            if zone_surge > 1.5:
                surge_online_count += 1
        
        ratio = surge_online_count / len(events)
        
        if ratio > 0.7:  # 70%+ online during surge
            logger.warning(f"Potential surge gaming: driver={driver_id}, ratio={ratio}")
            return True
        
        return False
    
    async def penalize_surge_gamer(self, driver_id: str):
        # Reduce priority in matching for 7 days
        await self.driver_service.apply_penalty(
            driver_id,
            penalty_type="match_priority",
            factor=0.5,
            duration_days=7
        )
```

---

## 7. Production Operations

### 🟢 Beginner — The Air Traffic Control Room

Running Uber is like managing a busy airport. Thousands of "planes" (cars) moving constantly. Controllers (ops engineers) watch screens with metrics. If something goes wrong (storm, runway closure), they have procedures.

Key things to watch:
- How many "planes" in the air (active trips)
- Any "planes" circling (long ETAs, failed matches)
- Airport capacity (server load)

---

### 🟡 Senior — Monitoring Dashboard

```yaml
# Grafana dashboard panels for ride-sharing

panels:
  - title: "Active Trips"
    query: sum(trips_active)
    alert: sudden drop > 20%
  
  - title: "Match Latency p99"
    query: histogram_quantile(0.99, rate(match_latency_bucket[5m]))
    alert: > 1000ms
  
  - title: "Match Success Rate"
    query: rate(matches_successful[5m]) / rate(matches_attempted[5m])
    alert: < 95%
  
  - title: "Driver Location Freshness"
    query: avg(time() - driver_location_updated_at)
    alert: > 10 seconds
  
  - title: "WebSocket Connections"
    query: sum(websocket_connections)
    alert: capacity > 80%
  
  - title: "Payment Failure Rate"
    query: rate(payments_failed[5m]) / rate(payments_attempted[5m])
    alert: > 2%
  
  - title: "ETA Accuracy"
    query: avg(abs(actual_pickup_time - predicted_eta))
    alert: > 3 minutes
```

---

### 🔴 Architect — Incident Response Playbooks

**Incident: Matching service latency spike**

```markdown
## Runbook: Matching Latency > 1 second

### Symptoms
- Match latency p99 > 1000ms
- Rider complaints: "App is slow"
- Increased cancelled requests

### Immediate Actions
1. Check matching service health:
   kubectl get pods -l app=matching-service
   kubectl top pods -l app=matching-service

2. Check Redis (location data):
   redis-cli INFO | grep used_memory
   redis-cli INFO | grep connected_clients

3. Check routing service (ETA computation):
   curl -w "%{time_total}" http://routing-service/health

4. If Redis overloaded:
   - Scale up Redis replicas
   - Enable circuit breaker on non-critical data

5. If routing slow:
   - Fallback to distance-based matching
   - Disable real-time traffic consideration

### Recovery Verification
- Match latency p99 < 500ms
- Match success rate > 98%
```

**Disaster recovery: Multi-region failover**

```text
Normal operation:
  Users in US-West → US-West services
  Users in US-East → US-East services

US-West failure:
  1. Health checks fail for 30 seconds
  2. DNS failover triggered (Route53 health check)
  3. US-West traffic routed to US-East
  4. US-East auto-scales to handle load
  5. Capacity: US-East handles 2x normal load

Data considerations:
  - Location data: No replication needed (ephemeral)
  - Trip data: Active trips may be disrupted
  - User data: Replicated cross-region (eventual consistency)
```

---

## 8. Real-World Case Studies

### Uber's H3 Geospatial System

**Challenge**: Geohash rectangles have uneven areas at different latitudes. Makes surge pricing unfair.

**Solution**: H3 hexagonal grid (open-sourced by Uber).

```python
import h3

# Benefits of hexagons:
# 1. Uniform distance from center to any edge
# 2. Only 6 neighbors (simpler than 8)
# 3. Hierarchical (resolution 0-15)

# Uber uses resolution 7 for surge (~5km²)
cell = h3.geo_to_h3(37.7749, -122.4194, resolution=7)

# Get parent/child cells for drill-down
parent = h3.h3_to_parent(cell, resolution=6)
children = h3.h3_to_children(cell, resolution=8)
```

**Impact**: 15% more accurate surge pricing, better driver utilization.

---

### Lyft's Matching Algorithm Evolution

**2012**: Nearest driver wins.
**2014**: ETA-based matching (with traffic).
**2016**: Multi-factor scoring (rating, acceptance rate).
**2018**: Batch matching (global optimization every 2 seconds).
**2020**: ML-based matching (predicting rider satisfaction).

**Key insight**: Moving from greedy to batch matching improved driver utilization by 10%.

---

### Uber's Ringpop: Consistent Hashing for Services

**Problem**: How to route requests to the right service instance when you have 1000 matching service instances?

**Solution**: Ringpop — consistent hashing ring for service discovery.

```text
Requests for zone "sf_downtown" always go to same set of instances
  → Better cache locality
  → Fewer Redis lookups

When instance fails:
  → Requests reroute to next instance on ring
  → Automatic rebalancing
```

---

## Quick Recall Cheat Sheet {#cheat-sheet}

| Concept | One-Line Recall |
|---|---|
| Geohash | Encode lat/lng to string; nearby = shared prefix |
| S2 | Google's spherical cell system, 64-bit IDs |
| H3 | Uber's hexagonal grid, uniform distance |
| Cell query | Center cell + neighbors (8 for square, 6 for hex) |
| Location update rate | 1M drivers × 1/4sec = 250K writes/sec |
| Location storage | Redis (ephemeral), PostgreSQL (durable) |
| Stale threshold | Mark offline after 30s no update |
| Matching | Score = ETA + distance + direction + rating + acceptance |
| Batch matching | Collect 2s, Hungarian algorithm, global optimum |
| Offer timeout | 15 seconds per driver, then next candidate |
| Trip states | REQUESTED → MATCHED → ARRIVED → IN_PROGRESS → COMPLETED → PAID |
| Real-time tracking | WebSocket + Redis Pub/Sub |
| WebSocket scale | 50K connections per server |
| Surge zones | H3 resolution 7 (~5km²) |
| Surge computation | Every 30s: demand/supply ratio → multiplier |
| Surge smoothing | new = old × 0.6 + computed × 0.4 |
| Surge cap | 5.0x maximum |
| Match latency target | < 500ms p99 |
| ETA accuracy target | < 2 min deviation |
| Driver no-show timeout | 10 minutes |
| Payment retry | 3 attempts with backoff |
