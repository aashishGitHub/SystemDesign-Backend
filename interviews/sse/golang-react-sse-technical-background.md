# Technical Background: Golang Backend & React Full-Stack

**Role**: Principal Software Engineer / Senior Full-Stack Engineer  
**Current**: Couchbase Capella — Real-Time Infrastructure (SSE)  
**Stack**: Golang · React · TypeScript · NATS · Couchbase · Kubernetes

---

## Elevator Pitch (60 seconds)

> "I'm a principal-level full-stack engineer with 12+ years of experience. At Couchbase Capella, I own the real-time infrastructure: I designed and built a Server-Sent Events system in Golang that replaced ~3,600 HTTP polling requests per user per hour with a single persistent push connection. The system runs an in-memory broker with goroutine-per-client fan-out, RBAC-checked per event (not per connection), distributed across API instances via a NATS event bus — all integrated into a React frontend using a typed connection manager and TanStack Query invalidations. On the frontend I've led Angular-to-React migrations, built design systems, and optimized data-fetching patterns. I care deeply about the intersection of distributed backend correctness and the UI that consumes it."

---

## 1. SSE Implementation — Backend (Golang)

### Why SSE was Needed

| Before (Polling) | After (SSE) |
|-----------------|-------------|
| ~3,600 requests/user/hour | ~6 heartbeats/minute |
| 40+ hooks polling at 5–120s intervals | 1 persistent connection per org |
| Up to 120s latency for UI updates | < 1s latency |
| Load scales linearly with users × entities | Load near-constant per user |

---

### Architecture Overview

```
Browser (EventSource)
    │  GET /v2/organizations/{orgId}/sse/stream
    ▼
SSE Handler (Go HTTP handler)
    │  per-client goroutine + heartbeat ticker
    ▼
In-Memory Broker
    │  map[tenantID][userID][clientID]chan Event
    │  single Run() goroutine owns the map
    ▼
NATS Event Bus (Core Pub/Sub)
    │  all cp-api instances subscribe
    ▼
Core Backend Services
    │  fire-and-forget publish on mutation
```

---

### Broker — Core Data Structure & Concurrency Model

The broker is the heart of the SSE system. It owns one goroutine (`Run`) that serializes all mutations to the client map, avoiding mutexes and preventing race conditions.

```go
type Event struct {
    TenantID     string      `json:"tenant_id"`
    Type         string      `json:"event_type"`   // e.g. "project_created"
    ResourceID   string      `json:"resource_id"`
    ResourceType string      `json:"resource_type"` // "project", "cluster", "user"
}

type Client struct {
    TenantID string
    UserID   string
    ClientID string
    Chan     chan Event
}

type Broker struct {
    // TenantID → UserID → ClientID → channel
    clients map[string]map[string]map[string]chan Event

    userConnCount map[string]int

    register   chan *Client
    unregister chan *Client
    broadcast  chan Event

    rbac   RBACResolver
    logger *zap.Logger
}

const (
    MaxConnectionsPerUser = 2
    ClientChanBuffer      = 10
)

func NewBroker(rbac RBACResolver, logger *zap.Logger) *Broker {
    return &Broker{
        clients:       make(map[string]map[string]map[string]chan Event),
        userConnCount: make(map[string]int),
        register:      make(chan *Client),
        unregister:    make(chan *Client),
        broadcast:     make(chan Event, 256),
        rbac:          rbac,
        logger:        logger,
    }
}

// Run is the single goroutine that owns the client map.
// All mutations flow through channels — no mutex required.
func (b *Broker) Run(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            b.shutdownAll()
            return

        case c := <-b.register:
            b.addClient(c)

        case c := <-b.unregister:
            b.removeClient(c)

        case event := <-b.broadcast:
            b.fanOut(event)
        }
    }
}
```

**Why channels over mutexes?**  
Go's memory model guarantees that channel sends happen-before receives. A single goroutine owning the map eliminates all data races without the overhead or deadlock risk of lock hierarchies.

---

### Fan-Out with Per-Event RBAC

