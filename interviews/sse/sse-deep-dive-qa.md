# SSE Architecture — Deep Dive Q&A with Implementation

---

## Q1. What is SSE and how is it different from regular HTTP?

**Simple answer**: In regular HTTP, the browser asks → server answers → connection closes. SSE flips this: the browser opens one connection and the server keeps sending data down that same connection whenever it wants.

**The protocol difference:**

```
Regular HTTP:
  Browser:  GET /projects          →
  Server:                          ← 200 OK { data: [...] }  [connection closes]
  Browser:  GET /projects (again)  →   (repeat every 30s)

SSE:
  Browser:  GET /sse/stream        →
  Server:                          ← 200 OK (headers flushed, connection stays open)
  Server:                          ← event: project_created\ndata: {"id":"abc"}\n\n
  Server:                          ← : heartbeat\n\n
  Server:                          ← event: cluster_updated\ndata: {"id":"xyz"}\n\n
  ...connection stays open for 15 minutes...
```

**What the raw SSE wire format looks like** (this is literally what travels over TCP):

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

: heartbeat

: heartbeat

event: project_created
data: {"tenant_id":"org-123","resource_id":"proj-456","resource_type":"project"}

event: collaborator_added
data: {"tenant_id":"org-123","resource_id":"user-789","resource_type":"user"}

: heartbeat
```

Rules of the format:
- Lines starting with `:` are comments (used for heartbeats — ignored by browser, but keep connection warm)
- `event:` sets the event name your `addEventListener` listens to
- `data:` is the JSON payload
- A blank line (`\n\n`) signals end of one event

---

## Q2. What exactly does the Browser (EventSource) do?

**Simple answer**: The browser has a built-in class called `EventSource` that handles the persistent connection for you, including automatic reconnect.

**What it does under the hood:**

```typescript
// You write this:
const es = new EventSource('/v2/organizations/org-123/sse/stream');

es.addEventListener('project_created', (e: MessageEvent) => {
    const payload = JSON.parse(e.data);
    console.log('New project:', payload.resource_id);
});

// Internally the browser does:
// 1. Opens a TCP connection to the server
// 2. Sends an HTTP GET with Accept: text/event-stream
// 3. Keeps the connection open indefinitely
// 4. Parses incoming text looking for event:/data: patterns
// 5. Fires the right event listeners
// 6. If connection drops → waits 3 seconds → reconnects automatically
// 7. Sends Last-Event-ID header on reconnect so server knows where to resume
```

**The problem with native EventSource**: It cannot send custom headers. You cannot do:

```typescript
// THIS DOES NOT WORK — EventSource has no headers option
new EventSource('/sse/stream', {
    headers: { Authorization: 'Bearer my-jwt' } // ← not supported
});
```

**How we solved it** — used `@microsoft/fetch-event-source` library which wraps `fetch` (which does support headers) to behave like EventSource:

```typescript
import { fetchEventSource } from '@microsoft/fetch-event-source';

