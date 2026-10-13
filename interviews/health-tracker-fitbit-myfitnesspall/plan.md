# Health Tracker HLD (Fitbit / MyFitnessPal): 30-minute senior talk guide

## Context
This is interview prep for the prompt "Design a health tracking app" with sub-questions (a) data model, (b) wearables and real-time insights, (c) data accuracy across devices, (d) recommendations. The repo has no worked health or fitness design, but the building blocks already exist. This guide maps each sub-question to the repo notes to revise, and gives a timed talk track. Paths are relative to `SystemDesign-Backend/`.

---

## Timeline (30 min)

| Min | Block | Goal |
|---|---|---|
| 0–4 | Clarify and scope | Requirements, scale, what "real-time" means |
| 4–8 | High-level architecture | One diagram: device → phone gateway → ingest → stream → stores → insights/reco |
| 8–14 | (a) Data model | Split by access pattern: OLTP docs versus time series |
| 14–20 | (b) Wearables and real-time insights | Ingest path, hot/cold split, push |
| 20–25 | (c) Data accuracy | Dedup, clocks, overlapping sources, bad readings |
| 25–29 | (d) Recommendation engine | Rules plus ML, two pipelines, cold start, guardrails |
| 29–30 | Wrap-up | Trade-offs and what you'd do next |

---

## 0–4: Clarify (ask these and don't skip them)
- Who are the users? Consumers only, or clinical / HIPAA-scoped? This decides compliance and audit needs.
- Scale assumption, to state out loud and label as an assumption: about 50M MAU (monthly active users), about 20M wearables. A wearable syncs a batch every few minutes, and heart rate is sampled at about 1 Hz on the device but uploaded batched.
  - Back-of-envelope estimate: 20M devices × 1 batch per 5 min ≈ 67K batches/sec, with peaks around 3× that. Each batch holds a few hundred samples, so ≈ 10M+ points/sec into the time-series DB if stored raw. That is why we downsample.
- "Real-time" for whom? Live workout screen (seconds), anomaly alert such as a high heart rate (seconds to a minute), daily insights (batch).
- Food logging is user-entered, low volume and high value. Sensor data is the opposite: high volume, low value per point. **This asymmetry drives the whole design**, so say it explicitly.

## 4–8: Architecture (say it in one sentence first)
"Device → phone app as the BLE gateway (BLE = Bluetooth Low Energy) with a local store → batched upload to an Ingest API (idempotent) → Kafka → stream processors (aggregate, detect anomalies) → time-series store plus a profile/goal doc store → insight and notification service → recommendation service fed by a feature store."
- Third-party sources (Apple HealthKit, Google Health Connect, Garmin) arrive through a separate connector service: OAuth tokens, webhooks or polling, then normalized into the same canonical event. You may want to verify current vendor API names before the interview; they change.
- Repo: `patterns/realtime-updates.md` §2–3, `interviews/ad-click-aggregation/deep-dive.md` §1 (hot/cold path).

## 8–14: (a) Data model
Split it into two stores by access pattern. That split is the senior point.

**Doc / OLTP store** (Couchbase or Postgres): low volume, read-modify-write.
- `User {userId, profile, units, tz, privacy/consent flags}`
- `Device {deviceId, userId, type, firmware, clockOffsetMs, priorityRank, lastSyncCursor}`
- `Goal {goalId, userId, type(steps|weight|calories|sleep), target, period, startDate, status, version}`
- `FoodLog {logId, userId, date, items[{foodId, qty, macros}], source}` + `FoodCatalog` (global, read-heavy, cacheable)
- `Workout/ActivitySession {sessionId, userId, type, start, end, sourceDeviceId, summary}`

**Time-series store** (Cassandra / TimescaleDB / InfluxDB-class): append-only, very high write volume.
- Raw sample: partition key `(userId, metricType, day)`, clustering by `ts`. Fields: `value, deviceId, seq, quality`.
- Rollups: 1-min → hourly → daily tables, built by the stream job. The app reads rollups, almost never raw data.
- Retention tiers: raw for about 30–90 days, rollups kept forever. The retention numbers are a design choice; say so.
- Why partition by userId+day: it bounds partition size and avoids one hot unbounded row. Repo: `patterns/scaling-writes.md` §3, §7, §9 and line ~451 (`hash(tenant)+timestamp`); `interviews/kv-store/answers.md` ~627 (TWCS compaction for time series).

**Derived**: `DailySummary {userId, date, steps, kcalIn, kcalOut, sleepMin, restingHR, goalProgress}`. This is what the home screen reads. It is a CQRS read model (separate write and read shapes).

**Privacy**: health data is PII (personally identifiable information). Use per-user encryption keys so crypto-shredding can delete a user. Keep consent per data type and region pinning (GDPR). Repo has this only lightly (`interviews/chat-system` encryption sections), so prep it.

Couchbase angle (your real experience): user and goal docs in a KV store with XDCR (cross-datacenter replication) for multi-region; Couchbase Lite on the phone for the local store. Repo: `sync-gateway/sync-gateway.md`.

