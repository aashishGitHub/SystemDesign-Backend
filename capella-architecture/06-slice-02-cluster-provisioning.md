# 06 — Slice 2: Cluster Provisioning (async, CP → AWS → DP)

The concrete question: **a user clicks "Create Database". What happens over the
next 20 minutes?**

Slice 1 was one synchronous request. This is the opposite: a 202, a queue, a
reconciliation loop, and a fleet of agents converging on desired state.

If your team only learns one thing from this slice, make it this: **the API does
not build the cluster. The API records an intent and returns. Everything else is
convergence.**

---

## The shape

```
BROWSER
  POST /v2/organizations/{tenantId}/clusters/v2
     |
CP-API  (cmd/cp-api/v2/clusters/deployments.go:318)
  validate tenant -> feature flag -> payment method -> decode
  -> project ownership -> RBAC -> CreateFromTemplate -> Deploy
  -> 202 Accepted {id}                       <-- returns here. nothing built yet.
     |
CLUSTERS QUEUER (internal/clusters/queuer/queuer.go:66)
  circuit breaker? -> already >= 2 jobs queued? -> conflicting turn-off?
  -> build job (with Pre / steps / Post) -> Queue()
     |
JOBS QUEUER (internal/jobs)
  write job document to Couchbase   +   send message to SQS FIFO
                                        MessageGroupID = clusterID
     |
CP-JOBS  (cmd/cp-jobs/main.go — the worker; 59 processor registrants)
  consume SQS -> look up processor by job.Type -> run
     |
DEPLOY PROCESSOR (internal/clusters/jobs/deploy.go:114)
  10 min budget per attempt (25 for private endpoints)
  r.Sit(envelope, visibility)  <-- extend SQS visibility
  load/compute deployment State, maxAttempts, metrics
  -> deployer.Deploy(...)
  -> returns Done{err, fatal, reattempt, schedule, next}
     |                                    ^
     |                                    |  not finished? reschedule +30s
     +------------------------------------+  (the loop; runs ~12x for a 2h upgrade)
     |
DEPLOYER (internal/clusters/deployer/deployer.go:380)
  IDEMPOTENT RECONCILER. Reads desired state, diffs actual, converges.
  pre-actions -> credentials -> secrets -> cluster assets -> columnar
  -> network -> fusion network -> [backup node if upgrade] -> restore
  -> deploymentPlan (compute ONCE, persist)  -> apply -> checkpoint
     |
PLANNER (internal/clusters/planner/planner.go:27)
  Plan { Deploy[], Replace[], Destroy[], GrowDisks[] }   <-- terraform plan, in Go
     |
INFRA (internal/clusters/infra/infra.go:36 — Deployer/Destroyer interfaces)
  aws/ | azure/ | gcp/     one interface, three adapters
     |
CSP ACCESS (internal/csp/access/aws/aws.go:167)
  STS AssumeRole into the TENANT'S AWS account -> scoped SDK
     |
AWS: ASG (1 node = 1 ASG, max 1 instance), EC2, EBS, VPC, SG, IAM, KMS,
     Route53, S3, ELB, AWS Backup
     |
EC2 boots -> dp-agent-v3 (systemd) -> registers with CP
     |
DP-AGENT-V3 <---- mTLS/basic-auth ----> CP-INTERNAL-API
  register node, poll config, phone home, sync certs, expand disk,
  export audit logs, trigger backup
     |
CP updates cluster state -> UI polls -> "Healthy"
```

---

## Part 1 — The API call that builds nothing

`cmd/cp-api/v2/clusters/deployments.go:318` — `ClusterDeploymentV2()`

Registered at `cmd/cp-api/v2/clusters/clusters.go:273`:

```go
router.Handle(ClustersV2URL, c.ClusterDeploymentV2()).Methods(http.MethodPost)
```

URL constants at `deployments.go:44,50`:

```go
ClustersURL   = "/v2/organizations/{tenantId}/clusters"
ClustersV2URL = ClustersURL + "/v2"
```

`clusters.go:264` — `router = v2.Own(router, owners.Deployer)`. Different owning
team from Projects (`owners.Auth`). Ownership travels with the route.

The handler body, in order:

```go
m, err := keynames.ValidateIDKeyNames(vars, keynames.TenantIDKey)   // 1 path vars
_, err = c.tenants.Get(ctx, tenantID)                              // 2 tenant exists -> 404
c.checkDayZeroFeatureFlag(ctx, tenantID)                           // 3 feature flag gate
d, err := c.creditcards.GetBillingInfo(ctx, tenantID)              // 4 COMMERCIAL GATE
if d.Restricted { goof.ErrCannotDeployClusterWithoutPaymentMethod() }
var payload templatesV2.Create
v2.Decode(r, &payload)                                             // 5 body
pj, err := c.check.Project(ctx, tenantID, payload.ProjectID)       // 6 ownership
c.rbac.Create(ctx, rbac.ResourceTypeCluster, pj)                   // 7 authorise
cluster, err := c.svc.CreateFromTemplate(ctx, tenantID, clusters.NewTemplateCreate(payload))
c.svc.Deploy(ctx, cluster.ID, clusters.NewClusterDeployment)       // 8 enqueue
c.responder.Respond(ctx, w, http.StatusAccepted, &ID{ID: cluster.ID})   // 202
```

Five things to teach from this:

1. **`202 Accepted`, not `201 Created`.** The correct status for "I have accepted
   your intent; the resource does not exist yet." Slice 1's project create
   returned `201` because the write was done. Status codes are a contract about
   *completion*, and your team will get this wrong until someone says it out loud.

2. **The response body is just an ID.** The client has nothing to render but a
   handle. That is what forces the UI into a polling/subscription model — which
   is exactly why `use-database-list` and `use-database-jobs` exist on the
   frontend, and why so many `hooks/api/use-*` hooks accept `refetchInterval`.

3. **The commercial gate sits before RBAC.** `d.Restricted` means "Stripe account
   with no payment method attached". A business rule enforced in the handler,
   ahead of authorisation. Product logic is in the code — go read it.

4. **Authorisation is on the *parent*.** `c.rbac.Create(ctx, ResourceTypeCluster, pj)`
   passes the **project**, because the cluster does not exist yet. "Can you create
   a child of this parent?" That is the generalisation slice 1's project-create
   only hinted at.

5. **Create and Deploy are two calls.** `CreateFromTemplate` writes the desired
   state; `Deploy` asks for convergence. The record exists even if the queue is
   down — and the retry story is therefore about convergence, not about re-POSTing.

Compare `ClusterDeployment()` (v1, `deployments.go:244`) with `ClusterDeploymentV2()`
(`:318`) to see how the team versions a payload shape without breaking the old UI.

---

## Part 2 — The queuer: backpressure, idempotency, and honest comments

`internal/clusters/queuer/queuer.go` is the best-commented file in the repo. Read
it end to end; it is 45 minutes well spent.

```go
var _ clusters.Queuer = (*Queuer)(nil)      // :23

// Queuer ... It exists to prevent the stacking of "jobs" for a cluster.
type Queuer struct {                        // :30
    circuitBreakers jobs.CircuitBreakers
    jobs            jobs.Store
    logger          log.Logger
    metrics         metrics.Client
    queuer          jobs.Queuer
}
```