fetchEventSource('/v2/organizations/org-123/sse/stream', {
    headers: {
        Authorization: `Bearer ${getJWT()}`,
        Accept: 'text/event-stream',
    },
    onmessage(event) {
        if (event.event === 'project_created') {
            queryClient.invalidateQueries({ queryKey: ['projects'] });
        }
    },
    onerror(err) {
        // Return a number to set custom retry delay (ms)
        // Throw to stop retrying entirely
        return 3000; // retry after 3s
    },
});
```

---

## Q3. What does the SSE Handler do and why does it need a goroutine per client?

**Simple answer**: When your browser hits the endpoint, Go starts a function that blocks indefinitely in a loop — waiting for either a heartbeat tick, an incoming event, or a disconnect signal. Each connected browser tab is one such blocking loop.

**The HTTP headers that turn a normal response into a stream:**

```go
w.Header().Set("Content-Type", "text/event-stream")  // tells browser: stream incoming
w.Header().Set("Cache-Control", "no-cache")           // don't let proxies cache this
w.Header().Set("Connection", "keep-alive")            // don't close after response
w.Header().Set("X-Accel-Buffering", "no")             // tells Nginx: flush immediately, don't buffer
flusher.Flush()                                        // send headers to client right now
```

Without `X-Accel-Buffering: no`, Nginx would buffer your data and only send it in chunks — the browser would see events arrive in batches, not instantly.

**The goroutine loop — what it does every iteration:**

```go
func (h *SSEHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // ... auth, registration ...

    heartbeat := time.NewTicker(10 * time.Second)
    defer heartbeat.Stop()

    // This is the goroutine — it sits here for the entire connection lifetime.
    // Go's select{} picks whichever channel has data first.
    for {
        select {

        case <-r.Context().Done():
            // Browser closed the tab, or network dropped.
            // r.Context() is cancelled automatically by Go's HTTP server.
            return

        case <-heartbeat.C:
            // Every 10 seconds, send a comment line.
            // Browser ignores it visually, but it keeps routers from
            // treating the connection as idle and killing it.
            fmt.Fprintf(w, ": heartbeat\n\n")
            flusher.Flush()

        case event, ok := <-client.Chan:
            if !ok {
                // Broker closed this channel — either shutdown or slow consumer.
                return
            }
            // Write SSE format to the response body.
            payload, _ := json.Marshal(event)
            fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, payload)
            flusher.Flush() // push bytes to TCP buffer immediately
        }
    }
}
```

**Why one goroutine per client and not one goroutine for all?**

If you used one goroutine for all 10,000 clients:
```
for _, client := range allClients {
    client.Chan <- event  // if one client is slow, this blocks for everyone
}
```
One slow client blocks the whole loop. With per-client goroutines, each client has its own `chan Event` — slow clients get their channel dropped (non-blocking send), others are unaffected.

**Memory cost**: Each goroutine starts at ~2KB stack. With 10,000 connections = ~20MB just for goroutine stacks + ~35MB for HTTP context = ~55MB total. Cheap.

---

## Q4. What is the In-Memory Broker and why does it have that nested map structure?

**Simple answer**: The broker is a directory of everyone currently connected. The three-level nesting — tenant → user → tab — exists because we need to route events to exactly the right people at exactly the right level of granularity.

**The data structure explained:**

```go
clients map[string]map[string]map[string]chan Event
//           ^           ^           ^        ^
//        tenantID     userID     clientID  channel to that tab
```

**Concrete example** — what it looks like in memory:

```
clients = {
    "org-acme": {
        "user-alice": {
            "tab-chrome-1": chan Event  ← Alice's Chrome tab
            "tab-firefox-2": chan Event ← Alice's Firefox tab (same user, 2 tabs)
        },
        "user-bob": {
            "tab-safari-1": chan Event  ← Bob's Safari tab
        }
    },
    "org-globex": {
        "user-carol": {
            "tab-chrome-1": chan Event  ← Carol works at a different company
        }
    }
}
```

**Why three levels and not just a flat map?**

```go
// Flat map approach (bad):
clients map[string]chan Event  // clientID → channel

// Problem 1: When broadcasting, you'd iterate ALL clients across ALL tenants
//            and have to filter by org manually → O(total clients) per event

// Problem 2: No way to enforce "max 2 tabs per user" without
//            scanning and counting

// Three-level approach (good):
// When event arrives for org-acme:
tenantClients := clients["org-acme"]  // instantly isolated to one org
// When checking user connection count:
userClients := tenantClients["user-alice"]  // len() gives tab count directly
```

**Why single goroutine owns the map?**

```go
// If two goroutines write the map at the same time:
// Goroutine A: clients["org-acme"]["user-alice"]["tab-1"] = ch1
// Goroutine B: clients["org-acme"]["user-bob"]["tab-1"] = ch2
// → Go runtime panics: "concurrent map writes"

// Solution — all map changes go through channels to one goroutine:
type Broker struct {
    clients    map[string]map[string]map[string]chan Event
    register   chan *Client   // "please add this client"
    unregister chan *Client   // "please remove this client"
    broadcast  chan Event     // "please send this to everyone who should see it"
}