```go
func (b *Broker) fanOut(event Event) {
    tenantClients, ok := b.clients[event.TenantID]
    if !ok {
        return
    }

    for userID, userClients := range tenantClients {
        // RBAC checked per-event, not at connection time.
        // If a user loses access mid-stream, the next event self-corrects.
        if !b.rbac.CanAccess(userID, event.ResourceID, event.ResourceType) {
            // Special bypass: removal events must still reach the removed user.
            if event.Type != "collaborator_removed" || event.ResourceID != userID {
                continue
            }
        }

        for clientID, ch := range userClients {
            select {
            case ch <- event:
                // delivered
            default:
                // Slow consumer — drop and force reconnect.
                // The client's EventSource will reconnect automatically.
                b.logger.Warn("slow consumer dropped",
                    zap.String("user_id", userID),
                    zap.String("client_id", clientID),
                )
                close(ch)
                delete(userClients, clientID)
            }
        }
    }
}
```

**Why per-event RBAC?**  
Checking once at connection open is cheaper but stale. If a collaborator is removed while their stream is live, they would still receive events until they reconnect. Per-event checks make permission changes self-correcting within one event cycle.

---

### SSE Handler — HTTP to Stream Upgrade

```go
func (h *SSEHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    tenantID := chi.URLParam(r, "orgId")
    userID   := h.auth.UserIDFromContext(r.Context())

    // Validate org membership before opening the stream.
    if !h.rbac.IsMemberOfOrg(userID, tenantID) {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }

    // Enforce per-user connection cap.
    client, err := h.broker.Register(tenantID, userID)
    if err != nil {
        http.Error(w, "Too Many Connections", http.StatusTooManyRequests)
        return
    }
    defer h.broker.Unregister(client)

    // Upgrade response to SSE stream.
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "Streaming Unsupported", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.Header().Set("X-Accel-Buffering", "no") // Disable Nginx buffering
    flusher.Flush()

    // 15-minute max stream lifetime — server-side forced reconnect.
    ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
    defer cancel()

    heartbeat := time.NewTicker(10 * time.Second)
    defer heartbeat.Stop()

    for {
        select {
        case <-ctx.Done():
            // Clean close — client EventSource will reconnect automatically.
            fmt.Fprintf(w, ": stream-timeout\n\n")
            flusher.Flush()
            return

        case <-heartbeat.C:
            fmt.Fprintf(w, ": heartbeat\n\n")
            flusher.Flush()

        case event, ok := <-client.Chan:
            if !ok {
                return // Broker closed the channel (slow consumer or shutdown)
            }
            payload, _ := json.Marshal(event)
            fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, payload)
            flusher.Flush()
        }
    }
}
```

**Design choices worth noting:**
- `X-Accel-Buffering: no` tells Nginx to bypass its buffer — required for SSE behind reverse proxies
- 15-minute max lifetime provides a periodic re-authentication checkpoint
- `Context.WithTimeout` drives clean closure without a separate timer goroutine

---

### Graceful Shutdown (Kubernetes SIGTERM)

```go
func (b *Broker) shutdownAll() {
    for _, tenantClients := range b.clients {
        for _, userClients := range tenantClients {
            for _, ch := range userClients {
                close(ch) // SSEHandler detects closed channel and exits
            }
        }
    }
}

// In main.go
sigCh := make(chan os.Signal, 1)
signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

go func() {
    <-sigCh
    brokerCancel() // triggers broker.Run shutdown → shutdownAll
    server.Shutdown(context.Background())
}()
```

Without proactive connection severing, Kubernetes rolling updates hang until the SIGKILL timeout (default 30s) because `http.Server.Shutdown` waits for active connections to drain. This approach drops all SSE streams cleanly, letting the pod exit immediately.

---

### NATS Event Bus Integration