`Deploy` (`:66`) runs four gates before it will queue anything.

### Gate 1 — Circuit breaker

```go
_, err := q.circuitBreakers.GetForResource(ctx, clusterJobs.Deploy, clusterID)
switch err {
case nil:
    logger.Info("skipping creating a deployment job as circuit breaker exists for cluster")
    return nil                                  // <- silently succeed
case jobs.ErrCircuitBreakerNotFound:
default:
    logger.Warn("attempting to assert if cluster has circuit breaker in place", zap.Error(err))
    // do NOT block queueing on this failure
}
```

**Concept: an operator kill-switch, per (job type, resource).** Support flips a
breaker on one cluster; deployments for that cluster stop being queued *and*
stop being processed. Everything else keeps running.

`internal/jobs/interfaces.go:110` documents the whole contract, including the
default expiry:

```go
const DefaultCircuitBreakerExpiry = time.Hour * 24     // :250
```

And the comment explains *why* 24 hours: "in most cases where a circuit breaker
would be needed it is going to be an affair that takes at least a day to
recover." Implemented as a Couchbase document TTL — the breaker cannot be left on
forever by accident.

Note the failure handling: if the breaker *lookup* fails, queueing proceeds. The
comment is explicit — "The worst case is a job gets killed on entry to cp-jobs."
The check is also performed by the processor, so the queuer's copy is an
optimisation, not the enforcement point. **Defence in depth lets you fail open at
the cheap layer.**

### Gate 2 — Backpressure, and why the limit is 2 and not 1

`:177` — `const max = 2`, with ~20 lines of reasoning above it. Paraphrased:

> Why allow more than 1? Because the deployer takes the state of the control
> plane metadata when it *first processes* the job and builds a plan against that
> snapshot. With only one job allowed, subsequent metadata updates would never be
> realised. Allowing two guarantees that N updates (which happen before queueing)
> get deployed.
>
> Why cap it at all? A no-op deployment still transitions the UI and still
> carries risk — a temporary cloud-provider outage would fail it.

**This is the deepest idea in the slice.** The plan is a snapshot. That single
fact determines the queue depth, and the number 2 is derived from it rather than
picked. When your team proposes a magic constant in review, this is the standard:
either derive it or document why.

### Gate 3 — Conflict detection

```go
if otherJobPayload.Reason == clusters.TurnOffDeployment && deploymentOpts.Reason != clusters.NoOpDeployment {
    return ErrDeployConflictsWithExistingTurnOff
}
```

A turn-off changes the cluster's *intended* state, so every deployment queued
behind it silently becomes a turn-off too. The comment notes this is a
belt-and-braces check — the main prevention happens earlier via cluster state —
and exists purely "to prevent race conditions while jobs are still in the queue".

`TurnOff` (`:311`) has the mirror check, and its comment carries a UX
justification: a turn-off could sit behind a long deployment, by which time the
user no longer wants it, and there is no cancel button — so return an error and
let the caller explain.

**Naming the two layers is the lesson:** state-based prevention (early, cheap,
usually right) plus queue-based conflict detection (late, narrow, catches races).

### Gate 4 — Alerting instead of blocking

`buildWheres` (`:127`) takes a different branch for rebalance deployments: fetch
the last 20 by `createdAt DESC`, and if more than 19 completed in the past hour,
emit a metric.

```go
const tooManyRebalancingJobs = 19
if rebalancing > tooManyRebalancingJobs {
    q.metrics.Incr(ctx, metricTooManyRebalancingJobs, tags)
}
```

The comment (AV-70889) says it plainly: "We don't want to stop the machinery but
we do need to alert someone."

**Concept: not every anomaly should be a hard stop.** A rebalance storm needs a
human, not a closed valve. Deciding *which* limits block and which only page is
architecture work.

### Destroy: kill the queue in front of you

`Destroy` (`:390`) queries jobs in `Pending | Processing | Failed`, limit 30,
newest first — the comment notes real incidents with 10+ pending jobs — then
`killJobs` (`:518`) walks them:

```go
switch job.Status {
case jobs.Killed:                     // nothing to do
case jobs.Complete:  return           // stop: history beyond here is settled
case jobs.Failed:    q.killJob(...); return   // kill the first failed one so it isn't reattempted
default:             q.killJob(...)
}
```

`Killed` is a real status (`internal/jobs/status.go:18`, AV-43305): the processor
sees it, deletes the SQS message, and never reattempts.

`killJob` (`:540`) swallows the update error, with the reasoning recorded:

> "It comes down to what is the worse UX. The case where it takes longer for the
> destroy job to get going? Or returning a 5XX error when trying to delete the
> cluster? Option A seems like the friendlier of the two options."

**Every deliberate error-swallow in this codebase carries its justification.**
That is the standard to hold your team to — not "never swallow errors", but
"never swallow one silently".

`tooManyDestroyJobs` (`:555`) caps destroys at 2 as well, and the comment names
the real user: "a user sitting there and clicking 'delete' N number of times."

---

## Part 3 — The job model

`internal/jobs/job.go:31`

```go
type Job struct {
    cb.Metadata `json:"-"`                       // Couchbase CAS
    ID          string
    TenantID    string
    RequestID   string      `json:"requestId"`   // the HTTP request that caused this
    SpanID      interface{} `json:"spanId"`      // tracing continuity
    TraceID     interface{} `json:"traceId"`
    UserID      string
    MessageGroupID string   `json:"messageGroupID"`   // :67  SQS FIFO partition key
    Type        Type
    Payload     interface{}
    Pre  []*Job `json:"pre,omitempty"`           // :78  run first; failure skips the main steps
    Post []*Job `json:"post,omitempty"`          // :84  ALWAYS run, success or failure
    Jobs []*Job                                  // the main steps
    ...
}
```

### Tracing across the async boundary

`RequestID`, `SpanID`, and `TraceID` are carried on the job document. A trace
that starts at the browser click survives the queue and reappears 20 minutes
later in the deploy processor's spans. Without this, async work is a debugging
black hole — and this is three fields.

### SQS FIFO partitioning — the concurrency model in one line

`internal/clusters/jobs/deploy.go:109`

```go
job.MessageGroupID = clusterID
```

SQS FIFO guarantees ordering and single-consumer *within* a message group.
Setting the group to the cluster id means:

- deployments for **one** cluster are strictly serialised — no two deploys race
  on the same infrastructure
- deployments for **different** clusters run fully in parallel
- no distributed lock is needed for this

**One queue behaves as N queues, partitioned by resource.** Compare with slice 1,
which needed an explicit Couchbase lock for the project-quota check. Different
tools for different problems: the lock protects a read-modify-write; the partition
protects a long-running workflow.

`WaitOnDisks` uses `clusterID + ":WaitOnDisks"` (`deploy.go:1203`) — same cluster,
*different* group, so it can proceed in parallel with a deploy. Partition choice
is a design decision per job type.

### Pre / steps / Post — a saga, declared

`DeployJob` (`internal/clusters/jobs/deploy.go:55`) composes the workflow:

