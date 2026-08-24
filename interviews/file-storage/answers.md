# Answers: Google Drive / Dropbox (File Sync & Storage)

> Keyed to [questions.md](./questions.md). Read questions first.
> Code examples use Python/TypeScript where helpful.

---

## Level 1 — File Storage Fundamentals

### A1. Metadata vs Content Separation

Separating metadata from content allows each to be stored in the optimal system:

| Aspect | Metadata | Content |
|--------|----------|---------|
| Examples | File name, size, owner, permissions, folder path, versions | Actual file bytes |
| Read pattern | Frequent, small queries (list folder, check permissions) | Infrequent, large reads (download) |
| Write pattern | Frequent, small updates (rename, move) | Write-once, append-only (new versions) |
| Storage | PostgreSQL (transactional, indexed, relational) | S3 / Blob storage (cheap, durable, scalable) |
| Consistency | Strong consistency needed | Eventual consistency acceptable |

If you store file bytes in PostgreSQL, you waste expensive SSD storage on immutable blobs, and queries become slow. If you store metadata in S3, you lose the ability to do efficient folder listings and permission checks.

---

### A2. Metadata vs Content Operations

| Operation | Touches Metadata? | Touches Content? |
|-----------|-------------------|------------------|
| Rename to avatar.jpg | ✅ Yes (update `name` column) | ❌ No |
| Share with friend | ✅ Yes (insert permission row) | ❌ No |
| Upload original file | ✅ Yes (create metadata row) | ✅ Yes (write bytes to S3) |

Once bytes are in blob storage, they're immutable. All subsequent operations (rename, move, share) are pure metadata operations.

---

### A3. Why Blob Storage for Large Files

Blob storage (S3, GCS, Azure Blob) is object storage optimized for:

| Feature | Why It Matters for Files |
|---------|-------------------------|
| Infinite scale | Store petabytes without provisioning |
| Pay-per-GB | Only pay for what you use |
| 11 nines durability | Data replicated across multiple facilities |
| Presigned URLs | Clients upload/download directly, offloading your servers |
| Multipart upload | Upload 5 TB files in parallel chunks |

MySQL/PostgreSQL would require you to manage disk provisioning, backups, and scaling — all solved problems with S3.

---

### A4. Resumable Uploads

**Approach: Chunked upload with server-side session**

```python
# Client-side pseudocode
def upload_large_file(file_path):
    # 1. Initialize upload session
    session = api.post("/upload/init", {
        "fileName": file_path.name,
        "totalSize": file_path.size,
        "chunkSize": 4 * 1024 * 1024  # 4 MB
    })
    
    # 2. Upload chunks (can resume from last successful chunk)
    for i, chunk in enumerate(file_path.read_chunks(4 * 1024 * 1024)):
        if not session.chunk_uploaded[i]:  # Skip already uploaded
            api.put(session.chunk_upload_urls[i], chunk)
    
    # 3. Finalize
    api.post(f"/upload/{session.id}/complete")
```

<details>
<summary>☕ <b>Java</b> — FileChannel streams — never Files.readAllBytes on a large file</summary>

```java
// Client-side
void uploadLargeFile(Path filePath) throws IOException {
    long size = Files.size(filePath);
    int  chunkSize = 4 * 1024 * 1024;                 // 4 MB

    // 1. Initialize upload session
    UploadSession session = api.post("/upload/init",
            new InitRequest(filePath.getFileName().toString(), size, chunkSize));

    // 2. Upload chunks — resumable, skip what already landed
    try (FileChannel channel = FileChannel.open(filePath, READ)) {
        ByteBuffer buf = ByteBuffer.allocate(chunkSize);
        for (int i = 0; channel.read(buf) > 0; i++, buf.clear()) {
            if (session.chunkUploaded(i)) continue;   // resume
            buf.flip();
            api.put(session.chunkUploadUrl(i), buf);
        }
    }

    // 3. Finalize
    api.post("/upload/" + session.id() + "/complete");
}
```

</details>


Server tracks which chunks arrived. Client remembers last uploaded chunk index. After network failure, client queries server for missing chunks and resumes.

---

### A5. File Identification — UUID vs Content Hash

| Approach | UUID (random) | Content Hash (SHA-256) |
|----------|--------------|------------------------|
| Uniqueness | Always unique | Same file = same hash |
| Deduplication | Not possible | Free — same hash = don't upload |
| Integrity | None | Hash mismatch = corrupted |
| Upload check | Must always upload | "I have chunk abc123" → Server: "Already have it, skip" |

**Content hash is superior** because it enables deduplication and integrity verification. Dropbox saved 75%+ storage through deduplication in their early days.

---

## Level 2 — Upload Pipeline

### A6. Chunked Upload Process

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    Chunked Upload Flow                               │
└─────────────────────────────────────────────────────────────────────┘

Client                         Server                         S3
  │                              │                             │
  ├─── POST /upload/init ───────►│                             │
  │    {fileName, totalSize}     │                             │
  │                              │                             │
  │◄── UploadSession ────────────┤                             │
  │    {sessionId,               │                             │
  │     chunkUploadUrls[]}       │                             │
  │                              │                             │
  ├─── PUT presigned URL ────────┼────────────────────────────►│
  │    [Chunk 0 bytes]           │                             │
  │                              │                             │
  ├─── PUT presigned URL ────────┼────────────────────────────►│
  │    [Chunk 1 bytes]           │                             │
  │         ...                  │                             │
  │                              │                             │
  ├─── POST /upload/complete ───►│                             │
  │    {chunkHashes[]}           │                             │
  │                              ├─── Verify all chunks ──────►│
  │◄── FileMetadata ─────────────┤                             │
```

**Why chunk?**
- Resume broken uploads
- Parallel upload (upload chunks concurrently)
- Server can reject bad chunks individually
- Deduplication at chunk level

---

### A7. Presigned URLs

A presigned URL is a time-limited, pre-authenticated URL to S3. It embeds the access credentials in the URL itself.

```python
import boto3

s3 = boto3.client('s3')

presigned_url = s3.generate_presigned_url(
    'put_object',
    Params={'Bucket': 'my-bucket', 'Key': 'chunk-abc123'},
    ExpiresIn=3600  # 1 hour
)

# Client uploads directly to this URL:
# PUT https://my-bucket.s3.amazonaws.com/chunk-abc123?X-Amz-Signature=...
```

<details>
<summary>☕ <b>Java</b> — AWS SDK v2</summary>

```java
// AWS SDK v2 presigner
S3Presigner presigner = S3Presigner.create();

PutObjectRequest putReq = PutObjectRequest.builder()
        .bucket("my-bucket")
        .key("chunk-abc123")
        .build();

PutObjectPresignRequest presignReq = PutObjectPresignRequest.builder()
        .signatureDuration(Duration.ofHours(1))
        .putObjectRequest(putReq)
        .build();

String presignedUrl = presigner.presignPutObject(presignReq).url().toString();

// The client PUTs directly to this URL — bytes never touch our servers.
```

</details>


**Why presigned URLs?**
- API servers don't proxy gigabytes of data
- Reduces API server load by 99%
- S3 handles throughput, throttling, and retries
- Secure — URL expires, can't be reused

---

### A8. Finalize Upload / Chunk Ordering

Server maintains an `UploadSession`:

```python
class UploadSession:
    session_id: str
    user_id: str
    file_name: str
    total_size: int
    chunk_size: int
    expected_chunk_count: int
    chunks_received: set[int]  # indices
    chunk_hashes: dict[int, str]  # index → hash
    created_at: datetime
    expires_at: datetime  # Cleanup incomplete sessions

def complete_upload(session_id: str, client_chunk_hashes: list[str]):
    session = get_session(session_id)
    
    # Verify all chunks arrived
    if len(session.chunks_received) != session.expected_chunk_count:
        raise MissingChunksError(missing=...)
    
    # Verify hashes match (client-computed vs server-computed)
    for i, expected_hash in enumerate(client_chunk_hashes):
        if session.chunk_hashes[i] != expected_hash:
            raise ChunkIntegrityError(chunk=i)
    
    # Create file version with chunk manifest
    version = FileVersion(
        file_id=session.file_id,
        chunk_manifest=[session.chunk_hashes[i] for i in range(session.expected_chunk_count)]
    )
    db.save(version)
