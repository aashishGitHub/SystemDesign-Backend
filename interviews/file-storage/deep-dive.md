# Deep Dive: Google Drive / Dropbox (File Sync & Storage)

> Three-tiered depth: 🟢 Phone Screen → 🟡 Onsite → 🔴 Staff+ deep dive

---

## Table of Contents

1. [Chunked Upload & Content-Addressable Storage](#1-chunked-upload--content-addressable-storage)
2. [Sync Protocol](#2-sync-protocol)
3. [Conflict Resolution](#3-conflict-resolution)
4. [Metadata Storage at Scale](#4-metadata-storage-at-scale)
5. [Deduplication & Storage Efficiency](#5-deduplication--storage-efficiency)
6. [Real-Time Notifications](#6-real-time-notifications)
7. [Production Operations](#7-production-operations)
8. [Real-World Case Studies](#8-real-world-case-studies)
9. [Quick Recall Cheat Sheet](#cheat-sheet)

---

## 1. Chunked Upload & Content-Addressable Storage

### 🟢 Beginner — The LEGO Analogy

Imagine you're moving houses and need to ship a huge sculpture made of LEGO bricks. Instead of shipping the complete sculpture (fragile, expensive), you:

1. **Take it apart** into individual bricks
2. **Number each brick** with a unique code based on its shape and color
3. **Ship the bricks** in separate boxes
4. Include an **instruction sheet** showing how to rebuild it

That's exactly what Dropbox does with files:
- **Chunking**: Split the file into 4 MB pieces (the bricks)
- **Hashing**: Give each chunk a unique ID based on its content (SHA-256)
- **Upload**: Send chunks to storage (ship the bricks)
- **Manifest**: Remember the order of chunks (the instructions)

If you ship the same brick twice by accident, the shipping company realizes "I already have this brick" and doesn't charge you again. That's **deduplication**.

---

### 🟡 Senior — How It Actually Works

**Upload flow**:

```python
import hashlib
from dataclasses import dataclass

@dataclass
class Chunk:
    hash: str
    data: bytes
    index: int

def chunk_file(file_path: str, chunk_size: int = 4 * 1024 * 1024) -> list[Chunk]:
    chunks = []
    with open(file_path, 'rb') as f:
        index = 0
        while True:
            data = f.read(chunk_size)
            if not data:
                break
            chunk_hash = hashlib.sha256(data).hexdigest()
            chunks.append(Chunk(hash=chunk_hash, data=data, index=index))
            index += 1
    return chunks

def upload_file(file_path: str, api_client):
    chunks = chunk_file(file_path)
    
    # 1. Ask server which chunks it needs
    existing = api_client.check_chunks([c.hash for c in chunks])
    
    # 2. Upload only new chunks
    for chunk in chunks:
        if chunk.hash not in existing:
            api_client.upload_chunk(chunk.hash, chunk.data)
    
    # 3. Create file with manifest
    manifest = [c.hash for c in chunks]
    api_client.create_file(
        name=file_path.name,
        size=sum(c.data for c in chunks),
        chunk_manifest=manifest,
        content_hash=compute_full_hash(chunks)
    )
```

**Download flow**:

```python
def download_file(file_id: str, local_path: str, api_client):
    # 1. Get file metadata with chunk manifest
    file_meta = api_client.get_file(file_id)
    
    # 2. Download chunks in parallel
    chunk_data = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(api_client.download_chunk, chunk_hash): i
            for i, chunk_hash in enumerate(file_meta.chunk_manifest)
        }
        for future in as_completed(futures):
            index = futures[future]
            chunk_data[index] = future.result()
    
    # 3. Reassemble in order
    with open(local_path, 'wb') as f:
        for i in range(len(file_meta.chunk_manifest)):
            f.write(chunk_data[i])
    
    # 4. Verify integrity
    if compute_full_hash(local_path) != file_meta.content_hash:
        raise CorruptionError()
```

**Comparison: Fixed vs Content-Defined Chunking**

| Aspect | Fixed-Size Chunks | Content-Defined Chunks (CDC) |
|--------|------------------|------------------------------|
| Boundary selection | Every N bytes | Rolling hash pattern match |
| Insertion impact | All subsequent chunks change | Only 1-2 chunks change |
| Dedup efficiency | Poor after edits | Excellent |
| CPU overhead | Low | Medium (rolling hash computation) |
| Use case | Simple storage | Sync-heavy workflows |

---

### 🔴 Architect — Chunking at Petabyte Scale

**Problem**: Computing SHA-256 for petabytes of data is expensive.

```text
Capacity math:
- 10,000 uploads/second
- Average file size: 10 MB
- Each file = 2.5 chunks × SHA-256 computation
- 25,000 SHA-256 hashes/second

SHA-256 throughput (single core): ~500 MB/s
At 25 chunks × 4 MB = 100 MB/s per core
Need ~2-3 cores per API server just for hashing
```

**Solutions**:

1. **Client-side hashing**: Offload to user's device
   ```javascript
   // Browser: Use SubtleCrypto
   const hash = await crypto.subtle.digest('SHA-256', chunkBuffer);
   ```

2. **Hardware acceleration**: AES-NI instructions
   ```bash
   # Check if server supports
   grep -o 'aes[^ ]*' /proc/cpuinfo
   ```

3. **Async verification**: Hash after upload (Lambda trigger)
   ```python
   # S3 event triggers Lambda
   def lambda_handler(event, context):
       chunk_key = event['Records'][0]['s3']['object']['key']
       # Stream-hash without loading full chunk
       computed = stream_hash(s3.get_object(Key=chunk_key))
       verify_chunk(chunk_key, computed)
   ```

**Failure mode: Race condition in deduplication**

```text
Timeline:
T0: User A starts uploading chunk X (hash: abc123)
T1: User B checks if abc123 exists → NO
T2: User A completes upload
T3: User B starts uploading same chunk
T4: Now two copies of abc123 in storage!

Solution: Optimistic insert with hash as primary key
- S3 PUT with If-None-Match: *
- Or: INSERT ON CONFLICT DO NOTHING
```

**Dropbox's "Streaming Sync"**: Rather than waiting for full file upload before sync, they start syncing chunks as they become available. User B sees partial file appearing on their device while User A is still uploading.

---

## 2. Sync Protocol

### 🟢 Beginner — The Mailroom Analogy

Imagine a corporate mailroom that tracks all packages. You're a remote worker with a copy of the package log.

Every morning, you call the mailroom: "What's new since yesterday?"

Mailroom responds:
- "Package 47 arrived for you"
- "Package 28 was returned"
- "Package 31 was forwarded to Bob"

You update your local log. If you shipped a package yourself, you tell the mailroom about it.

The **cursor** is your timestamp — "Give me updates since 5 PM yesterday." The mailroom doesn't send your entire package history every time, just the delta.

---

### 🟡 Senior — Delta Sync Implementation

**Server-side event log**:

```sql
CREATE TABLE sync_events (
    event_id BIGSERIAL PRIMARY KEY,
    workspace_id UUID NOT NULL,
    file_id UUID NOT NULL,
    event_type VARCHAR(20) NOT NULL,  -- 'create', 'modify', 'delete', 'move'
    path TEXT NOT NULL,
    content_hash VARCHAR(64),
    size_bytes BIGINT,
    parent_folder_id UUID,
    previous_path TEXT,  -- For moves
    actor_id UUID NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Fast lookup by workspace and sequence
    INDEX idx_sync_events_cursor (workspace_id, event_id)
);

-- Append-only: Never update, only insert
```

**Sync API**:

```python
@app.get("/sync/delta")
async def get_delta(
    workspace_id: str,
    cursor: Optional[str] = None,  # Encoded event_id
    limit: int = 200
):
    if cursor:
        last_event_id = decode_cursor(cursor)
        events = await db.query("""
            SELECT * FROM sync_events
            WHERE workspace_id = $1 AND event_id > $2
            ORDER BY event_id ASC
            LIMIT $3
        """, workspace_id, last_event_id, limit)
    else:
        # Initial sync: full file listing
        events = await get_all_current_files(workspace_id)
    
    return {
        "entries": [format_event(e) for e in events],
        "cursor": encode_cursor(events[-1].event_id) if events else cursor,
        "has_more": len(events) == limit
    }
```

**Client-side sync state machine**:

```python
class SyncStateMachine:
    """
    States: IDLE → FETCHING_REMOTE → APPLYING → PUSHING_LOCAL → IDLE
    """
    
    async def sync_cycle(self):
        # 1. Get remote changes
        self.state = "FETCHING_REMOTE"
        remote_changes = await self.api.get_delta(self.cursor)
        
        # 2. Apply remote changes locally
        self.state = "APPLYING"
        for change in remote_changes.entries:
            await self.apply_remote_change(change)
        self.cursor = remote_changes.cursor
        
        # 3. Detect local changes
        local_changes = await self.detect_local_changes()
        
        # 4. Push local changes
        self.state = "PUSHING_LOCAL"
        for change in local_changes:
            try:
                await self.push_change(change)
            except ConflictError as e:
                await self.handle_conflict(change, e.server_version)
        
        self.state = "IDLE"
    
    async def apply_remote_change(self, change):
        if change.type == "create" or change.type == "modify":
            # Download file content
            await self.download_file(change.file_id, change.path)
        elif change.type == "delete":
            os.remove(change.path)
        elif change.type == "move":
            os.rename(change.previous_path, change.path)
```

---

### 🔴 Architect — Sync at Scale

**Problem: Initial sync for large workspaces**

```text
Scenario: User with 100,000 files joins team workspace
Initial sync: Download all 100K file metadata entries

Naive approach: One API call → 100K entries → OOM on client, timeout on server

Solution: Paginated cursor with progress tracking
```

```python
class InitialSyncManager:
    async def perform_initial_sync(self, workspace_id: str):
        cursor = None
        total_files = 0
        
        while True:
            batch = await self.api.get_delta(workspace_id, cursor, limit=1000)
            
            # Process batch without loading all in memory
            for entry in batch.entries:
                await self.db.upsert_local_metadata(entry)
                total_files += 1
            
            # Checkpoint progress
            await self.save_sync_progress(cursor=batch.cursor, count=total_files)
            
            if not batch.has_more:
                break
            cursor = batch.cursor
            
            # Rate limit ourselves
            await asyncio.sleep(0.1)
        
        # Mark initial sync complete
        await self.set_sync_state("incremental")
```

**Event ordering guarantees**:

| Guarantee | How to Implement |
|-----------|------------------|
| Per-file ordering | Events for same file have increasing event_id |
| Workspace ordering | Single-threaded event writer per workspace |
| Global ordering (not needed) | Too expensive, relaxed consistency acceptable |

**Failure mode: Client crashes mid-sync**

```text
Problem:
- Client receives remote changes
- Applies 50 of 100 changes
- Crashes
- On restart: cursor is unchanged, receives same 100 changes
- Must not duplicate files

Solution: Idempotent application
- Use file_id as unique key, not path
- UPSERT instead of INSERT
- Track locally which changes were fully applied
```

---

## 3. Conflict Resolution

### 🟢 Beginner — The Library Copy Machine

Imagine a library with one copy of a rare book. Two researchers take it to the copy machine at the same time (somehow!).

Researcher A copies pages 1-50, writes notes on their copy, returns original.
Researcher B had the original earlier, made different notes.

Now we have two different "versions" of the book with notes. What do we do?

**Option 1 (Bad)**: Throw away one researcher's work. They'll be furious.
**Option 2 (Good)**: Keep both copies, label them clearly, let researchers sort it out.

Dropbox chooses Option 2: Create a "conflicted copy" so no work is lost.

---

### 🟡 Senior — Conflict Detection & Resolution

**Conflict detection using version vectors**:

```python
@dataclass
class FileVersion:
    version_number: int
    content_hash: str
    modified_at: datetime

def detect_conflict(local: FileVersion, remote: FileVersion, pushed: FileVersion) -> bool:
    """
    Local: What the client has
    Remote: What the server has now
    Pushed: The version client is trying to push (based on)
    
    Conflict if both local and remote diverged from the same base.
    """
    if pushed.version_number < remote.version_number:
        # Server has newer version than what client thinks
        if local.content_hash != remote.content_hash:
            return True  # Conflict: both sides modified
    return False
```

**Resolution flow**:

```python
class ConflictResolver:
    async def resolve(self, local_file: Path, remote_file: FileMetadata):
        # 1. Create conflicted copy with timestamp and device name
        conflict_name = f"{local_file.stem} (Conflicted copy from {device_name} on {date}){local_file.suffix}"
        conflict_path = local_file.parent / conflict_name
        
        # 2. Keep local changes as the conflicted copy
        shutil.move(local_file, conflict_path)
        
        # 3. Download server version to original path
        await self.download(remote_file.file_id, local_file)
        
        # 4. Upload conflicted copy as new file
        await self.upload_file(conflict_path)
        
        # 5. Notify user
        self.notify_user(
            f"Conflict detected in {local_file.name}. "
            f"Your changes were saved as {conflict_name}."
        )
```

**Comparison: Resolution Strategies**

| Strategy | Use Case | Drawback |
|----------|----------|----------|
| **Fork (Dropbox)** | File storage (Word docs, PDFs) | User must manually merge |
| **Last-write-wins** | Low-value data (logs) | Data loss |
| **OT (Google Docs)** | Real-time collaboration | Complex, document-specific |
| **CRDT (Figma)** | Concurrent graphics editing | Limited data types |
| **Manual merge** | Code (Git) | Requires user knowledge |

---

### 🔴 Architect — Edge Cases & Production Considerations

**Edge case: Delete-edit conflict**

```text
User A deletes document.docx at 10:00 AM
User B (offline since 9:00 AM) edits document.docx
User B comes online at 11:00 AM

Options:
1. "File was deleted, discard your edits" (data loss!)
2. "File was deleted, but I'll save your version" (resurrection)
3. "Conflict: file was deleted but you edited it. Keep your version? Y/N"

Answer: Option 3 — always surface conflicts to user.
```

**Edge case: Move-move conflict**

```text
User A moves /folder/doc.txt to /archive/doc.txt
User B moves /folder/doc.txt to /important/doc.txt

Result:
- One move wins (server timestamp)
- Other user gets a notification
- No data loss, just path confusion
```

**Implementation: Conflict-free IDs**

```python
# Problem: Two users create "New Document.txt" in same folder simultaneously
# Solution: Server assigns canonical file_id, path is just metadata

async def create_file(name: str, folder_id: str) -> FileMetadata:
    file_id = generate_uuid()  # Globally unique
    
    # Check for name collision
    existing = await db.get_file_by_path(folder_id, name)
    if existing:
        # Auto-rename: "New Document (1).txt"
        name = generate_unique_name(name, folder_id)
    
    file = FileMetadata(
        file_id=file_id,  # Permanent
        name=name,        # Can change
        folder_id=folder_id
    )
    await db.insert(file)
    return file
```

---

## 4. Metadata Storage at Scale

### 🟢 Beginner — The Catalog vs The Warehouse

A library has:
- **Catalog cards**: Small, indexed by author/title/subject. Quick to search.
- **Books on shelves**: Large, organized by location code.

Similarly:
- **Metadata database**: Small records (file name, size, owner, permissions). Fast queries.
- **Blob storage**: Large files. Cheap storage.

You wouldn't store book text on catalog cards, and you wouldn't store file bytes in PostgreSQL.

---

### 🟡 Senior — Schema Design for Performance

**Core schema**:

```sql
CREATE TABLE workspaces (
    workspace_id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE file_metadata (
    file_id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    parent_folder_id UUID,  -- NULL for root
    name VARCHAR(255) NOT NULL,
    is_folder BOOLEAN DEFAULT FALSE,
    size_bytes BIGINT DEFAULT 0,
    content_hash VARCHAR(64),
    current_version_id UUID,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP,  -- Soft delete
    
    -- Denormalized for fast listing
    full_path TEXT,
    depth INT,
    
    CONSTRAINT fk_workspace FOREIGN KEY (workspace_id) 
        REFERENCES workspaces(workspace_id),
    CONSTRAINT fk_parent FOREIGN KEY (parent_folder_id) 
        REFERENCES file_metadata(file_id)
);

-- Critical indexes
CREATE INDEX idx_folder_listing 
ON file_metadata (workspace_id, parent_folder_id, name)
WHERE deleted_at IS NULL;

CREATE INDEX idx_workspace_files 
ON file_metadata (workspace_id, updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX idx_full_path 
ON file_metadata (workspace_id, full_path);
```

**Query patterns and their optimizations**:

| Query | Index Used | Expected Latency |
|-------|------------|------------------|
| List folder contents | `idx_folder_listing` | < 10ms for 1K files |
| Search by path | `idx_full_path` | < 5ms |
| Recent files | `idx_workspace_files` | < 10ms |
| File by ID | Primary key | < 2ms |

**Maintaining full_path denormalization**:

```python
async def move_file(file_id: UUID, new_parent_id: UUID, new_name: str):
    async with db.transaction():
        file = await db.get(file_id)
        new_parent = await db.get(new_parent_id)
        
        # Update the file
        new_path = f"{new_parent.full_path}/{new_name}"
        await db.update(file_id, {
            "parent_folder_id": new_parent_id,
            "name": new_name,
            "full_path": new_path,
            "depth": new_parent.depth + 1
        })
        
        # Update all descendants (if folder)
        if file.is_folder:
            old_path_prefix = file.full_path
            await db.execute("""
                UPDATE file_metadata
                SET full_path = REPLACE(full_path, $1, $2),
                    depth = depth + $3
                WHERE workspace_id = $4
                  AND full_path LIKE $5
            """, old_path_prefix, new_path, 
                 new_parent.depth - file.depth,
                 file.workspace_id, f"{old_path_prefix}/%")
```

---

### 🔴 Architect — Sharding at Billion-File Scale

**Problem**: Single PostgreSQL can handle ~100M files. At 10B+ files, need sharding.

**Sharding strategy**:

```text
Option 1: Shard by workspace_id
  + All files for a workspace on same shard
  + Simple queries (no scatter-gather)
  - Hot workspaces (1M+ files) problematic

Option 2: Shard by file_id
  + Even distribution
  - Folder listing requires scatter-gather
  - Cross-shard transactions for moves

Option 3: Hierarchical (Google's approach)
  - Shard by workspace_id
  - Hot workspaces get their own shard
  - Auto-split when workspace exceeds threshold
```

**Implementation with Vitess (MySQL sharding)**:

```yaml
# VSchema for file_metadata
{
  "sharded": true,
  "vindexes": {
    "workspace_hash": {
      "type": "hash"
    }
  },
  "tables": {
    "file_metadata": {
      "column_vindexes": [
        {
          "column": "workspace_id",
          "name": "workspace_hash"
        }
      ]
    }
  }
}
```

**Failure mode: Shard failure**

```yaml
# Alert: Shard becomes unavailable
- alert: MetadataShardDown
  expr: mysql_up{shard=~"metadata_shard_.*"} == 0
  for: 30s
  annotations:
    runbook: |
      1. Check replica health: SHOW SLAVE STATUS
      2. If primary down, promote replica:
         - orchestrator -c relocate-below master.shard01 replica.shard01
      3. Update routing tables
      4. Notify affected workspaces (degraded mode)
```

---

## 5. Deduplication & Storage Efficiency

### 🟢 Beginner — The Photo Album Analogy

Imagine a family sharing a photo album. Grandma, Mom, and you all have the same photo of the beach vacation. Instead of printing 3 copies, you print 1 and put a note on each person's page: "See photo #42."

That's deduplication. If 1 million users upload the same profile background image, we store it once and add 1 million "see chunk #abc123" references.

Dropbox famously saved 70%+ storage costs through deduplication.

---

### 🟡 Senior — Deduplication Implementation

**Block-level deduplication**:

```python
class ChunkStore:
    def __init__(self, s3_client, db):
        self.s3 = s3_client
        self.db = db
    
    async def store_chunk(self, chunk_data: bytes) -> str:
        chunk_hash = hashlib.sha256(chunk_data).hexdigest()
        
        # Check if chunk exists
        existing = await self.db.query(
            "SELECT chunk_hash FROM chunks WHERE chunk_hash = $1",
            chunk_hash
        )
        
        if existing:
            # Deduplicated! Just increment reference count
            await self.db.execute(
                "UPDATE chunks SET ref_count = ref_count + 1 WHERE chunk_hash = $1",
                chunk_hash
            )
        else:
            # New chunk — upload to S3
            await self.s3.put_object(
                Bucket=CHUNK_BUCKET,
                Key=chunk_hash,
                Body=chunk_data,
                ContentType='application/octet-stream'
            )
            await self.db.execute(
                "INSERT INTO chunks (chunk_hash, size_bytes, ref_count) VALUES ($1, $2, 1)",
                chunk_hash, len(chunk_data)
            )
        
        return chunk_hash
```

**Measuring dedup efficiency**:

```sql
-- Dedup ratio: logical bytes / physical bytes
SELECT 
    SUM(fm.size_bytes) AS logical_bytes,  -- What users think they have
    SUM(c.size_bytes) AS physical_bytes,  -- What we actually store
    SUM(fm.size_bytes)::float / SUM(c.size_bytes) AS dedup_ratio
FROM file_metadata fm
JOIN file_versions fv ON fm.current_version_id = fv.version_id
JOIN LATERAL unnest(fv.chunk_manifest) AS chunk_hash ON true
JOIN chunks c ON c.chunk_hash = chunk_hash;

-- Typical result: dedup_ratio = 2.5 to 4.0 (60-75% savings)
```

---

### 🔴 Architect — Advanced Deduplication Techniques

**Content-Defined Chunking (CDC) with Rabin fingerprinting**:

```python
import pwnkit.rabin as rabin  # Or implement your own

class CDCChunker:
    MIN_CHUNK = 2 * 1024 * 1024    # 2 MB
    MAX_CHUNK = 8 * 1024 * 1024    # 8 MB
    AVG_CHUNK = 4 * 1024 * 1024    # Target 4 MB
    WINDOW_SIZE = 48
    
    def chunk(self, data: bytes) -> list[bytes]:
        chunks = []
        start = 0
        pos = self.MIN_CHUNK
        
        fingerprinter = rabin.Rabin(window_size=self.WINDOW_SIZE)
        
        while pos < len(data):
            # Update rolling hash
            fingerprinter.update(data[pos - self.WINDOW_SIZE:pos])
            
            # Check for chunk boundary (fingerprint matches pattern)
            if pos - start >= self.MIN_CHUNK:
                if fingerprinter.digest() % self.AVG_CHUNK == 0:
                    chunks.append(data[start:pos])
                    start = pos
                elif pos - start >= self.MAX_CHUNK:
                    # Force boundary
                    chunks.append(data[start:pos])
                    start = pos
            
            pos += 1
        
        # Final chunk
        if start < len(data):
            chunks.append(data[start:])
        
        return chunks
```

**Why CDC matters**:

```text
Scenario: User inserts 1 KB at the beginning of a 100 MB file

Fixed chunking (4 MB chunks):
- All 25 chunks have different content (shifted by 1 KB)
- Re-upload: 100 MB
- Dedup savings: 0%

CDC:
- First chunk boundary shifts
- Remaining chunks unaffected
- Re-upload: ~4-8 MB (1-2 chunks)
- Dedup savings: 92-96%
```

**Storage tiering**:

```text
Hot tier (SSD/fast storage):
- Recently uploaded chunks (< 30 days)
- Frequently accessed chunks (> 10 accesses/week)

Cold tier (HDD/cheap storage):
- Old chunks (> 90 days)
- Rarely accessed chunks

Archive tier (Glacier):
- Version history older than 1 year
- Deleted but retained for compliance
```

---

## 6. Real-Time Notifications

### 🟢 Beginner — The Security Camera Model

Imagine your doorbell camera. When someone approaches, you get a notification on your phone instantly. You don't keep refreshing your app to check.

File sync works similarly. When a teammate uploads a file, your computer gets a ping: "Hey, new file available!" rather than checking every second.

---

### 🟡 Senior — Notification Architecture

**WebSocket-based push**:

```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import aioredis

class NotificationHub:
    def __init__(self):
        self.connections: dict[str, list[WebSocket]] = {}  # user_id -> connections
        self.redis = None
    
    async def connect(self, user_id: str, websocket: WebSocket):
        await websocket.accept()
        if user_id not in self.connections:
            self.connections[user_id] = []
        self.connections[user_id].append(websocket)
        
        # Subscribe to user's channel
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(f"user:{user_id}:notifications")
        
        try:
            async for message in pubsub.listen():
                if message["type"] == "message":
                    await websocket.send_json(json.loads(message["data"]))
        except WebSocketDisconnect:
            self.connections[user_id].remove(websocket)
    
    async def notify_file_change(self, workspace_id: str, change: dict):
        # Get all users with access to workspace
        users = await get_workspace_members(workspace_id)
        
        # Publish to each user's channel
        for user_id in users:
            await self.redis.publish(
                f"user:{user_id}:notifications",
                json.dumps({
                    "type": "file_change",
                    "workspace_id": workspace_id,
                    "change": change
                })
            )

hub = NotificationHub()

@app.websocket("/ws/notifications")
async def websocket_endpoint(websocket: WebSocket, user_id: str = Depends(get_user)):
    await hub.connect(user_id, websocket)
```

**When to trigger notifications**:

```python
# After any file operation, publish event
async def create_file(file: FileMetadata, user_id: str):
    await db.insert(file)
    
    # Publish for real-time sync
    await notification_hub.notify_file_change(
        workspace_id=file.workspace_id,
        change={
            "type": "create",
            "file_id": str(file.file_id),
            "path": file.full_path,
            "size": file.size_bytes,
            "actor": user_id
        }
    )
```

---

### 🔴 Architect — Scaling Notifications

**Challenge**: 100M DAU, each connected to WebSocket.

```text
Connections per server: 50,000 (well-tuned Linux)
Servers needed: 100M / 50K = 2,000 WebSocket servers

Message fan-out:
- Popular workspace with 10,000 members
- One file upload = 10,000 WebSocket messages
- Need efficient pub/sub
```

**Architecture**:

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    Notification Architecture                         │
└─────────────────────────────────────────────────────────────────────┘

File Service
    │
    ├─── [file change event] ──────────────────────┐
    │                                              │
    ▼                                              ▼
Redis Pub/Sub                               Kafka (durability)
(real-time, fire-and-forget)               (catchup on reconnect)
    │                                              │
    ├─────────────────┬─────────────────┐         │
    ▼                 ▼                 ▼         │
┌─────────┐     ┌─────────┐     ┌─────────┐      │
│  WS 1   │     │  WS 2   │     │  WS N   │      │
│ (50K)   │     │ (50K)   │     │ (50K)   │      │
└────┬────┘     └────┬────┘     └────┬────┘      │
     │               │               │           │
     └───────────────┴───────────────┘           │
                     │                           │
              Connected clients                  │
                     │                           │
                     └─── [catchup on reconnect] ┘
```

**Graceful degradation**:

```python
class NotificationService:
    async def notify(self, user_ids: list[str], event: dict):
        # Try WebSocket first (real-time)
        for user_id in user_ids:
            if user_id in self.active_connections:
                try:
                    await self.send_ws(user_id, event)
                except:
                    # Fall back to push notification
                    await self.send_push(user_id, event)
            else:
                # User offline — they'll catch up on next sync
                pass
    
    async def send_push(self, user_id: str, event: dict):
        # Mobile push for high-priority events
        if event["priority"] == "high":
            await apns.send(user_id, f"New file: {event['file_name']}")
```

---

## 7. Production Operations

### 🟢 Beginner — The Hospital Monitoring Room

A hospital has a monitoring room where nurses watch vital signs of all patients. If a heart rate spikes or drops, an alarm sounds.

Running a file storage system is similar. Engineers watch dashboards showing:
- How many files are being uploaded (heart rate)
- How fast downloads are (blood pressure)
- Any errors happening (fever)

When something goes wrong, alerts trigger and engineers respond.

---

### 🟡 Senior — Key Metrics and Alerts

```yaml
# Prometheus alerting rules
groups:
  - name: file-storage
    rules:
      - alert: HighUploadErrorRate
        expr: rate(upload_errors_total[5m]) / rate(upload_requests_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Upload error rate > 1%"
      
      - alert: SyncQueueBacklog
        expr: sync_queue_depth > 100000
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Sync queue backlog exceeds 100K events"
      
      - alert: S3LatencyHigh
        expr: histogram_quantile(0.99, rate(s3_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "S3 p99 latency > 2 seconds"
      
      - alert: MetadataDBConnectionPoolExhausted
        expr: pg_stat_activity_count / pg_connections_max > 0.9
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL connection pool > 90% utilized"
```

**Grafana dashboard panels**:

| Panel | Query | Purpose |
|-------|-------|---------|
| Upload throughput | `rate(uploads_total[5m])` | Traffic baseline |
| Upload latency p99 | `histogram_quantile(0.99, ...)` | User experience |
| Sync latency | `sync_changes_latency_seconds` | Client freshness |
| Storage growth | `sum(chunk_size_bytes_total)` | Capacity planning |
| Dedup ratio | `logical_bytes / physical_bytes` | Efficiency |
| Error rate by endpoint | `rate(errors{endpoint=~".*"})` | Debugging |

---

### 🔴 Architect — Incident Response

**Incident: Data corruption detected**

```markdown
## Runbook: Chunk Hash Mismatch

### Symptoms
- Clients reporting "download failed: integrity check error"
- Alert: `chunk_verification_failures > 0`

### Immediate Actions
1. Identify affected chunks:
   SELECT chunk_hash, last_verified_at, error
   FROM verification_failures
   WHERE detected_at > NOW() - INTERVAL '1 hour';

2. Check if corruption is widespread:
   - Single chunk: likely bit rot
   - Many chunks: possible storage system issue

3. Attempt recovery from replica:
   for chunk in affected_chunks:
     for region in replica_regions:
       replica_hash = compute_hash(s3[region].get(chunk))
       if replica_hash == chunk:
         s3_primary.put(chunk, s3[region].get(chunk))
         mark_recovered(chunk)
         break

4. If no good replica:
   - Mark affected files as "potentially corrupted"
   - Notify affected users
   - Check S3 CloudTrail for unauthorized access

### Post-Incident
- Enable S3 Object Lock for immutability
- Increase verification frequency
- Review encryption and access policies
```

**Capacity planning**:

```text
Current state:
- 500 PB stored
- Growing 2% per month
- Current cost: $10M/month

Forecast (12 months):
- 500 PB × 1.02^12 = 635 PB
- Need to provision 135 PB additional capacity
- Consider cold storage tiering for older data

Cost optimization:
- Move 200 PB (versions > 90 days) to S3 Glacier: 60% savings
- Improve dedup ratio from 3x to 4x: 25% storage reduction
- Total projected savings: $2M/month
```

---

## 8. Real-World Case Studies

### Dropbox's Magic Pocket

**Challenge**: S3 costs were unsustainable at Dropbox's scale.

**Solution**: Built custom blob storage "Magic Pocket."

```text
Architecture:
- Custom storage software on commodity hardware
- 3-way replication across data centers
- Reed-Solomon erasure coding for durability
- Block-level encryption with per-user keys

Results:
- 10x cost reduction vs S3
- 99.999999999% (11 nines) durability
- 500+ PB stored
```

**Key insight**: At sufficient scale, building your own infrastructure is cheaper than cloud.

---

### Google Drive's Operational Transform

**Challenge**: Real-time collaborative editing (Google Docs) on top of Drive.

**Solution**: Operational Transform (OT) for conflict-free concurrent edits.

```javascript
// Simplified OT example
// Two users typing at position 5 simultaneously

// User A: insert "hello" at position 5
// User B: insert "world" at position 5

// Without OT: Both overwrite each other

// With OT: Transform operations
// User A's "hello" at 5 is applied first
// User B's "world" must be transformed: insert at 5 + 5 = 10

function transform(op1, op2) {
  if (op1.position <= op2.position) {
    op2.position += op1.text.length;
  }
  return op2;
}
```

**Key insight**: OT is document-specific. Works great for text, harder for binary files.

---

### Sync.com: Zero-Knowledge Encryption

**Challenge**: Provide end-to-end encryption while supporting sharing.

**Solution**: Key hierarchy with client-side encryption.

```text
Key structure:
- User has master key (derived from password)
- Each folder has unique data key
- Data key encrypted with owner's public key
- To share: decrypt data key, re-encrypt with recipient's public key
- Server never sees plaintext keys

Tradeoff:
- Lose password = lose all data (no recovery)
- No server-side search
- Slower than unencrypted (encryption overhead)
```

---

## Quick Recall Cheat Sheet {#cheat-sheet}

| Concept | One-Line Recall |
|---------|----------------|
| Metadata vs content | File names/permissions in PostgreSQL, bytes in S3 |
| Chunking | Split into 4 MB pieces, hash each, upload individually |
| Content-addressable | Store by SHA-256 hash → same content = same key = dedup |
| CDC | Rolling hash to find chunk boundaries based on content, not position |
| Chunk manifest | Ordered list of chunk hashes = file recipe |
| Presigned URL | Time-limited S3 URL, client uploads directly, bypasses API |
| Sync cursor | Opaque server sequence ID, client says "changes since X" |
| Delta sync | Only transfer changed chunks, not whole file |
| Conflict resolution | Fork (Dropbox) > last-write-wins (data loss) |
| Reference counting | Track chunk usage, delete when count = 0 + grace period |
| Permission inheritance | Subfolder gets parent's permissions automatically |
| Files on-demand | Placeholder until opened, then download (Cloud Files API) |
| Full_path denormalization | Store complete path for fast search, update on move |
| Shard by workspace_id | All files in workspace on same shard, simple queries |
| GC grace period | Wait 24-72 hours before deleting chunks |
| Dedup ratio | logical_bytes / physical_bytes, typically 2.5-4x |
| WebSocket scale | 50K connections per server, use Redis Pub/Sub for fan-out |
| Bit rot detection | Periodic background job re-hashes chunks, compares |