func (b *Broker) Run(ctx context.Context) {
    for {
        select {
        case c := <-b.register:
            b.addClient(c)    // safe: only this goroutine touches the map
        case c := <-b.unregister:
            b.removeClient(c) // safe
        case event := <-b.broadcast:
            b.fanOut(event)   // safe
        case <-ctx.Done():
            b.shutdownAll()
            return
        }
    }
}
```

---

## Q5. How does the per-event RBAC check work and why not check once at connection time?

**Simple answer**: When Alice connects, her permissions are checked. But what if Bob (an admin) removes Alice from a project *while she's connected*? If we only checked at connect time, Alice keeps receiving project events even after being removed. Per-event checks catch this immediately.

**RBAC resolver interface:**

```go
type RBACResolver interface {
    CanAccess(userID, resourceID, resourceType string) bool
    IsMemberOfOrg(userID, orgID string) bool
}
```

**The fan-out with RBAC:**

```go
func (b *Broker) fanOut(event Event) {
    tenantClients, ok := b.clients[event.TenantID]
    if !ok {
        return // no one connected to this org right now
    }

    for userID, userClients := range tenantClients {

        authorized := b.rbac.CanAccess(userID, event.ResourceID, event.ResourceType)

        // Special case: when a collaborator is removed from a project,
        // their permissions are deleted BEFORE this event fires.
        // So CanAccess returns false for them — but they MUST receive
        // this event so their UI removes the project card.
        // We bypass the check with a user-targeted publish.
        if !authorized {
            isRemovalEvent := event.Type == "collaborator_removed" &&
                              event.AffectedUserID == userID
            if !isRemovalEvent {
                continue // skip this user — they can't see this resource
            }
        }

        for clientID, ch := range userClients {
            select {
            case ch <- event:
                // delivered to this tab
            default:
                // channel buffer full = slow consumer
                // close the channel, the handler goroutine will exit,
                // EventSource on browser will reconnect automatically
                b.logger.Warn("dropping slow consumer",
                    zap.String("user", userID),
                    zap.String("client", clientID))
                close(ch)
                delete(userClients, clientID)
            }
        }
    }
}
```

**Timeline showing why per-event RBAC matters:**

```
T=0:00  Alice connects to SSE stream
        → CanAccess("alice", "proj-abc") = true  (she's a collaborator)

T=0:30  Bob creates a new cluster in proj-abc
        → fanOut fires, CanAccess("alice", "proj-abc") = true
        → Alice receives "cluster_created" event ✓

T=1:00  Admin removes Alice from proj-abc
        → Alice receives "collaborator_removed" event (bypass check) ✓
        → Her UI removes proj-abc from the list

T=1:30  Bob updates proj-abc name
        → fanOut fires, CanAccess("alice", "proj-abc") = false
        → Alice receives NOTHING ✓  (self-corrected, no reconnect needed)

T=2:00  Admin re-adds Alice to proj-abc
        → fanOut fires, CanAccess("alice", "proj-abc") = true again
        → Alice starts receiving events again ✓
```

---

## Q6. What is NATS and why is it needed?

**Simple answer**: Your API runs on multiple servers (pods). If a user is connected to Pod A but their project gets created on Pod B, Pod A never hears about it — so the user's browser never updates. NATS is a message bus that makes all pods receive all events simultaneously.

**The problem without NATS:**

```
User's browser → Pod A (SSE connection lives here)

Bob creates project → Pod B handles the HTTP POST → writes to DB
                                 ↓
                         Pod B's broker gets the event
                                 ↓
                    Only Pod B's connected clients are notified
                                 ↓
                    Pod A's broker never hears about it
                                 ↓
                    User's browser tab (on Pod A) never updates ✗
```

**With NATS:**

```
Bob creates project → any pod handles POST → writes to DB
                                 ↓
                    publishes to NATS topic "capella.events"
                                 ↓
                 NATS delivers to ALL subscribed pods simultaneously
                            ↙        ↓        ↘
                         Pod A     Pod B     Pod C
                           ↓         ↓         ↓
                     each pod's broker does local fan-out
                           ↓
                 User's browser (on any pod) gets the update ✓
```

**What NATS Core Pub/Sub means:**

```go
// Publisher (backend service after mutation):
nc, _ := nats.Connect("nats://nats-cluster:4222")
payload, _ := json.Marshal(event)
nc.Publish("capella.events", payload)
// That's it. Fire and forget. No waiting for delivery confirmation.

// Subscriber (runs in each cp-api pod on startup):
nc.Subscribe("capella.events", func(msg *nats.Msg) {
    var event Event
    json.Unmarshal(msg.Data, &event)
    broker.Publish(event) // forward to local in-memory broker
})
```

**Why not Kafka?**

```
Kafka needs:
  - Zookeeper/KRaft for coordination
  - Topic partition configuration
  - Consumer group management
  - Offset tracking
  - Retention policy decisions
  → Heavyweight. ~30 minute setup. Built for durable streaming.

NATS Core needs:
  - Just the NATS server binary
  - One .Publish() call
  - One .Subscribe() call
  → 5 minute setup. No persistence. Built for lightweight signaling.

Our events are signals (triggers for refetch), not data.
A missed signal is fine — the next heartbeat causes a refetch anyway.
Kafka's durability guarantees are solving a problem we don't have.
```

**NATS 3-node cluster across 3 AZs:**

```
AZ-1: nats-pod-1 ←──gossip──→ nats-pod-2 :AZ-2
           ↑                        ↑
           └──────gossip────────────┘
                      ↑
                  nats-pod-3 :AZ-3

If nats-pod-2 dies:
→ nats-pod-1 and nats-pod-3 continue serving
→ Go NATS client reconnects automatically to a live node
→ Zero disruption to publishers or subscribers
```

---

## Q7. What does "fire-and-forget" mean and why is it safe?

**Simple answer**: After saving to the database, the backend publishes the event to NATS and immediately returns the HTTP response to the user. It does not wait to confirm the event was delivered to every browser tab.

**Code showing why this is important:**

```go
func (s *ProjectService) CreateProject(ctx context.Context, p *Project) error {
    // Step 1: Save to database (MUST succeed)
    if err := s.db.Save(ctx, p); err != nil {
        return err // return error to the API caller
    }

    // Step 2: Publish SSE event (best effort, non-blocking)
    go func() {
        event := Event{
            TenantID:     p.TenantID,
            Type:         "project_created",
            ResourceID:   p.ID,
            ResourceType: "project",
        }
        if err := s.eventBus.Publish(event); err != nil {
            // Log it, but don't fail the user's request.
            // The project was successfully created in the database.
            // The user will see it on next refresh or heartbeat-triggered refetch.
            s.logger.Warn("event publish failed",
                zap.Error(err),
                zap.String("resource_id", p.ID))
        }
    }()

    // Step 3: Return to caller — the HTTP POST /projects responds fast
    return nil
}
```

**Why is it safe to miss events?**

Because the event is not the data — it is just a nudge. The browser's reaction to any event is:

```typescript
es.addEventListener('project_created', () => {
    // We do NOT use event.data to update the UI directly.
    // We just tell TanStack Query: "your cache is stale, go refetch."
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    // TanStack then calls GET /projects → server returns fresh list
    // Server response is the source of truth, not the SSE payload
});
```

So the correctness model is:
```
Missed event  → UI not updated instantly → user sees stale data for 10 seconds max
              → next heartbeat causes no refetch (nothing changed from browser perspective)
              → but: next SSE event OR manual refresh shows correct data

This is identical to the old polling model's guarantee, just faster in the happy path.
```

---

## Q8. What happens when a user opens multiple browser tabs?

**Simple answer**: Each tab gets its own SSE connection. The broker handles this by allowing up to 2 connections per user. All tabs for the same user see the same events because RBAC is based on `userID`, not `clientID`.

**How the connection limit is enforced:**

```go
func (b *Broker) Register(tenantID, userID string) (*Client, error) {
    // This runs inside the single Run() goroutine — no race conditions.

    if _, ok := b.clients[tenantID]; !ok {
        b.clients[tenantID] = make(map[string]map[string]chan Event)
    }
    if _, ok := b.clients[tenantID][userID]; !ok {
        b.clients[tenantID][userID] = make(map[string]chan Event)
    }

    // Count existing tabs for this user
    currentTabs := len(b.clients[tenantID][userID])
    if currentTabs >= MaxConnectionsPerUser { // MaxConnectionsPerUser = 2
        return nil, errors.New("connection limit exceeded")
    }

    // Create a buffered channel for this tab
    clientID := uuid.New().String()
    ch := make(chan Event, 10) // buffer 10 events
    b.clients[tenantID][userID][clientID] = ch

    return &Client{
        TenantID: tenantID,
        UserID:   userID,
        ClientID: clientID,
        Chan:     ch,
    }, nil
}
```

**The HTTP handler rejects the 3rd tab:**

```go
client, err := h.broker.Register(tenantID, userID)
if err != nil {
    // Browser gets 429, EventSource stops retrying
    http.Error(w, "Too Many Connections", http.StatusTooManyRequests)
    return
}
```

**What the broker looks like with 2 tabs:**

```
clients["org-acme"]["user-alice"] = {
    "tab-uuid-1": chan Event (buffered, 10)   ← Chrome
    "tab-uuid-2": chan Event (buffered, 10)   ← Firefox
}

When event arrives for Alice:
  → both channels receive the event
  → both tabs update simultaneously
```

---

## Q9. How does graceful shutdown work during a Kubernetes deployment?

**Simple answer**: When Kubernetes wants to replace a pod with a new version, it sends SIGTERM. If Go's HTTP server just waits for all connections to drain naturally, SSE connections could hold the pod alive for up to 15 minutes (their max lifetime). That would block every deployment. So we actively close all connections on SIGTERM.

**The shutdown chain:**

```go
// main.go
sigCh := make(chan os.Signal, 1)
signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

brokerCtx, brokerCancel := context.WithCancel(context.Background())
go broker.Run(brokerCtx)

// Block until signal arrives
<-sigCh

// Step 1: Cancel broker context → triggers shutdownAll() inside Run()
brokerCancel()

// Step 2: Graceful HTTP shutdown (waits for non-SSE requests to finish)
shutdownCtx, _ := context.WithTimeout(context.Background(), 10*time.Second)
server.Shutdown(shutdownCtx)
```

**Inside the broker — shutdownAll closes every channel:**

```go
func (b *Broker) shutdownAll() {
    for tenantID, tenantClients := range b.clients {
        for userID, userClients := range tenantClients {
            for clientID, ch := range userClients {
                close(ch) // signals the SSEHandler goroutine to exit
                delete(userClients, clientID)
            }
            delete(tenantClients, userID)
        }
        delete(b.clients, tenantID)
    }
}
```

**Inside the SSE handler — detecting closed channel:**

```go
case event, ok := <-client.Chan:
    if !ok {
        // ok=false means channel was closed by broker (shutdown or slow consumer)
        // Just return — the HTTP handler exits, connection closes cleanly
        return
    }
```

**The full shutdown timeline:**

```
T=0s    Kubernetes sends SIGTERM to the pod
T=0s    main.go catches SIGTERM, calls brokerCancel()
T=0s    broker.Run() receives ctx.Done(), calls shutdownAll()
T=0s    All client channels closed
T=0s    All SSEHandler goroutines detect closed channel, return
T=0s    All SSE HTTP connections close
T=0s    server.Shutdown() sees zero active connections, exits immediately
T=1s    Pod exits cleanly
T=1s    Kubernetes removes pod from load balancer

Client side:
T=0s    Browser detects connection closed
T=3s    EventSource auto-reconnects to new pod
T=3s    User sees no interruption (heartbeat missed once, recoverable)
```

---

## Q10. How does the React SSE Provider connect everything on the frontend?

**Simple answer**: A React component wraps the app, opens the SSE connection when a user logs into an org, listens for typed events, and triggers TanStack Query refetches. When the user switches org or logs out, it tears down the connection cleanly.

**Full flow with code:**

```typescript
// 1. Event type definitions (strongly typed)
type SSEEventType =
    | 'project_created'
    | 'project_deleted'
    | 'project_updated'
    | 'collaborator_added'
    | 'collaborator_removed'
    | 'cluster_updated'
    | 'app_service_updated';

// 2. Map: which server event invalidates which query cache keys
const SSE_INVALIDATION_MAP: Record<SSEEventType, QueryKey[]> = {
    project_created:      [['projects']],
    project_deleted:      [['projects']],
    project_updated:      [['projects']],
    collaborator_added:   [['projects'], ['collaborators']],
    collaborator_removed: [['projects'], ['collaborators']],
    cluster_updated:      [['clusters']],
    app_service_updated:  [['app-services']],
};

// 3. The Provider component
export function SSEProvider({ children }: { children: ReactNode }) {
    const { orgId } = useActiveOrganization();
    const queryClient = useQueryClient();
    const [sseHealthy, setSseHealthy] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!orgId) return;

        // AbortController lets us cancel the fetch-event-source on cleanup
        const controller = new AbortController();
        abortRef.current = controller;

        fetchEventSource(`/v2/organizations/${orgId}/sse/stream`, {
            headers: {
                Authorization: `Bearer ${getAuthToken()}`,
            },
            signal: controller.signal,

            onopen: async (response) => {
                if (response.ok) {
                    setSseHealthy(true);
                } else if (response.status === 429) {
                    // Too many tabs open — don't retry
                    throw new Error('Connection limit exceeded');
                }
            },

            onmessage: (event) => {
                const eventType = event.event as SSEEventType;
                const keysToInvalidate = SSE_INVALIDATION_MAP[eventType];

                if (keysToInvalidate) {
                    keysToInvalidate.forEach(key => {
                        queryClient.invalidateQueries({ queryKey: key });
                    });
                }
            },

            onerror: () => {
                setSseHealthy(false);
                return 3000; // retry after 3 seconds
            },

            onclose: () => {
                setSseHealthy(false);
            },
        });

        // Cleanup: runs when orgId changes (org switch) or component unmounts
        return () => {
            controller.abort();
            setSseHealthy(false);
        };
    }, [orgId, queryClient]);

    return (
        <SSEContext.Provider value={{ sseHealthy }}>
            {children}
        </SSEContext.Provider>
    );
}

