# Interview Questions: Ride Sharing (Uber / Lyft)

> Attempt each question before reading [answers.md](./answers.md).
> Questions progress from fundamentals to Google Staff-level depth.

---

## Level 1 — Core Problem (Beginner)
*Understanding why ride-sharing is hard before jumping to solutions*

**Q1.** A rider opens the Uber app and requests a ride. What are the core steps the system must perform between request and driver arrival?

**Q2.** Why can't you just store all driver locations in a PostgreSQL table and query `SELECT * FROM drivers WHERE distance(lat, lng, rider_lat, rider_lng) < 2km`?

**Q3.** Uber has 1 million active drivers. Each sends GPS coordinates every 4 seconds. What's the write throughput in updates per second? Why is this problematic for traditional databases?

**Q4.** What's the difference between "nearest driver" and "best driver"? Why might the nearest driver not be the best match?

**Q5.** If the ride matching system goes down for 2 minutes, what happens to riders and drivers? Why is availability critical for this system?

---

## Level 2 — Geospatial Indexing
*How to efficiently query "drivers within X kilometers"*

**Q6.** Explain what a geohash is. How does it convert a (latitude, longitude) pair into a string like "9q8yyk"?

**Q7.** If you're using geohash with 6-character precision (~1.2km × 0.6km cells), how do you find all drivers within 2km of a rider?

**Q8.** What's the "edge problem" with geohash queries? A rider is at the corner of cell A — how do you avoid missing drivers in adjacent cell B?

**Q9.** Compare geohash, S2 (Google), and H3 (Uber). What are the key differences, and when would you choose each?

**Q10.** How would you store driver locations indexed by geohash in Redis? What data structure would you use?

**Q11.** A rider is in downtown Manhattan (very dense). A rider is in rural Texas (very sparse). Should you use the same geohash precision for both? Why or why not?

---

## Level 3 — Location Updates at Scale
*Handling 250K GPS updates per second*

**Q12.** Design the driver location update flow. What happens when a driver's phone sends GPS coordinates every 4 seconds?

**Q13.** Should driver locations be stored in PostgreSQL, Redis, or both? What's the tradeoff?

**Q14.** What happens if a driver's phone loses connectivity for 30 seconds? How does the system handle stale location data?

**Q15.** How do you detect and handle GPS drift (driver appears to teleport across the city)?

**Q16.** The driver app sends coordinates. Should it send every GPS reading or batch updates? What are the tradeoffs?

**Q17.** How do you handle the "thundering herd" when 100K drivers all come online at 8 AM in a city?

---

## Level 4 — Matching Algorithm
*Finding the best driver, not just the closest*

**Q18.** You have 50 available drivers near a rider. How do you score them to find the best match?

**Q19.** Define the matching problem formally. What inputs do you have, what constraints, what objective function?

**Q20.** Driver A is 500m away but driving in the opposite direction. Driver B is 1km away but heading toward the rider. Which has lower ETA?

**Q21.** How do you incorporate driver ratings, acceptance rates, and vehicle type into matching?

**Q22.** Uber matches multiple riders and drivers simultaneously (batch matching). Why is this better than matching one at a time?

**Q23.** What's the "offer" system? Why does Uber send a ride request to one driver at a time rather than broadcasting to all nearby drivers?

**Q24.** A driver gets a ride offer and has 15 seconds to accept. What happens if they don't respond? How do you handle the timeout?

---

## Level 5 — Trip State Machine
*From request to completion — modeling the ride lifecycle*

**Q25.** Draw the state machine for a trip. What are the states, and what events trigger transitions?

**Q26.** What happens if a rider cancels after a driver is assigned but before pickup? What about after pickup?

**Q27.** How do you handle driver no-shows? The driver accepts but never arrives at the pickup point.

**Q28.** The payment fails after the trip completes. How do you handle this? What state does the trip end in?

**Q29.** How do you store trip history? What's the access pattern — read-heavy? Write-heavy? What database would you use?

**Q30.** A rider disputes a fare ("I was charged for a longer route"). How does the system support fare disputes with trip data?

---

## Level 6 — Real-Time Tracking
*WebSockets for live location updates*

**Q31.** During a trip, the rider watches the driver's car move on the map. How is this real-time tracking implemented?

**Q32.** Compare WebSockets, SSE, and polling for real-time driver tracking. Which would you use?

**Q33.** How do you scale WebSocket connections to 1 million concurrent riders tracking their rides?

**Q34.** A rider's WebSocket disconnects during the trip. When they reconnect, how do they resume tracking?

**Q35.** How do you reduce the data sent over WebSockets? A driver sends coordinates every 4s but the map doesn't need that precision.

---

## Level 7 — Surge Pricing
*Dynamic pricing based on supply and demand*

**Q36.** Explain surge pricing conceptually. What inputs determine the surge multiplier (1.0x, 1.5x, 2.5x)?

**Q37.** How do you define "zones" for surge pricing? Why not compute surge per-ride on demand?

**Q38.** New Year's Eve: demand spikes 10x at midnight. How does the surge system respond in real-time?

**Q39.** How do you prevent surge pricing from oscillating? (Price goes up → riders cancel → price drops → riders request → price goes up...)

**Q40.** How would you detect and prevent "surge fraud" — drivers who wait for surge before going online?

---

## Level 8 — Production Operations (Architect / Staff)
*Capacity planning, failure modes, monitoring, scaling*

**Q41.** Estimate the storage and compute needed for driver location service in a city with 100K active drivers.

**Q42.** The matching service goes down. What's your failover strategy? How do you degrade gracefully?

**Q43.** What are the key metrics you'd monitor for the ride-sharing platform? Name at least 6 with why each matters.

**Q44.** Uber operates in 50+ countries with different regulations. How do you architect for multi-region deployment?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** How do you handle "pool" rides (UberPool/Lyft Line) where multiple riders share a vehicle? What changes in the matching algorithm?

**QB2.** How does Uber predict ETA? What signals are used, and how accurate does it need to be?

**QB3.** How do you handle driver fraud — fake trips, GPS spoofing, collusion between rider and driver?

**QB4.** How does Uber handle cash payments in markets like India where credit cards aren't common?

**QB5.** A major event (concert, sports game) ends and 50,000 people request rides simultaneously. How do you handle this demand spike?

**QB6.** How do you design the dispatch system to be fair to drivers? (Avoid sending all rides to the same driver.)