```go
type NATSEventBus struct {
    conn   *nats.Conn
    broker *Broker
    logger *zap.Logger
}

func (n *NATSEventBus) Subscribe(ctx context.Context) error {
    sub, err := n.conn.Subscribe("capella.events.*", func(msg *nats.Msg) {
        var event Event
        if err := json.Unmarshal(msg.Data, &event); err != nil {
            n.logger.Error("unmarshal event failed", zap.Error(err))
            return
        }
        // Forward into local broker — decouples NATS from SSE delivery
        n.broker.Publish(event)
    })
    if err != nil {
        return fmt.Errorf("nats subscribe: %w", err)
    }

    <-ctx.Done()
    return sub.Unsubscribe()
}

// Backend service — fire-and-forget publish after mutation
func (s *ProjectService) CreateProject(ctx context.Context, p *Project) error {
    if err := s.db.Save(ctx, p); err != nil {
        return err
    }

    go func() {
        event := Event{
            TenantID:     p.TenantID,
            Type:         "project_created",
            ResourceID:   p.ID,
            ResourceType: "project",
        }
        if err := s.eventBus.Publish(ctx, event); err != nil {
            s.logger.Warn("event publish failed", zap.Error(err))
            // Non-fatal: missed events are covered by client refetch
        }
    }()

    return nil
}
```

**NATS operational contract:**  
Core Pub/Sub (not JetStream). At-most-once, fire-and-forget. 3-node cluster across 3 AZs with gossip + full mesh. A single node loss is non-disruptive — the Go client reconnects automatically.  
JetStream (persistence, replay) is intentionally excluded: SSE events are signals to trigger TanStack Query refetches, not the source of truth.

---

### Memory & Scaling Estimates

```
Per SSE connection:
  Map entry (TenantID + UserID + ClientID UUIDs + chan)  ≈  300 B
  Goroutine (minimum stack + HTTP context)               ≈  5 KB
  ─────────────────────────────────────────────────────────────────
  Total per client                                       ≈  5.5 KB

Scaling:
  1,000 connections  →  ~5.5 MB RAM
  10,000 connections →  ~55 MB RAM   (target per pod)
  100,000 connections → ~550 MB RAM  (needs sharding or BroadcastChannel)
```

Connection limit: `MaxConnectionsPerUser = 2` — enforced at registration, returns HTTP 429.  
Backpressure: slow consumers are disconnected (non-blocking `select` with default branch); `EventSource` reconnects automatically.

---

## 2. SSE Implementation — Frontend (React / TypeScript)

### Connection Manager

A singleton that prevents duplicate `EventSource` connections to the same endpoint. Similar to Axios interceptors but for streaming.

```typescript
class SSEConnectionManager {
    private connections = new Map<string, EventSource>();
    private listeners = new Map<string, Map<string, Set<(e: MessageEvent) => void>>>();

    connect(orgId: string, getToken: () => string): EventSource {
        if (this.connections.has(orgId)) {
            return this.connections.get(orgId)!;
        }

        // Native EventSource doesn't support custom headers.
        // Use @microsoft/fetch-event-source for Authorization header injection.
        const es = new EventSource(
            `/v2/organizations/${orgId}/sse/stream`,
            { withCredentials: true }
        );

        es.onerror = () => this.handleError(orgId);

        this.connections.set(orgId, es);
        return es;
    }

    on(orgId: string, eventType: string, handler: (e: MessageEvent) => void) {
        const es = this.connections.get(orgId);
        if (!es) return;

        if (!this.listeners.has(orgId)) {
            this.listeners.set(orgId, new Map());
        }
        const orgListeners = this.listeners.get(orgId)!;
        if (!orgListeners.has(eventType)) {
            orgListeners.set(eventType, new Set());
        }

        orgListeners.get(eventType)!.add(handler);
        es.addEventListener(eventType, handler);
    }

    disconnect(orgId: string) {
        const es = this.connections.get(orgId);
        if (!es) return;

        es.close();
        this.connections.delete(orgId);
        this.listeners.delete(orgId);
    }

    private handleError(orgId: string) {
        // EventSource retries automatically — no explicit reconnect needed.
        // If 3+ retries fail → signal fallback to polling.
    }
}

export const sseManager = new SSEConnectionManager();
```