## 14–20: (b) Wearables and real-time insights
- **Device → phone**: BLE sync. The device keeps a ring buffer with a monotonic `seq` per device. The phone pulls everything after `lastSeq`.
- **Phone → cloud**: batched upload, `POST /ingest {deviceId, batchId, fromSeq, toSeq, samples[]}`, compressed. Offline-first: the local DB queues batches and retries with backoff.
- **Ingest API**: auth, schema validation, dedup on `(deviceId, batchId)`, write to Kafka partitioned by `userId`. That keeps per-user ordering and lets one consumer own a user's state. Repo: `ad-click-aggregation/deep-dive.md` §2–3, `answers.md` A12 (idempotent retries from a mobile client).
- **Hot path** (Flink / Kafka Streams): windowed aggregates (tumbling 1-min windows), anomaly rules (resting HR above threshold for N minutes, no movement for X hours), goal-crossing events. Repo: `ad-click-aggregation/answers.md` A3 (windows), deep-dive §5 (watermarks).
- **Cold path**: raw data goes to object storage / a data lake for ML training and backfills.
- **Push to user**: live workout uses a WebSocket or BLE directly on the phone (no server round trip). Alerts and nudges go through the notification service (APNs/FCM) with user preferences, quiet hours and idempotency keys. Repo: `patterns/realtime-updates.md` §2, `interviews/notification-system/deep-dive.md` §3, §5, §6.
- **Backpressure**: the Kafka buffer absorbs the morning sync spike; insights tolerate lag, alerts get a priority topic. Repo: `ad-click-aggregation/answers.md` A14.
- Analogy to cite: high-frequency device updates look like the ride-sharing location stream (`interviews/ride-sharing/deep-dive.md` §2).

## 20–25: (c) Data accuracy (the senior differentiator)
Name the 5 failure classes, then a fix for each:
1. **Duplicates** (retries, re-sync): idempotent ingest on `(deviceId, seq)`, upsert in the time-series DB with a natural key. Repo: `patterns/multi-step-processes.md` §9, `key-technologies-notes.md` §18.
2. **Clock skew / drift** on cheap devices: record the device time and server receive time on each sync, compute `clockOffsetMs` per device, correct the timestamps. Use event time (not processing time) plus watermarks; late events (a watch offline for 2 days) trigger rollup recomputation for those windows only. Repo: `key-technologies-notes.md` §15 (HLC = hybrid logical clocks), `ad-click-aggregation/answers.md` A29.
3. **Overlapping sources** (watch and phone both count steps): **do not sum**. Use a per-user, per-metric source-priority rule: for each time bucket, take the highest-priority device with data, falling back to others for gaps. Keep raw data from every source and make "merged" a derived view, so a rule change means recompute rather than data loss. This is the gap in the repo, so rehearse it.
4. **Bad sensor data**: range checks (HR 25–250), rate-of-change checks, a `quality` flag from the device (poor skin contact). Flag outliers, never silently drop them.
5. **User edits vs device data** (manual weight, edited food log across phone and web): document-level conflict. Use LWW (last-write-wins) with an HLC for simple fields; a merge rule for lists such as food items in a log (CRDT-ish add/remove set). Repo: `interviews/kv-store/deep-dive.md` §6, `fundamentals/vector-clocks.md`, `interviews/collaborative-editing/deep-dive.md` §3, `key-technologies-notes.md` §16 (LWW clock-skew risk).

One-liner to say: "Raw is immutable and source-tagged; everything the user sees is a recomputable projection."

## 25–29: (d) Recommendation engine
- **Two-stage design**: a deterministic rules layer and an ML ranking layer.
  - Rules: calorie target from BMR/TDEE (basal metabolic rate / total daily energy expenditure) and goal pace, macro split, **safety guardrails** (minimum calories, max weekly weight-loss rate, medical flags exclude certain plans). Guardrails always override ML. Say this explicitly; it's health.
  - ML: candidate generation (workouts and meals similar to what the user completed, collaborative filtering from similar users) → ranking on adherence probability → rerank for diversity and constraints (diet, allergies, equipment).
- **Pipelines**: offline batch builds embeddings and candidates nightly; an online service reads the feature store (7-day adherence, recent sleep, today's kcal left) and ranks. This is CQRS: a separate write path and read path. Repo: `interviews/recommendation-system/deep-dive.md` §1, §5, §8, §9 (RRF = reciprocal rank fusion), §10–11 cache.
- **Adaptive goals**: a feedback loop. If 2 weeks of missed targets, lower the target; if consistently hit, progress it. Updated with an EMA (exponential moving average) of adherence, from repo §6.
- **Cold start**: an onboarding questionnaire plus popular plans for the cohort (age band and goal type). Repo §12.
- **Metrics**: adherence rate, goal completion, retention. Not just CTR (click-through rate).

## 29–30: Wrap-up trade-offs
- Doc store vs time-series store: two systems to run, but each fits its access pattern.
- Batch upload vs streaming from the device: battery and cost win; true sub-second only on the phone.
- Raw kept and projections recomputed: storage cost buys correctness and auditability.
- Next: multi-region with data residency, a clinical/HIPAA tier, and A/B testing for the recommendations.

---

## Likely grill questions (prep answers)
1. The watch was offline 3 days, then syncs. What breaks? (late data, rollup recompute, goal-streak recompute, notifications not re-fired for stale events)
2. A user has a watch and a ring both measuring sleep. Which wins and why?
3. How do you delete all of a user's health data in 30 days across Kafka, the lake and backups? (crypto-shredding)
4. A hot user (a 24/7 athlete with many devices): partition skew?
5. How would you know your step counts are wrong? (data-quality metrics per device model / firmware, drift dashboards; repo `interviews/observability/deep-dive.md` §3–4)
6. Why not compute everything on the device?

## Gaps to prep beyond the repo
- Source-priority merge for overlapping devices (c.3).
- Third-party health APIs + OAuth connector (b).
- HIPAA/GDPR, consent, crypto-shredding (a).
- Nutrition rules and guardrails for recommendations (d).

## Verification (self-check before the interview)
- Do a timed 30-minute dry run against this guide. Draw the architecture diagram in under 3 minutes.
- Re-read the repo sections listed above, in this order: ad-click-aggregation deep-dive §1–5, scaling-writes §3/§7/§9, kv-store deep-dive §6, recommendation-system deep-dive §1/§6/§12.
