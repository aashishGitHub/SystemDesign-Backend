# Health Tracker (Fitbit / MyFitnessPal): Questions & Answers

> 15 questions covering clarification, (a) data model, (b) wearables and real-time insights, (c) data accuracy, and (d) recommendations.
> Try each question before reading its answer. "Repo" lines point to existing notes for going deeper.

---

## Clarify & Architecture

### Q1. What do you clarify first, and what scale do you assume?

- **Who are the users?** Consumers only, or clinical (HIPAA)? This decides compliance and audit scope.
- **What does "real-time" mean?** Live workout screen: seconds, on the phone. Anomaly alert (high heart rate): seconds to a minute. Daily insights: batch.
- **Scale.** State these out loud as assumptions, not facts: ~50M MAU (monthly active users), ~20M wearables, one batch upload per device every ~5 min.
  - 20M / 300s ≈ **~67K batches/sec**, with peaks of ~3× in the morning.
  - A few hundred samples per batch ≈ **~10M+ points/sec** if stored raw. That is why we downsample.
- **The key insight:** food logs are low-volume and high-value per record. Sensor data is the opposite. That asymmetry drives every choice that follows.

---

### Q2. Give the high-level architecture in one breath.

```
Wearable ──BLE──▶ Phone app (local store, batch + retry)
                     │
                     ▼
               Ingest API (auth, validate, dedup) ──▶ Kafka (key = userId)
                                                          │
                      ┌───────────────────────────────────┼──────────────────────┐
                      ▼                                   ▼                      ▼
              Stream processor                    Raw ─▶ Data lake         Doc store
          (rollups, anomalies, goals)            (training, backfill)  (profile, goals, food)
                      │
          ┌───────────┼────────────────┐
          ▼           ▼                ▼
   Time-series DB  DailySummary   Notification svc ──▶ APNs / FCM
                      │
                      ▼
          Feature store ──▶ Recommendation svc
```

- Third-party sources (Apple HealthKit, Google Health Connect, Garmin) come in through a **connector service** and are normalized into the same canonical event (see Q8).
- Repo: `patterns/realtime-updates.md` §2–3, `interviews/ad-click-aggregation/deep-dive.md` §1.

---

## (a) Data Model

### Q3. How do you model user profiles, goals and food logs? Which store?

A **document / KV store** (Couchbase or Postgres). Volume is low, the pattern is read-modify-write, and the data is keyed by user.

```
User     {userId, name, dob, heightCm, units, tz, consent{dataType: bool}, region}
Device   {deviceId, userId, type, firmware, clockOffsetMs, priorityRank, lastSeq}
Goal     {goalId, userId, type: steps|weight|kcal|sleep, target, period, startDate, status, version}
FoodLog  {logId, userId, date, items[{foodId, qty, kcal, macros}], updatedAt(HLC)}
Session  {sessionId, userId, type: run|swim|..., start, end, sourceDeviceId, summary}
FoodCatalog {foodId, name, per100g{kcal, protein, carbs, fat}}   // global, read-heavy, cached
```

- `version` on Goal gives **optimistic concurrency**: an update fails if someone else changed the doc first.
- FoodCatalog is shared and read-heavy, so put it behind a cache/CDN plus a search index for "search food".
- **Couchbase angle (your experience):** the user doc is the key, XDCR (cross-datacenter replication) handles multi-region, and Couchbase Lite on the phone is the offline store.
- Repo: `sync-gateway/sync-gateway.md`, `interviews/sharding-replication/deep-dive.md` §2.

---

### Q4. How do you store health metrics such as heart rate, steps and sleep?

A **time-series store** (Cassandra / TimescaleDB / InfluxDB-class): append-only, very high write volume.

```
raw_samples
  partition key : (userId, metricType, day)
  clustering    : ts
  columns       : value, deviceId, seq, quality
```

- **Why `(userId, metricType, day)`:** queries are always "one user, one metric, a time range". The day bucket bounds partition size, so you never get one unbounded hot row.
- **Rollups:** 1-min → hourly → daily, written by the stream job. The app reads rollups and almost never touches raw data.
- **Retention tiers:** keep raw ~30–90 days, then move it to the lake; keep rollups forever. The numbers are a product choice, so say so.
- **Compaction:** time-window compaction (TWCS) fits data that is written once and expires by time.
- Repo: `patterns/scaling-writes.md` §3, §7, §9; `interviews/kv-store/answers.md` (~line 627, TWCS); `interviews/observability/deep-dive.md` §3 (downsampling).

---

### Q5. The home screen shows "today: steps, kcal in/out, sleep, goal progress". How is that fast?

A precomputed **read model** (CQRS: separate write and read shapes):