---

### SSE Provider — React Component

```tsx
const SSE_EVENT_MAP: Record<string, QueryKey[]> = {
    project_created:     [['projects']],
    project_deleted:     [['projects']],
    project_updated:     [['projects']],
    collaborator_added:  [['projects'], ['collaborators']],
    collaborator_removed:[['projects'], ['collaborators']],
    cluster_updated:     [['clusters']],
    app_service_updated: [['app-services']],
};

export function SSEProvider({ children }: { children: ReactNode }) {
    const { orgId } = useOrganization();
    const queryClient = useQueryClient();
    const [sseActive, setSseActive] = useState(false);

    useEffect(() => {
        if (!orgId) return;

        const es = sseManager.connect(orgId, getToken);

        // Map each server event type → TanStack Query invalidations.
        // We never mutate cache directly — always refetch from source of truth.
        Object.entries(SSE_EVENT_MAP).forEach(([eventType, queryKeys]) => {
            sseManager.on(orgId, eventType, () => {
                queryKeys.forEach(key => {
                    queryClient.invalidateQueries({ queryKey: key });
                });
            });
        });

        es.onopen = () => setSseActive(true);
        es.onerror = () => setSseActive(false);

        return () => {
            sseManager.disconnect(orgId);
            setSseActive(false);
        };
    }, [orgId, queryClient]);

    // Expose SSE health to hooks so they know when to enable/disable polling.
    return (
        <SSEContext.Provider value={{ sseActive }}>
            {children}
        </SSEContext.Provider>
    );
}
```

---

### Polling Fallback Pattern

```typescript
// Hooks check SSE health and toggle polling accordingly.
export function useProjects() {
    const { sseActive } = useSSEContext();

    return useQuery({
        queryKey: ['projects'],
        queryFn: fetchProjects,
        // Poll only when SSE is unavailable (corporate firewalls, proxy issues).
        refetchInterval: sseActive ? false : 30_000,
        staleTime: sseActive ? Infinity : 0,
    });
}
```

This gives resilience without permanently falling back: as soon as SSE reconnects and `sseActive` flips to `true`, polling stops automatically.

---

## 3. Past Projects — Golang Context

### Couchbase Capella (Oct 2023 – Present)

**Core domain**: Cloud-hosted Couchbase database control plane (`cp-api`, `cp-jobs`)

- **SSE Infrastructure** (described above): Designed end-to-end, owned architecture and implementation
- **RBAC integration**: Worked within existing `rbac.Resolver` interfaces to add per-event authorization at fan-out time
- **Background job coordination** (`cp-jobs`): Understanding of how async cluster lifecycle jobs (deploy, scale, destroy) generate state-change events that feed the SSE bus
- **Multi-tenant routing**: Org-scoped endpoints, tenant isolation in broker data structures

**Golang patterns used in production:**
- Goroutine-per-client with `select`-based event loops
- Channel-only communication to avoid mutex races
- `context.Context` propagation for cancellation (SIGTERM → broker shutdown → handler exit)
- Structured logging with `zap` (direct `warn`/`error` outside request context)
- Interface-driven design (`RBACResolver`, `EventBus`) for testability

---

### Key Golang Concepts I Own

**Concurrency model decision — why channels, not sync.Mutex:**

```go
// Mutex approach (rejected):
type Broker struct {
    mu      sync.RWMutex
    clients map[string]chan Event
}
func (b *Broker) Send(id string, e Event) {
    b.mu.RLock()
    ch := b.clients[id]
    b.mu.RUnlock()
    ch <- e // Still need lock if channel could be closed concurrently
}

// Channel approach (implemented):
// One goroutine owns the map. All operations are messages.
// Zero lock contention, zero deadlock risk, clearer ownership.
```

**Error handling philosophy — don't block primary path:**

```go
// Publishing SSE events must never slow down HTTP response times.
// Missed SSE events are tolerable; stalled API responses are not.
go func() {
    if err := bus.Publish(event); err != nil {
        logger.Warn("event publish failed — client will refetch on next heartbeat",
            zap.Error(err), zap.String("resource_id", event.ResourceID))
    }
}()
```

