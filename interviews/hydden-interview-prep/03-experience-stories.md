# Experience Stories - STAR Format

## Table of Contents
1. [Story 1: SSE Architecture](#story-1-sse-architecture---real-time-identity-monitoring-parallel)
2. [Story 2: RBAC-Aware Event Delivery](#story-2-rbac-aware-event-delivery)
3. [Story 3: Scaling Challenges](#story-3-scaling-to-10k-connections)
4. [Story 4: Multi-Tenant Isolation](#story-4-multi-tenant-isolation)
5. [Story 5: Distributed Event Bus](#story-5-distributed-event-bus-architecture)

---

## Story 1: SSE Architecture - Real-Time Identity Monitoring Parallel

### Situation
At Couchbase Capella, our UI was making approximately **3,600 HTTP requests per user per hour** due to a polling-based mechanism. We had over 40 hooks polling various entities - databases, indexes, app services, metrics - at intervals ranging from 5 to 120 seconds. This created three major problems:

1. **Delayed Updates**: Changes could take up to the polling interval to appear in the UI
2. **Wasted Bandwidth**: The majority of requests (>90%) returned unchanged or empty data
3. **High Server Load**: API load scaled linearly with (user count × polled entities)

For a typical user session with 5 clusters, we were seeing ~3,600 requests per hour, and this was becoming a scalability bottleneck as our user base grew.

### Task
My responsibility was to **architect and implement a replacement for the polling mechanism** using Server-Sent Events (SSE) to provide real-time push updates while dramatically reducing network overhead. The solution needed to:

- Eliminate unnecessary polling requests
- Provide near-instant UI updates when state changes occurred
- Scale to thousands of concurrent users
- Maintain RBAC (users only see events for resources they can access)
- Work across multiple API instances (horizontal scaling)
- Handle edge cases: network failures, slow clients, graceful shutdowns

### Action

**1. Architecture Design**

I designed a three-layer architecture:

```
Frontend (EventSource) 
    ↓
SSE Handler (per-client goroutine)
    ↓
In-Memory Broker (RBAC-aware fan-out)
    ↓
Event Bus (NATS - distributed coordination)
    ↓
Core Backend (mutation events)
```

**2. Backend Implementation (Golang)**

- **SSE Handler**: HTTP endpoint that upgrades the connection to a long-lived event stream
  - Sets proper headers (`Content-Type: text/event-stream`, `Connection: keep-alive`)
  - Creates a dedicated goroutine per client connection
  - Implements heartbeat mechanism (10-second intervals) to prevent proxy timeouts
  - Handles graceful disconnection

- **In-Memory Broker**: Central event distribution engine
  - Data structure: `map[tenantID][userID][clientID]chan Event`
  - Single-writer pattern: one `Run()` goroutine owns the map (prevents race conditions)
  - RBAC-aware broadcasting: checks permissions **per-event** using existing RBAC resolvers
  - Backpressure handling: slow clients are dropped rather than blocking fast clients
  - Multi-tab support: same user can have multiple browser tabs connected

- **Event Bus Integration (NATS)**:
  - Published events from backend mutation handlers (project created, cluster updated, etc.)
  - Each API instance subscribes to the NATS topic and forwards to its local broker
  - Fire-and-forget pattern: event publishing doesn't block HTTP response
  - Eliminates sticky session requirements (any client can connect to any instance)

**3. Key Technical Decisions**

- **Channels over Mutexes**: Used Go's "share memory by communicating" philosophy
  - Single broker goroutine owns client map
  - Other goroutines communicate via channels (register, unregister, broadcast)
  - Simpler reasoning, no deadlock concerns

- **RBAC at Broadcast Time, Not Connection Time**:
  ```go
  for userID, userClients := range tenantClients {
      if !rbac.CanAccess(userID, event.ResourceID) {
          continue // Permission check per-event
      }
      // Send to authorized users only
  }
  ```

- **Graceful Shutdown for Kubernetes**:
  - Listen for SIGTERM, close all client channels
  - Prevents blocking rolling deployments
  - Clients auto-reconnect to new pods

**4. Frontend Integration (React + TypeScript)**

- **Connection Manager**: Prevents duplicate SSE connections to same endpoint
- **SSE Provider**: React component that manages connection lifecycle
- **Event Handling**: Instead of directly updating UI state, events trigger **TanStack Query invalidations**
  - This ensures data consistency (server is source of truth)
  - Handles missed events gracefully (refetch gets latest state)

### Result

**Quantitative Impact:**
- **Network Traffic**: Reduced from ~3,600 requests/hour to near-zero (only heartbeats)
- **Update Latency**: Reduced from up to 120 seconds to < 1 second
- **Server Load**: Linear reduction in API calls, enabling better horizontal scaling

**Qualitative Impact:**
- **User Experience**: Users see changes instantly across all tabs
- **System Efficiency**: Eliminated 90%+ of empty HTTP requests
- **Architecture Improvement**: Foundation for future real-time features

**Technical Validation:**
- Scaling calculations: 10,000 concurrent connections = ~55MB RAM
- Handled connection churn gracefully (clients connecting/disconnecting)
- Zero RBAC permission leakages in testing
- Successful Kubernetes rolling deployments with proactive connection severing

### → Hydden Connection

**This experience directly maps to Hydden's identity monitoring challenges:**

1. **Polling → Continuous Discovery**
   - Just as we moved from periodic polling to real-time push, Hydden moves from quarterly access reviews to continuous identity discovery (multiple times per day)

2. **Real-Time Architecture Experience**
   - I've built the exact infrastructure needed for continuous identity monitoring: event streaming, distributed coordination, real-time state updates

3. **RBAC-Aware Delivery**
   - My per-event authorization checks mirror what Hydden needs: dynamic identity visibility based on SecOps user permissions

4. **Scaling Mindset**
   - I designed for 10K concurrent connections; Hydden discovers 70K users across multiple systems - same scaling considerations: memory management, concurrent processing, graceful degradation

5. **Distributed Systems**
   - My Event Bus pattern (NATS fan-out) is exactly what identity correlation requires: events from multiple disconnected systems need to be aggregated into a unified view

**Interview Talking Point:**
> "The SSE architecture I built for Capella is essentially what Hydden needs for identity monitoring - continuous state updates instead of periodic polling, distributed event correlation, RBAC-aware delivery, and the ability to scale to tens of thousands of entities. I've already solved these problems in production, just in a different domain context."

---

## Story 2: RBAC-Aware Event Delivery

### Situation
Once we decided to implement SSE for real-time updates, we immediately faced a critical security requirement: **events must only be delivered to users who have permission to see the affected resource**.

In Capella, we have a multi-tenant system where:
- Organizations have multiple projects
- Projects have multiple resources (clusters, app services, databases)
- Users have different roles: org owners (see everything), project collaborators (see specific projects only), read-only users

We couldn't simply broadcast all events to all connected users - that would be a significant security violation exposing confidential project data across tenant boundaries.

### Task
Design and implement **resource-level access control** for the SSE event stream, ensuring:
1. Users only receive events for resources they have permission to view
2. Permission changes take effect immediately (no stale authorization windows)
3. No cross-tenant data leakage
4. Minimal performance impact (authorization checks can't be a bottleneck)
5. Integration with existing RBAC infrastructure (don't reinvent the wheel)

### Action

**1. Architecture Decision: Per-Event Authorization (Not Per-Connection)**

I rejected the simpler approach of checking permissions once at connection time:

```go
// REJECTED APPROACH: Permissions checked at connection open
func HandleSSE(w http.ResponseWriter, r *http.Request) {
    userProjects := rbac.GetUserProjects(userID) // Cached
    // Problem: User's permissions change, but we're still using stale cache!
}
```

Instead, implemented **runtime authorization** at event broadcast time:

```go
// IMPLEMENTED APPROACH: Permissions checked per-event
func (b *Broker) Broadcast(event Event) {
    for userID, userClients := range b.clients {
        // Fresh RBAC check for each user, each event
        if !b.rbac.CanAccess(userID, event.ResourceID, event.ResourceType) {
            continue // Skip this user
        }
        
        // User authorized, send event
        for _, clientChan := range userClients {
            clientChan <- event
        }
    }
}
```

**2. RBAC Resolver Integration**

Integrated with Capella's existing RBAC infrastructure:

```go
type RBACResolver interface {
    CanAccess(userID, resourceID, resourceType string) bool
}

type CapellaRBACResolver struct {
    db Database
    cache Cache // Short-lived cache (30s TTL) for performance
}

func (r *CapellaRBACResolver) CanAccess(userID, resourceID, resourceType string) bool {
    // Check cache first
    if cached := r.cache.Get(userID, resourceID); cached != nil {
        return cached.Value
    }
    
    // Query database
    switch resourceType {
    case "project":
        hasAccess := r.db.IsOrgOwner(userID) || 
                     r.db.IsProjectCollaborator(userID, resourceID)
        r.cache.Set(userID, resourceID, hasAccess, 30*time.Second)
        return hasAccess
        
    case "cluster":
        // Clusters inherit project permissions
        projectID := r.db.GetProjectIDForCluster(resourceID)
        return r.CanAccess(userID, projectID, "project")
        
    default:
        return false
    }
}
```

**3. Optimizations**

- **Short-Lived Cache**: 30-second TTL on RBAC results balances freshness vs performance
- **Batch Queries**: When broadcasting to many users, batch permission checks
- **Early Termination**: If no users are connected to a tenant, skip RBAC checks entirely

**4. Special Case: Permission Removal Events**

For events where a user is being **removed** from a resource, I implemented a special bypass:

```go
// Special case: User removed from project
// They need to receive this ONE event to update their UI,
// even though they no longer have permission
if event.Type == "collaborator_removed" && event.AffectedUserID == userID {
    clientChan <- event // Send despite lack of permission
}
```

**5. Testing**

Created comprehensive test scenarios:
- User connects, sees only their projects
- User is added to a project → immediately sees new project events
- User is removed from a project → stops receiving events (self-correcting)
- Org owner sees all projects; collaborator sees only assigned projects
- Cross-tenant isolation: User in Org A never sees events from Org B

### Result

**Security Validation:**
- Zero permission leakage in production
- Automated tests covering all RBAC scenarios
- Security team sign-off after thorough review

**Performance:**
- RBAC checks add < 5ms latency per event broadcast
- Short-lived cache reduces database queries by ~80%
- No bottleneck even with hundreds of connected users

**Dynamic Permission Handling:**
- Permission changes take effect on the **next event** (< 1 second in practice)
- No need to disconnect/reconnect users when permissions change
- System self-corrects automatically

**User Experience:**
- Users see projects appear in real-time when added as collaborator
- Projects disappear from UI when removed from access
- Multi-tab support works correctly (all tabs respect permissions)

### → Hydden Connection

**Identity security faces identical RBAC challenges:**

1. **Resource-Level Visibility**
   - Different SecOps users have different identity visibility scopes
   - Some see all identities org-wide, others only identities in their region/business unit
   - My experience shows how to enforce this: per-event authorization checks

2. **Dynamic Permission Model**
   - SecOps user permissions change (new scope added, access revoked)
   - Hydden needs to reflect this immediately, not after re-login
   - My per-event RBAC approach handles this automatically

3. **Multi-Tenant SaaS**
   - Hydden likely serves multiple customers
   - Customer A must never see Customer B's identities
   - I've implemented strict tenant isolation with zero data leakage

4. **Performance at Scale**
   - Checking RBAC for every identity event across thousands of identities
   - My caching strategy and optimization approach directly applies

**Interview Talking Point:**
> "Identity visibility must be role-based - not every SecOps user should see every identity. I implemented runtime authorization in my SSE system where permissions are checked per-event, not per-connection. This means when a user's access scope changes, the system self-corrects on the next event without reconnection. This dynamic authorization model is exactly what identity platforms need - continuous evaluation as identity state and user permissions evolve."

---

## Story 3: Scaling to 10K Connections

### Situation
During the SSE design phase, the natural question arose: **"How many concurrent connections can we support?"**

For a SaaS platform like Capella with thousands of users, I needed to provide concrete answers:
- How much memory does each connection consume?
- What's our theoretical maximum on current infrastructure?
- Where are the bottlenecks?
- When do we need to scale horizontally?

Without this analysis, we risked deploying a system that would degrade or fail under production load.

### Task
Perform detailed **capacity planning and scaling analysis** for the SSE architecture:
1. Calculate resource consumption per connection
2. Identify bottlenecks and limits
3. Design backpressure mechanisms to handle overload gracefully
4. Provide operational guidance for monitoring and scaling

### Action

**1. Memory Analysis**

Broke down memory consumption per SSE connection into components:

```go
type Client struct {
    TenantID string      // UUID (16 bytes + 36-byte string)
    UserID string        // UUID (16 bytes + 36-byte string)
    ClientID string      // UUID (16 bytes + 36-byte string)
    EventChan chan Event // Channel struct (~96 bytes)
}
```

**Map Overhead:**
- TenantID, UserID, ClientID: ~150 bytes total
- Channel struct: ~96 bytes
- Go map internal buckets: ~54 bytes
- **Total per-client map entry: ~300 bytes**

**Goroutine Overhead:**
- Minimum stack size: 2 KB
- HTTP request/response context: ~2-3 KB
- **Total per-connection goroutine: ~5 KB**

**Combined: ~5.5 KB per connection**

**2. Scaling Estimates**

Calculated capacity at different scales:

| Concurrent Connections | Memory Usage | Feasibility |
|------------------------|--------------|-------------|
| 100                    | ~550 KB      | Trivial     |
| 1,000                  | ~5.5 MB      | Easy        |
| 10,000                 | ~55 MB       | Target      |
| 100,000                | ~550 MB      | Needs optimization |

**Current infrastructure**: API pods with 2GB RAM → **10,000 connections per pod is safe target**

**3. Connection Limits & Backpressure**

Implemented safeguards to prevent resource exhaustion:

```go
const MaxConnectionsPerUser = 2 // Limit tabs per user

type Broker struct {
    clients map[string]map[string]map[string]chan Event
    userConnectionCount map[string]int
    mu sync.RWMutex
}

func (b *Broker) Register(client *Client) error {
    b.mu.Lock()
    defer b.mu.Unlock()
    
    // Check per-user limit
    if b.userConnectionCount[client.UserID] >= MaxConnectionsPerUser {
        return errors.New("connection limit exceeded")
    }
    
    // Register client
    // ... registration logic
    
    b.userConnectionCount[client.UserID]++
    return nil
}
```

**SSE Handler rejects excess connections:**
```go
err := broker.Register(client)
if err != nil {
    http.Error(w, "Too many connections", http.StatusTooManyRequests)
    return
}
```

**4. Slow Client Handling**

Implemented **non-blocking event delivery** to prevent slow clients from affecting others:

```go
// Each client has a buffered channel
clientChan := make(chan Event, 10) // Buffer 10 events

// When broadcasting
select {
case clientChan <- event:
    // Sent successfully
default:
    // Channel full = slow consumer
    metrics.Increment("sse.slow_client_dropped")
    close(clientChan) // Force disconnect
    // SSE handler will detect closed channel and clean up
}
```

This ensures:
- Fast clients aren't blocked by slow clients
- Slow clients (poor network, overwhelmed browser) are disconnected
- They automatically reconnect via EventSource API

**5. Monitoring & Observability**

Added metrics for operational visibility:

```go
// Prometheus metrics
var (
    activeConnections = prometheus.NewGauge(...)
    eventsPublished = prometheus.NewCounter(...)
    eventsBroadcast = prometheus.NewCounter(...)
    slowClientsDropped = prometheus.NewCounter(...)
    rbacCheckDuration = prometheus.NewHistogram(...)
)

// Updated in broker
func (b *Broker) Register(client *Client) {
    activeConnections.Inc()
    // ...
}

func (b *Broker) Unregister(client *Client) {
    activeConnections.Dec()
    // ...
}
```

**6. Horizontal Scaling Strategy**

With Event Bus (NATS):
- Each API pod maintains its own broker with local connections
- Events fan out to ALL pods simultaneously
- Load balancer distributes client connections across pods
- **No sticky sessions required**

Scaling math:
- 1 pod: 10K connections
- 10 pods: 100K connections
- Linear scaling

### Result

**Capacity Validation:**
- Production testing confirmed ~5.5 KB per connection
- Sustained 10K+ concurrent connections in staging
- Memory usage matched predictions within 10%

**Operational Success:**
- Never exceeded connection limits in production
- Slow client drops occurred but auto-reconnect handled gracefully
- Metrics provided clear visibility into system health

**Scaling Capability:**
- Horizontally scalable (add pods as needed)
- Clear operational guidance: "Scale when average connections per pod > 8K"

**Performance:**
- Event delivery latency < 100ms (p99)
- RBAC checks < 5ms (with caching)
- Heartbeat mechanism prevented connection timeouts

### → Hydden Connection

**Identity discovery at scale faces identical challenges:**

1. **Resource Planning**
   - Discovering 70K users across multiple systems requires capacity planning
   - How many discovery agents? How much memory for identity state?
   - I've done this analysis - same methodology applies

2. **Concurrent Processing**
   - Scanning 20+ identity sources in parallel
   - Same goroutine-based concurrency patterns I used for SSE connections
   - Same considerations: memory per agent, timeout handling, error isolation

3. **Backpressure Handling**
   - Legacy systems that respond slowly shouldn't block fast systems
   - My non-blocking delivery pattern applies: slow sources get timeouts, don't affect others

4. **Horizontal Scaling**
   - Multiple discovery instances coordinating via message bus
   - My Event Bus architecture is exactly this pattern

**Interview Talking Point:**
> "I approached SSE scaling analytically - calculated memory per connection, identified limits, designed for graceful degradation. Hydden faces similar scaling: discovering 70K users multiple times per day requires the same capacity planning. My analysis showed 10K connections = 55MB; identity discovery of 70K users would have similar memory calculations for state management. I've proven I can design systems that scale predictably with detailed operational metrics."

---

## Story 4: Multi-Tenant Isolation

### Situation
Capella is a multi-tenant SaaS platform where each organization (tenant) has:
- Multiple projects
- Multiple users with different roles
- Separate billing and resource quotas
- Strict data isolation requirements (Org A must never see Org B's data)

When implementing SSE, we needed to ensure **zero cross-tenant data leakage** in the real-time event stream.

This was especially critical because:
- SSE connections are long-lived (potential for subtle leaks over time)
- Users can belong to multiple organizations
- Events broadcast across all connected clients need precise filtering

### Task
Design and implement **tenant-level isolation** for SSE event streaming:
1. Ensure users only receive events for the organization they're currently viewing
2. Handle users who belong to multiple organizations
3. Prevent cross-tenant leakage even with multiple browser tabs
4. Gracefully handle organization context switches

### Action

**1. Architecture Decision: Org-Scoped SSE Endpoints**

Instead of a single global SSE endpoint, designed **tenant-scoped** endpoints:

```
❌ BAD: /v2/sse/stream (global)
✅ GOOD: /v2/organizations/{orgId}/sse/stream (org-scoped)
```

**Advantages:**
- Org context is explicit in the URL
- Backend knows which tenant to filter for
- Connection lifecycle tied to org context

**2. Connection Management**

Frontend Connection Manager enforces one connection per organization:

```typescript
class SSEConnectionManager {
    private connections = new Map<string, EventSource>();
    
    connect(orgId: string) {
        // Only one connection per org
        if (this.connections.has(orgId)) {
            return this.connections.get(orgId);
        }
        
        const eventSource = new EventSource(
            `/v2/organizations/${orgId}/sse/stream`,
            { withCredentials: true }
        );
        
        this.connections.set(orgId, eventSource);
        return eventSource;
    }
    
    disconnect(orgId: string) {
        const conn = this.connections.get(orgId);
        if (conn) {
            conn.close();
            this.connections.delete(orgId);
        }
    }
    
    // When user switches orgs
    switchOrg(oldOrgId: string, newOrgId: string) {
        this.disconnect(oldOrgId); // Close old connection
        this.connect(newOrgId);    // Open new connection
    }
}
```

**3. Backend Tenant Validation**

SSE Handler validates tenant access before opening stream:

```go
func (h *SSEHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Extract tenant ID from URL
    tenantID := mux.Vars(r)["orgId"]
    
    // Get user from JWT
    userID := h.getUserFromJWT(r)
    
    // CRITICAL: Verify user has access to this tenant
    if !h.rbac.IsMemberOfOrg(userID, tenantID) {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }
    
    // Proceed with SSE stream
    // ... SSE setup
}
```

**4. Broker Tenant Filtering**

Broker maintains tenant boundaries in data structure:

```go
type Broker struct {
    // First level: tenant isolation
    clients map[string]map[string]map[string]chan Event
    //           ^tenant   ^user    ^client   ^channel
}

func (b *Broker) Broadcast(event Event) {
    // Only broadcast to the affected tenant
    tenantClients, exists := b.clients[event.TenantID]
    if !exists {
        return // No clients connected for this tenant
    }
    
    // Iterate only within this tenant's clients
    for userID, userClients := range tenantClients {
        // Additional RBAC check (resource-level)
        if !b.rbac.CanAccess(userID, event.ResourceID) {
            continue
        }
        
        for _, clientChan := range userClients {
            clientChan <- event
        }
    }
}
```

**5. Multi-Org User Handling**

For users who belong to multiple orgs:

```typescript
// User is in Org A and Org B
const user = {
    orgs: ["org-a-id", "org-b-id"]
};

// Two browser tabs: one viewing Org A, one viewing Org B
// Tab 1:
SSEConnectionManager.connect("org-a-id") // Gets Org A events only

// Tab 2:
SSEConnectionManager.connect("org-b-id") // Gets Org B events only

// No cross-contamination!
```

**6. Testing Multi-Tenant Isolation**

Created comprehensive test scenarios:

```go
func TestTenantIsolation(t *testing.T) {
    // Setup two tenants
    tenantA := "org-a"
    tenantB := "org-b"
    
    // User1 in Tenant A only
    user1 := createUser(tenantA)
    
    // User2 in Tenant B only
    user2 := createUser(tenantB)
    
    // Both users connect
    conn1 := connectSSE(user1, tenantA)
    conn2 := connectSSE(user2, tenantB)
    
    // Publish event to Tenant A
    publishEvent(tenantA, "project_created")
    
    // Assert: User1 receives, User2 does NOT
    assert.Received(conn1, "project_created")
    assert.NotReceived(conn2, "project_created")
}

func TestCrossTenantAttempt(t *testing.T) {
    // User only in Tenant A
    user := createUser("org-a")
    
    // Attempt to connect to Tenant B
    resp := connectSSE(user, "org-b")
    
    // Assert: Forbidden
    assert.Equal(http.StatusForbidden, resp.StatusCode)
}
```

### Result

**Security Validation:**
- Zero cross-tenant leakage in production (6+ months)
- Automated tests covering all isolation scenarios
- Security audit passed with zero findings

**User Experience:**
- Seamless org switching in UI
- Each org's events isolated to its context
- Multi-tab support works correctly (different orgs in different tabs)

**Operational Simplicity:**
- Tenant boundaries clear in architecture
- Easy to debug: each connection explicitly scoped to org
- Metrics grouped by tenant for visibility

### → Hydden Connection

**Identity platforms require similar multi-tenant isolation:**

1. **Customer Isolation (SaaS)**
   - If Hydden serves multiple customers, Customer A's identities must be isolated from Customer B
   - I've implemented this: tenant-scoped endpoints, explicit validation, data structure isolation

2. **Business Unit Segmentation (Enterprise)**
   - Large enterprises may want identity segmentation by region, division, or business unit
   - My org-scoped architecture generalizes to any segmentation boundary

3. **Role-Based Visibility Scopes**
   - SecOps users may have different visibility scopes (e.g., "Americas region only")
   - My tenant filtering patterns apply to any scope boundary

**Interview Talking Point:**
> "Multi-tenant isolation is critical for identity platforms - different customers, different business units, different visibility scopes. I implemented strict tenant isolation in my SSE architecture with tenant-scoped endpoints, explicit validation, and zero data leakage. The same patterns apply to identity segmentation: explicit scope boundaries, validation at entry point, data structures that enforce separation. I've proven I can build secure multi-tenant systems."

---

## Story 5: Distributed Event Bus Architecture

### Situation
Initially, our SSE design had a critical limitation: it only worked for a **single API instance**.

When a mutation happened on Instance A, only clients connected to Instance A received events. Clients connected to Instance B, C, or D saw nothing.

This violated the real-time update requirement and created a confusing user experience where updates appeared "sometimes" depending on which pod handled the request.

### Task
Extend the SSE architecture to work across **multiple API instances** (horizontal scaling):
1. Events published on any instance must reach clients connected to **all** instances
2. No sticky sessions (clients can connect to any instance)
3. Minimal latency overhead for event propagation
4. Resilient to individual instance failures

### Action

**1. Architecture Decision: Event Bus Pattern**

Introduced a **distributed message bus** between backend services and SSE brokers:

```
API Instance A                   API Instance B
┌──────────────┐                ┌──────────────┐
│ SSE Broker   │                │ SSE Broker   │
│ (5 clients)  │                │ (3 clients)  │
└──────┬───────┘                └──────┬───────┘
       │                               │
       │ subscribe                     │ subscribe
       └───────────┐       ┌───────────┘
                   │       │
                   ▼       ▼
            ┌────────────────────┐
            │    Event Bus       │
            │      (NATS)        │
            └──────────┬─────────┘
                       │
                       │ publish
                       │
                ┌──────▼────────┐
                │ Backend       │
                │ (mutation)    │
                └───────────────┘
```

**2. Technology Choice: NATS**

Selected NATS for the Event Bus:
- **Lightweight**: Minimal overhead for pub/sub
- **Fast**: Microsecond latencies for in-cluster messaging
- **Simple**: No complex broker configuration or durable storage needed
- **Resilient**: Cluster mode with automatic failover

**Why not other options:**
- **Kafka**: Too heavy for lightweight event notifications (overkill)
- **Redis Pub/Sub**: No built-in clustering/HA in our infrastructure
- **RabbitMQ**: More complex than needed, higher latency
- **Couchbase DCP**: Wrong use case (replication protocol, not pub/sub)

**3. Implementation**

**Backend: Publish Events to NATS**
```go
type ProjectService struct {
    db Database
    eventBus EventBus
}

func (s *ProjectService) CreateProject(ctx context.Context, project *Project) error {
    // 1. Perform business logic
    if err := s.db.Save(project); err != nil {
        return err
    }
    
    // 2. Publish event (fire-and-forget)
    event := Event{
        TenantID: project.TenantID,
        Type: "project_created",
        ResourceID: project.ID,
        ResourceType: "project",
        Timestamp: time.Now(),
    }
    
    // Non-blocking publish
    go func() {
        if err := s.eventBus.Publish("capella.events", event); err != nil {
            log.Error("Failed to publish event", "error", err)
            // Don't fail the request if event publishing fails
        }
    }()
    
    return nil
}
```

**Broker: Subscribe to NATS**
```go
func (b *Broker) Start(ctx context.Context) error {
    // Subscribe to NATS topic
    sub, err := b.natsConn.Subscribe("capella.events", func(msg *nats.Msg) {
        var event Event
        if err := json.Unmarshal(msg.Data, &event); err != nil {
            log.Error("Failed to unmarshal event", "error", err)
            return
        }
        
        // Forward to local broker for broadcasting
        b.broadcast <- event
    })
    
    if err != nil {
        return fmt.Errorf("failed to subscribe: %w", err)
    }
    
    // Wait for shutdown signal
    <-ctx.Done()
    sub.Unsubscribe()
    return nil
}
```

**4. NATS Cluster Setup**

Deployed NATS in cluster mode (3 nodes across AZs):
- **Topology**: 3 NATS server pods with gossip + full mesh
- **No RAFT**: No quorum, no leader election (simplicity)
- **Fault Tolerance**: Single node loss is non-disruptive
- **Auto-Reconnect**: NATS Go client automatically reconnects

**5. Event Delivery Guarantees**

Deliberately chose **at-most-once delivery**:
- **Why**: SSE events are triggers for client refetch (not source of truth)
- **Impact of Missed Events**: Client refetch gets latest state anyway
- **Impact of Duplicate Events**: Idempotent (refetch is idempotent)
- **Simplification**: No persistence, no replay, no consumer state tracking

**6. Operational Contract**

Documented clear operational expectations:

```
Event Bus Operational Contract
───────────────────────────────
Mode: NATS Core Pub/Sub (not JetStream)
Delivery: At-most-once, fire-and-forget
Topology: 3-node cluster across 3 AZs
Resilience: Single node failure is non-disruptive
Recovery: Clients auto-reconnect, refetch compensates for missed events
```

### Result

**Multi-Instance Support:**
- Events published on any instance reach clients on **all** instances
- No sticky sessions required
- Horizontal scaling works seamlessly

**Performance:**
- Event propagation latency: < 10ms (p99)
- NATS throughput: Handles thousands of events/second easily
- No bottleneck even under peak load

**Operational Success:**
- NATS cluster deployed in staging and production
- Zero production incidents related to Event Bus
- NATS node failures handled transparently (automatic reconnect)

**Developer Experience:**
- Simple API: `eventBus.Publish("topic", event)`
- Fire-and-forget pattern doesn't complicate business logic
- Easy to add new event types

### → Hydden Connection

**Identity correlation across systems needs the same pattern:**

1. **Distributed Discovery Agents**
   - Agent discovers identities in AWS → publishes to Event Bus
   - Agent discovers identities in Azure AD → publishes to Event Bus
   - Agent discovers identities in on-prem AD → publishes to Event Bus
   - **Central correlation engine** subscribes to all events

2. **Multi-Instance Coordination**
   - Multiple discovery instances scanning different systems
   - All feed into unified identity inventory
   - Same Event Bus pattern for coordination

3. **Event-Driven Architecture**
   - Identity change detected → publish event
   - Anomaly detector subscribes → detects privilege escalation
   - Alert service subscribes → notifies SecOps
   - Same pub/sub pattern I built

**Interview Talking Point:**
> "Identity discovery is inherently distributed - identities exist in multiple disconnected systems. I built a distributed Event Bus architecture using NATS that allows services to publish events that reach all instances. This same pattern applies to identity correlation: discovery agents in different systems publish identity events to a central bus, where a correlation engine subscribes and builds the unified identity graph. I've already proven this architecture works at scale."

---

## How to Use These Stories

1. **Practice out loud** - Tell each story in 2-3 minutes
2. **Customize based on question** - Pick the most relevant story
3. **Always end with Hydden connection** - Bridge your experience to their needs
4. **Have technical details ready** - Be prepared to go deeper if asked
5. **Show impact** - Quantitative results + qualitative improvements

**General Format:**
1. **Situation** (30 seconds): Set context
2. **Task** (30 seconds): Your responsibility
3. **Action** (60-90 seconds): What you did (most detail here)
4. **Result** (30 seconds): Impact and validation
5. **Hydden Connection** (30 seconds): How it applies to their challenges

Total: 2-3 minutes per story