```
DailySummary {userId, date, steps, kcalIn, kcalOut, sleepMin, restingHR, goalProgress{goalId: pct}}
```

- The stream processor upserts it whenever a rollup or food log changes.
- One key lookup per screen load (`userId::date`), cached.
- It is **derived**, so it can always be rebuilt from raw data plus logs. That matters for Q11 and Q12.

---

### Q6. Health data is sensitive. How do you handle privacy and "delete my data"?

- **Encryption:** at rest and in transit, plus a **per-user data key** (envelope encryption: a master key in KMS encrypts each user's key).
- **Deletion = crypto-shredding.** Destroy the user's key, and every copy in Kafka, the lake and backups becomes unreadable. You can't realistically rewrite every backup.
- **Consent** is stored per data type (heart rate, location, food). The ingest path drops data types the user hasn't consented to.
- **Residency:** pin a user's data to a region (GDPR).
- **Least privilege:** analytics and ML use pseudonymized IDs.
- Repo coverage is thin here (`interviews/chat-system` encryption sections), so rehearse this one.

---

## (b) Wearables & Real-Time Insights

### Q7. How does data get from a wearable to the cloud?

1. **Device → phone over BLE** (Bluetooth Low Energy). The device keeps a ring buffer, and each sample has a per-device **monotonic `seq`** (a counter that only goes up).
2. The phone asks for everything after `lastSeq`, stores it locally (offline-first), and acks the device so the buffer can be freed.
3. **Phone → cloud:** batched and compressed.
   ```
   POST /v1/ingest
   Idempotency-Key: {deviceId}:{fromSeq}-{toSeq}
   {deviceId, fromSeq, toSeq, deviceTimeAtUpload, samples[]}
   → 202 Accepted
   ```
4. The **Ingest API** authenticates, validates the schema, dedups, writes to Kafka keyed by `userId`, and returns 202.
5. If upload fails, retry with exponential backoff plus jitter. Data is safe on the phone until the server acks.

- **Why batch rather than stream from the device:** battery and cost. The live workout view doesn't need the server, because the phone renders straight from BLE.
- Repo: `interviews/ad-click-aggregation/deep-dive.md` §2–3, `answers.md` A12.

---

### Q8. How do you integrate third-party sources such as Apple Health, Google Health Connect and Garmin?

- A dedicated **connector service**, one adapter per vendor (adapter pattern), so vendor churn is isolated.
- **On-device platforms** (HealthKit, Health Connect) are read by the phone app and uploaded through the same `/ingest` path.
- **Cloud platforms** (e.g. Garmin) use OAuth tokens stored encrypted, plus a webhook or polling. Each payload is normalized into the canonical event `{userId, source, metricType, ts, value, unit}`.
- Treat each source as just another `deviceId` with a `priorityRank`, so the merge logic in Q12 handles it the same way.
- I'm not certain of every vendor's current API surface; verify the vendor docs before the interview.

---

### Q9. How do you produce real-time insights and alerts?

- **Hot path:** Flink / Kafka Streams consuming the ingest topic.
  - **Tumbling 1-min windows** (fixed, non-overlapping) feed the rollups and DailySummary.
  - **Anomaly rules**, for example resting heart rate above a threshold for N minutes, or no movement for X hours.
  - **Goal events**, for example "10K steps reached". Emit once per goal per period, enforced with an idempotency key.
- **Cold path:** raw data goes to the lake for ML training and backfills.
- **Delivery:** the notification service (APNs/FCM) applies user preferences, quiet hours and rate limits. Critical alerts go on a **priority topic** so a backlog of routine nudges can't delay them.
- **Backpressure:** Kafka absorbs the morning sync spike. Insights can tolerate lag; alerts can't, which is why they have their own topic.
- Repo: `interviews/ad-click-aggregation/answers.md` A3, A14; `interviews/notification-system/deep-dive.md` §3, §5, §6.

---

## (c) Data Accuracy

### Q10. The phone retries an upload, or re-syncs the same samples. How do you avoid double counting?

- **Two layers of idempotency:**
  1. Ingest API: dedup on the `Idempotency-Key` (`deviceId + seq range`) in a short-lived store.
  2. Storage: the natural key `(userId, metricType, deviceId, ts)` makes writes **upserts**, so a duplicate overwrites itself.
- Kafka is at-least-once. Exactly-once is achieved as **at-least-once delivery plus an idempotent effect**.
- Repo: `patterns/multi-step-processes.md` §9, `key-technologies-notes.md` §18, `interviews/ad-click-aggregation/answers.md` A4, A19.

---

### Q11. Device clocks drift, and a watch syncs 3 days late. What do you do?

- **Clock correction:** each sync sends `deviceTimeAtUpload`. The server computes `clockOffsetMs = serverTime − deviceTime`, stores it on the Device doc, and corrects sample timestamps.
- **Process on event time, not arrival time.** Watermarks (the stream's "I've probably seen everything up to time T" marker) close windows.
- **Late data** (a 3-day-old batch) doesn't patch the live stream. It triggers **recomputation of only the affected days'** rollups, DailySummary and goal streaks.
- **No stale alerts:** don't fire a "high heart rate" push for an event from 3 days ago; record it in history instead.
- Repo: `key-technologies-notes.md` §15 (HLC), `interviews/ad-click-aggregation/deep-dive.md` §5, `answers.md` A29.

---

### Q12. The watch and phone both count steps for the same walk. How do you merge?

**Never sum.** Pick one source for each time bucket.

- Each user/metric has a **source priority list**, for example `watch > ring > phone`. A sensible default per metric is overridable by the user.
- For each 1-min bucket, take the highest-priority source that has data, and fill gaps from lower-priority sources (for example, the watch was charging).
- **Raw data from every source stays stored and tagged.** The merged series is a **derived view**, so changing the rule means recompute, not data loss.

```java
long mergedSteps(Map<String, Long> stepsByDevice, List<String> priority) {
    for (String deviceId : priority) {
        Long steps = stepsByDevice.get(deviceId);
        if (steps != null) return steps;
    }
    return 0L;
}
```

- The repo has no coverage of this rule; it's the most likely deep-dive, so rehearse it.

---

### Q13. How do you handle bad sensor readings and conflicting user edits?

**Bad readings:**
- **Range checks** (for example HR 25–250 bpm), **rate-of-change checks** (no jump from 60 to 200 in one second), and the device's `quality` flag (poor skin contact).
- **Flag, don't drop.** Keep the raw value with `quality=suspect` and exclude it from rollups. That keeps it auditable and lets you fix the rule later.

**Conflicting edits** (the same food log edited offline on phone and web):
- Scalar fields (weight, goal target): **LWW** (last-write-wins) with an **HLC** (hybrid logical clock), not the raw device clock, which can be skewed.
- List fields (food items in a meal): merge as an **add/remove set** (CRDT-style), so both offline additions survive.
- Goals: `version` check plus retry (optimistic concurrency).

- Repo: `interviews/kv-store/deep-dive.md` §6, `fundamentals/vector-clocks.md`, `key-technologies-notes.md` §16, `interviews/collaborative-editing/deep-dive.md` §3.

---

## (d) Recommendation Engine

### Q14. Design the recommendation engine for fitness plans and diet suggestions.

**Two layers. Rules first, then ML.**

1. **Rules / constraints layer** (deterministic):
   - Daily calorie target from **BMR/TDEE** (basal metabolic rate / total daily energy expenditure) and goal pace; then a macro split.
   - **Hard filters:** allergies, diet type (vegan), equipment available, injuries.
   - **Safety guardrails:** a minimum calorie floor, a maximum weekly weight-loss rate, and exclusions for medical flags. **Guardrails always override ML**; say this explicitly.
2. **ML layer:**
   - **Candidate generation:** content-based (similar to workouts and meals the user completed) plus collaborative filtering (what similar users stuck with).
   - **Ranking** on **predicted adherence** (will they actually do it), not clicks.
   - **Re-rank** for diversity, then re-apply the hard filters.

**Pipelines (CQRS):**
- **Offline/batch nightly:** embeddings, candidate sets, user features → feature store.
- **Online:** reads fresh features (today's kcal left, last night's sleep, 7-day adherence), ranks in under ~100 ms (an assumed latency budget), with a cached result per user.
- **Metrics:** adherence rate, goal completion, 30-day retention.
- Repo: `interviews/recommendation-system/deep-dive.md` §1, §5, §8, §9, §10–11.

---

### Q15. How do plans adapt over time, and what about a brand-new user?

- **Adaptive goals (feedback loop):** track an **EMA** (exponential moving average) of adherence.
  - Two weeks below target → ease the plan (fewer sessions, smaller deficit).
  - Consistently hit → progress it (more volume, next milestone).
  - Weight trend versus plan → recompute the TDEE estimate from observed data.
- **Cold start:** an onboarding questionnaire (goal, level, diet, equipment) plus the plans that worked best for that **cohort** (age band × goal × level). Move to personalized ranking after a few weeks of data.
- **Explainability:** "Lowered your target because you missed 4 of the last 7 days." This builds trust, and in health it is close to mandatory.
- Repo: `interviews/recommendation-system/deep-dive.md` §6 (EMA), §12 (cold start).