**Interface-driven testing:**

```go
type RBACResolver interface {
    CanAccess(userID, resourceID, resourceType string) bool
    IsMemberOfOrg(userID, orgID string) bool
}

// In tests:
type mockRBAC struct{ allow bool }
func (m mockRBAC) CanAccess(_, _, _ string) bool { return m.allow }
func (m mockRBAC) IsMemberOfOrg(_, _ string) bool { return m.allow }

func TestFanOut_FiltersByRBAC(t *testing.T) {
    broker := NewBroker(mockRBAC{allow: false}, zap.NewNop())
    // ... assert event not delivered
}
```

---

## 4. Talking Points by Question Type

### "Walk me through a technically complex system you built"

Lead with the problem size (3,600 req/hr), transition to architecture diagram, drill into the broker's concurrency model (channels over mutexes), then NATS fan-out, then React integration. End with quantified impact.

### "How do you handle distributed systems at scale?"

NATS Event Bus removes sticky session requirements. Each `cp-api` instance subscribes independently — events reach all clients regardless of which pod they're connected to. Scaling is horizontal and linear.

### "How do you approach security in real-time systems?"

Per-event RBAC (not per-connection) means permission changes take effect within one event cycle, no stale authorization windows. Tenant-scoped endpoints (`/v2/organizations/{orgId}/...`) enforce isolation at the URL level before any broker logic runs.

### "Tell me about a time you improved system performance"

Polling → SSE: 3,600 req/hr → near-zero. The key insight was that most polling responses were empty (no state change), so shifting to push eliminated wasted work. The TanStack Query invalidation pattern preserved cache consistency without increasing complexity.

### "How do you balance backend and frontend concerns?"

SSE events are typed signals, not raw data payloads. The backend never tries to second-guess what the frontend renders. The frontend triggers `invalidateQueries` and lets TanStack refetch from the REST source of truth. This keeps the event payload small (resource ID + type), decouples the systems, and handles missed events gracefully.

---

## 5. System Design Keywords to Drop Naturally

| Concept | What to Say |
|---------|-------------|
| Backpressure | "Slow consumers are dropped via non-blocking channel send; EventSource auto-reconnects" |
| At-most-once delivery | "Acceptable because each event is a refetch signal, not the source of truth" |
| Fan-out | "Broker iterates connected clients per tenant, RBAC-filters, sends to buffered channels" |
| Horizontal scaling | "NATS removes sticky session requirement — any pod receives any event" |
| Graceful shutdown | "SIGTERM → cancel broker context → close all client channels → pod exits cleanly" |
| Connection lifecycle | "Register → goroutine-per-client loop → unregister on disconnect or timeout" |
| Cache invalidation | "SSE triggers TanStack Query `invalidateQueries` — server is always source of truth" |
| Heartbeat | "10-second SSE comment frames prevent proxy timeouts; absence triggers client fallback" |

---

## 6. Quick Architecture Comparison Table

| Decision | Chosen | Rejected | Why |
|----------|--------|----------|-----|
| Concurrency | Channels (single-owner goroutine) | `sync.RWMutex` | No deadlocks, clearer ownership |
| Event Bus | NATS Core Pub/Sub | Kafka, Redis, DCP | Lightweight, no persistence needed |
| Delivery semantics | At-most-once | Exactly-once (JetStream) | Events are signals, refetch is source of truth |
| RBAC timing | Per-event fan-out | Per-connection open | Self-correcting; no stale permission windows |
| Frontend state | TanStack invalidation | Direct cache mutation | Server is authoritative; handles missed events |
| Connection scope | Per-org endpoint | Single global endpoint | Clean org switching; simple RBAC scoping |
| Backpressure | Drop slow consumers | Queue / retry | Publisher latency stays independent of client speed |
| Auth for SSE | Bearer JWT in header | Query param token | Requires `@microsoft/fetch-event-source` (native EventSource lacks header support) |
