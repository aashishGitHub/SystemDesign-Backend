# Deep Dive: Video Streaming (Netflix / YouTube)

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive mental models
> - 🟡 **Senior** — implementation mechanics + tradeoffs
> - 🔴 **Architect** — failure modes, capacity math, and review-level decisions

---

## Table of Contents

1. [Why Video Streaming Is Different](#1-why-video-streaming-is-different)
2. [The Upload Pipeline](#2-the-upload-pipeline)
3. [Transcoding Architecture](#3-transcoding-architecture)
4. [Adaptive Bitrate Streaming (HLS/DASH)](#4-adaptive-bitrate-streaming-hlsdash)
5. [CDN & Global Video Delivery](#5-cdn--global-video-delivery)
6. [Storage Architecture](#6-storage-architecture)
7. [Watch History & Progress Tracking](#7-watch-history--progress-tracking)
8. [Content Protection (DRM)](#8-content-protection-drm)
9. [Live Streaming Architecture](#9-live-streaming-architecture)
10. [Real-World Company Patterns](#10-real-world-company-patterns)
11. [Pattern Recognition — Identifying Video Streaming Decisions in Interviews](#11-pattern-recognition--identifying-video-streaming-decisions-in-interviews)
12. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Why Video Streaming Is Different

### 🟢 Beginner — The TV Channel vs Library Book Analogy

A TV channel broadcasts one show at a time; everyone watches the same stream. A library lets you pick any book and read it at your own pace. Video streaming is like a personal library: millions of people each opening a different book at a different page at the same time.

The hard part is: each "book" is gigabytes in size, multiple people may want the same book at once, and you need to deliver it fast enough that the reader can keep reading without waiting. You can't ship the whole book — you deliver a few pages ahead of where they're reading, adjusting how fast you deliver based on how fast they read.

---

### 🟡 Senior — The Core Technical Problem Set

Video streaming combines five hard problems simultaneously:

```text
1. Storage problem:    100M videos × 14 GB per video = 1.4 exabytes → tiered storage
2. Throughput problem: 200M viewers × 4 Mbps = 800 Tbps egress → CDN is mandatory
3. Latency problem:    Viewer anywhere on earth, <2s startup → edge caching
4. Adaptation problem: Networks fluctuate 10x per minute → adaptive bitrate streaming
5. Processing problem: 1 GB raw video → encode 8 quality levels before it's streamable → async pipeline
```

| Property | Video Streaming | REST API |
|---|---|---|
| Response size | 2–14 GB per video | Kilobytes |
| Client access pattern | Sequential + seek | Random point access |
| Repeat consumption | Same bytes by millions | Mostly unique responses |
| Caching model | CDN-first, immutable | Varies |
| Failure tolerance | Degraded quality is acceptable | No partial results |

---

### 🔴 Architect — Failure-First Thinking

At review time, the questions to answer before building:
- What is our expected CDN cache hit ratio? (Netflix: ~99.9%.)
- What happens to in-progress streams if a CDN PoP fails? (Client switches to next closest PoP.)
- What is our RTO for the transcoding pipeline? (New uploads queue up; existing content unaffected.)
- Is any path in the read stack synchronous with the transcoding worker? (It must not be — read path must be fully independent.)

Real incident pattern: A platform launched a new encoder version that corrupted the first segment of every video. The CDN cached the corrupt segments with a 7-day TTL. Fixing required global CDN invalidation of millions of segment keys. Lesson: encode a canary video first, validate playback, then rollout.

---

## 2. The Upload Pipeline

### 🟢 Beginner — The Post Office Analogy

Mailing a package: you don't carry a 50 kg box to the post office in one trip. You put it in a shipping box, label it, and give it to the carrier. If the carrier drops it, you re-ship the damaged items only.

Video upload is the same: break the file into labeled chunks, send them in parallel, re-send only failed chunks. The "post office" (storage) assembles them at the end.

---

### 🟡 Senior — Chunked Upload State Machine

```text
States:
  INITIATED → UPLOADING → ASSEMBLING → COMPLETE → (triggers transcoding)
                                     → FAILED    → (retry from last chunk)

Client-side logic:
  1. POST /uploads → get { upload_id, chunk_size: 8MB }
  2. Split file into 8 MB chunks
  3. For each chunk (parallel, max 4 concurrent):
       PUT /uploads/{upload_id}/parts/{part_num}
       Header: Content-Range: bytes start-end/total
       Retry with exponential backoff on 5xx
  4. GET /uploads/{upload_id}/status → verify all parts received
  5. POST /uploads/{upload_id}/complete
```

```ts
// Resumable upload client
async function resumableUpload(file: File, uploadId: string) {
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  
  // Query for already-uploaded parts (resume support)
  const { completedParts } = await api.get(`/uploads/${uploadId}/parts`);
  const completedSet = new Set(completedParts.map((p: Part) => p.partNumber));
  
  const queue = Array.from({ length: totalChunks }, (_, i) => i + 1)
    .filter(n => !completedSet.has(n)); // skip already done
  
  // Upload remaining chunks with concurrency limit
  await pLimit(4)(queue.map(partNum => async () => {
    const start = (partNum - 1) * CHUNK_SIZE;
    const chunk = file.slice(start, start + CHUNK_SIZE);
    await api.put(`/uploads/${uploadId}/parts/${partNum}`, chunk, {
      headers: { 'Content-Range': `bytes ${start}-${start + chunk.size - 1}/${file.size}` }
    });
  }));
  
  await api.post(`/uploads/${uploadId}/complete`);
}
```

| Design Decision | Reason |
|---|---|
| 8 MB chunk size | Balance: large enough to reduce request overhead, small enough to retry cheaply |
| Direct-to-S3 presigned multipart | App server not in data path — S3 handles 10 GB without touching EC2 |
| Max 4 parallel chunks | Saturates uplink without overwhelming browser connection pool |
| Exponential backoff per chunk | Network jitter causes transient failures — backoff prevents retry storms |

---

### 🔴 Architect — Upload Security and Blast Radius

At scale, every upload endpoint is a potential attack surface:

| Threat | Mitigation |
|---|---|
| Upload of malicious executables | Content-type validation + binary signature check (magic bytes) |
| Storage exhaustion (zip bomb, huge files) | Pre-validate file size before issuing presigned URL |
| Presigned URL sharing | URL includes checksum of allowed Content-Type; scoped to specific S3 key |
| Upload bypass (attacker writes to arbitrary S3 path) | Presigned URLs restrict exact S3 key — not a wildcard |
| DoS via parallel small uploads | Rate limit upload session creation per creator |

Blast radius for upload service failure: only affects new content creation (write path). The read path is completely independent — existing content continues streaming unaffected.

---

## 3. Transcoding Architecture

### 🟢 Beginner — The Bakery Analogy

A raw video file is like flour, eggs, and butter. Viewers can't eat flour. The transcoding pipeline is the bakery that takes raw ingredients and bakes them into finished loaves (multiple sizes and varieties). The bakery can run many ovens in parallel — one for each loaf at once. You don't wait for the white bread to finish before starting the whole wheat.

---

### 🟡 Senior — GOP-Parallel Transcoding

A video is composed of **GOPs (Groups of Pictures)** — sequences of frames that can be decoded independently. This makes GOP-parallel transcoding possible.

```text
1-hour video at 4s segments = 900 GOPs (segments)

Sequential (naive):
  Transcode 240p: 360 s
  Then 360p:      360 s
  Then 720p:      360 s
  ...
  Total: 8 × 360s = 2880s = 48 minutes

Parallel by rendition:
  Transcode 240p, 360p, 720p... simultaneously = 360s = 6 minutes

Parallel by rendition + GOP:
  900 GOPs × 8 qualities = 7200 tasks
  With 100 workers, ~72 tasks each:
  Time ≈ max task time ≈ ~2 minutes
```

```text
Pipeline coordinator (AWS Step Functions / Temporal):
  Job: transcode video_789
  ├── Fan-out: create 7200 chunk tasks → SQS
  ├── Workers: transcode assigned chunk → write to S3 (deterministic path)
  └── Fan-in: poll completion → when all 7200 done → stitch playlists → update metadata
```

| Component | Role |
|---|---|
| Message queue (SQS/Kafka) | Durable task queue per chunk |
| Elastic worker fleet (EC2 Spot) | Scale up/down based on queue depth |
| S3 (deterministic paths) | Idempotent chunk output |
| Step Functions / Temporal | Orchestrate fan-out and fan-in |
| CB in worker | If S3 unavailable, worker backs off; job does not fail |

---

### 🔴 Architect — Transcoding Failure Modes and Capacity

**Failure 1: Poison pill segment**
A specific video segment causes FFmpeg to crash every time. Worker picks it up, crashes, message returns to queue, repeat. Solution: dead-letter queue after N retries + automated alert + human review.

**Failure 2: Cost explosion with Spot instances**
EC2 Spot interruptions mid-transcode lose progress on that chunk. Mitigation: use SQS visibility timeout = max chunk duration × 2. On interruption, message returns to queue and another worker picks it up. No work is lost because S3 writes are atomic per chunk.

**Capacity Math:**
```text
Netflix uploads ~500 hours of content per minute (stated publicly).
Per 1-hour video: ~100 worker-minutes of transcoding (6 quality levels)
500 hours/min × 100 worker-min = 50,000 worker-minutes per minute = 50,000 workers

In practice: EC2 Spot auto-scaling group, target 80% SQS queue depth
Cost: ~$0.03/worker-minute × 50,000 = $1,500/minute → significant incentive for encode optimization
```

Netflix's "Dynamic Optimizer" (per-title encoding) reduces transcoding work by 30% by matching encoding parameters to content complexity — comedy at lower bitrate looks as good as action at higher bitrate.

---

## 4. Adaptive Bitrate Streaming (HLS/DASH)

### 🟢 Beginner — The Garden Hose vs Fire Hose Analogy

If you water a garden with a fire hose at full pressure, you flood it. If your water pressure drops suddenly and you're mid-watering, the plants wilt. Smart irrigation systems sense soil dryness and adjust flow automatically.

ABR streaming is the smart irrigation system. The player measures how fast data is arriving (bandwidth) and automatically chooses the pipe size (quality level) to match. When the internet slows down, it switches to a smaller pipe. When it speeds up, a bigger pipe. The garden never floods or wilts — it always gets as much water as it can handle.

---

### 🟡 Senior — HLS/DASH Protocol Mechanics

**HLS (Apple, universally supported):**
```m3u8
# STEP 1: Player fetches master playlist
#EXTM3U
#EXT-X-VERSION:6

#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240,CODECS="avc1.4d400d,mp4a.40.2"
240p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=7800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
```

```m3u8
# STEP 2: Player fetches quality-specific playlist
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD

#EXT-X-KEY:METHOD=AES-128,URI="https://license.example.com/key/video_789",IV=0x00000000000000000000000000000001
#EXTINF:4.000000,
seg_001.ts
#EXTINF:4.000000,
seg_002.ts
...
#EXTINF:3.850000,
seg_900.ts
#EXT-X-ENDLIST
```

**Quality selection algorithm (BOLA — Netflix):**
```ts
function selectQuality(
  availableQualities: Quality[],  // sorted by bitrate
  bufferSeconds: number,
  downloadSpeedBps: number
): Quality {
  // BOLA: buffer-based with throughput validation
  if (bufferSeconds < 8) {
    // Emergency: buffer critically low — pick lowest quality
    return availableQualities[0];
  }
  
  // Find highest quality that estimated bandwidth can sustain
  const safetyFactor = 0.85; // headroom for bandwidth fluctuation
  const sustainable = availableQualities
    .filter(q => q.bitrateBps * (1/safetyFactor) <= downloadSpeedBps)
    .at(-1); // highest that fits
    
  if (bufferSeconds > 25 && sustainable) {
    // Buffer healthy + bandwidth available → step up
    const currentIdx = availableQualities.indexOf(sustainable);
    return availableQualities[Math.min(currentIdx + 1, availableQualities.length - 1)];
  }
  
  return sustainable ?? availableQualities[0];
}
```

---

### 🔴 Architect — ABR Algorithm Choice and Its Impact on Bandwidth Costs

Netflix's ABR algorithms directly affect their $1B+ annual CDN bandwidth cost.

| Algorithm | Strategy | Bandwidth Efficiency | QoE Score |
|---|---|---|---|
| Throughput-based (naïve) | Match bitrate to measured speed | Medium | Medium (overshoots bursts) |
| BOLA (buffer-occupancy) | Maximize quality given buffer | High | High (stable) |
| MPC (model predictive) | Predict future bandwidth | Highest | Highest (smooth) |

Netflix BOLA improvement (2021 paper): 10% reduction in average bitrate with equal or better perceived quality → ~$100M/year in CDN savings at Netflix's scale.

**Segment duration impact on live latency:**
```text
LL-HLS with partial segments: 0.5s chunks → <2s live latency
Standard HLS: 4s segments × 3 segments prefetch = 12s live latency
MPEG-DASH low-latency: 1s segments → <3s live latency

Tradeoff: shorter segments → more HTTP requests → higher origin load
Solution: HTTP/2 push for segment prefetching, CDN request coalescing
```

---

## 5. CDN & Global Video Delivery

### 🟢 Beginner — The Warehouse vs Local Store Analogy

Amazon has one main warehouse in each country. But Prime Now delivers groceries in 1 hour because there are local stores (dark stores) 5 miles from your home. The local stores stock only popular items — the warehouse has everything.

Video CDN works the same: S3 origin is the warehouse. CDN edge nodes are the local stores. Popular video segments are stocked locally. Your video request goes to the edge 5 miles away, not to a data center 3,000 miles away.

---

### 🟡 Senior — CDN Request Lifecycle for Video

```text
First viewer (cache miss):
  Tokyo viewer → Tokyo CDN PoP
    → MISS: CDN requests from S3 origin (US)
    → S3 → CDN PoP (segment buffered during transit)
    → CDN: store segment in edge cache
    → CDN → viewer (streaming while caching)
  Latency: 200ms to first byte (US round-trip)

Second viewer (cache hit):
  Tokyo viewer → Tokyo CDN PoP
    → HIT: segment served from edge memory
    → CDN → viewer
  Latency: 3ms to first byte

10M concurrent viewers of same segment (thunder herd):
  All → Tokyo CDN PoP
  CDN request coalescing: collapses 10M into ONE request to S3
  S3 → CDN: one response, fanned out to 10M waiters
```

**CDN configuration for video:**
```nginx
# Nginx CDN cache config for video segments
location ~ \.ts$ {
  proxy_cache video_cache;
  proxy_cache_valid 200 365d;      # immutable segments: cache 1 year
  proxy_cache_lock on;             # request coalescing: only one upstream request
  proxy_cache_lock_timeout 30s;
  add_header X-Cache-Status $upstream_cache_status;
  
  # Byte-range support (mandatory for seeking)
  proxy_force_ranges on;
  slice 2m;                        # CDN-level byte-range slicing
}

location ~ index\.m3u8$ {
  proxy_cache video_cache;
  proxy_cache_valid 200 3600s;     # manifest: cache 1 hour (may be updated)
  proxy_cache_bypass $http_pragma;
}
```

---

### 🔴 Architect — Netflix Open Connect vs Standard CDN

Netflix's insight that no off-the-shelf CDN could handle their scale:

```text
Standard CDN economics:
  Netflix traffic: ~15% of all downstream internet traffic globally
  CloudFront/Fastly pricing: $0.01-0.085/GB egress
  Netflix monthly egress: ~1 exabyte (estimated)
  Monthly CDN cost: ~$10B-$85B/year — impossible

Open Connect solution:
  Netflix manufactures custom servers (350TB SSD + 100Gbps NICs)
  Installs inside ISP data centers for free (ISP benefits: less traffic on backbone)
  Proactively pushes popular content to OCA nightly (before demand)
  ~95% of Netflix traffic never leaves the ISP's network

OCA proactive prefetch (3am local time):
  1. Netflix predicts next day's top 1000 titles per geography
     (based on trending, recommendations, release schedule)
  2. Pushes all segments for those titles to regional OCAs
  3. Morning viewers hit local OCA: sub-5ms, zero origin requests
```

**Capacity math:**
```text
OCA hardware per ISP PoP:
  350 TB SSD storage
  Top 1000 movies × 14 GB each = 14 TB needed → fits on one OCA
  100 Gbps NIC → serves ~25,000 simultaneous 4 Mbps streams
  
Netflix installs multiple OCAs per large ISP = redundancy + capacity
```

---

## 6. Storage Architecture

### 🟢 Beginner — The Warehouse Shelving System Analogy

Imagine a giant warehouse storing millions of book series. Every series (video) has multiple editions (quality levels), each edition has hundreds of chapters (segments). You need to find any chapter instantly. The key is a consistent labeling system: every shelf is labeled `{series}/{edition}/{chapter}`.

Blob storage works identically: every segment has a predictable path. No index needed — just know the naming convention and compute the path directly.

---

### 🟡 Senior — Storage Design Decisions

```text
S3 bucket structure:
  raw-uploads/{creator_id}/{upload_id}.{ext}         # kept for re-encode
  transcoded/{video_id}/{quality}/index.m3u8         # quality playlist
  transcoded/{video_id}/{quality}/seg_{seq:04d}.ts   # padded seq for ordering
  transcoded/{video_id}/master.m3u8                  # composite master
  thumbnails/{video_id}/{timestamp_ms}.jpg           # multiple keyframes
  subtitles/{video_id}/{language}.vtt                # WebVTT format
```

| Decision | Choice | Reason |
|---|---|---|
| Segment naming | Sequential int (`seg_0001.ts`) | Predictable without index; easy client-side computation |
| Separate buckets per type | Yes (raw vs transcoded vs thumb) | Independent lifecycle policies + permissions |
| S3 Transfer Acceleration | Yes for uploads from creators | Faster write path using CloudFront backbone |
| S3 Intelligent-Tiering | Yes for transcoded content | Auto-moves cold content to cheaper tiers |
| S3 Event Notifications | Yes (→ SNS/SQS) | Event-driven pipeline triggers, no polling |

**Storage cost optimization tiers:**
```text
Tier 0: S3 Standard       ~$0.023/GB  → top 10% by 30-day views  (all renditions cached at CDN)
Tier 1: S3-IA             ~$0.0125/GB → 10-80th percentile        (720p and below only)
Tier 2: S3 Glacier        ~$0.004/GB  → bottom 80%                (480p + original only)
Tier 3: S3 Glacier Deep   ~$0.00099/GB → archive (>5yr no views)  (original only, restore on demand)
```

---

### 🔴 Architect — Content-Addressable Storage for Deduplication

YouTube and Netflix use content-based addressing for exact deduplication:

```text
Content-Addressed Storage (CAS):
  Hash = SHA-256(file bytes)
  S3 key = "cas/{hash[:2]}/{hash[2:4]}/{hash}"  ← like Git's object store
  
On upload:
  1. Client computes SHA-256 of raw video
  2. Check CAS index: does hash exist?
  3. If yes: new video metadata row → points to same S3 key (no upload needed)
  4. If no: upload to CAS path → create metadata

For video re-encodings:
  Same raw bytes → same hash → same raw file
  Different encode parameters → different transcoded paths
  
YouTube Content ID uses perceptual hash (audio + visual fingerprint):
  Audio: Shazam-like fingerprint of waveform
  Visual: DCT hash of keyframes (robust to resolution/bitrate changes)
  Comparison: Hamming distance < threshold → copyright match
```

Deduplication impact: YouTube reports ~30% of all uploads are duplicates (re-uploads, reposts). CAS reduces storage by 30% and transcoding costs by 30% for that cohort.

---

## 7. Watch History & Progress Tracking

### 🟢 Beginner — The Library Bookmark Analogy

A library card tracks every book you've checked out and the page you left a bookmark in. When you visit another branch, your bookmark is still there — it's stored centrally, not in the physical book. You can pick up where you left off at any branch.

Resume position works the same way: your position is stored in a central database, associated with your account. Any device can read it. The video player seeks to your last position before starting playback.

---

### 🟡 Senior — Progress Write Pipeline

```text
Scale: 200M concurrent viewers × report every 5s = 40M writes/s

Architecture:
  Player      → Kafka (durable event log, horizontally scalable)
  Kafka       → Flink stream processor
                  → deduplicate (same user, same video: keep latest)
                  → aggregate (group by user_id, batch 30s)
  Flink       → Cassandra write (partitioned by user_id)
                  ← 40M/30 = 1.3M final writes/s
  
  Cassandra read-path:
    GET /watch-progress/{video_id}
    → Cassandra lookup by (user_id, video_id) — O(1), sub-10ms
```

```ts
// Progress data model (Cassandra CQL)
CREATE TABLE watch_progress (
  user_id     UUID,
  video_id    UUID,
  position_ms BIGINT,         -- millisecond precision
  total_ms    BIGINT,
  completed   BOOLEAN,        -- crossed 70% threshold
  updated_at  TIMESTAMP,
  device_type TEXT,
  PRIMARY KEY (user_id, video_id)
) WITH CLUSTERING ORDER BY (video_id ASC);

// Upsert: keep latest position (idempotent)
INSERT INTO watch_progress (user_id, video_id, position_ms, updated_at)
VALUES (?, ?, ?, toTimestamp(now()))
USING TIMESTAMP ?;   -- client-side timestamp for ordering (LWW semantics)
```

---

### 🔴 Architect — Failure Modes in Progress Tracking

**Failure 1: Player sends progress for deleted/purged video**
Edge case: user watches offline-cached content that was deleted from the platform. Progress writes will fail FK constraint if video_id is hard-deleted. Solution: soft-delete videos (status = 'deleted'), keep metadata row.

**Failure 2: Clock skew between devices**
User fast-forwards on TV (position = 3600s). Phone, out of sync, sends old position (position = 1200s). Without ordering, phone overwrites TV progress.

Mitigation:
- Use `USING TIMESTAMP {client_ts}` in Cassandra — LWW (Last Write Wins) by client timestamp
- Client timestamp is the player clock when the event was captured (not when it was sent)
- If client clock is wildly off, server rejects if delta > 1 hour from server time

**Failure 3: Kafka consumer lag on peak**

```text
Netflix's New Year peak: ~300M concurrent viewers (2x normal)
Progress writes: 300M/5s = 60M writes/s → Kafka topic partition count = bottleneck

Prevention:
  Pre-scale Kafka consumer group before anticipated peak
  Auto-scale consumer group via Kubernetes HPA keyed on consumer lag metric
  Alert when consumer lag > 60s (potential durability gap)
```

---

## 8. Content Protection (DRM)

### 🟢 Beginner — The Encrypted Safety Deposit Box Analogy

A bank safe deposit box holds your valuables. You have a key. Without your key, the box is useless — even if someone steals it, they can't open it. But you can only get a key at the bank after showing ID.

DRM works the same: video segments are an encrypted box. The CDN delivers the box to anyone. But the decryption key is only given to authorized viewers after authentication. Pirates who capture CDN traffic get an encrypted box — worthless without the key.

---

### 🟡 Senior — DRM Architecture

```text
Content preparation (at transcode time):
  Video segments → encrypted with Content Encryption Key (CEK) → S3/CDN
  CEK → stored in Key Management System (KMS), NOT in S3
  
  PSSH box embedded in segment: signals which DRM to use for this content
  (Widevine, FairPlay, PlayReady)
  
Playback authorization (at play time):
  1. Player: requests video, gets encrypted segment
  2. Player: reads PSSH box → knows this requires Widevine
  3. Player → License Server:
       POST /license/widevine
       Body: { license_challenge (generated by DRM module), video_id }
       Auth: Bearer {JWT}
  4. License Server:
       Validate JWT (user has entitlement for this video?)
       Fetch CEK from KMS
       Wrap CEK in DRM-encrypted license blob
       Return license blob to player
  5. Player → DRM module: decrypt license → extract CEK
  6. Player: decrypt segments using CEK → play
  7. License: cached in player for session (don't refetch per segment)
```

| DRM System | Platform | Notes |
|---|---|---|
| Widevine | Chrome, Android, desktop | L1/L2/L3 security levels (L1 = hardware TEE) |
| FairPlay | Safari, iOS, Apple TV | Requires HTTPS + Apple developer cert |
| PlayReady | Edge, Windows 10/11 | Required for Xbox, Dolby Vision HDR |
| Multi-DRM (CMAF) | All | One encode, three DRM licenses → cost efficient |

---

### 🔴 Architect — DRM Failure Modes

**Failure 1: License server becomes SPOF**

If the license server is down, all new playback fails globally (existing sessions continue with cached licenses).

Mitigation:
- Multi-region license servers with DNS failover
- License pre-fetch: issue license when user clicks "play" (not on first segment decode) — masks latency
- Offline license: allow downright download + DRM offline license for mobile (valid 30 days)

**Failure 2: Key leakage from transcoding pipeline**

CEK must never appear in logs, S3 metadata, or SQS messages. Use envelope encryption:
```text
CEK = AES-256 key generated by KMS per video
CEK stored in KMS (never leaves KMS server)
Transcoder calls KMS.Encrypt(CEK) for each chunk
S3: stores encrypted CEK alongside segment → only KMS can decrypt
License server: calls KMS.Decrypt → gets CEK → wraps in DRM license
```

If CEK is compromised: rotate via KMS → generate new CEK → re-encrypt all segments (expensive but safe).

**Failure 3: DRM module unavailable on client**

Widevine requires `libwidevinecdm.so` to be installed (Chrome ships it). If it's missing or outdated:
→ Graceful degradation: offer lower-security stream (HLS without DRM for unprotected content)
→ For premium content: block playback with user-friendly error + remediation link

---

## 9. Live Streaming Architecture

### 🟢 Beginner — The Radio Station Analogy

A radio station broadcasts live: whatever they play at 3 PM, everyone who tunes in at 3 PM hears simultaneously. They can't rewind (unless they recorded it). There's no file — just a continuous stream being generated in real-time.

Live video streaming is the same: the encoder sends content as it's created. The pipeline must process and deliver it within 1–10 seconds. There's no pre-transcoded file — everything is generated on-the-fly.

---

### 🟡 Senior — Live Pipeline Architecture

```text
encoder (OBS/hardware) 
  → RTMP/SRT ingest server
    → Transcoding (real-time FFmpeg or hardware ASIC)
      → HLS/DASH segmenter
        → Origin CDN server (segments + rolling playlist)
          → Edge CDN
            → Viewer

Key differences from VOD:
  Segments only exist after the broadcast reaches that moment (no pre-fetch possible)
  Playlist is constantly updated (new segments appended every 2s)
  No "seek to beginning" — can seek only within DVR window (last N minutes)
```

| Parameter | Live | VOD |
|---|---|---|
| Segment creation | Real-time (2–4s) | Pre-computed (minutes) |
| Playlist file | Appended every segment | Complete at publish |
| CDN cache TTL | Manifest: no-cache; segments: 2-3x segment duration | Segments: immutable |
| Error recovery | Encoder must reconnect instantly | Re-transcode job |
| Viewer latency | 2–30s behind live | N/A |

**LL-HLS (Low-Latency HLS):**
```m3u8
#EXT-X-PART-INF:PART-TARGET=0.5  # 0.5s partial segments
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5

# Regular 4s segments
#EXTINF:4.0,seg_1200.ts
# Plus partial segments (0.5s each, 8 per full segment)
#EXT-X-PART:DURATION=0.5,URI=seg_1201_part_0.m4s
#EXT-X-PART:DURATION=0.5,URI=seg_1201_part_1.m4s
...
```
Result: viewer is only 1–2 segments (2–4s) behind live instead of 6–30s.

---

### 🔴 Architect — Live Streaming Failure Handling

**Failure 1: Encoder disconnects mid-stream (most common)**

```text
Encoder loses internet → SRT/RTMP connection drops
Ingest server: detects heartbeat timeout after 3s
Actions:
  1. Insert slate video (fallback image/video) into segment stream
  2. Continue producing segments with slate (viewers see "interrupted" slate)
  3. Wait for reconnect (30s reconnect window)
  4. When encoder reconnects: seamlessly switch from slate to live feed
  5. If reconnect fails after 30s: mark stream as ended
```

**Failure 2: Transcoding GPU overload on peak concurrent live events**

```text
Scenario: 100,000 streamers go live simultaneously (New Year's Eve)
Each stream needs one GPU transcode pipeline
GPU capacity: each GPU handles ~10 1080p streams
Required: 10,000 GPUs
Solution:
  Pre-scale GPU fleet to expected peak (based on historical data)
  Tiered encoding: 1080p live uses more GPUs → downgrade 480p streams first
  Adaptive encoding: reduce keyframe frequency at peak to reduce CPU/GPU
```

**Failure 3: CDN playlist stale (viewer sees stale manifest)**

Live segment playlist updates every 2s. If CDN caches it for 10s, viewers see old playlist, request non-existent upcoming segments.

Fix:
- `Cache-Control: no-cache` on manifest (always revalidated)
- CDN conditional request: `If-None-Match: {etag}` → 304 if unchanged → minimal bandwidth

---

## 10. Real-World Company Patterns

### 🟢 Beginner — Same Problem, Different Scale

Netflix, YouTube, TikTok, and Twitch all stream video but at different scale and with different priorities. Interviewing at each expects you to know which parts of the system they obsess over.

---

### 🟡 Senior — How Major Companies Solve Key Problems

**Netflix — Open Connect + Per-Title Encoding**

```text
Open Connect (ISP appliance CDN):
  Problem: Standard CDN too expensive at Netflix's egress volume
  Solution: Install 350TB SSDs inside ISP networks
  Result: 95%+ cache hit rate, 0 egress cost per served GB
  Impact: Enables Netflix at its current price point

Per-Title Encoding (2015):
  Problem: encoding uniform bitrate ladder wastes bandwidth
             (studio animation compresses better than action; same bitrate = wasted bits)
  Solution: ML model analyzes content complexity → per-title optimal bitrate ladder
  Result: 20-30% bandwidth reduction with equal or better perceptual quality
  Impact: ~$100-200M/year bandwidth savings
```

**YouTube — Parallel Transcoding at Extreme Scale**

```text
YouTube upload stats (2022): 500 hours of video uploaded per minute
Transcoding pipeline must handle: 500 × 60 minutes × multiple qualities per minute
Solution: 
  Borg (Google's cluster scheduler) allocates transcoding jobs across Google's spare CPU capacity
  GOP-parallel: one video → thousands of small tasks across the fleet
  Jobs can be preempted by other Google workloads (best-effort scheduling)
  → Transcoding is not time-critical (best-effort queue fine for most uploads)

Content ID (copyright fingerprinting):
  Audio fingerprint: hash of audio spectral shape
  Visual fingerprint: DCT hash of keyframes every 5s
  Database: 800M+ reference fingerprints from rights holders
  On upload: new video fingerprinted and compared → match within seconds
```

**Cloudflare Stream — Serverless Video Encoding**

```text
Problem: SMBs can't afford own video infrastructure
Solution: Pay-as-you-go transcoding API on Cloudflare's edge
Innovation: Run encoding tasks on serverless workers at the edge (near uploader)
  → Reduce upload latency to ingestion PoP
  → Workers encode lightweight tasks (thumbnails, 360p) at edge
  → Heavy encoding (4K) sent to regional data center
```

**TikTok — Short Video Optimizations**

```text
Video length: 15s-3min (much shorter than YouTube)
Optimization opportunities:
  1. Eager transcoding: short videos finish in seconds (not minutes)
  2. Precompute all quality levels and cache in CDN before video is shown
  3. Autoplay preloading: prefetch next video in feed before user reaches it
    → Net effect: 0ms startup latency (video already buffered when user swipes)
  4. Portrait-mode (9:16) dominant → optimize encoding for portrait aspect ratio
```

---

### 🔴 Architect — Production Incidents From Video Streaming Failures

**Incident 1 — The Corrupt Segment That Broke 40M Streams (Netflix, internal)**

A new encoder version introduced subtle corruption in the first segment of every video (wrong timestamp in SPS header). The corrupt segments were cached by CDN with long TTL. When users pressed play, first-segment decode failed → black screen or crash. Affected only new encodes; existing cached content fine.

```text
Root cause: encoder regression in NALU header writing, no segment-level validation
Fix:
  Encoder regression testing: decode-validate every output segment in CI
  Canary rollout: new encoder version on <1% of new uploads, monitor error rates 24h
  CDN hash-on-path: segment URL includes hash of content → corrupt segment = different URL = no cache pollution
  Rollback: re-encode affected titles from raw (reason to always keep originals)
```

**Incident 2 — Thumbnail Service OOM Bringing Down Transcoding (common pattern)**

A team added thumbnail generation to the same SQS queue as transcoding. Thumbnail tasks were computationally cheap but numerous. Workers spent most time on thumbnails, transcoding jobs queued for hours.

```text
Root cause: shared queue priority inversion
Fix: separate queue per job type (transcoding, thumbnails, subtitles)
     separate auto-scaling groups per queue
     never bundle slow jobs with fast jobs in same queue
```

**Incident 3 — CDN Invalidation Timeout During DMCA Takedown**

Legal required a video removed from CDN within 30 minutes. CDN invalidation API call was issued. API accepted the request but processing was queued due to CDN overload — effective removal took 4 hours.

```text
Root cause: CDN invalidation is eventually consistent, not immediate
Fix:
  Token-based access: segment URLs include signed access token with TTL = 2 hours
  Takedown = revoke token → existing cached segments continue 2h (acceptable) → then 404
  CDN invalidation still issued (defense in depth) but not the primary control
  
Alternative: serve sensitive content through authenticated origin (no CDN cache) → add latency
```

**Incident 4 — Watch Progress Stack Overflow (common pattern)**

A batch job queried all watch progress for a popular video to compute completion stats. Query: `SELECT user_id, MAX(position_seconds) FROM watch_progress WHERE video_id = 'popular_movie' GROUP BY user_id`. The movie had 100M viewers. The query returned 100M rows into application memory → OOM crash.

```text
Root cause: pulling analytics data into application layer
Fix:
  Never run analytics queries against production OLTP DB
  Use read replica (still wrong — 100M rows is too big)
  Use dedicated OLAP system: Snowflake, BigQuery, Spark
  Completion counter: maintain a separate pre-aggregated counter per video
                      incremented in Flink stream when user crosses 70%
```

---

## 11. Pattern Recognition — Identifying Video Streaming Decisions in Interviews

### 🟢 Beginner — The Interview Signal Checklist

When you hear these phrases, video-streaming design decisions should appear:

| Interview Signal | Design Response |
|---|---|
| "upload large files" | Chunked upload, presigned URLs, TUS protocol |
| "stream video" | HLS/DASH with adaptive bitrate, CDN-first |
| "different quality levels" | Transcoding pipeline, rendition ladder |
| "global users" | CDN edge caching, multi-region, Open Connect-style |
| "Netflix / YouTube" | Identify write path vs read path immediately |
| "content creators upload" | Async transcoding pipeline, not sync |
| "playback starts fast" | CDN cache hit, segment pre-buffering |
| "live streaming" | LL-HLS, real-time transcoding, rolling playlist |
| "resume watching" | Progress tracking at scale, Kafka + batching |

---

### 🟡 Senior — System Component Pattern Matching

| Requirement Signal | Component Choice | Why |
|---|---|---|
| "10 GB file upload" | S3 Multipart + presigned URL | App server not in data path |
| "upload resumes on failure" | TUS protocol / S3 Multipart Resume | Chunk-level idempotency |
| "1080p, 720p, 480p..." | GOP-parallel transcoding | Fastest path to all renditions |
| "video ready for streaming" | S3 → SQS → workers → manifest update | Event-driven, async |
| "smooth playback globally" | CDN with long segment TTL + request coalescing | Immutable segments + edge |
| "quality adapts to network" | HLS ABR with BOLA/MPC algorithm | Buffer-based quality selection |
| "watch progress at 200M scale" | Kafka → Flink → Cassandra | 40M writes/s → batch → durable |
| "prevent piracy" | DRM (Widevine/FairPlay/PlayReady) | Encrypted segments, licensed keys |
| "live event" | LL-HLS with partial segments | <2s latency behind live |

---

### 🔴 Architect — Reading System Design Signals Like a Senior

**Signal: "Design Netflix/YouTube"**

Separation to state immediately:
```text
Write path (creator):
  Upload → blob storage (raw)
  → Event: S3 → SQS → transcoding workers (GOP-parallel)
  → Output: S3 (segments) + metadata DB (rendition ready)
  → CDN warm-up for popular titles

Read path (viewer):
  Player → CDN (HLS master manifest)
  → Player selects quality → CDN (quality playlist)
  → Player fetches segments (CDN, byte-range)
  → ABR: continuously measures bandwidth, switches quality
  → Progress reports: Kafka → batch → Cassandra
```

**Signal: "The system needs to handle a popular video with 10M viewers"**

Automatic checklist:
```text
1. CDN request coalescing: 10M requests → 1 origin request per segment
2. CDN edge pre-warming: push popular segments before demand spike
3. Origin S3: add CloudFront + Transfer Acceleration for cache miss path
4. Transcoding: pre-encode at all quality levels before viral potential (all videos)
5. Watch progress: Kafka absorbs 10M/5s = 2M writes/s for this title alone
6. DRM license server: spike to 10M concurrent sessions → horizontally scale license issuer
```

**Signal: "How do you handle a new season dropping at midnight UTC"**

```text
Content preparation (T-12h):
  Transcoding: complete and verified (all renditions)
  DRM key material: pre-generated and staged in KMS
  
CDN pre-warm (T-2h to T-0):
  Netflix OCA appliances: push first 3 episodes to all regional OCAs
  Standard CDN: issue warm-up requests to all PoPs for Episode 1
  
Traffic management:
  Global rate limiting on metadata endpoint (anti-hammer)
  License server: pre-scale to 10x normal capacity
  
Rollout:
  T-0: flip video status = "available" in metadata DB
  T+0: 100M simultaneous "play" requests → CDN cache hit → zero origin
```

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Write vs read path | Two completely separate systems — write path failure must never affect streaming |
| Presigned URL | Creator uploads directly to S3 — app server never touches video bytes |
| Resumable upload | Chunked + server-side state → resume from last chunk on failure |
| S3 event trigger | S3 ObjectCreated → SQS → transcoding workers (never poll) |
| GOP-parallel transcoding | Split 1h video into 900 chunks × 8 qualities = 7200 parallel tasks → 2-min total |
| Per-title encoding | Content-aware bitrate ladder → 20-30% bandwidth savings (Netflix) |
| HLS master manifest | `.m3u8` listing all quality levels — player reads first |
| ABR quality selection | BOLA: buffer-based; switch down if buffer < 8s, up if > 25s |
| Short segments (2–4s) | Faster quality switch, lower live latency, more HTTP requests |
| CDN immutable TTL | Video segments never change → cache forever (`max-age=31536000`) |
| CDN request coalescing | 10M same-segment requests → 1 origin request, fanned out |
| Open Connect | Netflix ISP-embedded appliances eliminate egress cost + last-mile latency |
| Byte-range request | `Range: bytes=0-4194303` → seek without downloading whole file |
| Content deduplication | SHA-256 for exact; perceptual hash for copyright (YouTube Content ID) |
| Watch progress scale | 200M viewers / 5s = 40M writes/s → Kafka + Flink batch + Cassandra |
| Progress idempotency | `GREATEST(position_seconds)` with client timestamp → LWW, never roll back |
| DRM architecture | Encrypt segments at transcode; CEK in KMS; license issued post-auth at play-time |
| Multi-DRM | CMAF: one encode, Widevine + FairPlay + PlayReady licenses per platform |
| Live vs VOD | Live: rolling playlist, real-time transcode, no-cache manifest; VOD: complete, immutable |
| LL-HLS | Partial segments (0.5s) → <2s live latency |
| CDN invalidation lag | Not immediate — use token-based access + short TTL for legal takedowns |
| Long-tail storage | Store fewer renditions for <100-view videos; keep raw for re-encode |
| Thunder herd | Popular episode release → CDN pre-warm + request coalescing + origin scale |
| Corrupt segment incident | Validate decode in CI; canary encoder rollout; keep raws for rollback |
| Queue priority inversion | Separate SQS queues per job type (transcode vs thumbnail vs subtitle) |
| Analytics anti-pattern | Never run `SELECT COUNT(*)` on 100M watch-progress rows in OLTP |