```go
job := jobs.NewJob(tenantID, Deploy, payload)

if payload.Reason == clusters.NewClusterDeployment && payload.IsSelfServiceTrial {
    job.AppendJobs(jobs.NewJob("", SelfServiceBucket, nil))     // free tier: sample bucket
}
if payload.AllowedIPs != nil        { job.AppendJobs(jobs.NewJob("", UpdateClusterAllowList, payload)) }
if payload.ThirdPartyIntegrator != nil && payload.ThirdPartyIntegrator.Vercel != nil {
    job.AppendJobs(jobs.NewJob("", VercelIntegration, payload))
}
job.AppendJobs(jobs.NewJob("", DeleteStaleSyncGatewaysConnections, nil))

switch payload.Reason {
case clusters.UpgradingDeployment: job.AppendJobs(... xdcr.ReferenceRepairJobType ...)
case clusters.TurnOnDeployment:    if payload.OnOffOpts.CloudNativeGatewayDeployed { ... cngJobs.NewDeployJob ... }
case clusters.ScalingDeployment:   job.AppendJobs(... rjobs.NewInvalidateReservationFulfillmentJob ...)
}

job.AppendJobs(jobs.NewJob(tenantID, ValidateClusterImageUpgrade, ...))

// :103-107 — Post steps
job.AppendPost(rjobs.NewDecommissionMaintenanceReservationsJob(...))
job.AppendPost(activationv2jobs.UpdateActivationJob(tenantID, nil))
job.AppendPost(fusionJobs.NewTearDownForDeployJob(tenantID, clusterID))
```

The comment above the `AppendPost` block is the whole point:

> "we append post to avoid relying on previous jobs to complete successfully.
> Since this has COGS implications, we do not want to be dependent on other jobs
> and perform all the needed checks/validations within the job itself."

**Concept: compensating actions must run on the failure path too.** Decommissioning
reserved capacity costs real money (COGS = cost of goods sold). If it only ran on
success, a failed deployment would leak spend forever. `Post` is the `finally`
block of a distributed workflow — and each Post step must be self-validating,
because it cannot assume the main job succeeded.

Teach the shape: **`Pre` = preconditions. `Jobs` = the work, conditionally
composed. `Post` = cleanup and billing truth, unconditional.**

---

## Part 4 — `cp-jobs`: the worker

Note first: root `AGENTS.md` lists a `cp-worker` binary. **There is no
`cmd/cp-worker`.** The worker is `cmd/cp-jobs`. Docs drift; the filesystem is the
source of truth. Have your team verify before quoting.

`cmd/cp-jobs/main.go` is 99 lines. All of it:

```go
func realMain() int {
    app, err := application.New(name, component, processors()...)
    if err != nil { ...; return 1 }
    if err := app.Run(); err != nil { ...; return 1 }
    return 0
}

func processors() []application.WithRegistrant {
    return []application.WithRegistrant{
        application.WithK8sProcessors(),
        application.WithG2Processors(),          // <- cluster deploy/destroy lives here
        application.WithBillingProcessors(),
        application.WithBackupProcessor(),
        ... 59 entries ...
    }
}
```

**Functional options as a plugin registry.** The binary is a *list of
capabilities*. Adding a domain to the worker is one line. Removing one for an
incident is one line. There is no god-object, no reflection, and the compiler
checks it.

Compare with `cmd/cp-api/server/server.go` (~10k lines of explicit construction).
Same philosophy — explicit, compile-time wiring — expressed at a different
granularity because the unit here is a *processor set*, not a service.

### The dispatch contract

`internal/jobs/interfaces.go`

```go
type Processor func(context.Context, Runner, *Job) Done      // :35
type ProcessorSet map[Type]Processor                          // :64
type Registrant interface { Processors() ProcessorSet }       // :68
type Runner interface { Sit(*Envelope, int64) }               // :14

type Queuer interface {                                       // :19
    Queue(ctx context.Context, job *Job) error                       // now
    Schedule(ctx context.Context, job *Job, scheduledFor time.Time) error   // later
    Send(ctx context.Context, jobID string) error                    // push existing job
}
```

A processor is a function. A registrant contributes a `Type -> Processor` map.
Job types must be globally unique — that is a documented invariant, not a
compiler guarantee, so it is a review item.

### `Done`: the retry policy is a return value

`internal/jobs/done.go:14`

```go
type Done interface {
    Error() error
    Fatal() bool        // stop everything; do not reattempt
    Next() []*Job       // dynamically insert follow-up steps
    Reattempt() bool
    Schedule() int64    // seconds until visible again (SQS visibility timeout)
}
```

Builder helpers (`:100+`):

```go
d := jobs.NewDone()
d.Err(err)
d.Attempts(job.Attempts, max)     // :134  sets fatal = actual>=max, reattempt = actual<max
d.MarkAsFatal()
d.SetSchedule(30)
d.AddNext(nextJobs...)
d.HandleFatalError(logger, err, msg)   // :154  log + err + fatal, in one call
d.HandleError(logger, err, msg, job, maxAttempts, schedule)
```

**Concept: the processor decides its own retry policy, per failure.** Not a global
retry config, not an annotation — a value returned from the function that knows
what went wrong. A missing restore record is fatal; a Couchbase blip is a 30-second
reschedule. Same processor, different verdicts.

The honest caveat is documented on `Schedule()`:

> "Under the hood this simply marks the SQS visibility on the message and does not
> guarantee that the job will be run at that point in time simply that SQS will
> allow a consumer of the message visibility to it at the provided point in time."

At-least-once, not exactly-once. Which is precisely why every processor must be
idempotent.

### Job statuses

`internal/jobs/status.go`

```go
Scheduled  Pending  Processing  Complete  Failed
SkippedDueToFatal
Killed                       // :18  AV-43305: processor deletes the SQS message
SkippedDueToCircuitBreaker   // :23  AV-46172: breaker was set
```

Notice that three of the eight statuses exist for *operational* reasons, and each
carries the ticket that created it. A state machine grown from incidents.

### `cp-scheduler` — the other producer

`cmd/cp-scheduler/README.md` is short and clear. Three schedule kinds:

| Kind | Where defined | Example |
|---|---|---|
| **Static** | `recurringJobSchedules` in `cmd/cp-scheduler/scheduler.go`, shipped in the binary | invoice customers at month end |
| **Dynamic** | added/removed at runtime | back up a cluster on the 2nd Wednesday monthly (README marks this TO BE IMPLEMENTED) |
| **One shot** | `jobs.Queuer.Schedule(ctx, job, when)` | expire this credential in 15 days |

The one-shot mechanism is worth naming:

> "The job record is created, but not added to the message queue. Polls the index
> containing jobs with the status `scheduled`."

**Concept: two delivery paths, one job model.** SQS for now-work; a database index
poll for future-work. SQS message timers max out at 15 minutes, so anything
further out must live in the database. `cp-scheduler` uses `robfig/cron/v3` for the
static schedules.

So the producers are: `cp-api` (user intent), `cp-scheduler` (time), `cp-internal-api`
(agent-reported events, e.g. disk expansion). One consumer: `cp-jobs`.

---

## Part 5 — The deploy processor: a bounded attempt in an unbounded workflow

`internal/clusters/jobs/deploy.go:114`

```go
timeout := 10 * time.Minute                  // per-attempt budget
const schedule int64 = 30                    // reschedule delay, seconds
const minimumAttempts = 10
```

### Timeout tiering

```go
if cluster.Config.PrivateEndpointsEnabled { timeout = 25 * time.Minute }   // :149
```

