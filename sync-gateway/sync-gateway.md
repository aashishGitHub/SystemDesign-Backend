# Sync Gateway

Sync Gateway enables offline device sync through bi-directional synchronization between Couchbase Lite (embedded database on devices) and Couchbase Server.

---

## Architecture & Core Components

Sync Gateway sits in the middle between edge devices and Couchbase Server, handling:

- **Couchbase Lite clients** on mobile apps and IoT devices
- **Couchbase Server** (or Capella) as the source of truth
- **Web clients** via REST API

---

## How Offline Sync Works

1. **Local Storage** — Each device has its own Couchbase Lite database that stores data locally
2. **Online Phase** — When connected, the device syncs bidirectionally with Sync Gateway (pushing changes and pulling updates)
3. **Offline Phase** — Device continues working with local data; all operations are queued
4. **Resynchronization** — When connectivity resumes, Sync Gateway automatically syncs all pending changes

---

## Key Mechanisms

| Mechanism | Description |
|-----------|-------------|
| **Shared Bucket Access** | Uses Couchbase Server XATTRs (Extended Attributes) to store sync metadata, allowing both Sync Gateway and Couchbase Server to read/write to the same bucket simultaneously |
| **Import Processing** | Continuously monitors Couchbase Server bucket changes (from SDKs, SQL++ queries) and imports them for replication to mobile clients |
| **Delta Sync** | Only transfers changed parts of documents, significantly reducing bandwidth consumption |
| **Channels & Sync Function** | Custom JavaScript logic routes documents to users based on access control rules, determining which data each user can see/edit |
| **Revision Tracking** | Uses revision trees with automatic or custom conflict resolution when multiple devices modify the same document |
| **Network Awareness** | Automatically pauses/resumes sync based on network availability without user intervention |

---

## Security Layer

- User authentication (OpenID Connect, custom providers, certificates)
- Role-based access control (RBAC) at user/role/document level
- Fine-grained channel-based data routing
- TLS for secure replication
