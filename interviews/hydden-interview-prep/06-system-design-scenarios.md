# System Design Scenarios - Practice Problems

## How to Approach These

1. **Read the problem out loud** - helps clarify requirements
2. **Draw diagrams** - use paper/whiteboard, practice visual thinking
3. **Think about your SSE experience** - find parallels
4. **Talk through trade-offs** - show decision-making process
5. **Time yourself** - aim for 30-40 minute end-to-end design

---

## Scenario 1: Design Hydden's Identity Discovery Engine

### Problem Statement

Design a system that discovers all identities (human and non-human) across a hybrid enterprise environment:

**Requirements:**
- **Sources**: 20+ systems (AWS, Azure, GCP, Active Directory, legacy databases, mainframes)
- **Scale**: 70,000 users total across all sources
- **Frequency**: Multiple times per day (continuous discovery)
- **Latency**: Discovery cycle should complete within 30 minutes
- **Reliability**: Individual source failures shouldn't block discovery from other sources
- **Change Detection**: Identify what changed since last discovery (new identities, deleted, modified permissions)
- **No Production Impact**: Discovery queries shouldn't overwhelm source systems

---

### Step 1: Requirements Clarification (Ask These Questions)

1. **Identity Types**: Do we need to discover all types (users, service accounts, API keys, certificates)?
2. **Permission Depth**: Do we discover just identity existence, or also their permissions/group memberships?
3. **Historical State**: Do we need to preserve historical snapshots for forensics?
4. **Rate Limits**: Do source systems have API rate limits we need to respect?
5. **Authentication**: How do we securely store and manage credentials for 20+ systems?
6. **Correlation**: Do we need to correlate identities across systems (john.doe@company.com = jdoe = JDOE)?