// 4. Hooks use SSE health to toggle polling
export function useProjects() {
    const { sseHealthy } = useSSEContext();

    return useQuery({
        queryKey: ['projects'],
        queryFn: () => api.get('/projects'),
        // When SSE is up: never poll (refetch only on invalidation)
        // When SSE is down: poll every 30s as fallback
        refetchInterval: sseHealthy ? false : 30_000,
        staleTime: sseHealthy ? Infinity : 0,
    });
}
```

**What the component tree looks like:**

```tsx
<QueryClientProvider client={queryClient}>
    <AuthProvider>
        <SSEProvider>          ← opens SSE connection, listens for events
            <Router>
                <ProjectsPage />   ← uses useProjects() which TanStack updates
                <ClustersPage />   ← uses useClusters()
            </Router>
        </SSEProvider>
    </AuthProvider>
</QueryClientProvider>
```

**What happens when Alice switches from Org A to Org B:**

```
1. orgId changes from "org-a" to "org-b"
2. useEffect cleanup runs → controller.abort() → SSE connection to org-a closes
3. useEffect runs again with new orgId → new SSE connection to org-b opens
4. Alice now receives events only for org-b
5. No stale events from org-a can reach her
```

---

## Summary: The Full Journey of One Event

```
1. Bob (UI) clicks "Create Project"
   → POST /v2/organizations/org-acme/projects