Private endpoints are slower on GCP and Azure. The budget is a function of what
is being built, not a global constant.

### Extending the lease, then bounding the work

```go
visibility := int64(timeout.Seconds()) + schedule
r.Sit(&jobs.Envelope{Job: job, Current: job, Ctx: ctx, ReceiptHandle: job.ReceiptHandle}, visibility)

preTimeoutContext := ctx
ctx, cancel := context.WithTimeout(ctx, timeout)
defer cancel()
```

Two clocks, deliberately ordered:

1. `r.Sit(...)` extends the **SQS visibility timeout** so no other consumer picks
   the message up while this attempt runs. Visibility = timeout + buffer.
2. `context.WithTimeout` bounds the **work itself**, so it cannot outlive its lease.

**Concept: the lease must outlast the work.** Invert these and two workers deploy
the same cluster concurrently — which the infra layer explicitly says it does not
support (`internal/clusters/infra/infra.go:29-34`).

Note `preTimeoutContext`. When the attempt times out, `ctx` is cancelled — so the
"record why we failed" calls (`updateAndEmitClusterStateOnDeployFatal`) are given
the *pre-timeout* context. **Cleanup must not run on a cancelled context.** This
is a bug class your team will hit the first time they use `context.WithTimeout`
in anger.

### Adaptive attempt budget

```go
maxAttempts := setMaxAttempts(payload.Reason, timeout)
maxAttempts += state.GetRebalanceStatus().AttemptsBeforeRebalanceProgress
```

The comment explains both halves:

> The time a deployment takes can vary widely... We therefore allow a day for a
> deployment to complete... However for new cluster deployments we would like to
> limit it to 30 minutes.
>
> If we observe rebalance process in a deployment we want to effectively reset the
> attempt counter as we know the deployment is actually progressing rather than
> running into an error.

**Concept: retry on evidence of progress, not on a fixed count.** A 6-hour
rebalance that is advancing should not be killed by a retry cap. A stuck
deployment should. The distinguishing signal is *observed progress*, so that is
what feeds the budget.

This is the single most reusable idea in Part 5. Most retry logic in the industry
counts attempts. This counts attempts *since the last observed progress*.

### Error classification at the call site

`deploy.go:345`

```go
switch err := p.deployer.Deploy(ctx, cluster, &payload.DeploymentOpts, state, metadata); {
case err == nil:
case internalerrors.IsFatalError(err):
    d.MarkAsFatal()
    if doneErr := state.Done(err); doneErr != nil { logger.Warn(...) }
    fatal := internalerrors.GetFatalError(err)
    errCode := ...                     // code drives which alert fires
    p.updateRestoreStatusOnDeployFatal(ctx, ...)
    p.updateAndEmitClusterStateOnDeployFatal(preTimeoutContext, ..., errCode, ...)
case errors.Is(err, environment.ErrQuotaExceeded{}):
    d.MarkAsFatal()
    p.updateAndEmitClusterStateOnDeployFatal(preTimeoutContext, ..., "ErrExceededQuota", ...)
default:
    d.Attempts(job.Attempts, maxAttempts)
    scheduleAfter := schedule
    if rescheduleErr, ok := clusters.AsRescheduleJobError(err); ok {
        scheduleAfter = rescheduleErr.After          // the error names its own backoff
    }
    d.SetSchedule(scheduleAfter)
}
```

Four classes: success, fatal (with a typed code that selects an alert),
quota-exceeded (fatal, distinctly labelled), and retryable — where the error
itself may carry the backoff via `AsRescheduleJobError`.

**Concept: errors as typed data, not strings.** `IsFatalError`, `GetFatalError().Code()`,
`AsRescheduleJobError(err).After`. Compare this with slice 1's `goof` system — same
philosophy (errors carry structured behaviour), different vocabulary because the
audience is an operator rather than an end user.

### Timing and progress metrics

```go
if job.Attempts == 1 { p.deployMetrics(ctx, cluster, payload) }

const startBuffer = time.Minute * 2
if !job.CreatedAt.IsZero() && time.Since(job.CreatedAt) >= startBuffer {
    p.deployTimeMetrics(ctx, (time.Since(job.CreatedAt)-startBuffer).Minutes(), cluster, payload)
}
```

`CreatedAt`, not `StartedAt`, "since the latter gets reset for every attempt" —
so the metric measures the *customer-perceived* duration, not the current attempt.
Choosing the right clock is a product decision.

### Waiting on a peer workflow

For scheduled turn-offs, the processor checks for in-flight backup jobs, and if
found reschedules itself every 5 minutes until a deadline:

```go
const haveBackupJobsSchedule int64 = 60 * 5
if haveBackupJobs {
    if time.Now().UTC().After(*payload.TurnOffDeadlineInUTC) {
        logger.Warn("cluster turn off job deadline has passed")
        return d                       // give up WITHOUT alerting
    }
    r.Sit(&jobs.Envelope{... Ctx: preTimeoutContext ...}, int64(timeout.Seconds())+haveBackupJobsSchedule)
    d.ShouldReattempt()
    d.SetSchedule(haveBackupJobsSchedule)
}
```

The comment on the deadline branch is the interesting part:

> "Reaching the deadline due to a long-running backup should not trigger a failed
> deployment alert as the cluster should still be healthy infrastructure-wise due
> to the actual turn off deployment never starting."

**Concept: distinguish "did not happen" from "broke".** Both are non-success;
only one should page someone. Alert hygiene is designed here, in the processor.

---

## Part 6 — The deployer: reconciliation, not a script

`internal/clusters/deployer/manager.go:17`

```go
// Manager provides the means to "deploy" a cluster. Applications should never
// seek to use a Deployer implementation directly and choose an implementation
// of Manager.
type Manager interface {
    // Deploy will deploy the cluster. It is an idempotent operation that
    // will always produce the same outcome based on the state of the
    // cluster's specifications.
    Deploy(ctx context.Context, cluster *clusters.Cluster, opts *clusters.DeploymentOpts,
           state deployments.State, metadata AdditionalMetadata) error
    ScaleBackupNode(...) (*nodes.Node, error)
}
```

**"Idempotent... based on the state of the cluster's specifications."** That
sentence is the architecture. This is not a provisioning script; it is a
Kubernetes-style controller: read desired state, observe actual state, act to
close the gap, repeat. Being called 12 times for one upgrade is the *design*, not
a retry hack.

`internal/clusters/deployer/deployer.go:380` — the ordered phases:

```go
if cluster.Status.State == clusters.Destroying || cluster.Status.State == clusters.DestroyFailed {
    logger.Info("skipping deployment because of cluster state - nothing more to do")
    return nil            // customer asked to destroy; this queued job is stale
}

d.performPreDeploymentActions(ctx, logger, opts, cluster)
d.buildCredentials(ctx, logger, cluster)
d.buildSecretsEncryptionPassword(ctx, logger, cluster)
deps, err := d.getDependencies(ctx, logger, cluster, opts, state, metadata)

d.cluster(ctx, logger, deps, opts.Reason)          // cluster-wide: blob storage, IAM, secrets
if deps.cluster.Config.IsColumnarDataplane { d.columnarResources(...) }
d.prepareClusterForRestore(ctx, logger, deps)
deps.network, err = d.network(ctx, logger, deps)   // VPC, subnets, routes, endpoints
d.fusionNetwork(ctx, deps, logger)                 // needs cluster VPC id -> must follow network
if opts.Reason == clusters.UpgradingDeployment { d.backupNode(ctx, logger, deps) }
d.restoreCluster(ctx, logger, deps)
d.deploymentPlan(ctx, logger, deps, opts)          // <- plan + apply
deps.state.Checkpoint()
if cluster.Config.IntendedState == clusters.TurnedOff { d.turnOffCluster(ctx, logger, deps) }
```