```

<details>
<summary>☕ <b>Java</b> — note .equals — == on Strings would be a real bug here</summary>

```java
record UploadSession(String sessionId,
                     String userId,
                     String fileName,
                     long   totalSize,
                     int    chunkSize,
                     int    expectedChunkCount,
                     Set<Integer> chunksReceived,
                     Map<Integer, String> chunkHashes,
                     Instant createdAt,
                     Instant expiresAt) {}     // expiry cleans up abandoned uploads

void completeUpload(String sessionId, List<String> clientChunkHashes) {
    UploadSession session = getSession(sessionId);

    // Verify all chunks arrived
    if (session.chunksReceived().size() != session.expectedChunkCount()) {
        throw new MissingChunksError(missingIndices(session));
    }

    // Verify hashes match (client-computed vs server-computed)
    for (int i = 0; i < clientChunkHashes.size(); i++) {
        if (!session.chunkHashes().get(i).equals(clientChunkHashes.get(i))) {
            throw new ChunkIntegrityError(i);
        }
    }

    // A file IS its manifest of chunk hashes.
    List<String> manifest = IntStream.range(0, session.expectedChunkCount())
            .mapToObj(session.chunkHashes()::get)
            .toList();

    db.save(new FileVersion(session.fileId(), manifest));
}
```

</details>


The `chunk_manifest` is an ordered list of chunk hashes. Download reverses this — fetch chunks in order and concatenate.

---

### A9. Where to Compute Hash — Client vs Server

**Answer: Both, for different purposes.**

| Location | Purpose |
|----------|---------|
| Client (before upload) | Deduplication check — "Do you already have this chunk?" |
| Server (after upload) | Integrity verification — "Did the bytes arrive correctly?" |

```text
Client: "I want to upload chunk with hash abc123"
Server: "I already have abc123, skip upload"  ← Dedup

Client: uploads bytes
Server: computes hash → xyz789
Server: "Hash mismatch! Expected abc123, got xyz789"  ← Corruption detected
```

If you only hash on server, you can't do dedup. If you only hash on client, you can't detect corruption.

---

### A10. Detecting Upload Corruption

**End-to-end integrity**:

```python
# Client side
def upload_chunk(chunk_bytes):
    expected_hash = sha256(chunk_bytes).hexdigest()
    
    # Upload with checksum header
    response = requests.put(
        presigned_url,
        data=chunk_bytes,
        headers={
            "Content-MD5": base64_md5(chunk_bytes),  # S3 built-in check
            "x-amz-checksum-sha256": expected_hash
        }
    )
    
    return expected_hash

# Server side (finalize)
def verify_chunk(chunk_key, expected_hash):
    actual_hash = s3.head_object(Bucket=BUCKET, Key=chunk_key)['ChecksumSHA256']
    if actual_hash != expected_hash:
        raise CorruptionError()
```

<details>
<summary>☕ <b>Java</b> — HexFormat (Java 17+) replaces manual hex encoding</summary>

```java
// Client side
String uploadChunk(byte[] chunkBytes) throws Exception {
    MessageDigest sha = MessageDigest.getInstance("SHA-256");
    String expectedHash = HexFormat.of().formatHex(sha.digest(chunkBytes));

    HttpRequest request = HttpRequest.newBuilder(URI.create(presignedUrl))
            .header("Content-MD5", base64Md5(chunkBytes))          // S3 built-in check
            .header("x-amz-checksum-sha256", expectedHash)
            .PUT(HttpRequest.BodyPublishers.ofByteArray(chunkBytes))
            .build();

    httpClient.send(request, BodyHandlers.discarding());
    return expectedHash;
}

// Server side (finalize)
void verifyChunk(String chunkKey, String expectedHash) {
    HeadObjectResponse head = s3.headObject(HeadObjectRequest.builder()
            .bucket(BUCKET).key(chunkKey).build());

    if (!expectedHash.equals(head.checksumSHA256())) {
        throw new CorruptionError(chunkKey);
    }
}
```

</details>


S3's `Content-MD5` header provides transport-level integrity. Your application-level SHA-256 provides end-to-end integrity.

---

## Level 3 — Content-Addressable Storage

### A11. Deduplication with Content Hash

```python
def store_chunk(chunk_bytes: bytes) -> str:
    chunk_hash = sha256(chunk_bytes).hexdigest()
    
    # Check if already exists
    if s3.object_exists(BUCKET, chunk_hash):
        # Increment reference count (for garbage collection)
        db.execute("UPDATE chunks SET ref_count = ref_count + 1 WHERE hash = ?", chunk_hash)
        return chunk_hash  # Skip upload
    
    # New unique chunk — upload
    s3.put_object(Bucket=BUCKET, Key=chunk_hash, Body=chunk_bytes)
    db.execute("INSERT INTO chunks (hash, ref_count) VALUES (?, 1)", chunk_hash)
    
    return chunk_hash
```

<details>
<summary>☕ <b>Java</b> — the UPDATE-first form avoids a check-then-act race</summary>

```java
String storeChunk(byte[] chunkBytes) throws Exception {
    MessageDigest sha = MessageDigest.getInstance("SHA-256");
    String chunkHash = HexFormat.of().formatHex(sha.digest(chunkBytes));

    // Already stored? Just take another reference — this is the dedup win.
    int updated = jdbc.update(
            "UPDATE chunks SET ref_count = ref_count + 1 WHERE hash = ?", chunkHash);

    if (updated > 0) {
        return chunkHash;                       // Skip upload entirely
    }

    // New unique chunk — upload, then record with ref_count = 1
    s3.putObject(PutObjectRequest.builder().bucket(BUCKET).key(chunkHash).build(),
                 RequestBody.fromBytes(chunkBytes));
    jdbc.update("INSERT INTO chunks (hash, ref_count) VALUES (?, 1)", chunkHash);

    return chunkHash;
}
```

</details>


Two users uploading the same 4 GB movie both produce the same hash. Server stores one copy. Both users' file metadata points to the same chunks.

**Dropbox claims**: In 2013, 75% of uploads were skipped due to deduplication.

---

### A12. Chunk Manifest

A file is a sequence of chunks:

```json
{
  "file_id": "file_xyz",
  "version": 5,
  "size_bytes": 104857600,
  "chunk_manifest": [
    "a1b2c3d4e5f6...",  // Chunk 0
    "b2c3d4e5f6a1...",  // Chunk 1
    "c3d4e5f6a1b2...",  // Chunk 2
    // ... 24 more chunks for 100 MB file
  ]
}
```

**Download flow**:
1. Client requests `/files/{fileId}/download`
2. Server returns manifest + presigned URLs for each chunk
3. Client downloads chunks in parallel
4. Client concatenates in order
5. Client verifies full-file hash matches

---

### A13. Fixed-Size Chunking Problem

```text
Original file (100 MB, 25 chunks of 4 MB each):
[Chunk0][Chunk1][Chunk2][Chunk3]...[Chunk24]