2. cp-api handler receives request
   → validates input
   → saves project to Couchbase DB
   → go func() { nats.Publish("capella.events", projectCreatedEvent) }()
   → returns 201 Created to Bob's browser

3. NATS receives the publish
   → delivers to ALL subscribed cp-api pods simultaneously (< 5ms)

4. Each cp-api pod's NATS subscriber callback fires
   → broker.broadcast <- event

5. broker.Run() goroutine receives event from broadcast channel
   → calls fanOut(event)
   → looks up clients["org-acme"]
   → iterates users: alice, carol, dave, ...
   → for each user: rbac.CanAccess(userID, "proj-new", "project")
   → for authorized users: sends event to their buffered channel(s)

6. Alice's SSEHandler goroutine (on any pod) receives from client.Chan
   → writes "event: project_created\ndata: {...}\n\n" to HTTP response
   → calls flusher.Flush() → bytes go over TCP immediately

7. Alice's browser EventSource fires the "project_created" listener
   → queryClient.invalidateQueries({ queryKey: ['projects'] })

8. TanStack Query sees stale cache
   → fires GET /v2/organizations/org-acme/projects
   → receives fresh list including the new project
   → React re-renders ProjectsPage with new project card

Total time from Bob clicking → Alice seeing the new project: < 500ms
Old polling approach: up to 30 seconds
```
