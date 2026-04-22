# System Design: Google Drive / Dropbox (File Sync & Storage)

> **Target:** Senior / Staff Engineers at Google, Meta, Amazon, Microsoft, Uber
> **Style:** Interview-grill format — every concept is introduced as a question first, then answered.

---

## How to Use This Guide

1. First pass — attempt every question yourself before reading the answer.
2. Second pass — read the answers, compare, note what you missed.
3. Third pass — whiteboard the full system from memory. No notes.

---

## Learning Path

| Level | Topic | You'll Learn |
|-------|-------|-------------|
| 1 | File Storage Fundamentals | How files are stored, metadata vs content separation |
| 2 | Upload Pipeline | Chunked upload, resumable upload, multipart upload |
| 3 | Content-Addressable Storage | Deduplication, hashing content for storage |
| 4 | Sync Protocol | Delta sync, conflict resolution, file versioning |
| 5 | Sharing & Permissions | ACL, folder sharing, permission inheritance |
| 6 | Offline Support | Local cache, sync queue, conflict detection |
| 7 | Scalability | Sharding, replication, metadata at scale |
| 8 | Production Operations | Monitoring, failure modes, quota management |

---

## Files

| File | Purpose |
|------|---------|
| [questions.md](./questions.md) | All questions, organized by level. Read first. |
| [answers.md](./answers.md) | Full answers with code examples and tradeoff tables. |
| [deep-dive.md](./deep-dive.md) | In-depth explanations — beginner to architect level. |

---

## The Problem Statement

> Design a cloud file storage and synchronization service like Google Drive or Dropbox that allows users to store, sync, and share files across multiple devices.

**Key Constraints:**
- 500 million users, 100 million DAU
- Average user has 10 GB of files, 1000 files
- 500 petabytes total storage
- Files range from 1 KB to 50 GB
- Support desktop sync client, web, and mobile
- Sync latency < 10 seconds for small files
- 99.99% availability, 99.999999999% (11 nines) durability
- Support offline editing with eventual sync

---

## Core Functional Requirements

✅ **CORE (design these)**
1. Users should be able to **upload, download, and delete files** from any device
2. Users should be able to **sync files** across multiple devices automatically
3. Users should be able to **share files and folders** with other users with permissions (view/edit)

❌ **BELOW THE LINE (out of scope)**
- Real-time collaborative editing (Google Docs)
- Full-text search within files
- Third-party app integrations
- File preview/thumbnail generation
- Trash/restore functionality

---

## Core Non-Functional Requirements

✅ **CORE (design these)**
1. **Durability**: 99.999999999% (11 nines) — no file should ever be lost
2. **Sync latency**: < 10 seconds for files under 100 MB
3. **Bandwidth efficiency**: Minimize data transfer (delta sync, deduplication)

❌ **BELOW THE LINE (out of scope)**
- GDPR compliance / data residency
- Detailed audit logging
- CI/CD and deployment pipeline
- Mobile battery optimization

---

## How a Senior Engineer Thinks About This

The key insight is **separating metadata from content**. Metadata (file names, folder structure, sharing permissions, versions) lives in a relational database and changes frequently. Content (actual file bytes) lives in blob storage and is immutable — you never update a file in place; you create a new version.

The second insight is **content-addressable storage**. Instead of storing files by their user-provided name, you hash the file content (SHA-256) and use that as the storage key. If two users upload the same 4 GB movie, you store it once. This provides deduplication for free and makes sync efficient — if a chunk hasn't changed, you don't re-upload it.

The third insight is **chunking**. A 4 GB file is split into 4 MB chunks. Each chunk is hashed independently. If a user edits one paragraph in a 100 MB document, only the changed chunks (maybe 4-8 MB) get re-uploaded, not the whole file. This is the secret to Dropbox-style "instant sync."

---

## Core Entities

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Core Data Model                               │
└─────────────────────────────────────────────────────────────────────┘

User
├── user_id (PK)
├── email
├── storage_quota_bytes
├── storage_used_bytes
└── created_at

Workspace (shared folder/team drive)
├── workspace_id (PK)
├── owner_id (FK → User)
├── name
└── created_at

FileMetadata
├── file_id (PK)
├── workspace_id (FK)
├── parent_folder_id (FK → FileMetadata, nullable for root)
├── name
├── is_folder (boolean)
├── size_bytes
├── content_hash (SHA-256 of full file)
├── current_version_id (FK → FileVersion)
├── created_at
├── updated_at
└── deleted_at (soft delete)

FileVersion
├── version_id (PK)
├── file_id (FK → FileMetadata)
├── version_number
├── chunk_manifest (JSON: ordered list of chunk hashes)
├── size_bytes
├── created_by (FK → User)
├── created_at
└── comment (optional)