Three things to draw out:

1. **Ordering is dependency, and it is commented.** "This must run after cluster
   networking above, as it requires the cluster VPC ID and route table ID."
   "If this is an upgrade we need to deploy the backup node first to ensure that
   we do not run into a compatibility scenario." A reader can reorder safely only
   because the constraints are written down.

2. **The stale-job guard is first.** A deploy job queued before a destroy request
   returns `nil` (success, nothing to do) rather than fighting the destroy. In an
   async system, *"is this instruction still relevant?"* is the first question
   every worker must ask.

3. **`Checkpoint()` is best-effort.** Failing to record progress logs a warning
   and continues — losing a checkpoint costs re-work on the next attempt, and
   re-work is safe because the operation is idempotent. Idempotency is what buys
   you the freedom to treat bookkeeping as non-critical.

`d.enhanceContext` failing is also non-fatal: "We don't want the cluster
deployment to fail if we fail to add the audit tags to the context." Observability
must not be able to break the thing it observes.

---

## Part 7 — The planner: `terraform plan`, written in Go

`internal/clusters/planner/planner.go:27`

```go
// Plan communicates a course of action for a deployment. Building a plan
// results in the inspection of the current state and produces a diff of changes
// that are needed to result in getting the cluster to the desired state.
type Plan struct {
    Deploy    []nodes.Node `json:"deploy"`     // :41  new, or existing and untouched
    Replace   Replacements `json:"replace"`    // :66  must be rebuilt
    Destroy   []nodes.Node `json:"destroy"`    // :76  scale-down
    GrowDisks []nodes.Node `json:"growDisks"`  // :87  resize in place
}
```

The doc comments carry worked examples — read them verbatim with your team:

| Customer action | Deploy | Replace | Destroy |
|---|---|---|---|
| New 3-node cluster | 3 | 0 | 0 |
| Scale 3 → 5 nodes | 5 | 0 | 0 |
| Image / server version upgrade | 0 | all | 0 |
| Change compute type on 2 of 5 nodes | 3 (no-op) | 2 | 0 |
| Scale 5 → 3 nodes | 3 | 0 | 2 |

A node lands in `Replace` when the compute type changed, the disk size changed, or
the image / server version changed. `GrowDisks` exists because disks can be grown
in place — and the name is deliberate: "the mechanism here is 'GrowDisks' and not
'ResizeDisks'", because EBS cannot shrink.

**Notice that "no change" appears as `Deploy`, not as an empty set.** The plan
declares the desired end state for every node; convergence then makes unchanged
nodes a no-op. Declarative, not imperative.

### The plan is computed once and persisted

`internal/clusters/deployer/deployer.go:1447` — `deploymentPlan`:

```go
// A deployment is not something that we can expect to run via a single
// job. As such we only ever build the plan once. To put this into
// context an AMI upgrade might take 2 hours. The job to run the
// deployment is going to live for ~10 minutes. That means that at
// minimum the job is going to re-process at least 12 times. If this
// was not here then a new plan would be created everytime resulting in
// oddities with comparing the desired state to the actual state of the
// cluster.
if deps.plan = deps.state.GetPlan(); deps.plan != nil {       // :1464
    deps.plan.UpdateFromExistingNodes(logger, opts, cn...)
    return nil
}
...
deps.plan, err = planner.NewPlan(logger, deps.cluster, hostsEntries, fallbackRecords, opts, cn...)
deps.state.SetPlan(deps.plan)                                  // :1503
```

**This closes the loop back to the queuer's `max = 2`.** The plan is a snapshot of
intent taken at first processing; the deployment state document is where it lives
across the ~12 attempts. Because the plan is frozen, metadata changes made *after*
it was built are not picked up — which is exactly why a second job is allowed to
queue. Two files, one design decision. Show your team both together.

`UpdateFromExistingNodes` refreshes the *observed* side (which nodes now exist)
while leaving the *intended* side alone. Desired state frozen, actual state
refreshed. That is the reconciler contract in one method call.

---

## Part 8 — Multi-cloud through one interface

`internal/clusters/infra/infra.go:36`

```go
// Deployer is responsible for deploying network infrastructure ... Implementations
// have the following characteristics:
//   - Do not support calling the same method N number of times concurrently for
//     the same deployment. It is up to the caller to perform concurrency
//     restrictions and locking mechanisms.
//   - Provide idempotency. Calling the method repetitively will always result in
//     the same outcome. This is not true if for the same cluster the same method
//     is called concurrently.
type Deployer interface {
    Cluster(ctx, cluster) error                                  // blob storage, IAM, secrets
    Network(ctx, network) error
    Node(ctx, compute *Compute) error
    GetNodeASGSize(ctx, node) (int, error)
    Security(ctx, network, rules ...firewall.Rule) error
    Storage(ctx, container, isColumnarDataplane bool) error
    StorageEndpoint(ctx, container, network) error
    Columnar(ctx, cluster) error
    CapacityReservations(ctx, cr) error
}

type Destroyer interface { ... }        // :86  the exact inverse
```

Adapters: `infra/aws/`, `infra/azure/`, `infra/gcp/`.

**The interface contract states its own preconditions.** "Idempotent, but not
concurrently for the same cluster." That is precisely the guarantee SQS FIFO
partitioning by `clusterID` provides. The contract and the mechanism that
satisfies it live in different files — connect them explicitly when teaching.

### The AWS insight your team will remember: 1 node = 1 ASG

From the `Node` doc comment (`infra.go:45`):

> "In Couchbase Capella a node is an auto scaling group. The auto scaling group is
> a 1:1 relationship with a Couchbase cluster node. An auto scaling group will
> never have more than (1) instance running it. An auto scaling group might not
> have any instances if: the auto scaling group exists to serve the purpose of
> performing a cron job; the customer has chosen to turn down nodes."

Why do this, when an ASG is designed to manage *many* instances?

- **Self-healing for free.** Instance dies → ASG replaces it. No custom watchdog.
- **Turn-off is `desired_capacity = 0`.** Hibernation without deleting the node's
  identity, its EBS volume, or its DNS. `GetNodeASGSize` reads it back.
- **Node replacement is a launch-template change**, so `Plan.Replace` maps to an
  AWS-native primitive.
- **Stable identity.** A Couchbase node has state and cluster membership; you
  cannot treat instances as fungible. One ASG per node keeps identity 1:1.

Trade-off: many ASGs instead of a few, so ASG service quotas become a real
constraint — which is exactly what `internal/environment` manages.

`internal/clusters/infra/aws/` also contains (21 non-test files): `iam.go`, `kms.go`, `networks.go`,
`nodes.go`, `security.go`, `storage.go`, `peering.go`, `launchtemplates.go`,
`internetgateways.go`, `backupnode.go`, `columnar.go`, `reservations.go`,
`auditmanager.go`, `metadatavalidator.go`, `destroyer.go`. That list *is* the AWS
syllabus for this slice.