User B inserts 10 bytes at the beginning:
[---------- ALL CHUNKS SHIFT BY 10 BYTES ----------]
[Chunk0'][Chunk1'][Chunk2'][Chunk3']...[Chunk24']

All 25 chunks have different content → all 25 hashes change → upload 100 MB!
```

Fixed-size chunking is **position-sensitive**. Any insertion shifts all subsequent chunk boundaries.

---

### A14. Content-Defined Chunking (CDC)

CDC uses a **rolling hash** (Rabin fingerprint) to find chunk boundaries based on content patterns, not position.

```python
def cdc_chunk(data: bytes, avg_chunk_size=4*1024*1024):
    """
    Creates chunks at "natural boundaries" based on content.
    Inserting data shifts only adjacent chunks, not all.
    """
    window_size = 48
    min_chunk = avg_chunk_size // 4
    max_chunk = avg_chunk_size * 4
    mask = (1 << 22) - 1  # Tune for avg size
    
    chunks = []
    chunk_start = 0
    rolling_hash = 0
    
    for i in range(len(data)):
        rolling_hash = rabin_fingerprint(data[i-window_size:i])
        
        chunk_len = i - chunk_start
        if chunk_len >= min_chunk and (rolling_hash & mask) == 0:
            # Natural boundary found
            chunks.append(data[chunk_start:i])
            chunk_start = i
        elif chunk_len >= max_chunk:
            # Force boundary
            chunks.append(data[chunk_start:i])
            chunk_start = i
    
    return chunks
```

<details>
<summary>☕ <b>Java</b> — and it keeps the trailing chunk the Python version drops</summary>

```java
/**
 * Content-defined chunking. Boundaries follow the CONTENT, so inserting a
 * byte at the front shifts one chunk, not every chunk after it.
 */
List<byte[]> cdcChunk(byte[] data, int avgChunkSize) {
    int windowSize = 48;
    int minChunk   = avgChunkSize / 4;
    int maxChunk   = avgChunkSize * 4;
    int mask       = (1 << 22) - 1;             // tune for average size

    List<byte[]> chunks = new ArrayList<>();
    int chunkStart = 0;

    for (int i = windowSize; i < data.length; i++) {
        long rollingHash = rabinFingerprint(data, i - windowSize, i);
        int  chunkLen    = i - chunkStart;

        boolean naturalBoundary = chunkLen >= minChunk && (rollingHash & mask) == 0;
        boolean forcedBoundary  = chunkLen >= maxChunk;

        if (naturalBoundary || forcedBoundary) {
            chunks.add(Arrays.copyOfRange(data, chunkStart, i));
            chunkStart = i;
        }
    }
    if (chunkStart < data.length) {
        chunks.add(Arrays.copyOfRange(data, chunkStart, data.length));  // tail
    }
    return chunks;
}
```

</details>


**Result**: Insert 10 bytes → only 1-2 chunks change (local disruption, not global).

Dropbox, Restic, and Borg backup use this technique.

---

### A15. Reference Counting for Chunk Deletion

**Problem**: Chunk X is referenced by files from 1 million users. User A deletes their file. You can't delete chunk X — 999,999 users still need it.

```python
class ChunkGarbageCollector:
    def decrement_reference(self, chunk_hash: str):
        # Atomic decrement
        result = db.execute("""
            UPDATE chunks 
            SET ref_count = ref_count - 1 
            WHERE hash = ?
            RETURNING ref_count
        """, chunk_hash)
        
        if result.ref_count == 0:
            # Safe to delete — but use delayed deletion!
            self.schedule_deletion(chunk_hash, delay_hours=24)
    
    def schedule_deletion(self, chunk_hash, delay_hours):
        # Don't delete immediately — race condition protection
        #  - Upload completes but ref_count update hasn't propagated
        #  - Restoring from backup
        queue.send({
            "action": "delete_chunk",
            "chunk_hash": chunk_hash,
            "delete_after": now() + timedelta(hours=delay_hours)
        })
    
    def process_deletion(self, chunk_hash):
        # Re-check before deleting
        ref_count = db.query("SELECT ref_count FROM chunks WHERE hash = ?", chunk_hash)
        if ref_count == 0:
            s3.delete_object(Bucket=BUCKET, Key=chunk_hash)
            db.execute("DELETE FROM chunks WHERE hash = ?", chunk_hash)
```

<details>
<summary>☕ <b>Java</b> — same two-phase delete</summary>

```java
class ChunkGarbageCollector {

    void decrementReference(String chunkHash) {
        // Atomic decrement + read in one statement.
        Integer refCount = jdbc.queryForObject("""
                UPDATE chunks SET ref_count = ref_count - 1
                WHERE hash = ?
                RETURNING ref_count
                """, Integer.class, chunkHash);

        if (refCount != null && refCount == 0) {
            scheduleDeletion(chunkHash, Duration.ofHours(24));   // delayed, never immediate
        }
    }

    /**
     * Never delete immediately. An upload racing the ref-count update, or a
     * restore from backup, can resurrect a chunk that looked orphaned.
     */
    void scheduleDeletion(String chunkHash, Duration delay) {
        queue.send(new DeleteChunkJob(chunkHash, Instant.now().plus(delay)));
    }

    void processDeletion(String chunkHash) {
        // Re-check before deleting — the grace period exists for a reason.
        Integer refCount = jdbc.queryForObject(
                "SELECT ref_count FROM chunks WHERE hash = ?", Integer.class, chunkHash);

        if (refCount != null && refCount == 0) {
            s3.deleteObject(DeleteObjectRequest.builder()
                    .bucket(BUCKET).key(chunkHash).build());
            jdbc.update("DELETE FROM chunks WHERE hash = ?", chunkHash);
        }
    }
}
```

</details>


**What can go wrong**:
- Race condition: File upload increments ref_count while GC process reads 0
- Solution: Delayed deletion (24-hour grace period)
- Solution: Two-phase deletion (mark deleted → wait → actually delete)

---

## Level 4 — Sync Protocol

### A16. Conflict Resolution Strategies

| Strategy | Pros | Cons |
|----------|------|------|
| Last-write-wins | Simple | Silently loses data |
| Fork (conflicted copy) | Preserves all data | User must manually merge |
| Operational Transform (OT) | Real-time merge | Complex, document-specific |
| CRDT | Automatic merge | Works only for specific data types |

**Dropbox approach (fork)**:

```text
File: report.docx
  └── Original version: v3

User A offline: edits → saves v4-A at 10:00
User B online: edits → saves v4-B at 10:05

When A comes online:
  report.docx → v4-B (server wins for original filename)
  report (conflicted copy from A's laptop).docx → v4-A
```

**Last-write-wins is DANGEROUS** for file storage. User thinks they saved their work but it's overwritten. Law firm loses contract changes. Unacceptable.

---

### A17. Sync Changes API Design

```python
@app.get("/sync/changes")
async def get_sync_changes(
    cursor: str = Query(None),  # Opaque server timestamp/sequence
    limit: int = Query(100, max=1000)
):
    """
    Returns changes since cursor.
    Cursor is a server-side event sequence number.
    """
    if cursor is None:
        # Initial sync — return all files
        changes = db.query("""
            SELECT * FROM sync_events 
            WHERE user_id = ?
            ORDER BY sequence_id ASC
            LIMIT ?
        """, user_id, limit)
    else:
        cursor_seq = decode_cursor(cursor)
        changes = db.query("""
            SELECT * FROM sync_events 
            WHERE user_id = ? AND sequence_id > ?
            ORDER BY sequence_id ASC
            LIMIT ?
        """, user_id, cursor_seq, limit)
    
    return {
        "changes": [
            {
                "type": c.event_type,  # created, modified, deleted, moved
                "file_id": c.file_id,
                "path": c.path,
                "parent_id": c.parent_id,
                "content_hash": c.content_hash,
                "modified_at": c.modified_at,
                "size_bytes": c.size_bytes
            }
            for c in changes
        ],
        "cursor": encode_cursor(changes[-1].sequence_id) if changes else cursor,
        "has_more": len(changes) == limit
    }
```

<details>
<summary>☕ <b>Java</b> — one query handles both the initial and incremental case</summary>

```java
@GetMapping("/sync/changes")
SyncResponse getSyncChanges(
        @RequestParam(required = false) String cursor,
        @RequestParam(defaultValue = "100") int limit,
        @AuthenticationPrincipal User user) {

    limit = Math.min(limit, 1000);

    // A cursor names a POSITION in the event log. Never an offset.
    long cursorSeq = (cursor == null) ? -1 : decodeCursor(cursor);

    List<SyncEvent> changes = jdbc.query("""
            SELECT * FROM sync_events
            WHERE user_id = ? AND sequence_id > ?
            ORDER BY sequence_id ASC
            LIMIT ?
            """, syncEventMapper, user.id(), cursorSeq, limit);

    String nextCursor = changes.isEmpty()
            ? cursor
            : encodeCursor(changes.get(changes.size() - 1).sequenceId());

    return new SyncResponse(
            changes.stream().map(ChangeDto::from).toList(),
            nextCursor,
            changes.size() == limit);      // has_more
}
```

</details>


---

### A18. Desktop File System Monitoring

| OS | Mechanism | Pitfalls |
|-----|-----------|----------|
| macOS | FSEvents | Coalesces events, may miss intermediate states |
| Windows | ReadDirectoryChangesW | Buffer overflow under heavy load |
| Linux | inotify | Limited watch descriptors (default 8192) |

```python
# Example with watchdog (Python cross-platform)
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

class SyncHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory:
            sync_queue.put({"type": "create", "path": event.src_path})
    
    def on_modified(self, event):
        # De-bounce: editors save multiple times
        debounce_and_queue(event)
    
    def on_moved(self, event):
        sync_queue.put({"type": "move", "old": event.src_path, "new": event.dest_path})

# Pitfall: Large folder moves generate thousands of events
# Solution: Detect directory move, treat as single operation
```

<details>
<summary>☕ <b>Java</b> — WatchService — and the two places it differs from watchdog</summary>

```java
// java.nio.file.WatchService is the JDK's built-in equivalent of watchdog.
WatchService watcher = FileSystems.getDefault().newWatchService();
syncRoot.register(watcher, ENTRY_CREATE, ENTRY_MODIFY, ENTRY_DELETE);

while (true) {
    WatchKey key = watcher.take();                 // blocks

    for (WatchEvent<?> event : key.pollEvents()) {
        Path path = syncRoot.resolve((Path) event.context());

        if (event.kind() == ENTRY_CREATE) {
            syncQueue.put(new Change("create", path));
        } else if (event.kind() == ENTRY_MODIFY) {
            debounceAndQueue(path);                // editors save several times
        } else if (event.kind() == ENTRY_DELETE) {
            syncQueue.put(new Change("delete", path));
        }
    }
    key.reset();
}
// Two JDK caveats worth naming: WatchService has NO native rename event
// (you get delete + create and must pair them), and it is not recursive —
// you register every subdirectory yourself.
// Pitfall either way: a large folder move generates thousands of events.
// Detect the directory move and treat it as ONE operation.
```

</details>


---

### A19. Handling Long-Offline Clients

```python
async def sync_long_offline_client(user_id: str, last_cursor: str):
    # Calculate delta size
    event_count = db.query("""
        SELECT COUNT(*) FROM sync_events 
        WHERE user_id = ? AND sequence_id > ?
    """, user_id, decode_cursor(last_cursor))
    
    if event_count > 10000:
        # Full resync is faster than streaming 10K events
        return {"action": "full_resync"}
    
    # Stream changes in batches
    async for batch in stream_changes(user_id, last_cursor, batch_size=500):
        yield batch
        await asyncio.sleep(0.1)  # Rate limit
```

<details>
<summary>☕ <b>Java</b> — same delta-vs-full-resync decision</summary>

```java
void syncLongOfflineClient(String userId, String lastCursor, Consumer<Batch> sink) {
    Long eventCount = jdbc.queryForObject("""
            SELECT COUNT(*) FROM sync_events
            WHERE user_id = ? AND sequence_id > ?
            """, Long.class, userId, decodeCursor(lastCursor));

    if (eventCount != null && eventCount > 10_000) {
        // Replaying 10K deltas costs more than sending current state.
        sink.accept(Batch.fullResync());
        return;
    }

    // Stream changes in batches, rate-limited so one client can't
    // monopolize the sync tier.
    streamChanges(userId, lastCursor, 500).forEach(batch -> {
        sink.accept(batch);
        sleepQuietly(Duration.ofMillis(100));
    });
}
```

</details>


**Backoff strategy**:
- First sync: 100 changes per request
- If >1000 pending: Reduce to 50, add 500ms delay
- If >10000 pending: Full resync (download all metadata)

---

### A20. Conflict Resolution Flow

```text
┌─────────────────────────────────────────────────────────────────────┐
│                     Conflict Resolution Flow                         │
└─────────────────────────────────────────────────────────────────────┘

Client Local State          Server State
  file.docx                   file.docx
  hash: H1                    hash: H2
  modified: 10:00 AM          modified: 10:05 AM
      │                           │
      └───────────┬───────────────┘
                  ▼
           Client pushes H1
                  │
                  ▼
        Server detects conflict:
        - Server has H2 (newer)
        - Client pushing H1 (older base)
                  │
                  ▼
        Server response:
        {
          "status": "conflict",
          "server_version": {
            "hash": "H2",
            "modified": "10:05"
          }
        }
                  │
                  ▼
        Client creates fork:
        - Downloads H2 → file.docx
        - Renames local H1 → file (conflicted copy from Laptop).docx
                  │
                  ▼
        Client uploads conflicted copy as new file
```

---

## Level 5 — Sharing & Permissions

### A21. Permission Storage and Checking

```sql
CREATE TABLE share_permissions (
    permission_id UUID PRIMARY KEY,
    resource_id UUID NOT NULL,           -- file_id or folder_id
    resource_type VARCHAR(10) NOT NULL,  -- 'file' or 'folder'
    grantee_id UUID,                     -- NULL for public link
    grantee_type VARCHAR(20),            -- 'user', 'group', 'anyone_with_link'
    permission_level VARCHAR(10),        -- 'view', 'comment', 'edit', 'owner'
    share_token VARCHAR(64),             -- For link sharing
    created_at TIMESTAMP
);

CREATE INDEX idx_permissions_resource ON share_permissions(resource_id);
CREATE INDEX idx_permissions_grantee ON share_permissions(grantee_id);
CREATE INDEX idx_permissions_token ON share_permissions(share_token);
```

```python
async def check_permission(user_id: str, file_id: str, required: str) -> bool:
    # 1. Check cache first (Redis)
    cache_key = f"perm:{user_id}:{file_id}"
    cached = await redis.get(cache_key)
    if cached:
        return permission_level_allows(cached, required)
    
    # 2. Check direct permission
    direct = await db.query("""
        SELECT permission_level FROM share_permissions
        WHERE resource_id = ? AND grantee_id = ?
    """, file_id, user_id)
    
    # 3. Check inherited permissions (walk up folder tree)
    if not direct:
        folder_id = await get_parent_folder(file_id)
        while folder_id:
            inherited = await db.query(...)
            if inherited:
                return permission_level_allows(inherited, required)
            folder_id = await get_parent_folder(folder_id)
    
    # 4. Cache result (5 minutes)
    await redis.setex(cache_key, 300, direct or 'none')
    
    return permission_level_allows(direct, required)
```

<details>
<summary>☕ <b>Java</b> — caching the negative result too — the Python version doesn't</summary>

```java
boolean checkPermission(String userId, String fileId, Permission required) {
    // 1. Cache first — permission checks are on every single request.
    String cacheKey = "perm:" + userId + ":" + fileId;
    String cached = jedis.get(cacheKey);
    if (cached != null) {
        return Permission.valueOf(cached).allows(required);
    }

    // 2. Direct grant on the file itself
    Optional<Permission> direct = jdbc.query("""
            SELECT permission_level FROM share_permissions
            WHERE resource_id = ? AND grantee_id = ?
            """, permissionMapper, fileId, userId).stream().findFirst();

    Permission effective = direct.orElse(null);

    // 3. Otherwise walk up the folder tree
    if (effective == null) {
        String folderId = getParentFolder(fileId);
        while (folderId != null && effective == null) {
            effective = lookupDirect(folderId, userId).orElse(null);
            folderId  = getParentFolder(folderId);
        }
    }

    // 4. Cache the answer — including "none", or misses re-walk the tree.
    jedis.setex(cacheKey, 300, (effective == null ? Permission.NONE : effective).name());

    return effective != null && effective.allows(required);
}
```

</details>


---

### A22. Permission Inheritance

```text
Shared Folder (Carol = edit)
  └── Subfolder (created by Alice)
       └── document.txt (created by Alice)

Question: Can Carol edit document.txt?
Answer: Yes — inherits from parent folder permission.
```

**Implementation options:**

| Approach | Pros | Cons |
|----------|------|------|
| Walk up tree at read time | No denormalization | O(depth) queries per access check |
| Materialize ACLs at write time | O(1) permission check | Complex updates when parent changes |
| Hybrid (cache walks) | Best of both | Cache invalidation complexity |

**Google Drive uses materialized ACLs** — when you share a folder, all descendants immediately get the permission written. But they cache aggressively.

---

### A23. Shareable Links with Revocation

```python
def create_shareable_link(file_id: str, permission_level: str) -> str:
    token = secrets.token_urlsafe(32)  # 256-bit random
    
    db.insert(SharePermission(
        resource_id=file_id,
        grantee_type='anyone_with_link',
        permission_level=permission_level,
        share_token=token,
        created_at=now()
    ))
    
    return f"https://drive.example.com/share/{token}"

def access_via_link(token: str) -> FileMetadata:
    permission = db.query("""
        SELECT * FROM share_permissions
        WHERE share_token = ? AND grantee_type = 'anyone_with_link'
    """, token)
    
    if not permission or permission.revoked_at:
        raise AccessDenied()
    
    return get_file_metadata(permission.resource_id)

def revoke_link(token: str):
    db.execute("""
        UPDATE share_permissions 
        SET revoked_at = NOW()
        WHERE share_token = ?
    """, token)
    
    # Invalidate CDN cache for this token
    cdn.purge(f"/share/{token}")
```

<details>
<summary>☕ <b>Java</b> — SecureRandom, not Random — this token is a credential</summary>

```java
String createShareableLink(String fileId, Permission level) {
    // 256 bits of entropy from a CSPRNG — never Random or UUID.randomUUID
    // for anything that acts as a bearer credential.
    byte[] raw = new byte[32];
    SecureRandom.getInstanceStrong().nextBytes(raw);
    String token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);

    db.insert(new SharePermission(fileId, GranteeType.ANYONE_WITH_LINK,
                                  level, token, Instant.now()));

    return "https://drive.example.com/share/" + token;
}

FileMetadata accessViaLink(String token) {
    SharePermission permission = jdbc.query("""
            SELECT * FROM share_permissions
            WHERE share_token = ? AND grantee_type = 'anyone_with_link'
            """, permMapper, token).stream().findFirst()
            .orElseThrow(AccessDeniedException::new);

    if (permission.revokedAt() != null) throw new AccessDeniedException();

    return getFileMetadata(permission.resourceId());
}

void revokeLink(String token) {
    jdbc.update("UPDATE share_permissions SET revoked_at = NOW() WHERE share_token = ?",
                token);
    cdn.purge("/share/" + token);      // the link may be cached at the edge
}
```

</details>


---

### A24. Offline Edit vs Online Delete Conflict

```text
Timeline:
9 AM UTC: User A deletes file X (server acknowledges)
10 AM UTC: User B (offline since 8 AM) edits file X
12 PM UTC: User B comes online, pushes edit

Server response:
{
  "status": "conflict",
  "reason": "file_deleted",
  "deleted_at": "9:00 AM UTC",
  "deleted_by": "User A"
}

Client options:
1. Recreate file with User B's content (user chooses)
2. Save as new file
3. Discard (user acknowledges data loss)
```

**Key principle**: Never silently lose user data. Always surface conflict to user.

---

### A25. External Sharing Governance Query

```sql
-- Admin query: All files shared externally from organization
SELECT 
    f.file_id,
    f.name,
    f.path,
    sp.grantee_id,
    u.email AS shared_with,
    sp.permission_level,
    sp.created_at AS shared_at,
    owner.email AS file_owner
FROM share_permissions sp
JOIN file_metadata f ON sp.resource_id = f.file_id
JOIN users u ON sp.grantee_id = u.user_id
JOIN users owner ON f.owner_id = owner.user_id
WHERE f.organization_id = 'acme-corp'
  AND u.organization_id != 'acme-corp'  -- External user
  AND sp.revoked_at IS NULL
ORDER BY sp.created_at DESC;
```

For real-time governance, maintain an `external_shares` materialized view updated on every share event.

---

## Level 6 — Offline Support & Mobile

### A26. Offline Mode Operations

| Operation | Supported Offline? | How |
|-----------|-------------------|-----|
| Open/edit local files | ✅ | Cache file content locally |
| Create new files | ✅ | Create locally, queue upload |
| Rename/move files | ✅ | Track in local sync queue |
| Delete files | ✅ | Mark deleted locally, queue |
| View folder structure | ✅ | Cache metadata locally |
| Share files | ❌ | Requires server |
| Search | ❌ (or limited) | Index local files only |

**Local cache**:
```text
~/.dropbox/
├── file_metadata.sqlite    # Local metadata DB
├── sync_queue.sqlite       # Pending operations
├── chunks/                 # Cached file chunks
│   ├── abc123...
│   └── def456...
└── logs/
```

---

### A27. Sync Commit API

```python
@app.post("/sync/commit")
async def commit_changes(changes: list[LocalChange]) -> CommitResult:
    results = []
    
    for change in changes:
        try:
            if change.type == "create":
                # Check for conflicts (file already exists server-side)
                server_file = await db.get_file_by_path(change.path)
                if server_file:
                    results.append({
                        "change_id": change.id,
                        "status": "conflict",
                        "server_version": server_file.version,
                        "action_required": "resolve_conflict"
                    })
                else:
                    # Accept create
                    new_file = await create_file(change)
                    results.append({
                        "change_id": change.id,
                        "status": "accepted",
                        "server_version": new_file.version
                    })
            
            elif change.type == "modify":
                server_file = await db.get_file(change.file_id)
                if server_file.version != change.base_version:
                    # Version conflict
                    results.append({
                        "change_id": change.id,
                        "status": "conflict",
                        "server_version": server_file.version
                    })
                else:
                    # Accept modification
                    new_version = await update_file(change)
                    results.append({"status": "accepted", ...})
                    
        except Exception as e:
            results.append({"status": "error", "error": str(e)})
    
    return {"results": results, "new_cursor": generate_cursor()}
```

<details>
<summary>☕ <b>Java</b> — per-change try/catch: one bad change can't fail the batch</summary>

```java
@PostMapping("/sync/commit")
CommitResult commitChanges(@RequestBody List<LocalChange> changes) {
    List<ChangeResult> results = new ArrayList<>();

    for (LocalChange change : changes) {
        try {
            switch (change.type()) {
                case CREATE -> {
                    FileRecord serverFile = db.getFileByPath(change.path());
                    results.add(serverFile != null
                            ? ChangeResult.conflict(change.id(), serverFile.version())
                            : ChangeResult.accepted(change.id(), createFile(change).version()));
                }
                case MODIFY -> {
                    FileRecord serverFile = db.getFile(change.fileId());
                    // Optimistic concurrency: the client's base version must
                    // still be current, or somebody edited underneath it.
                    results.add(serverFile.version() != change.baseVersion()
                            ? ChangeResult.conflict(change.id(), serverFile.version())
                            : ChangeResult.accepted(change.id(), updateFile(change).version()));
                }
                case DELETE -> results.add(deleteFile(change));
            }
        } catch (Exception e) {
            results.add(ChangeResult.error(change.id(), e.getMessage()));
        }
    }
    return new CommitResult(results, generateCursor());
}
```

</details>


---

### A28. Files On-Demand (Placeholder Files)

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    Files On-Demand Flow                              │
└─────────────────────────────────────────────────────────────────────┘

Finder/Explorer shows:
├── Documents/
│   ├── ☁ report.docx (64 MB)    ← Cloud icon, not downloaded
│   ├── 📄 notes.txt (2 KB)       ← Local, synced
│   └── ☁ video.mp4 (2 GB)        ← Cloud icon

User double-clicks report.docx:
1. OS intercepts open request (via filesystem driver)
2. Dropbox client fetches file on-demand
3. Progress indicator shows download
4. File opens when download completes

Windows: Cloud Files API (StorageProvider)
macOS: File Provider extension
Linux: FUSE filesystem
```

---

### A29. iOS Background Upload

```swift
// iOS: Use URLSession with background configuration
let config = URLSessionConfiguration.background(withIdentifier: "com.dropbox.upload")
config.isDiscretionary = false  // Don't delay
config.sessionSendsLaunchEvents = true  // Wake app on completion

let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)

// Start upload task — survives app suspension
let task = session.uploadTask(with: request, fromFile: fileURL)
task.resume()

// App may be suspended here...

// System wakes app when complete
func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // Handle completion, update sync state
}
```

Server must handle **idempotent uploads** — client might retry after being killed mid-upload.

---

### A30. Smart Sync / Selective Sync

```python
class SmartSyncPolicy:
    def should_keep_local(self, file: FileMetadata, device: Device) -> bool:
        # Recent files — always keep
        if file.last_accessed_at > now() - timedelta(days=7):
            return True
        
        # Pinned by user — always keep
        if file.pinned:
            return True
        
        # Small files — always keep
        if file.size_bytes < 1_000_000:  # 1 MB
            return True
        
        # Check device space
        if device.free_space_bytes < 5_000_000_000:  # < 5 GB free
            # Evict least recently accessed first
            return False
        
        return True
    
    def evict_to_free_space(self, device: Device, needed_bytes: int):
        # Evict oldest accessed files first (that aren't pinned)
        candidates = get_local_files(device, exclude_pinned=True)
        candidates.sort(key=lambda f: f.last_accessed_at)
        
        freed = 0
        for file in candidates:
            if freed >= needed_bytes:
                break
            evict_local_copy(file)  # Keep placeholder, delete content
            freed += file.size_bytes
```

<details>
<summary>☕ <b>Java</b> — note the L suffix — 5_000_000_000 overflows an int</summary>

```java
class SmartSyncPolicy {

    boolean shouldKeepLocal(FileMetadata file, Device device) {
        if (file.lastAccessedAt().isAfter(Instant.now().minus(Duration.ofDays(7)))) {
            return true;                                  // Recent — always keep
        }
        if (file.pinned())                    return true;    // User asked
        if (file.sizeBytes() < 1_000_000)     return true;    // Small — cheap to keep

        // Under space pressure, stop keeping cold large files.
        return device.freeSpaceBytes() >= 5_000_000_000L;     // 5 GB
    }

    void evictToFreeSpace(Device device, long neededBytes) {
        // Evict least recently accessed first, never anything pinned.
        List<FileMetadata> candidates = getLocalFiles(device, false).stream()
                .sorted(Comparator.comparing(FileMetadata::lastAccessedAt))
                .toList();

        long freed = 0;
        for (FileMetadata file : candidates) {
            if (freed >= neededBytes) break;
            evictLocalCopy(file);          // Keep the placeholder, drop the content
            freed += file.sizeBytes();
        }
    }
}
```

</details>


---

## Level 7 — Scale & Performance

### A31. Garbage Collection for Orphaned Chunks

```python
class ChunkGarbageCollector:
    """
    Two-phase garbage collection:
    1. Mark: Find chunks with ref_count = 0
    2. Sweep: Delete after grace period
    """
    
    async def mark_phase(self):
        # Find orphaned chunks (no references)
        orphans = await db.query("""
            SELECT chunk_hash, created_at
            FROM chunks
            WHERE ref_count = 0
              AND deletion_scheduled_at IS NULL
        """)
        
        # Schedule deletion with grace period
        for chunk in orphans:
            await db.execute("""
                UPDATE chunks
                SET deletion_scheduled_at = NOW() + INTERVAL '7 days'
                WHERE chunk_hash = ?
            """, chunk.hash)
    
    async def sweep_phase(self):
        # Delete chunks past grace period
        to_delete = await db.query("""
            SELECT chunk_hash FROM chunks
            WHERE deletion_scheduled_at < NOW()
              AND ref_count = 0  -- Re-check in case resurrected
        """)
        
        for chunk in to_delete:
            # Verify truly orphaned (no race with upload)
            refs = await count_references(chunk.hash)
            if refs == 0:
                await s3.delete_object(Bucket=BUCKET, Key=chunk.hash)
                await db.execute("DELETE FROM chunks WHERE hash = ?", chunk.hash)

# Run nightly
schedule.every().day.at("03:00").do(gc.mark_phase)
schedule.every().day.at("04:00").do(gc.sweep_phase)
```

<details>
<summary>☕ <b>Java</b> — same mark/sweep</summary>

```java
/**
 * Two-phase garbage collection:
 *   1. Mark  — find chunks with ref_count = 0
 *   2. Sweep — delete only after a grace period
 */
class ChunkGarbageCollector {

    void markPhase() {
        jdbc.update("""
                UPDATE chunks
                SET deletion_scheduled_at = NOW() + INTERVAL '7 days'
                WHERE ref_count = 0 AND deletion_scheduled_at IS NULL
                """);
    }

    void sweepPhase() {
        List<String> toDelete = jdbc.queryForList("""
                SELECT chunk_hash FROM chunks
                WHERE deletion_scheduled_at < NOW()
                  AND ref_count = 0        -- re-check: it may have been resurrected
                """, String.class);

        for (String hash : toDelete) {
            if (countReferences(hash) != 0) continue;    // raced with an upload
            s3.deleteObject(DeleteObjectRequest.builder().bucket(BUCKET).key(hash).build());
            jdbc.update("DELETE FROM chunks WHERE hash = ?", hash);
        }
    }
}

// Run nightly — Spring's cron, or a ScheduledExecutorService.
// @Scheduled(cron = "0 0 3 * * *")  markPhase
// @Scheduled(cron = "0 0 4 * * *")  sweepPhase
```

</details>


---

### A32. Fast Folder Listing Schema

```sql
CREATE TABLE file_metadata (
    file_id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    parent_folder_id UUID,  -- NULL for root
    name VARCHAR(255) NOT NULL,
    is_folder BOOLEAN NOT NULL,
    size_bytes BIGINT,
    content_hash VARCHAR(64),
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    
    -- Denormalized for fast listing
    full_path TEXT GENERATED ALWAYS AS (...) STORED
);

-- Critical: Composite index for folder listing
CREATE INDEX idx_folder_listing 
ON file_metadata (workspace_id, parent_folder_id, name);

-- Query: List folder contents
SELECT file_id, name, is_folder, size_bytes, updated_at
FROM file_metadata
WHERE workspace_id = ?
  AND parent_folder_id = ?
ORDER BY is_folder DESC, name ASC
LIMIT 1000;
-- Uses index, returns in < 10ms even for 10K files
```

**Pagination** for very large folders:
```sql
-- Keyset pagination (cursor-based)
SELECT * FROM file_metadata
WHERE workspace_id = ? AND parent_folder_id = ?
  AND (is_folder, name) < (?, ?)  -- Cursor from previous page
ORDER BY is_folder DESC, name ASC
LIMIT 100;
```

---

### A33. Offloading Hash Computation

| Approach | How It Works | When to Use |
|----------|-------------|-------------|
| Client-side hashing | Client computes SHA-256 before upload | Always — enables dedup |
| Async server hashing | Upload → S3 → Lambda triggers hash | Large files, verification |
| Hardware acceleration | SHA-256 using AES-NI instructions | High-throughput servers |

```python
# AWS Lambda triggered on S3 upload
def lambda_handler(event, context):
    bucket = event['Records'][0]['s3']['bucket']['name']
    key = event['Records'][0]['s3']['object']['key']
    
    # Stream hash computation (don't load entire file in memory)
    s3_object = s3.get_object(Bucket=bucket, Key=key)
    hasher = hashlib.sha256()
    
    for chunk in s3_object['Body'].iter_chunks(1024 * 1024):
        hasher.update(chunk)
    
    computed_hash = hasher.hexdigest()
    
    # Verify against expected (from upload session)
    session = get_upload_session(key)
    if session.expected_hash != computed_hash:
        # Corruption detected — delete and notify client
        s3.delete_object(Bucket=bucket, Key=key)
        notify_client(session.user_id, "Upload failed: corruption detected")
    else:
        # Mark chunk as verified
        finalize_chunk(key, computed_hash)
```

<details>
<summary>☕ <b>Java</b> — DigestInputStream hashes while streaming — constant memory</summary>

```java
// AWS Lambda triggered on S3 upload
public class VerifyChunkHandler implements RequestHandler<S3Event, Void> {

    @Override
    public Void handleRequest(S3Event event, Context context) {
        S3EventNotificationRecord record = event.getRecords().get(0);
        String bucket = record.getS3().getBucket().getName();
        String key    = record.getS3().getObject().getKey();

        // Stream the hash — never load a whole chunk into heap.
        String computedHash;
        try (InputStream in = s3.getObject(GetObjectRequest.builder()
                .bucket(bucket).key(key).build());
             DigestInputStream dis = new DigestInputStream(
                     in, MessageDigest.getInstance("SHA-256"))) {

            dis.transferTo(OutputStream.nullOutputStream());   // drain
            computedHash = HexFormat.of().formatHex(dis.getMessageDigest().digest());

        } catch (Exception e) {
            throw new RuntimeException(e);
        }

        UploadSession session = getUploadSession(key);
        if (!session.expectedHash().equals(computedHash)) {
            s3.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build());
            notifyClient(session.userId(), "Upload failed: corruption detected");
        } else {
            finalizeChunk(key, computedHash);
        }
        return null;
    }
}
```

</details>


---

### A34. Cross-Shard Permission Queries

```text
Problem:
- Metadata sharded by user_id (each user's files on one shard)
- User A (shard 1) shares folder with User B (shard 2)
- User B requests "shared with me" — needs data from shard 1

Solutions:
```

| Approach | How | Tradeoff |
|----------|-----|----------|
| **Scatter-gather** | Query all shards, aggregate | High latency, expensive |
| **Share index table** | Separate unsharded table for shares | Another table to maintain |
| **Replicate share metadata** | Copy share info to grantee's shard | Consistency complexity |

**Google's approach**: Separate sharing service with its own sharding (by share_id). "Shared with me" queries this service, not the file metadata shards.

---

### A35. Thundering Herd on Popular Files

```python
class PopularFileHandler:
    CACHE_TTL = 3600  # 1 hour
    CACHE_LOCK_TTL = 30  # seconds
    
    async def get_download_url(self, file_id: str) -> str:
        cache_key = f"download_url:{file_id}"
        
        # 1. Try cache
        cached = await redis.get(cache_key)
        if cached:
            return cached
        
        # 2. Single-flight: Only one request computes
        lock_key = f"lock:{cache_key}"
        if await redis.set(lock_key, "1", nx=True, ex=self.CACHE_LOCK_TTL):
            # Won the lock — generate URL
            url = await s3.generate_presigned_url(file_id, expires_in=self.CACHE_TTL)
            await redis.setex(cache_key, self.CACHE_TTL - 60, url)
            await redis.delete(lock_key)
            return url
        else:
            # Another request is generating — wait and retry
            await asyncio.sleep(0.1)
            return await self.get_download_url(file_id)
    
    async def handle_viral_file(self, file_id: str):
        """When file goes viral (>1000 QPS)"""
        # Replicate to CDN edge
        cdn.push_to_edges(f"s3://{BUCKET}/{file_id}")
        
        # Update file's download URL to use CDN
        cdn_url = f"https://cdn.example.com/{file_id}"
        await redis.setex(f"download_url:{file_id}", 86400, cdn_url)
```

<details>
<summary>☕ <b>Java</b> — try/finally guarantees the lock is released</summary>

```java
class PopularFileHandler {
    private static final int CACHE_TTL      = 3600;   // 1 hour
    private static final int CACHE_LOCK_TTL = 30;     // seconds

    String getDownloadUrl(String fileId) throws InterruptedException {
        String cacheKey = "download_url:" + fileId;

        String cached = jedis.get(cacheKey);
        if (cached != null) return cached;

        // Single-flight: exactly one request computes; the rest wait.
        String lockKey = "lock:" + cacheKey;
        String acquired = jedis.set(lockKey, "1",
                SetParams.setParams().nx().ex(CACHE_LOCK_TTL));

        if ("OK".equals(acquired)) {
            try {
                String url = presignDownload(fileId, Duration.ofSeconds(CACHE_TTL));
                // Expire the cache BEFORE the URL does, or you serve dead links.
                jedis.setex(cacheKey, CACHE_TTL - 60, url);
                return url;
            } finally {
                jedis.del(lockKey);
            }
        }

        Thread.sleep(100);                 // someone else is generating
        return getDownloadUrl(fileId);
    }

    /** When a file goes viral (>1000 QPS). */
    void handleViralFile(String fileId) {
        cdn.pushToEdges("s3://" + BUCKET + "/" + fileId);
        jedis.setex("download_url:" + fileId, 86_400,
                    "https://cdn.example.com/" + fileId);
    }
}
```

</details>


---

## Level 8 — Production Operations

### A36. Detecting and Remediating Metadata Corruption

```yaml
# Prometheus alert
- alert: MetadataCorruptionDetected
  expr: |
    rate(file_upload_hash_mismatch_total[5m]) 
    / rate(file_upload_total[5m]) > 0.001
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "0.1%+ uploads have metadata corruption"
    runbook: |
      1. Identify bad API server version:
         - Query: file_upload_hash_mismatch_total by (server_version)
      2. Rollback:
         - kubectl rollout undo deployment/file-service
      3. Identify affected files:
         - SELECT file_id FROM files WHERE created_at > (deploy_time) 
           AND created_at < (rollback_time)
      4. Mark affected files for reverification:
         - Set needs_verification = true
      5. Run batch job:
         - Recompute hashes, fix metadata, notify users if unrecoverable
```

---

### A37. S3 Regional Failover

```text
Normal:
  US-West user → us-west-1 S3 → success

US-East-1 Outage:
1. Health check fails (5xx responses for 30 seconds)
2. Route53 health check marks us-east-1 unhealthy
3. DNS TTL expires (60 seconds)
4. US-East users routed to us-west-2

In-progress uploads:
- Client maintains session state (which chunks uploaded)
- On reconnect, client queries session status
- Resumes from last successful chunk
- S3 multipart upload automatically handles cross-region

Chunk data:
- Cross-region replication is async (minutes lag)
- Recently uploaded chunks may not be in failover region
- Solution: Retry upload if chunk not found
```

---

### A38. Sync Service Falling Behind — Incident Response

```python
# Key metrics to check
dashboard_queries = {
    "sync_queue_depth": "sum(sync_queue_pending_events)",
    "sync_latency_p99": "histogram_quantile(0.99, sync_request_duration_seconds)",
    "sync_consumer_lag": "kafka_consumer_group_lag{group='sync-service'}",
    "db_query_latency": "histogram_quantile(0.99, pg_query_duration_seconds{query_type='sync_changes'})",
    "active_sync_sessions": "sum(sync_sessions_active)"
}

# Incident response
"""
1. Check sync queue depth:
   - If growing: Consumers can't keep up
   - Scale up sync-service replicas

2. Check DB query latency:
   - If high: Check for missing indexes, long-running queries
   - Kill long queries, add index

3. Check Kafka lag:
   - If high: Consumers are slow
   - Check processing time per event

4. Check active sessions:
   - If spike: Many users came online simultaneously
   - Rate limit sync requests per user

5. Emergency: Enable degraded mode
   - Return "please retry later" for non-critical sync
   - Prioritize active users over dormant
"""
```

---

### A39. File Count Quota (Metadata DOS)

```python
class QuotaEnforcer:
    def check_upload_allowed(self, user: User, file_size: int) -> bool:
        # Byte quota
        if user.storage_used_bytes + file_size > user.storage_quota_bytes:
            raise QuotaExceeded("storage_bytes")
        
        # File count quota (often overlooked!)
        if user.file_count >= user.max_files:
            raise QuotaExceeded("file_count")
        
        # Rate limiting (uploads per hour)
        recent_uploads = cache.get(f"uploads:{user.id}:count")
        if recent_uploads > 1000:  # 1000 files/hour
            raise RateLimited("Too many uploads")
        
        return True

# User quotas (example tiers)
QUOTA_TIERS = {
    "free": {"bytes": 2 * GB, "files": 10_000},
    "pro": {"bytes": 2 * TB, "files": 500_000},
    "business": {"bytes": 10 * TB, "files": 10_000_000}
}
```

<details>
<summary>☕ <b>Java</b> — note 2L * TB — int arithmetic would silently overflow</summary>

```java
class QuotaEnforcer {

    void checkUploadAllowed(User user, long fileSize) {
        // Byte quota
        if (user.storageUsedBytes() + fileSize > user.storageQuotaBytes()) {
            throw new QuotaExceededException("storage_bytes");
        }
        // File count quota — often overlooked, and metadata has real cost.
        if (user.fileCount() >= user.maxFiles()) {
            throw new QuotaExceededException("file_count");
        }
        // Rate limit (uploads per hour)
        String key = "uploads:" + user.id() + ":count";
        long recent = jedis.incr(key);
        if (recent == 1) jedis.expire(key, 3600);
        if (recent > 1000) {
            throw new RateLimitedException("Too many uploads");
        }
    }
}

// Example tiers
static final Map<String, Quota> QUOTA_TIERS = Map.of(
        "free",     new Quota(2L * GB,  10_000),
        "pro",      new Quota(2L * TB,  500_000),
        "business", new Quota(10L * TB, 10_000_000));
```

</details>


---

### A40. Live Migration Between Cloud Providers

```text
Phase 1: Dual-write (2-4 weeks)
┌─────────────────┐
│   Write Path    │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌──────┐  ┌──────┐
│ GCS  │  │  S3  │  ← New uploads go to both
└──────┘  └──────┘

Phase 2: Background migration
- Batch job copies existing data from GCS to S3
- Track progress: migration_status per chunk

Phase 3: Read cutover
- Start reading from S3 (with fallback to GCS)
- if s3.get() fails: return gcs.get()

Phase 4: Validate
- Compare checksums between GCS and S3
- Run for 1-2 weeks

Phase 5: Decommission
- Stop writes to GCS
- Delete GCS data after 30-day retention
```

---

### A41. Silent Data Corruption (Bit Rot) Detection

```python
class BitRotDetector:
    """
    Periodic integrity verification job.
    Reads chunks, recomputes hash, compares to stored hash.
    """
    
    async def verify_chunk(self, chunk_hash: str) -> bool:
        # Fetch from S3
        data = await s3.get_object(Bucket=BUCKET, Key=chunk_hash)
        
        # Recompute hash
        actual_hash = hashlib.sha256(data).hexdigest()
        
        if actual_hash != chunk_hash:
            # CORRUPTION DETECTED
            await self.handle_corruption(chunk_hash, actual_hash)
            return False
        
        return True
    
    async def handle_corruption(self, expected_hash: str, actual_hash: str):
        # 1. Try to recover from replica
        for region in REPLICA_REGIONS:
            try:
                replica_data = await s3_clients[region].get_object(Key=expected_hash)
                replica_hash = hashlib.sha256(replica_data).hexdigest()
                if replica_hash == expected_hash:
                    # Replica is good — replace corrupt primary
                    await s3.put_object(Key=expected_hash, Body=replica_data)
                    metrics.increment("bit_rot.recovered")
                    return
            except:
                continue
        
        # 2. No good replica — data is lost
        await mark_chunk_unrecoverable(expected_hash)
        await notify_affected_users(expected_hash)
        metrics.increment("bit_rot.data_loss")

# Run continuously, checking 0.1% of chunks per day
# Full corpus verification every ~3 years
```

<details>
<summary>☕ <b>Java</b> — typed catch — the Python bare `except:` swallows everything</summary>

```java
/**
 * Periodic integrity verification. Reads chunks, recomputes the hash,
 * compares against the stored one. Chunks are content-addressed, so the
 * key IS the expected hash.
 */
class BitRotDetector {

    boolean verifyChunk(String chunkHash) throws Exception {
        byte[] data = s3.getObjectAsBytes(GetObjectRequest.builder()
                .bucket(BUCKET).key(chunkHash).build()).asByteArray();

        String actual = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(data));

        if (!actual.equals(chunkHash)) {
            handleCorruption(chunkHash);          // CORRUPTION DETECTED
            return false;
        }
        return true;
    }

    void handleCorruption(String expectedHash) throws Exception {
        // 1. Try to recover from a replica
        for (String region : REPLICA_REGIONS) {
            try {
                byte[] replica = s3Clients.get(region).getObjectAsBytes(
                        GetObjectRequest.builder().bucket(BUCKET)
                                .key(expectedHash).build()).asByteArray();

                String replicaHash = HexFormat.of().formatHex(
                        MessageDigest.getInstance("SHA-256").digest(replica));

                if (replicaHash.equals(expectedHash)) {
                    s3.putObject(PutObjectRequest.builder().bucket(BUCKET)
                            .key(expectedHash).build(), RequestBody.fromBytes(replica));
                    metrics.increment("bit_rot.recovered");
                    return;
                }
            } catch (S3Exception e) {
                // Only catch what you mean — a bare catch here would swallow
                // interrupts and programming errors too.
                log.warn("replica {} unavailable for {}", region, expectedHash, e);
            }
        }

        // 2. No good replica — the data is gone. Say so loudly.
        markChunkUnrecoverable(expectedHash);
        notifyAffectedUsers(expectedHash);
        metrics.increment("bit_rot.data_loss");
    }
}
// Check ~0.1% of chunks per day ⇒ full corpus verified about every 3 years.
```

</details>


---

### A42. Monitoring Dashboard Metrics

| Metric | Alert Threshold | Why It Matters |
|--------|-----------------|----------------|
| Upload success rate | < 99% | User-facing failures |
| Upload latency p99 | > 10s | Slow experience |
| Download latency p99 | > 5s | Critical for file access |
| Sync queue depth | > 100K | Falling behind |
| Sync latency p99 | > 30s | Users see stale data |
| Conflict rate | > 1% | Too many collisions |
| Chunk dedup ratio | < 50% | Dedup not working |
| Storage growth rate | > 2%/day | Capacity planning |
| Hash mismatch rate | > 0.01% | Corruption |
| Error rate by API | > 0.1% | Service degradation |

```yaml
# Grafana dashboard JSON
{
  "panels": [
    {"title": "Upload Success Rate", "expr": "rate(uploads_success[5m]) / rate(uploads_total[5m])"},
    {"title": "Sync Queue Depth", "expr": "sum(sync_queue_pending)"},
    {"title": "Storage Used (TB)", "expr": "sum(storage_bytes_total) / 1e12"},
    {"title": "Active Sync Sessions", "expr": "sum(sync_sessions_active)"},
    {"title": "Dedup Savings", "expr": "1 - (sum(bytes_stored) / sum(bytes_uploaded))"}
  ]
}
```

---

## Bonus Answers

### AB1. Content-Defined Chunking Decision

"CDC is more complex but essential for our use case. Users frequently edit documents — inserting, deleting, and modifying. With fixed chunks, a single-character insertion shifts all chunk boundaries, causing 100% re-upload. CDC uses rolling hashes to find boundaries based on content patterns, making boundaries stable across small edits. Dropbox's own papers show CDC reduced transfer by 60%+ compared to fixed chunking. The implementation complexity (Rabin fingerprinting) is well-understood and worth it."

### AB2. Conflict Resolution Philosophy

"For a file storage product, forking (Dropbox-style) is the right choice. Unlike Google Docs where real-time collaboration is the core feature, Drive/Dropbox users expect files to behave like local files — not changing underneath them. OT/CRDT requires document-specific merge logic (what does merging two Excel files mean?). Forking is document-agnostic, preserves all user data, and lets humans resolve conflicts. The UX is 'here are both versions, you decide' which is transparent and trustworthy."

### AB3. Idempotent Sync Commit

"Each sync operation gets a client-generated idempotency key (UUID + operation type + content hash). Server stores processed operations in a dedup table for 24 hours. On retry, server returns the original response. This handles the exact scenario: client crashes after server processes but before client receives ACK. On restart, client retries with same idempotency key, gets the cached success response instead of duplicate-create error."

### AB4. PostgreSQL vs Hierarchical KV Store

"For file metadata, I'd actually stick with PostgreSQL, but with careful schema design. Hierarchical KV stores like FoundationDB are excellent for ordered range scans but lose relational query power. We need JOIN for permissions, GROUP BY for quotas, and ACID transactions for move operations. PostgreSQL with composite indexes (workspace_id, parent_folder_id, name) handles folder listing at 10K files in < 10ms. If we truly hit PostgreSQL limits at 10B+ files, we could shard by workspace_id."

### AB5. Version Retention Policy

"Default policy: keep 100 versions or 30 days, whichever is less. For older versions, keep 1 per day for 90 days, then 1 per week for 1 year. After that, only keep versions explicitly marked 'keep forever.' Implement as background compaction job that merges consecutive versions with same semantic content (binary diff < 1%). For billing, charge for 'active storage' (current versions) and 'version history' separately — users can choose cheaper retention."

### AB6. Zero-Knowledge Encryption with Sharing

"For client-side encryption that supports sharing: Each file encrypted with a unique symmetric key (AES-256). That file key is encrypted with the owner's public key and stored with metadata. To share, owner decrypts file key with their private key, re-encrypts file key with recipient's public key, stores that as a share permission. Receiver gets file, decrypts file key with their private key, decrypts file. Server never sees unencrypted file keys. Key management is hard — users must backup their private keys or lose everything. That's why most consumer products don't do this by default."

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---------|----------------|
| Metadata vs content | Metadata in PostgreSQL (relational), content in S3 (cheap + durable) |
| Content-addressable | Store by SHA-256 hash → same file = same key → deduplication |
| Chunking | Split files into 4 MB chunks. Upload, hash, store independently |
| CDC vs fixed chunks | CDC: boundaries based on content patterns, stable across edits |
| Chunk manifest | File = ordered list of chunk hashes. Download = fetch & concatenate |
| Reference counting | Track how many files use each chunk. Delete when ref_count = 0 |
| Presigned URL | Time-limited S3 URL. Client uploads directly, bypasses API servers |
| Sync cursor | Opaque server-side sequence ID. Client says "changes since X" |
| Conflict resolution | Fork (create conflicted copy) > last-write-wins (loses data) |
| Permission inheritance | Subfolder inherits parent's permissions. Materialize for speed |
| Files on-demand | Placeholder files. Download on open. Cloud Files API / FUSE |
| Smart sync | Evict least-recently-accessed files when storage low |
| GC grace period | Wait 24-72 hours before deleting chunks (race condition protection) |
| Hash computation | Client: before upload (dedup). Server: after upload (verification) |
| Folder listing index | Composite index: (workspace_id, parent_folder_id, name) |
| Bit rot | Periodic background job recomputes chunk hashes, compares, repairs |