Chunk (content-addressable)
├── chunk_hash (PK, SHA-256)
├── size_bytes
├── blob_storage_key
├── reference_count (for garbage collection)
└── created_at

SharePermission
├── permission_id (PK)
├── resource_id (file_id or workspace_id)
├── resource_type (file, folder, workspace)
├── grantee_id (user_id or group_id)
├── grantee_type (user, group, anyone_with_link)
├── permission_level (view, comment, edit, owner)
├── created_by
└── created_at

SyncState (per device)
├── device_id (PK)
├── user_id (FK)
├── last_sync_cursor (server-side event ID)
├── last_sync_at
└── device_name
```

---

## API Design

### File Operations

```
POST /files/upload/init -> UploadSession
Body: { fileName, parentFolderId, totalSizeBytes, contentHash }
// Initiates chunked upload, returns uploadSessionId and presigned URLs

PUT /files/upload/{sessionId}/chunk/{chunkIndex}
Body: raw chunk bytes
// Uploads a single chunk to blob storage via presigned URL

POST /files/upload/{sessionId}/complete -> FileMetadata
Body: { chunkHashes: string[] }
// Finalizes upload, creates file version

GET /files/{fileId}/download -> PresignedUrlResponse
// Returns presigned URL for direct download from blob storage

DELETE /files/{fileId} -> void
// Soft delete (move to trash)
```

### Sync Operations

```
GET /sync/changes?cursor={cursor}&limit=100 -> SyncChanges
// Returns list of changes since cursor (file added, modified, deleted, moved)
// Cursor is opaque server-side event ID

POST /sync/commit -> CommitResult
Body: { changes: SyncChange[] }
// Client pushes local changes to server
// Server resolves conflicts, returns accepted/rejected changes
```

### Sharing Operations

```
POST /share -> SharePermission
Body: { resourceId, resourceType, granteeEmail, permissionLevel }
// Shares file or folder with another user

GET /shared-with-me -> FileMetadata[]
// Lists all files/folders shared with current user

PATCH /share/{permissionId} -> SharePermission
Body: { permissionLevel }
// Updates permission level

DELETE /share/{permissionId} -> void
// Revokes access
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     File Storage Architecture                        │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Desktop App  │     │   Web App    │     │  Mobile App  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  API Gateway    │
                   │  (Auth, Rate    │
                   │   Limiting)     │
                   └────────┬────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  File Service │   │  Sync Service │   │ Share Service │
│  (Upload/     │   │  (Change      │   │ (Permissions) │
│   Download)   │   │   Detection)  │   │               │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │  Metadata   │ │    Blob     │ │    Cache    │
    │   Database  │ │   Storage   │ │   (Redis)   │
    │ (PostgreSQL)│ │    (S3)     │ │             │
    └─────────────┘ └─────────────┘ └─────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  Notification   │
                   │  Service        │
                   │ (WebSocket/SSE) │
                   └─────────────────┘
```

---

## Key Design Decisions

| Decision | Options | Choice | Why |
|----------|---------|--------|-----|
| Content storage | Store full files vs chunks | Chunks (4 MB) | Enables delta sync, deduplication, parallel upload |
| Chunk identification | File path vs content hash | Content hash (SHA-256) | Deduplication, integrity verification |
| Metadata storage | NoSQL vs SQL | PostgreSQL | Hierarchical data (folders), transactions, strong consistency |
| Sync mechanism | Polling vs push | Long-polling + WebSocket | Real-time notification, efficient for both web and desktop |
| Conflict resolution | Last-write-wins vs fork | Fork + user resolution | Preserves user data, no silent overwrites |
| Upload resumability | Yes vs no | Yes (chunked upload) | Users upload large files, connections fail |

---

## What Makes This Problem Hard

1. **Chunking + Deduplication**: Computing content hashes on large files is CPU-intensive. Choosing chunk boundaries (fixed vs content-defined) affects deduplication efficiency.

2. **Conflict Resolution**: User A edits offline, User B edits same file online. When A comes online, what happens? Can't silently overwrite either.

3. **Sync Protocol**: Desktop clients need to track local filesystem changes, compare with server state, and resolve differences. This is a distributed state synchronization problem.

4. **Scale**: 500 PB of storage, billions of chunks. Metadata queries (list folder, check permissions) must be fast despite massive scale.

5. **Offline Support**: Clients may be offline for days. When they reconnect, they have many changes to sync. The system must handle this gracefully without overwhelming the server.

---

## Related Topics

- [Blob Storage](../blob-storage/) — S3-style object storage fundamentals
- [Distributed Caching](../distributed-caching/) — Caching metadata for performance
- [Message Queues](../message-queues/) — Async processing for file operations
- [API Design](../api-design/) — REST API patterns for file operations