---

## Part 9 — Cross-account access: the DBaaS trust model

This is the AWS concept a Principal Engineer at a DBaaS company must be able to
draw on a whiteboard.

`internal/csp/access/method.go:12`

```go
type Method string
const (
    // Hosted communicates that the account that needs to be accessed is
    // owned and controlled by Couchbase Capella.
    Hosted Method = "hosted"                  // :19

    // SelfService communicates that the account is a shared account in the
    // cloud service provider.
    SelfService Method = "selfService"        // :23
)

func MethodFromContext(ctx context.Context) Method {       // :31
    if internalcontext.SelfServiceTrialCluster(ctx) { return SelfService }
    return Hosted
}
```

Two tenancy models, chosen from `ctx`:

- **Hosted** — the tenant has a dedicated **resource container** (a dedicated AWS
  account). Paying customers.
- **SelfService** — a *pool* of shared accounts. Free-tier trials, where a
  dedicated account per signup would be absurd.

`internal/csp/access/aws/aws.go`

```go
const adminRole   = "rc-cluster-admin"        // :27   "rc" = resource container
const BillingRole = "rc-billing-admin"        // :29

func (a *accessor) AccessByMethod(ctx, method, tenantID, opts...) (*Session, error) {   // :96
    switch method {
    case access.Hosted:      return a.hostedSession(ctx, tenantID, opts...)
    case access.SelfService: return a.trialSession(ctx, tenantID, opts...)
    default:                 return nil, ErrInvalidAccessMethod
    }
}

func (a *accessor) getAccountNo(ctx, tenantID string) (string, error) {                 // :140
    rcs, err := a.resourceReader.Many(ctx,
        n1ql.WithWheres(n1ql.Equals("tenantId", tenantID), n1ql.Equals("provider", providers.AWS)),
        n1ql.WithLimit(2),   // "we only expect (1) and if there is more than (1) it is an error"
    )
    if len(rcs) != 1 { return "", ErrTooManyResourceContainers }
    awsrc, ok := rcs[0].(*resource.AWS)
    if !ok { return "", ErrUnexpectedResourceContainerType }
    return awsrc.AccountID, nil
}

func (a *accessor) assumeRole(accountNo string, opts ...ConfigOpt) *aws.Config {        // :167
    roleARN := getRoleARN(accountNo, options.IAMRole)
    creds := stscreds.NewCredentialsWithClient(a.sts, roleARN, func(p *stscreds.AssumeRoleProvider) {
        p.Duration = options.Duration
    })
    return aws.NewConfig().WithCredentials(creds)
}

func getRoleARN(accountNo, role string) string {                                        // :226
    return fmt.Sprintf("arn:aws:iam::%s:role/%s", accountNo, role)
}
```

Walk it end to end:

1. Tenant id → look up the **resource container** record in Couchbase → AWS account number.
2. Build the role ARN by convention: `arn:aws:iam::<account>:role/rc-cluster-admin`.
3. `stscreds.AssumeRoleProvider` fetches **short-lived** credentials via STS.
4. Return a config; the SDK refreshes automatically as they near expiry.

**Nowhere does the control plane store a customer's AWS keys.** It holds one
identity, and assumes a well-known role in each tenant account. Five concepts in
forty lines:

- **Cross-account access** — the standard AWS multi-tenant pattern
- **Temporary credentials** — nothing long-lived to leak, `p.Duration` bounds the window
- **Role naming by convention** — the ARN is derived, not stored; no per-tenant config
- **Role separation** — `rc-cluster-admin` vs `rc-billing-admin`; the billing path
  cannot touch clusters (`BillingAccess`, `:107`)
- **`n1ql.WithLimit(2)` as an assertion** — fetch one more than expected so
  "exactly one" can be *verified*, not assumed. Cheap invariant checking; steal it.

Also note `getAccountNoBilling` (`:129`) hardcodes account `264138468394` in dev and
stage "due to salesforce cleanups". Environment-specific hacks exist; they are
labelled, scoped to non-prod, and explained. That is how to carry a wart.

### The scoped SDK

`internal/clusters/infra/aws/sdk/sdk.go:32`

```go
// SDK provides an AWS SDK that is built from the credentials of a tenant. ...
// The implication is that any resources provisioned using this SDK will be a
// tenant's account.
type SDK struct {
    AccountID   string
    AutoScaling internalautoscaling.API
    EC2         internalec2.API
    IAM         internaliam.API
    KMS         internalkms.API
    Route53     internalroute53.API
    S3          internals3.API
    S3Uploader  internals3manager.Uploader
    Secrets     internalsecretsmanager.Manager
    ELB         internalelb.API
    Backup      internalbackup.API
    TaggingV2   internaltagging.V2API
}

type SDKGetter func(ctx, method, tenantID, region string, fn SessionGetter, fnV2 ConfigGetter, opts ...SDKOpt) (*SDK, error)   // :49
```

**Every field is an interface** (`internalec2.API`, etc.), each a thin in-house
wrapper that adds tracing. So:

- the whole AWS surface is mockable — deployer unit tests need no AWS
- every AWS call appears as a span (see `internal/aws/v2/sts/sts.go:73`,
  `TracedAPI.AssumeRole` wrapping the call in `tracer.StartSpan`)
- the SDK instance is **already scoped to one tenant**, so a leaked SDK cannot
  touch another tenant's account

`SDKGetter` is a function type "to aid in unit testing" — dependency injection
without a framework, again.

Bonus curiosity at `sdk.go:64`: partner-attribution headers (`PartnerName`,
`PartnerProduct`, `PartnerVersion`) added for AWS's partner program, with a
mildly exasperated comment. Real systems carry commercial obligations in code.

---

## Part 10 — Quotas and the environment

`internal/environment/infra.go:13`

```go
type Environmenter interface {
    // Inspect returns an error if a given cluster cannot be deployed to the
    // environment (resource container, cloud) because of environment
    // restrictions. Given that resource container has quota limit for 10 VPC's
    // but the tenant already provisioned 10 clusters and used all VPC's
    // the environment.ErrQuotaExceeded is returned.
    Inspect(ctx context.Context, cluster *clusters.Cluster, deployment Type) error

    // PostDeployment performs environment check after a successful cluster
    // deployment. For hosted it checks if the resource container where
    // the cluster was deployed didn't cross the quota threshold. If quota
    // threshold is reached the automatic quota increase is triggered.
    PostDeployment(ctx context.Context, cluster *clusters.Cluster, deployment Type) error
}
```

`internal/environment/errors.go:19`

```go
type ErrQuotaExceeded struct { ... }
func NewErrQuotaExceeded(service, key string, exceeded int) ErrQuotaExceeded
func (e ErrQuotaExceeded) Is(target error) bool     // :42  works with errors.Is
```

**Concept: AWS service quotas are a first-class product constraint.** VPCs per
region, ASGs per account, EIPs, EBS volume counts. A DBaaS provisioning into
customer accounts hits these constantly.

Two behaviours worth naming:

1. **`Inspect` before deploying** — fail fast with a clear, fatal error rather
   than half-building a cluster and hitting `LimitExceeded` from the API.
2. **`PostDeployment` raises quotas automatically** when a threshold is crossed.
   Quota increases take AWS hours-to-days to approve, so you must request them
   *before* you need them. Capacity planning as a background job.

