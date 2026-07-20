# Technical Q&A - Hydden Interview

## Table of Contents
1. [Identity Security Concepts](#identity-security-concepts)
2. [Golang System Design Questions](#golang-system-design-questions)
3. [Concurrency & Scaling](#concurrency--scaling)
4. [Your SSE Experience - Deep Dive](#your-sse-experience---deep-dive)

---

## Identity Security Concepts

### Q1: What's the difference between identity discovery, identity inventory, and identity monitoring?

**Answer:**

**Identity Discovery** is the initial process of finding all identities across your systems.
- **Scope**: One-time or periodic scans to find accounts, service accounts, API keys
- **Output**: "Here are all the identities we found in AD, AWS, Azure, legacy systems"
- **Challenge**: Systems don't always expose identities via APIs, especially legacy
- **Hydden's approach**: Connects to "anything," discovers identities everywhere

**Identity Inventory** is maintaining an up-to-date catalog of discovered identities.
- **Scope**: Ongoing management of the identity catalog
- **Output**: "Here's our current list of all identities with metadata (owner, type, source system)"
- **Challenge**: Inventory goes stale if not continuously refreshed
- **Hydden's approach**: Multiple discovery cycles per day keeps inventory fresh

**Identity Monitoring** is watching identity behavior and changes over time.
- **Scope**: Real-time or near-real-time tracking of identity activity
- **Output**: "User X just gained new permissions," "Service account Y hasn't been used in 90 days"
- **Challenge**: Requires integration with activity logs, permission systems, behavioral analytics
- **Hydden's approach**: Continuous monitoring + behavioral modeling for anomaly detection

**My Experience Connection:**
> "In my SSE work, we moved from periodic polling (like periodic discovery) to continuous monitoring (real-time updates). The same shift Hydden makes - instead of quarterly access reviews that produce stale inventory, you're continuously discovering and monitoring identity changes as they happen."

---

### Q2: What are non-human identities and why are they challenging?

**Answer:**

**Non-Human Identities** include:
- Service accounts (app-to-app authentication)
- API keys and tokens (OAuth tokens, JWT, static API keys)
- Machine identities (TLS certificates, SSH keys)
- Cloud IAM roles (AWS IAM roles, Azure managed identities, GCP service accounts)
- IoT device credentials

**Why They're Challenging:**

1. **No Clear Owner**
   - Created by developer who left 2 years ago
   - Shared across teams
   - Documentation missing: "Whose service account is this?"

2. **Long-Lived and Forgotten**
   - API keys never expire or rotated
   - Service accounts outlive the services they were created for
   - Certificate renewal failures cause outages

3. **Excessive Permissions**
   - Created with admin privileges "just in case"
   - Violate least privilege principle
   - If compromised, provide broad access

4. **Hard to Discover**
   - Not in employee directory systems
   - Scattered across cloud providers, legacy systems
   - No central registry

5. **Behavioral Anomalies**
   - Service account suddenly accessed from new location
   - API key usage pattern changes dramatically
   - Hard to distinguish legitimate automation from compromise

**Hydden's Approach:**
- Treats non-human identities as **first-class citizens** (not an afterthought)
- Automatically discovers them across all systems
- Maps them back to human owners
- Models normal behavior to detect anomalies

**My Experience Connection:**
> "In our SSE system, we handled both human users and service accounts connecting to the event stream. We had to track 'who owns this connection' - whether it was a user's browser or a backend service. Similarly, Hydden needs to discover non-human identities and map them back to owners, which requires correlation across systems and organizational knowledge."

---

### Q3: Explain privilege escalation attack paths through identity graphs.

**Answer:**

**Privilege Escalation** is gaining higher privileges than intended by exploiting identity relationships.

**Simple Example:**
```
Alice (Developer) → Can assume ServiceAccountA (Admin on Database)
                    → ServiceAccountA can access Production DB

Attack Path: Alice's stolen credentials → Assume ServiceAccountA → Admin access
```

**Identity Graph Concept:**
```
Nodes: Identities (users, service accounts, roles)
Edges: Relationships (can-assume, owns, has-permission-to)

Attack Path = Graph traversal from compromised identity to target resource
```

**Real-World Scenario:**

1. **Initial Compromise**: Attacker phishes Junior Developer's credentials
2. **Discovery**: Developer has permission to deploy to Dev environment
3. **Pivot**: Dev deployment uses service account with Production read access
4. **Escalation**: Service account can assume a higher-privilege role
5. **Lateral Movement**: Higher role has access to other cloud accounts
6. **Goal Achieved**: Access sensitive customer data

**Traditional Tools Miss This:**
- PAM sees the service account but not the relationship chain
- IAM sees individual permissions but not the path
- IGA does quarterly reviews (too slow to catch active attacks)

**Hydden's Advantage:**
- **Identity Graph**: Models all relationships
- **Path Analysis**: Can query "How can Identity A reach Resource B?"
- **Real-Time Detection**: Alerts when unusual paths are traversed
- **Visualization**: Shows SecOps the attack chain

**My Experience Connection:**
> "In our RBAC implementation, we had hierarchical permissions - org owners inherit project permissions, project members inherit resource permissions. We had to ensure authorization checks prevented unintended access through relationship chains. Hydden faces the same problem at enterprise scale across disconnected systems - understanding not just 'who has access' but 'who can get access through what path.'"

---

### Q4: How would you discover all identities in a hybrid environment (cloud + on-prem + legacy)?

**Answer:**

**Approach:**

**1. Identify Identity Sources**
```
Cloud:
- AWS IAM (users, roles, service accounts)
- Azure AD (users, groups, managed identities)
- GCP IAM (users, service accounts, workload identities)
- SaaS apps (Okta, GitHub, Salesforce users)

On-Premise:
- Active Directory / LDAP
- Legacy databases (Oracle, SQL Server local users)
- Mainframe systems (RACF, ACF2, Top Secret)

Legacy:
- Custom authentication systems
- SSH keys and service accounts on servers
- Application-specific user tables
```

**2. Design Discovery Architecture**

```go
// Discovery Agent pattern
type DiscoveryAgent interface {
    Connect(config SourceConfig) error
    DiscoverIdentities(ctx context.Context) ([]Identity, error)
    GetMetadata() SourceMetadata
}

// Specific implementations
type ADAgent struct { /* LDAP connection */ }
type AWSAgent struct { /* AWS SDK */ }
type LegacyDBAgent struct { /* Database driver */ }
type CustomAgent struct { /* Custom protocol */ }
```

**3. Concurrent Discovery**
```go
func DiscoverAll(sources []DiscoveryAgent) []Identity {
    results := make(chan []Identity, len(sources))
    
    // Discover from all sources concurrently
    for _, agent := range sources {
        go func(a DiscoveryAgent) {
            identities, err := a.DiscoverIdentities(context.Background())
            if err != nil {
                log.Error("Discovery failed", "agent", a.GetMetadata())
                results <- []Identity{}
                return
            }
            results <- identities
        }(agent)
    }
    
    // Aggregate results
    var allIdentities []Identity
    for i := 0; i < len(sources); i++ {
        identities := <-results
        allIdentities = append(allIdentities, identities...)
    }
    
    return allIdentities
}
```

**4. Identity Correlation**
```
Problem: Same person exists as:
- john.doe@company.com (Azure AD)
- jdoe (Active Directory)
- john_doe (AWS IAM)
- JDOE (Mainframe)

Solution: Correlation engine
- Email matching
- Employee ID mapping
- Username pattern analysis
- Manual mapping for edge cases
```

**5. Handle Legacy Systems Without APIs**
```
Options:
1. Log parsing: Analyze authentication logs
2. Database queries: Direct SQL to user tables
3. File parsing: Parse passwd files, config files
4. Agent installation: Deploy lightweight agent on legacy system
5. Network monitoring: Observe authentication traffic
```

**6. Continuous Discovery**
```go
func ContinuousDiscovery(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    
    for {
        select {
        case <-ticker.C:
            identities := DiscoverAll(sources)
            UpdateInventory(identities)
            DetectChanges(identities)
        }
    }
}
```

**Challenges:**
- **Rate limiting**: Cloud APIs have limits (need backoff)
- **Authentication**: Each source requires credentials/tokens
- **Permissions**: Discovery agent needs read access everywhere
- **Scale**: 70K users across 20+ sources = millions of API calls
- **Failures**: Some sources will be slow/unavailable (need timeouts)

**My SSE Experience Applied:**
> "This is similar to our Event Bus architecture - multiple independent sources (identity systems = API instances) that need to be aggregated into a unified view (identity inventory = event stream). I used concurrent goroutines with channels for aggregation, timeouts for slow sources, and graceful handling of failures. The same patterns apply to identity discovery at scale."

---

## Golang System Design Questions

### Q5: Design an identity discovery system that scans 70K users across multiple Active Directory forests.

**Requirements:**
- Multiple AD forests (different domains, different credentials)
- 70,000 total users across all forests
- Discover multiple times per day without impacting AD performance
- Detect changes (new users, deleted users, permission changes)
- Handle AD being temporarily unavailable

**Design:**

```go
package identity

import (
    "context"
    "sync"
    "time"
)

// Identity represents a discovered identity
type Identity struct {
    ID           string
    SourceSystem string
    Username     string
    Email        string
    Groups       []string
    LastSeen     time.Time
    Metadata     map[string]string
}

// ADForest represents an Active Directory forest
type ADForest struct {
    Name        string
    DomainController string
    Credentials Credentials
}

// DiscoveryEngine orchestrates identity discovery
type DiscoveryEngine struct {
    forests      []ADForest
    inventory    *IdentityInventory
    changeDetector *ChangeDetector
    rateLimiter  *RateLimiter
}

// Discover performs a full discovery cycle
func (e *DiscoveryEngine) Discover(ctx context.Context) error {
    results := make(chan []Identity, len(e.forests))
    errors := make(chan error, len(e.forests))
    
    // Concurrent discovery across all forests
    var wg sync.WaitGroup
    for _, forest := range e.forests {
        wg.Add(1)
        go func(f ADForest) {
            defer wg.Done()
            
            // Rate limit per forest to avoid overloading AD
            e.rateLimiter.Wait(f.Name)
            
            // Discover with timeout
            ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
            defer cancel()
            
            identities, err := e.discoverForest(ctx, f)
            if err != nil {
                errors <- err
                return
            }
            
            results <- identities
        }(forest)
    }
    
    // Wait for all discoveries to complete
    go func() {
        wg.Wait()
        close(results)
        close(errors)
    }()
    
    // Aggregate results
    var allIdentities []Identity
    for identities := range results {
        allIdentities = append(allIdentities, identities...)
    }
    
    // Update inventory and detect changes
    changes := e.changeDetector.DetectChanges(e.inventory.GetAll(), allIdentities)
    e.inventory.Update(allIdentities)
    e.publishChanges(changes)
    
    return nil
}

// discoverForest discovers all identities in a single AD forest
func (e *DiscoveryEngine) discoverForest(ctx context.Context, forest ADForest) ([]Identity, error) {
    conn, err := connectToAD(forest)
    if err != nil {
        return nil, err
    }
    defer conn.Close()
    
    // Paginated LDAP query (AD limits result sets)
    var identities []Identity
    pageSize := 1000
    
    for {
        page, err := conn.QueryUsers(ctx, pageSize)
        if err != nil {
            return nil, err
        }
        
        identities = append(identities, page...)
        
        if len(page) < pageSize {
            break // Last page
        }
    }
    
    return identities, nil
}

// ChangeDetector identifies what changed between discovery cycles
type ChangeDetector struct{}

type Change struct {
    Type     string // "added", "removed", "modified"
    Identity Identity
    Field    string // which field changed
    OldValue string
    NewValue string
}

func (cd *ChangeDetector) DetectChanges(old, new []Identity) []Change {
    oldMap := make(map[string]Identity)
    newMap := make(map[string]Identity)
    
    for _, id := range old {
        oldMap[id.ID] = id
    }
    for _, id := range new {
        newMap[id.ID] = id
    }
    
    var changes []Change
    
    // Detect additions
    for id, identity := range newMap {
        if _, exists := oldMap[id]; !exists {
            changes = append(changes, Change{
                Type:     "added",
                Identity: identity,
            })
        }
    }
    
    // Detect removals
    for id, identity := range oldMap {
        if _, exists := newMap[id]; !exists {
            changes = append(changes, Change{
                Type:     "removed",
                Identity: identity,
            })
        }
    }
    
    // Detect modifications
    for id, newIdentity := range newMap {
        if oldIdentity, exists := oldMap[id]; exists {
            // Compare groups (permissions)
            if !equalGroups(oldIdentity.Groups, newIdentity.Groups) {
                changes = append(changes, Change{
                    Type:     "modified",
                    Identity: newIdentity,
                    Field:    "groups",
                    OldValue: fmt.Sprint(oldIdentity.Groups),
                    NewValue: fmt.Sprint(newIdentity.Groups),
                })
            }
        }
    }
    
    return changes
}

// RateLimiter prevents overloading AD controllers
type RateLimiter struct {
    limiters map[string]*time.Ticker
    mu       sync.Mutex
}

func NewRateLimiter(requestsPerSecond int) *RateLimiter {
    return &RateLimiter{
        limiters: make(map[string]*time.Ticker),
    }
}

func (rl *RateLimiter) Wait(forestName string) {
    rl.mu.Lock()
    ticker, exists := rl.limiters[forestName]
    if !exists {
        ticker = time.NewTicker(time.Second / 10) // 10 requests/sec
        rl.limiters[forestName] = ticker
    }
    rl.mu.Unlock()
    
    <-ticker.C
}
```

**Key Design Decisions:**

1. **Concurrent Discovery**: Each AD forest discovered in parallel (goroutines)
2. **Rate Limiting**: Prevent overloading AD controllers (production system impact)
3. **Pagination**: LDAP results are paginated (AD returns max 1000 at a time)
4. **Change Detection**: Compare previous inventory to new discoveries (delta)
5. **Timeouts**: Each forest discovery has timeout (handle unavailability)
6. **Graceful Degradation**: Failed forests don't block others

**My SSE Experience Applied:**
> "This design mirrors my SSE broker architecture - concurrent handling of multiple sources (AD forests = client connections), rate limiting to prevent overwhelming the system, graceful handling of slow/failed sources, and change detection to only process deltas instead of full state every time."

---

### Q6: Design a real-time identity anomaly detection system.

**Requirements:**
- Stream of identity events: logins, permission changes, resource access
- 10,000 events/second across all systems
- Detect anomalies in real-time (< 5 seconds)
- Alerting to SecOps team
- Handle bursty traffic

**Design:**

```go
package anomaly

import (
    "context"
    "time"
)

// Event represents an identity-related event
type Event struct {
    Timestamp    time.Time
    IdentityID   string
    EventType    string // "login", "permission_change", "resource_access"
    SourceSystem string
    SourceIP     string
    Resource     string
    Metadata     map[string]interface{}
}

// Anomaly represents a detected anomaly
type Anomaly struct {
    Event       Event
    AnomalyType string
    Confidence  float64
    Reason      string
}

// DetectionEngine processes events and detects anomalies
type DetectionEngine struct {
    eventStream   chan Event
    anomalyStream chan Anomaly
    detectors     []Detector
    stateStore    *StateStore
}

// Detector interface for different anomaly detection strategies
type Detector interface {
    Detect(ctx context.Context, event Event, state *IdentityState) *Anomaly
}

// IdentityState tracks historical behavior per identity
type IdentityState struct {
    IdentityID      string
    NormalLocations []string
    NormalHours     []int // hour of day (0-23)
    TypicalResources []string
    AverageEventsPerHour float64
    LastSeen        time.Time
}

// StateStore maintains identity behavioral state
type StateStore struct {
    states map[string]*IdentityState
    mu     sync.RWMutex
}

func (ss *StateStore) Get(identityID string) *IdentityState {
    ss.mu.RLock()
    defer ss.mu.RUnlock()
    return ss.states[identityID]
}

func (ss *StateStore) Update(identityID string, event Event) {
    ss.mu.Lock()
    defer ss.mu.Unlock()
    
    state, exists := ss.states[identityID]
    if !exists {
        state = &IdentityState{IdentityID: identityID}
        ss.states[identityID] = state
    }
    
    // Update behavioral profile
    state.LastSeen = event.Timestamp
    // ... update statistics
}

// ProcessEvents is the main event processing loop
func (de *DetectionEngine) ProcessEvents(ctx context.Context) {
    // Worker pool for parallel processing
    numWorkers := 10
    
    for i := 0; i < numWorkers; i++ {
        go de.worker(ctx)
    }
}

func (de *DetectionEngine) worker(ctx context.Context) {
    for {
        select {
        case event := <-de.eventStream:
            de.processEvent(event)
        case <-ctx.Done():
            return
        }
    }
}

func (de *DetectionEngine) processEvent(event Event) {
    // Get identity's historical behavior
    state := de.stateStore.Get(event.IdentityID)
    if state == nil {
        // First time seeing this identity, create baseline
        de.stateStore.Update(event.IdentityID, event)
        return
    }
    
    // Run all detectors
    for _, detector := range de.detectors {
        anomaly := detector.Detect(context.Background(), event, state)
        if anomaly != nil {
            de.anomalyStream <- *anomaly
        }
    }
    
    // Update state with new event
    de.stateStore.Update(event.IdentityID, event)
}

// Example Detectors

// LocationAnomalyDetector detects logins from unusual locations
type LocationAnomalyDetector struct{}

func (d *LocationAnomalyDetector) Detect(ctx context.Context, event Event, state *IdentityState) *Anomaly {
    if event.EventType != "login" {
        return nil
    }
    
    // Check if location is in normal set
    for _, loc := range state.NormalLocations {
        if event.SourceIP == loc {
            return nil // Normal
        }
    }
    
    return &Anomaly{
        Event:       event,
        AnomalyType: "unusual_location",
        Confidence:  0.85,
        Reason:      fmt.Sprintf("Login from %s, never seen before", event.SourceIP),
    }
}

// TimeAnomalyDetector detects activity outside normal hours
type TimeAnomalyDetector struct{}

func (d *TimeAnomalyDetector) Detect(ctx context.Context, event Event, state *IdentityState) *Anomaly {
    hour := event.Timestamp.Hour()
    
    // Check if this hour is typical
    for _, normalHour := range state.NormalHours {
        if hour == normalHour {
            return nil
        }
    }
    
    return &Anomaly{
        Event:       event,
        AnomalyType: "unusual_time",
        Confidence:  0.75,
        Reason:      fmt.Sprintf("Activity at %d:00, outside normal hours", hour),
    }
}

// PrivilegeEscalationDetector detects sudden permission increases
type PrivilegeEscalationDetector struct{}

func (d *PrivilegeEscalationDetector) Detect(ctx context.Context, event Event, state *IdentityState) *Anomaly {
    if event.EventType != "permission_change" {
        return nil
    }
    
    // Check if new permission is significantly higher
    newPerms := event.Metadata["new_permissions"].([]string)
    if containsAdminRole(newPerms) {
        return &Anomaly{
            Event:       event,
            AnomalyType: "privilege_escalation",
            Confidence:  0.95,
            Reason:      "Identity gained admin-level permissions",
        }
    }
    
    return nil
}

// Backpressure handling (like your SSE design)
func (de *DetectionEngine) IngestEvent(event Event) error {
    select {
    case de.eventStream <- event:
        return nil
    default:
        // Channel full, drop event (best effort)
        metrics.Increment("anomaly.events.dropped")
        return errors.New("event stream full")
    }
}
```

**Key Design Decisions:**

1. **Worker Pool**: 10 workers processing events concurrently (similar to your SSE goroutines)
2. **In-Memory State**: Fast access to identity behavioral profiles
3. **Pluggable Detectors**: Easy to add new detection strategies
4. **Backpressure Handling**: Drop events if processing can't keep up (your SSE pattern)
5. **Non-Blocking**: Event processing doesn't block ingestion

**My SSE Experience Applied:**
> "This design uses the same patterns from my SSE implementation: worker pool with goroutines, channels for event distribution, backpressure handling where slow consumers don't block fast producers, and in-memory state management for low-latency access. The detector pattern is similar to our event handlers - pluggable components that process events independently."

---

## Concurrency & Scaling

### Q7: In your SSE design, why did you choose channels over mutexes for the broker?

**Answer:**

**Design Decision:**
Used channels and goroutines following Go's philosophy: "Share memory by communicating" instead of "communicating by sharing memory."

**SSE Broker Architecture:**
```go
type Broker struct {
    // clients: map[tenantID][userID][clientID]chan Event
    clients map[string]map[string]map[string]chan Event
    
    register   chan *Client
    unregister chan *Client
    broadcast  chan Event
}

func (b *Broker) Run() {
    for {
        select {
        case client := <-b.register:
            // Register client
        case client := <-b.unregister:
            // Unregister client
        case event := <-b.broadcast:
            // Broadcast to matching clients
        }
    }
}
```

**Why Channels Over Mutexes:**

1. **Single Writer, Multiple Readers**
   - Broker's `Run()` goroutine is the **only** writer to the clients map
   - All other goroutines send messages via channels
   - No race conditions - one goroutine owns the data

2. **Simpler Reasoning**
   - Clear data flow: register channel → broker → clients map
   - No need to think about lock ordering or deadlocks
   - Each goroutine has clear responsibilities

3. **Natural Concurrency**
   ```go
   // With channels (clean)
   broker.broadcast <- event
   
   // With mutexes (error-prone)
   broker.mu.Lock()
   for _, clients := range broker.clients {
       for _, client := range clients {
           // What if client.Send() blocks? Deadlock!
           client.Send(event)
       }
   }
   broker.mu.Unlock()
   ```

4. **Backpressure Naturally**
   ```go
   select {
   case client.eventChan <- event:
       // Sent successfully
   default:
       // Client's channel full, drop event (slow consumer)
       close(client.eventChan)
   }
   ```

5. **Graceful Shutdown**
   ```go
   func (b *Broker) Shutdown() {
       close(b.broadcast)  // Signal completion
       // Run() goroutine exits cleanly
   }
   ```

**When Mutexes Would Be Appropriate:**
- Simple read-heavy scenarios (map lookups with rare updates)
- Very short critical sections
- Shared state that doesn't fit channel semantics

**In Identity Discovery Context:**
> "The same pattern applies to identity discovery - instead of multiple goroutines locking a shared identity inventory map, you'd have discovery agents send discovered identities via channels to an inventory manager goroutine that owns the map. This prevents race conditions and makes the system easier to reason about."

---

### Q8: How did you handle graceful shutdown in your SSE system?

**Answer:**

**Challenge:**
Long-lived SSE connections block Kubernetes rolling updates because the Go http.Server waits for active connections to drain before exiting. Without intervention, K8s eventually sends SIGKILL.

**Solution:**

```go
// 1. Listen for shutdown signals
func main() {
    server := &http.Server{Addr: ":8080", Handler: handler}
    broker := NewBroker()
    
    // Shutdown channel
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
    
    // Run server in goroutine
    go func() {
        if err := server.ListenAndServe(); err != nil {
            log.Error("Server error", err)
        }
    }()
    
    // Wait for shutdown signal
    <-stop
    log.Info("Shutdown signal received")
    
    // Graceful shutdown sequence
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    
    // 1. Stop accepting new SSE connections
    server.Shutdown(ctx)
    
    // 2. Close all active SSE connections
    broker.CloseAll()
    
    log.Info("Shutdown complete")
}

// 2. Broker shutdown implementation
func (b *Broker) CloseAll() {
    // Send shutdown message to all clients
    b.shutdown <- true
}

func (b *Broker) Run() {
    for {
        select {
        case <-b.shutdown:
            // Close all client connections
            for _, tenantClients := range b.clients {
                for _, userClients := range tenantClients {
                    for _, clientChan := range userClients {
                        close(clientChan) // Triggers SSE handler to exit
                    }
                }
            }
            return
        case client := <-b.register:
            // ... handle registration
        case event := <-b.broadcast:
            // ... handle broadcast
        }
    }
}

// 3. SSE Handler responds to connection closure
func (h *SSEHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // ... setup SSE connection
    
    clientChan := make(chan Event)
    h.broker.Register(clientChan, tenantID, userID)
    defer h.broker.Unregister(clientChan, tenantID, userID)
    
    for {
        select {
        case event, ok := <-clientChan:
            if !ok {
                // Channel closed = shutdown signal
                log.Info("Connection closed due to shutdown")
                return
            }
            // Send event to client
            fmt.Fprintf(w, "data: %s\n\n", event)
            flusher.Flush()
            
        case <-r.Context().Done():
            // Client disconnected
            return
        }
    }
}
```

**Shutdown Flow:**

1. **K8s sends SIGTERM** to pod
2. **Server stops accepting new requests** (30s timeout)
3. **Broker closes all client channels** (signals SSE handlers to exit)
4. **SSE handlers detect closed channel** and cleanly close HTTP responses
5. **Clients receive connection close** and automatically reconnect to a different pod

**Key Insights:**

- **Proactive Connection Severing**: Don't wait for K8s SIGKILL, actively close connections
- **Client Auto-Reconnect**: EventSource API automatically reconnects on disconnect
- **Zero-Downtime**: Other pods handle reconnections during deployment
- **Graceful Period**: 30-second timeout gives connections time to close cleanly

**Application to Identity Discovery:**

> "For Hydden's continuous discovery, you'd need similar graceful shutdown - discovery agents in progress should finish their current scan or abort cleanly, partial results should be saved, and new discoveries should resume on the replacement pod. The same context cancellation pattern applies: discovery goroutines check ctx.Done() and exit cleanly when shutdown is triggered."

---

## Your SSE Experience - Deep Dive

### Q9: Walk me through your SSE architecture end-to-end.

**Answer:**

**Problem:**
Capella UI was making ~3600 HTTP requests per hour per user due to polling 40+ hooks at intervals of 5-120 seconds. This caused delayed updates (up to polling interval), wasted bandwidth (most requests returned empty), and high server load.

**Solution: Server-Sent Events (SSE) with Real-Time Push**

**Architecture Diagram:**

```
┌─────────────┐       GET /sse/stream        ┌──────────────┐
│   Browser   │─────────────────────────────>│ SSE Handler  │
│             │<─────────────────────────────│              │
│ EventSource │     event stream (push)      │ (per client  │
└─────────────┘                               │  goroutine)  │
                                              └──────┬───────┘
                                                     │
                                              registers client
                                                     │
                                                     ▼
                                              ┌──────────────┐
                                              │    Broker    │
                                              │  (in-memory) │
                                              └──────┬───────┘
                                                     │
                                           receives events from
                                                     │
                                                     ▼
                                              ┌──────────────┐
                                              │  Event Bus   │
                                              │    (NATS)    │
                                              └──────┬───────┘
                                                     │
                                              publishes events
                                                     │
                                                     ▼
                                              ┌──────────────┐
                                              │Core Backend  │
                                              │  (mutations) │
                                              └──────────────┘
```

**Components:**

**1. Frontend (Browser)**
```typescript
// Connection Manager (prevents duplicate connections)
class SSEConnectionManager {
    private connections = new Map<string, EventSource>();
    
    connect(orgId: string, onEvent: (event: Event) => void) {
        if (this.connections.has(orgId)) {
            return; // Already connected
        }
        
        const eventSource = new EventSource(
            `/v2/organizations/${orgId}/sse/stream`,
            { withCredentials: true }
        );
        
        eventSource.onmessage = (e) => {
            const event = JSON.parse(e.data);
            onEvent(event);
        };
        
        this.connections.set(orgId, eventSource);
    }
}

// SSE Provider (React component)
function SSEProvider({ children, orgId }) {
    useEffect(() => {
        const handleEvent = (event) => {
            // Invalidate TanStack Query
            queryClient.invalidateQueries(['projects']);
        };
        
        SSEConnectionManager.connect(orgId, handleEvent);
        
        return () => SSEConnectionManager.disconnect(orgId);
    }, [orgId]);
    
    return children;
}
```

**2. Backend: SSE Handler**
```go
func (h *SSEHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Set SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
        return
    }
    
    // Create client channel
    clientChan := make(chan Event, 10)
    tenantID := extractTenantID(r)
    userID := getUserID(r)
    
    // Register with broker
    h.broker.Register(clientChan, tenantID, userID)
    defer h.broker.Unregister(clientChan, tenantID, userID)
    
    // Heartbeat ticker (keep connection alive)
    heartbeat := time.NewTicker(10 * time.Second)
    defer heartbeat.Stop()
    
    // Stream loop
    for {
        select {
        case event := <-clientChan:
            // Send event to client
            fmt.Fprintf(w, "event: %s\n", event.Type)
            fmt.Fprintf(w, "data: %s\n\n", event.Data)
            flusher.Flush()
            
        case <-heartbeat.C:
            // Send heartbeat
            fmt.Fprintf(w, ": heartbeat\n\n")
            flusher.Flush()
            
        case <-r.Context().Done():
            // Client disconnected
            return
        }
    }
}
```

**3. Broker (In-Memory Event Distribution)**
```go
type Broker struct {
    // Nested map: tenantID -> userID -> clientID -> channel
    clients map[string]map[string]map[string]chan Event
    
    register   chan *Client
    unregister chan *Client
    broadcast  chan Event
    rbac       RBACResolver
}

func (b *Broker) Run() {
    for {
        select {
        case client := <-b.register:
            // Add client to map
            
        case client := <-b.unregister:
            // Remove client, close channel
            
        case event := <-b.broadcast:
            // RBAC filtering + broadcast
            for tenantID, tenantClients := range b.clients {
                for userID, userClients := range tenantClients {
                    // Check RBAC: does this user have permission?
                    if !b.rbac.CanAccess(userID, event.ResourceID) {
                        continue
                    }
                    
                    // Send to all tabs for this user
                    for _, clientChan := range userClients {
                        select {
                        case clientChan <- event:
                            // Sent
                        default:
                            // Channel full, close slow client
                            close(clientChan)
                        }
                    }
                }
            }
        }
    }
}
```

**4. Event Bus (NATS for Multi-Instance Coordination)**
```go
// On startup: subscribe to NATS topic
func (b *Broker) SubscribeToEventBus() {
    natsConn.Subscribe("capella.events", func(msg *nats.Msg) {
        var event Event
        json.Unmarshal(msg.Data, &event)
        
        // Send to local broker
        b.broadcast <- event
    })
}

// When mutation happens: publish to NATS
func (s *ProjectService) CreateProject(project *Project) error {
    // Save to database
    err := s.db.Save(project)
    if err != nil {
        return err
    }
    
    // Publish event (fire-and-forget)
    event := Event{
        Type: "project_created",
        ResourceID: project.ID,
        ResourceType: "project",
    }
    s.eventBus.Publish("capella.events", event)
    
    return nil
}
```

**Key Insights:**

1. **Pull → Push**: Eliminated 3600 requests/hour with real-time events
2. **RBAC Per-Event**: Authorization checked at broadcast time, not connection time
3. **Distributed via NATS**: All API instances receive all events (no sticky sessions)
4. **Backpressure**: Slow clients dropped, don't block fast clients
5. **Multi-Tab**: Same user, multiple tabs, all get events
6. **Graceful Shutdown**: K8s SIGTERM → close connections → clients reconnect

**Results:**
- Network traffic: ~3600 requests/hour → near-zero (just heartbeats)
- Update latency: Up to 120s → < 1s
- Server load: Linear reduction in API calls

---

### Q10: How did you handle RBAC in your SSE system, and how does this apply to identity security?

**Answer:**

**RBAC Challenge:**
Events need to be broadcast only to users who have permission to see the affected resource. We can't just blast events to everyone - that's a security violation.

**Design Decision: Per-Event Authorization (Not Per-Connection)**

**Why Not Check at Connection Time?**
```go
// BAD: Check permissions when connection opens
func (h *SSEHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    userProjects := h.rbac.GetUserProjects(userID) // Checked once
    
    // Later, user's permissions change...
    // But we're still sending them events! Security violation!
}
```

**Correct Approach: Check at Broadcast Time**
```go
// Broker checks RBAC per-event
func (b *Broker) Run() {
    for {
        select {
        case event := <-b.broadcast:
            for tenantID, tenantClients := range b.clients {
                for userID, userClients := range tenantClients {
                    // Check RBAC NOW (not at connection time)
                    canAccess := b.rbac.CanAccess(userID, event.ResourceID, event.ResourceType)
                    if !canAccess {
                        continue // Don't send to this user
                    }
                    
                    // User has permission, send event
                    for _, clientChan := range userClients {
                        clientChan <- event
                    }
                }
            }
        }
    }
}

// RBAC Resolver interface
type RBACResolver interface {
    CanAccess(userID, resourceID, resourceType string) bool
}

// Implementation
type CapellaRBACResolver struct {
    db Database
}

func (r *CapellaRBACResolver) CanAccess(userID, resourceID, resourceType string) bool {
    switch resourceType {
    case "project":
        // Check if user is org owner or project collaborator
        return r.db.IsProjectMember(userID, resourceID)
    case "cluster":
        // Check if user has access to parent project
        projectID := r.db.GetProjectIDForCluster(resourceID)
        return r.db.IsProjectMember(userID, projectID)
    default:
        return false
    }
}
```

**Dynamic Permission Handling:**

**Scenario:** User's permissions change while SSE stream is active

1. **User A** is connected via SSE
2. **Admin** adds User A to Project X
3. **Event**: "Project X created"
4. **Broker**: Checks RBAC at broadcast time
5. **Result**: User A now receives Project X events (self-correcting)

Similarly:
1. **User B** is connected via SSE
2. **Admin** removes User B from Project Y
3. **Event**: "Project Y updated"
4. **Broker**: Checks RBAC at broadcast time
5. **Result**: User B does NOT receive Project Y events (self-correcting)

**No Stale Permission Window!**

**Application to Hydden:**

Identity security faces the exact same challenge:

1. **Identity Discovery Events**: "New service account discovered in AWS"
   - Should SecOps user Alice see this event?
   - Check RBAC: Does Alice have permission to see AWS identities?

2. **Permission Change Events**: "User Bob gained admin access"
   - Who should receive this alert?
   - Check RBAC: Which SecOps users monitor this system?

3. **Dynamic Permissions**: SecOps user's access scope changes
   - No need to disconnect/reconnect
   - Next event automatically reflects new permissions

**Interview Talking Point:**

> "In Hydden's context, different SecOps users have different visibility scopes - some see all identities, others only see identities in their region or business unit. My RBAC implementation shows how to handle this: check authorization per-event at broadcast time, not per-connection. This way, when a SecOps user's permissions change, the system self-corrects on the next event without requiring reconnection. It's the same runtime authorization model identity security requires - continuous evaluation, not static grants."

---

This covers the technical Q&A. Next, I'll create the experience stories document with STAR format responses.