**Assumptions** (if not clarified):
- Discover identity existence + basic metadata + permissions
- Preserve historical snapshots (key Hydden differentiator)
- Respect rate limits (can't overwhelm AD controllers)
- Need correlation (core value-add)

---

### Step 2: High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Discovery Orchestrator                   │
│  (Schedules scans, coordinates agents, aggregates results) │
└──────────────┬──────────────────────────────────────────────┘
               │
               │ spawns/manages
               │
       ┌───────┴───────┬──────────┬──────────┬─────────┐
       │               │          │          │         │
   ┌───▼────┐    ┌────▼───┐  ┌───▼───┐  ┌───▼───┐  ┌──▼──┐
   │  AWS   │    │ Azure  │  │  AD   │  │Legacy │  │ ... │
   │ Agent  │    │ Agent  │  │ Agent │  │  DB   │  │     │
   └───┬────┘    └────┬───┘  └───┬───┘  └───┬───┘  └──┬──┘
       │              │          │          │         │
       │ discovered   │          │          │         │
       │ identities   │          │          │         │
       └──────────────┴──────────┴──────────┴─────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Identity Inbox  │
                    │  (Event Queue)   │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │   Correlation    │
                    │     Engine       │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ Identity Store   │
                    │  (Graph + TS)    │
                    └──────────────────┘
```

---

### Step 3: Component Design

#### 3.1 Discovery Agents

**Interface:**
```go
type DiscoveryAgent interface {
    Connect(ctx context.Context, config SourceConfig) error
    DiscoverIdentities(ctx context.Context) ([]RawIdentity, error)
    DiscoverPermissions(ctx context.Context, identityID string) ([]Permission, error)
    GetMetadata() SourceMetadata
    HealthCheck() error
}

type RawIdentity struct {
    SourceSystem string    // "aws-prod", "azure-ad", "ad-corp"
    ExternalID   string    // Source-specific ID
    Type         string    // "user", "service_account", "api_key", "role"
    Username     string
    Email        string
    DisplayName  string
    CreatedAt    time.Time
    LastModified time.Time
    Groups       []string  // Or defer to DiscoverPermissions
    Metadata     map[string]interface{}
}
```

**Agent Implementations:**
- **AWSAgent**: Uses AWS SDK, discovers IAM users, roles, service accounts
- **AzureAgent**: Uses Microsoft Graph API, discovers Azure AD users, managed identities
- **ADAgent**: Uses LDAP queries, discovers on-prem AD users, groups
- **LegacyDBAgent**: Direct SQL queries to legacy database user tables
- **CustomAgent**: Extensible for new source types

**Rate Limiting:**
```go
type RateLimiter struct {
    limiters map[string]*rate.Limiter
    mu       sync.RWMutex
}

func (a *AWSAgent) DiscoverIdentities(ctx context.Context) ([]RawIdentity, error) {
    limiter := a.rateLimiter.GetLimiter("aws-prod")
    
    var identities []RawIdentity
    
    // Paginated discovery with rate limiting
    for {
        limiter.Wait(ctx) // Block if rate limit exceeded
        
        page, err := a.awsClient.ListUsers(ctx, &iam.ListUsersInput{
            MaxItems: aws.Int32(100),
        })
        
        if err != nil {
            return nil, err
        }
        
        for _, user := range page.Users {
            identities = append(identities, convertAWSUser(user))
        }
        
        if !page.IsTruncated {
            break
        }
    }
    
    return identities, nil
}
```

---

#### 3.2 Discovery Orchestrator

**Responsibilities:**
- Schedule discovery cycles
- Spawn discovery agents concurrently
- Handle failures gracefully (failed agent doesn't block others)
- Aggregate results
- Trigger correlation engine

**Implementation:**
```go
type DiscoveryOrchestrator struct {
    agents          []DiscoveryAgent
    identityInbox   chan RawIdentity
    scheduler       *cron.Scheduler
    correlator      *CorrelationEngine
}

func (o *DiscoveryOrchestrator) RunDiscoveryCycle(ctx context.Context) error {
    log.Info("Starting discovery cycle")
    startTime := time.Now()
    
    // Concurrent discovery across all sources
    var wg sync.WaitGroup
    errors := make(chan error, len(o.agents))
    
    for _, agent := range o.agents {
        wg.Add(1)
        go func(a DiscoveryAgent) {
            defer wg.Done()
            
            // Per-agent timeout
            ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
            defer cancel()
            
            // Health check before discovery
            if err := a.HealthCheck(); err != nil {
                log.Warn("Agent unhealthy, skipping", "agent", a.GetMetadata().Name)
                errors <- err
                return
            }
            
            // Discover identities
            identities, err := a.DiscoverIdentities(ctx)
            if err != nil {
                log.Error("Discovery failed", "agent", a.GetMetadata().Name, "error", err)
                errors <- err
                return
            }
            
            // Send to inbox for processing
            for _, identity := range identities {
                o.identityInbox <- identity
            }
            
            log.Info("Discovery completed", "agent", a.GetMetadata().Name, "count", len(identities))
        }(agent)
    }
    
    // Wait for all agents
    wg.Wait()
    close(errors)
    
    // Log errors but don't fail entire cycle
    for err := range errors {
        metrics.Increment("discovery.agent.failures")
        // Alert on repeated failures
    }
    
    log.Info("Discovery cycle completed", "duration", time.Since(startTime))
    return nil
}

// Schedule continuous discovery
func (o *DiscoveryOrchestrator) Start(ctx context.Context) {
    // Run every 2 hours
    ticker := time.NewTicker(2 * time.Hour)
    defer ticker.Stop()
    
    for {
        select {
        case <-ticker.C:
            o.RunDiscoveryCycle(ctx)
        case <-ctx.Done():
            return
        }
    }
}
```

---

#### 3.3 Correlation Engine

**Problem**: Same person exists as:
- `john.doe@company.com` (Azure AD)
- `jdoe` (Active Directory)
- `JDOE` (Mainframe)

**Solution**: Correlation strategies

```go
type CorrelationEngine struct {
    strategies []CorrelationStrategy
    identityStore *IdentityStore
}

type CorrelationStrategy interface {
    FindMatches(identity RawIdentity, candidates []Identity) []CorrelationMatch
    Confidence() float64
}

type CorrelationMatch struct {
    Identity   Identity
    Confidence float64
    Reason     string
}

// Strategy 1: Email matching
type EmailCorrelation struct{}

func (e *EmailCorrelation) FindMatches(raw RawIdentity, candidates []Identity) []CorrelationMatch {
    var matches []CorrelationMatch
    
    if raw.Email == "" {
        return matches
    }
    
    for _, candidate := range candidates {
        if strings.EqualFold(candidate.Email, raw.Email) {
            matches = append(matches, CorrelationMatch{
                Identity:   candidate,
                Confidence: 0.95, // High confidence
                Reason:     "email_exact_match",
            })
        }
    }
    
    return matches
}

// Strategy 2: Username pattern matching
type UsernamePatternCorrelation struct{}

func (u *UsernamePatternCorrelation) FindMatches(raw RawIdentity, candidates []Identity) []CorrelationMatch {
    var matches []CorrelationMatch
    
    // Extract patterns: jdoe, j.doe, john.doe, john_doe all variations of same person
    normalizedUsername := normalizeUsername(raw.Username)
    
    for _, candidate := range candidates {
        candidateNormalized := normalizeUsername(candidate.Username)
        
        if normalizedUsername == candidateNormalized {
            matches = append(matches, CorrelationMatch{
                Identity:   candidate,
                Confidence: 0.75, // Medium confidence
                Reason:     "username_pattern_match",
            })
        }
    }
    
    return matches
}

// Strategy 3: Employee ID (if available in metadata)
type EmployeeIDCorrelation struct{}

// Correlation process
func (c *CorrelationEngine) ProcessIncomingIdentity(raw RawIdentity) {
    // Check if identity already exists in store
    candidates := c.identityStore.FindSimilar(raw)
    
    // Run all correlation strategies
    var allMatches []CorrelationMatch
    for _, strategy := range c.strategies {
        matches := strategy.FindMatches(raw, candidates)
        allMatches = append(allMatches, matches...)
    }
    
    if len(allMatches) == 0 {
        // New identity, create entry
        identity := c.identityStore.Create(raw)
        log.Info("New identity created", "id", identity.ID)
        return
    }
    
    // Find best match (highest confidence)
    bestMatch := findBestMatch(allMatches)
    
    if bestMatch.Confidence > 0.9 {
        // High confidence, auto-merge
        c.identityStore.AddSource(bestMatch.Identity.ID, raw)
        log.Info("Identity correlated", "canonical_id", bestMatch.Identity.ID, "source", raw.SourceSystem)
    } else {
        // Medium confidence, flag for manual review
        c.identityStore.FlagForReview(bestMatch.Identity.ID, raw, bestMatch.Confidence)
    }
}
```

---

#### 3.4 Identity Store (Graph + Time-Series)

**Requirements:**
- Store identity graph (relationships)
- Time-series for historical snapshots
- Fast queries for attack paths

**Data Model:**
```go
type Identity struct {
    ID          string                // Canonical identity ID
    Type        string                // "human", "service_account", "api_key"
    Sources     []IdentitySource      // Multiple sources for same identity
    Permissions []Permission
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

type IdentitySource struct {
    SourceSystem string
    ExternalID   string
    Username     string
    Email        string
    DiscoveredAt time.Time
}

type Permission struct {
    Resource     string   // "aws-prod:s3:my-bucket"
    Actions      []string // ["read", "write"]
    Source       string   // Where this permission came from
    GrantedAt    time.Time
}

// Historical snapshots
type IdentitySnapshot struct {
    IdentityID  string
    Snapshot    Identity
    ValidFrom   time.Time
    ValidUntil  *time.Time // Null if current
}
```

**Storage:**
- **Graph DB** (Neo4j or similar): Identity relationships, attack paths
- **Time-Series DB** (TimescaleDB or similar): Historical snapshots
- **Primary DB** (PostgreSQL): Current state

---

### Step 4: Change Detection

**Problem**: 70K identities discovered every 2 hours = 140K records. Don't want to reprocess everything.

**Solution**: Delta detection

```go
type ChangeDetector struct {
    previousSnapshot map[string]Identity
}

type Change struct {
    Type     string // "added", "removed", "modified"
    Identity Identity
    Field    string
    OldValue interface{}
    NewValue interface{}
}

func (cd *ChangeDetector) DetectChanges(current []Identity) []Change {
    var changes []Change
    
    currentMap := make(map[string]Identity)
    for _, id := range current {
        currentMap[id.ID] = id
    }
    
    // Detect additions
    for id, identity := range currentMap {
        if _, exists := cd.previousSnapshot[id]; !exists {
            changes = append(changes, Change{
                Type:     "added",
                Identity: identity,
            })
        }
    }
    
    // Detect removals
    for id, identity := range cd.previousSnapshot {
        if _, exists := currentMap[id]; !exists {
            changes = append(changes, Change{
                Type:     "removed",
                Identity: identity,
            })
        }
    }
    
    // Detect modifications (permissions changed)
    for id, newIdentity := range currentMap {
        oldIdentity, exists := cd.previousSnapshot[id]
        if !exists {
            continue
        }
        
        if !equalPermissions(oldIdentity.Permissions, newIdentity.Permissions) {
            changes = append(changes, Change{
                Type:     "modified",
                Identity: newIdentity,
                Field:    "permissions",
                OldValue: oldIdentity.Permissions,
                NewValue: newIdentity.Permissions,
            })
        }
    }
    
    return changes
}
```

---

### Step 5: Your SSE Experience Applied

**Parallels:**

| SSE Challenge | Identity Discovery Challenge | Solution Pattern |
|---------------|------------------------------|------------------|
| Multiple API instances | Multiple discovery agents | Concurrent goroutines |
| Event fan-out to all instances | Aggregate results from all agents | Channels + WaitGroup |
| Rate limiting (backpressure) | Don't overwhelm AD controllers | Rate limiter per source |
| Graceful degradation | Failed agent doesn't block others | Timeout per agent, continue on errors |
| RBAC per-event | Permission discovery | Separate discovery pass |
| Historical state | Forensic analysis | Time-series snapshots |

**Interview Talking Point:**
> "This is similar to my SSE architecture. Discovery agents are like client connections - I need to handle many concurrently, with timeouts for slow sources, and graceful handling of failures. The correlation engine is like my Event Bus - aggregating data from multiple independent sources into a unified view. And change detection mirrors my approach of invalidating TanStack queries only when state actually changes - process deltas, not full state every time."

---

### Step 6: Scaling Estimates

**Memory Calculation:**
- 70,000 identities × ~2KB per identity = ~140 MB (in-memory index)
- Graph data: Depends on relationship density, estimate 500MB
- Time-series data: 1 snapshot/day × 365 days = historical data (disk, not memory)

**Compute:**
- Discovery agents: 20 sources × 5 min avg = 5 min total (parallel)
- Correlation: 70K identities × 10ms = 700 seconds (needs optimization)
  - Solution: Batch processing, pre-computed similarity indexes

**Storage:**
- Current state: ~500 MB (graph + relational)
- Historical snapshots: ~50 GB/year (compressed)

---

### Step 7: Trade-Offs & Discussion Points

**Trade-Off 1: Real-Time vs Batch Discovery**
- **Real-Time**: React to AD changes immediately (webhooks, event streams)
- **Batch**: Scheduled discovery cycles every N hours
- **Hydden's Choice**: Batch (mentioned "multiple times per day")
- **Reason**: Many legacy systems don't support real-time events

**Trade-Off 2: Auto-Correlation vs Manual Review**
- **Auto**: High confidence threshold, auto-merge
- **Manual**: Human review for all correlations
- **Hybrid**: Auto above 90% confidence, manual review for 70-90%

**Trade-Off 3: Graph DB vs Relational**
- **Graph**: Better for attack path queries
- **Relational**: Better for structured data, reporting
- **Hybrid**: Both (graph for relationships, relational for attributes)

---

## Scenario 2: Real-Time Identity Anomaly Detection

### Problem Statement

Design a system that detects anomalous identity behavior in real-time:

**Requirements:**
- **Event Stream**: 10,000 identity events/second (logins, permission changes, resource access)
- **Latency**: Detect and alert within 5 seconds
- **Anomaly Types**: 
  - Unusual location (login from new country)
  - Unusual time (activity at 3 AM when user normally works 9-5)
  - Privilege escalation (user gains admin permissions)
  - Unusual resource access (user accesses system they never used before)
- **Learning**: Build behavioral baselines per identity
- **Alerting**: Send high-confidence anomalies to SecOps dashboard

---

### High-Level Architecture

```
Event Sources          Detection Pipeline           Alerting
┌──────────┐          ┌─────────────────┐         ┌──────────┐
│  AD      │          │  Event Ingestion│         │ SecOps   │
│  AWS     │─events──>│   (Kafka/NATS)  │         │Dashboard │
│  Azure   │          └────────┬────────┘         └────▲─────┘
│  Apps    │                   │                       │
└──────────┘                   │                       │
                               ▼                       │
                        ┌──────────────┐         ┌────┴─────┐
                        │ Worker Pool  │         │ Alert    │
                        │ (goroutines) │─anomaly>│ Manager  │
                        └──────┬───────┘         └──────────┘
                               │
                        ┌──────▼──────┐
                        │ Detector    │
                        │ Engine      │
                        └──────┬──────┘
                               │
                        ┌──────▼──────┐
                        │ Behavioral  │
                        │ State Store │
                        └─────────────┘
```

### Component Design

**(Similar to Scenario 1 style, showing event processing loop, detector patterns, state management)**

---

## Scenario 3: Identity Graph Construction & Attack Path Detection

### Problem Statement

Design a system that builds an identity graph and queries attack paths:

**Requirements:**
- **Graph**: Identities (nodes) + Relationships (edges)
- **Relationships**: "can-assume", "owns", "has-permission-to", "member-of"
- **Query**: "Can Identity A reach Resource B?" (privilege escalation paths)
- **Real-Time Updates**: Graph updates as identities/permissions change
- **Visualization**: Render attack paths for SecOps team

---

### Graph Data Model

```
Nodes:
- Identity (User, ServiceAccount, Role)
- Resource (Database, S3Bucket, Server)
- Permission (Read, Write, Admin)

Edges:
- CAN_ASSUME: User -> Role
- OWNS: User -> ServiceAccount
- HAS_PERMISSION: Role -> Resource
- MEMBER_OF: User -> Group
```

### Attack Path Query

**Cypher Query (if using Neo4j):**
```cypher
MATCH path = (a:Identity {id: $identityA})-[*]->(r:Resource {id: $resourceB})
WHERE ALL(rel IN relationships(path) WHERE type(rel) IN ['CAN_ASSUME', 'HAS_PERMISSION', 'MEMBER_OF'])
RETURN path
ORDER BY length(path) ASC
LIMIT 10
```

**Challenge**: Real-time graph updates while handling queries

**Solution**: 
- Read-optimized graph (pre-compute common paths)
- Write-ahead log for updates
- Background recomputation

---

## How Your SSE Experience Maps

### For All Scenarios:

1. **Concurrent Processing**: Goroutines for parallel tasks
2. **Event-Driven**: Channels for communication between components
3. **Backpressure**: Handle slow consumers gracefully
4. **Graceful Degradation**: Failed components don't crash system
5. **RBAC**: Authorization checks throughout
6. **Scaling**: Memory calculations, capacity planning
7. **Distributed Coordination**: Event bus patterns

**Practice Script:**
> "This design mirrors my SSE architecture in several ways. Just as I used concurrent goroutines to handle multiple client connections, here I'd use goroutines for concurrent discovery agents. My Event Bus pattern for multi-instance coordination directly applies to aggregating discoveries from multiple sources. And my RBAC-per-event approach maps to checking permissions at query time, not caching stale authorization."

---

## Practice Approach

1. **Whiteboard these scenarios** - draw boxes and arrows
2. **Talk through trade-offs** - explain why you chose X over Y
3. **Reference your SSE work** - "In my implementation, I..."
4. **Time yourself** - 35-40 minutes per scenario
5. **Ask clarifying questions** - shows thoughtfulness

**You've got this!** Your SSE experience provides concrete patterns for all these challenges. 🚀