Note the layering: `ErrQuotaExceeded` implements `Is`, so `deploy.go:366` can
write `errors.Is(err, environment.ErrQuotaExceeded{})` and mark the job fatal with
its own alert label. A custom error type that participates properly in the stdlib
error tree.

Compare with slice 1's `quotasManager.Residual(ctx, tenantID, quotas.KeyProjectCount)`:
**business quotas** (how many projects your plan allows) and **infrastructure
quotas** (how many VPCs AWS will give you) are different systems with different
owners. Both are called "quota". Do not let your team conflate them.

---

## Part 11 — The CP↔DP seam

### The single door

`cmd/cp-internal-api/` is the only CP surface DP agents may reach. Recall from
doc 04 that it is fronted by a *second* nginx Ingress on the same `cp-api`
Service, enforcing **mTLS** with `auth-tls-verify-depth = 1`
(`terraform/modules/api/service.tf:64-74`).

### Resource-scoped verifiers

The auth model here is the slice-1 idea taken further: **the caller's identity is
a resource.**

`cmd/cp-internal-api/server/clustermiddleware.go:13`

```go
type clusterVerifier struct {
    Handler
    verifier internalagent.Verifier
}

// Middleware is invoked before actioning any incoming request to confirm the
// identity of the caller and the credentials used in the request.
// It confirms that the caller is always only a couchbase cluster node and the
// credentials have full_admin role.
func (s *clusterVerifier) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := ensureUserData(r.Context())
        clusterID := mux.Vars(r)["clusterId"]

        username, password, ok := r.BasicAuth()
        if !ok {
            s.respond(w, r, http.StatusNotFound, ErrNotFound)     // :36  <- 404, not 401
            return
        }
        ok, err := s.verifier.Verify(ctx, clusterID, username, password)
        if err != nil { s.respondError(w, r, err); return }
        if !ok {
            s.respond(w, r, http.StatusNotFound, ErrNotFound)     // :50  <- 404, not 403
            return
        }
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

**Auth failure returns 404, not 401/403.** An unauthenticated caller cannot learn
whether a cluster id exists. Same enumeration-defence reasoning as slice 1's
"access denied → empty 200". *Pattern consistency across two independently
written services is the sign of a real convention rather than a habit.*

The credentials are verified **against the cluster**: username/password must be a
Couchbase user on that cluster holding `full_admin`. So the data plane
authenticates with a credential the data plane already has, and CP verifies it by
asking the cluster. No separate agent secret to rotate for this path.

There are **at least ten** sibling verifiers, mounted per subrouter:
`clusterVerifier`, `sgwVerifier`, `distributionPointsVerifier`,
`languageModelVerifier`, `languageModelPhoneHomeVerifier`,
`observabilityResourceVerifier`, `aiServicesVerifier`, `analyticsNebulaVerifier`,
`vectorizationVerifier`, `vulcanVerifier`, plus `NewControlPlaneVerifier` — see
`agentversions.go:42-53`, `alertmuter.go:65`, `datadog.go:65-73`. One verifier per
*kind of caller*, and the list is a census of everything that talks to CP from
outside.

Mounting looks like this (`phonehome.go:24`):

```go
func (s *Server) mountPhoneHome(deps *Deps) error {
    path := "/clusters/{clusterId}/nodes/{nodeId}/phonehome"
    svc := phoneHomeHandler{Handler: s.handler, logger: ..., nodes: ..., svc: ...}
    sr := s.PathPrefix(path).Subrouter()
    sr.Use(s.clusterVerifier)                    // :35
    sr.Handle("", &svc)
    return nil
}
```

`mount*` + `configure` per file. ~100 files, all the same shape. Boring on
purpose: a reviewer checking "is this endpoint properly verified?" looks at one
line, in a predictable place.

Phone-home payloads are **snappy-compressed** (`github.com/golang/snappy` imported
in `phonehome.go`). Every node in every cluster reports periodically — compression
is a bandwidth and cost decision at fleet scale.

### The agent

`cmd/dp-agent-v3/AGENTS.md` is the best single document in the repo. Read it in
full with the team; it is short. The highlights, with the concept each teaches:

| Behaviour | Concept |
|---|---|
| Discovers identity via cloud **IMDS**, registers with `cp-internal-api` | Instance metadata as identity; zero-config bootstrap |
| **Phone home** heartbeat | Liveness reported by the node, not polled by CP — scales to a large fleet |
| **Poll config** (e.g. updates `/etc/hosts` for cluster DNS) | Pull-based config. Agents converge; CP does not push. |
| **Sync certificates**, interval randomised **12–24h** | *Thundering-herd mitigation* — jitter so a fleet does not stampede CP |
| **Expand disk** when a threshold is breached | The agent *requests* work from CP; the node is a job producer |
| **Export audit logs** → compress → S3/Blob/GCS → delete locally | Log shipping with local cleanup |
| **Trigger backup** only if this node is the Couchbase **orchestrator** (`/pools/default/terseClusterInfo`) | Leader election by delegation — reuse the database's own election instead of building one |
| LVM cache: ephemeral NVMe fronting EBS | Storage tiering for real performance gain |
| Bind mounts `/var/cb/couchbase` → `/opt/couchbase/var/lib/couchbase` | Decouple state from the installation so reinstall/upgrade is safe |
| `samber/do/v2` DI to swap AWS/Azure/GCP implementations | Same ports-and-adapters idea as `infra/`, at the node level |
| systemd `Restart=on-failure`, `RestartSec=10`, `StartLimitIntervalSec=0` | **Exit 0 is terminal.** Never exit cleanly on error, or the agent stays dead. |
| "the entirety of the initialization and disk mounting logic is strictly idempotent" | Every restart replays bootstrap; idempotency is a hard requirement |

Two of these are worth dwelling on.

**Thundering-herd mitigation via jitter.** A fleet of nodes with the same 24-hour
timer will synchronise and hit CP in a spike. Randomising to 12–24 hours spreads
the load flat. This is a distributed-systems reflex your team should acquire now;
it applies equally to frontend `refetchInterval` values.

**Orchestrator-aware operations.** A cluster-wide action must happen once, not
once per node. Rather than building leader election, the agent asks Couchbase who
the orchestrator is and defers if it is not. **Reuse an existing consensus
mechanism instead of adding one.**

### The convergence loop, stated plainly

```
CP writes desired state (Couchbase)  ->  agents POLL config  ->  agents converge
agents PHONE HOME actual state       ->  CP updates cluster status  ->  UI reflects it
```

Nothing is pushed to the data plane. CP publishes intent; agents pull and
reconcile; agents report; CP records. The same reconciler shape as the deployer,
now spanning a network boundary and a trust boundary. Once your team sees that
`deployer.Deploy` and the agent's poll loop are *the same pattern at two scales*,
this architecture stops feeling large.

---

## New patterns introduced in this slice

Additions to [doc 03](03-go-patterns.md); the review checklist at the end of this
document folds them in.

| # | Pattern | Where |
|---|---|---|
| 21 | Reconciliation loop / idempotent converger | `internal/clusters/deployer/manager.go:17` |
| 22 | Plan-then-apply with a persisted plan | `planner/planner.go:27`, `deployer.go:1464` |
| 23 | Retry policy as a return value (`Done`) | `internal/jobs/done.go:14` |
| 24 | Progress-aware retry budget | `internal/clusters/jobs/deploy.go` (`AttemptsBeforeRebalanceProgress`) |
| 25 | Circuit breaker as an operator kill-switch | `internal/jobs/interfaces.go:110` |
| 26 | Queue-depth backpressure with a derived limit | `internal/clusters/queuer/queuer.go:177` |
| 27 | Saga with unconditional compensations (`Pre`/`Jobs`/`Post`) | `internal/clusters/jobs/deploy.go:55` |
| 28 | Resource-partitioned FIFO queue | `deploy.go:109` (`MessageGroupID = clusterID`) |
| 29 | Lease/work dual timeout (`r.Sit` + `context.WithTimeout`) | `deploy.go:153-168` |
| 30 | Pre-cancellation context for cleanup | `deploy.go` (`preTimeoutContext`) |
| 31 | Processor registry via functional options | `cmd/cp-jobs/main.go` |
| 32 | Per-tenant scoped SDK via `AssumeRole` | `internal/csp/access/aws/aws.go:167` |
| 33 | Stale-instruction guard in a worker | `deployer.go:380` (destroying check) |
| 34 | Errors as typed operational data | `IsFatalError`, `GetFatalError().Code()`, `AsRescheduleJobError` |
| 35 | Alert-don't-block for anomalies | `queuer.go` (rebalance storm metric) |
| 36 | `WithLimit(n+1)` as an invariant assertion | `csp/access/aws/aws.go:140` |
| 37 | Jitter to prevent thundering herd | `cmd/dp-agent-v3/AGENTS.md` (SyncCertificates 12–24h) |
| 38 | Leader election by delegation | `cmd/dp-agent-v3/AGENTS.md` (orchestrator check) |
| 39 | Identity-as-resource auth, failing to 404 | `cp-internal-api/server/clustermiddleware.go:36,50` |

---

## New AWS concepts introduced in this slice

Additions to [doc 04](04-aws-concepts.md).

| Concept | Why it is used here |
|---|---|
| **STS `AssumeRole`** across accounts | The DBaaS trust model. No stored customer keys. |
| **Short-lived credentials** (`stscreds.AssumeRoleProvider`) | Nothing long-lived to leak; `p.Duration` bounds it |
| **Role ARN by convention** | `arn:aws:iam::<acct>:role/rc-cluster-admin` — derived, not stored |
| **Role separation** | `rc-cluster-admin` vs `rc-billing-admin` |
| **ASG with max 1 instance = 1 node** | Self-healing, `desired=0` hibernation, launch-template replacement, stable identity |
| **SQS FIFO + `MessageGroupID`** | Per-resource serialisation; one queue behaves as N |
| **SQS visibility timeout** | The work lease. `r.Sit()` extends it; `Schedule()` shortens it to reschedule. |
| **SQS delay limits** | 15-minute cap is why one-shot jobs poll a DB index instead |
| **AWS service quotas** | VPCs, ASGs, EIPs. `Inspect` pre-checks; `PostDeployment` auto-raises. |
| **EC2 IMDS** | Node self-identification at boot; zero-config bootstrap |
| **Launch templates** | Node replacement = new template version |
| **EBS grow-only** | Why the plan field is `GrowDisks`, not `ResizeDisks` |
| **Instance store (NVMe) + LVM cache** | Ephemeral disk fronting EBS for read/write caching |
| **KMS / BYOK-CMEK** | Customer-managed encryption keys per cluster |
| **VPC peering, VPC endpoints, private endpoints** | `peering.go`, `StorageEndpoint`, `PrivateEndpointsEnabled` (and why the timeout jumps to 25 min) |
| **AWS Backup** | Columnar backup resources (`infra/aws/columnar.go`) |
| **Capacity reservations** | Azure capacity-constrained regions (AV-88128) |
| **Resource tagging API** | `TaggingV2` — cost attribution and resource discovery |

---

## Exercises for the team

1. **Follow one deploy.** In dev, create a cluster. Find the job document in
   Couchbase by `payload.id`. Watch `status` walk `pending → processing →
   complete`, and count `Attempts`. Then find the same `traceId` in Datadog and
   line the spans up against the phases in `deployer.Deploy`.

2. **Explain `max = 2`** without looking. If you cannot get from "the plan is a
   snapshot" to "therefore two", re-read `queuer.go:127-215` and `deployer.go:1456-1467`
   together. This is the comprehension checkpoint for the whole slice.

3. **Find a fifth gate.** `Deploy` has four (breaker, depth, conflict, alerting).
   Read `TurnOff` and `Destroy` and list what is different and why.

4. **Trace an `AssumeRole`.** Start at a deployer AWS call, walk back to
   `getRoleARN`. Then explain, out loud, why Capella holds no customer AWS keys.

5. **Draw the reconciliation loop** twice: once for `deployer.Deploy` (CP → AWS),
   once for `dp-agent-v3` (node → CP). Label what is desired state, what is
   observed state, and what closes the gap. They should look the same.

6. **Break idempotency deliberately.** In a local branch, make a deployer step
   non-idempotent (e.g. append rather than upsert). Predict what happens on
   attempt 2. Then read the `infra.Deployer` contract comment again.

7. **Audit an alert decision.** Find the scheduled-turn-off deadline branch in
   `deploy.go`. Explain why it returns without alerting. Then find one place you
   think *should* alert but does not, and argue it.

---

## Review checklist — async work

Anything that queues a job, or runs as one, gets checked against this.

**Queueing**
- [ ] Circuit breaker consulted; lookup failure fails **open**, not closed
- [ ] Queue depth bounded, and the bound is **derived or documented**
- [ ] Conflicting in-flight job types detected (and the state-based prevention exists too)
- [ ] `MessageGroupID` set deliberately — what is being serialised, and against what?
- [ ] Compensating/billing-relevant steps go in `Post`, never in `Jobs`
- [ ] Anomalies that need a human **alert** rather than silently blocking

**Processing**
- [ ] Idempotent. Re-running the whole processor is safe.
- [ ] Stale-instruction guard first (has the user since cancelled/destroyed?)
- [ ] SQS visibility (`r.Sit`) extended **beyond** the work timeout, not under it
- [ ] `context.WithTimeout` bounds the work; cleanup uses the **pre-timeout** context
- [ ] Errors classified: fatal vs quota vs retryable-with-backoff
- [ ] Retry budget reflects **observed progress**, not just an attempt count
- [ ] Fatal paths record cluster state and emit an error **code**, so alerts can route
- [ ] Metrics use the customer-perceived clock (`CreatedAt`), not per-attempt
- [ ] Observability failures (tracing, audit tags, checkpoints) never fail the job

**Cloud calls**
- [ ] SDK obtained via `AccessByMethod` — never a long-lived credential
- [ ] Every SDK field is an interface, so the path is unit-testable without AWS
- [ ] Quotas inspected before building; threshold crossing triggers an increase
- [ ] Resources tagged for cost attribution and discovery

**Agent-facing endpoints**
- [ ] Mounted on a subrouter with the correct resource verifier
- [ ] Auth failure returns **404**, never 401/403
- [ ] High-frequency payloads compressed
- [ ] Periodic work jittered; cluster-wide work gated on orchestrator
