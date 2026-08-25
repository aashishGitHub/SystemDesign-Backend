# 03 — Go Patterns in `couchbase-cloud`

Format for each: **name → where → what it buys → how it changes testing → the
trap**. Patterns 1–20 come from slice 1 (the synchronous request path).

**Patterns 21–39 — the async/orchestration set — are documented in
[doc 06, "New patterns introduced in this slice"](06-slice-02-cluster-provisioning.md#new-patterns-introduced-in-this-slice):**
reconciliation loops, plan-then-apply, retry-as-a-return-value, progress-aware
retry budgets, circuit breakers, derived backpressure, sagas with unconditional
compensations, resource-partitioned FIFO queues, lease/work dual timeouts, and
per-tenant scoped SDKs via `AssumeRole`.

Aimed at a UI engineer who knows JS/TS patterns and needs the Go equivalents.

---

## 1. Functional Options

**Where:** `internal/couchbase/n1ql/query.go:339`

```go
type QueryOpt func(*Query)

func WithLimit(limit int) QueryOpt   { return func(q *Query) { q.limit = limit } }   // :393
func WithOffset(offset int) QueryOpt { ... }                                        // :399
func WithSortBy(fields ...string) QueryOpt { ... }                                  // :432
```

Used as `store.Many(ctx, n1ql.WithLimit(100), n1ql.WithOffset(100), n1ql.WithSortBy("name"))`.
Also `couchbase.CommandOption` (`WithQuerySelect`, `WithNamedParams`,
`WithExponentialBackoffRetry`, `WithPagination`).

**Buys:** Go has no default or named arguments. Options give you both, plus
backwards-compatible API growth — adding `WithFoo()` breaks no caller.

**Testing:** each option is a pure function over a struct. Assert the built
`Query`, no DB needed.

**Trap:** options are applied in order, so a later option silently wins. And a
`[]QueryOpt` built by `append` into a shared slice can alias — see
`project.go:307-316` where `opts` is mutated between `Count` and the page query.

**TS analogue:** an options object — but here each option is a closure, so it can
carry validation and derived state.

---

## 2. Ports and Adapters (Hexagonal), with Interface Segregation

**Where:** `internal/project/manager.go`

```go
type Storer  interface { One; Many; ManyIDs; Get; Delete; Create; UpdateFields...; Query; Count; BucketName; GetWithHistory }  // :14
type Reader  interface { Count; One; Many; Get; GetWithHistory }                                                                // :30
type Writer  interface { Create; Upsert; UpdateFields; Delete }                                                                 // :39
type Manager interface { List; ListWithMany; Delete; Create; Update; Count; Get; Count*ForProject; ... }                        // :46
```

Adapters: `reader/`, `writer/`, `store/`. Policy: `service/`.

**Buys:** Four interfaces instead of one fat one means a consumer declares the
*narrowest* capability it needs. `v2/rbac.go:36` takes `projectReader project.Storer`
for reads. A read-only consumer that takes `Reader` **cannot** write — least
privilege enforced by the type system, not by discipline.

**Testing:** `//go:generate mockgen` at `manager.go:11` produces
`internal/project/mocks/mocks.go`. Handler tests set expectations on the mock and
never touch Couchbase — which is how `project_test.go` reaches 2,018 lines.

**Trap:** interface bloat. `Storer` already has 12 methods and a `BucketName()`
that leaks the persistence detail upward. When an interface starts describing the
database rather than the need, split it.

**Where the interface lives matters:** interfaces are declared in
`internal/project` (the domain), and implemented in subpackages. Consumers depend
on the abstraction; adapters depend on it too. That is Dependency Inversion, and
it is why there are no import cycles.

---

## 3. Compile-Time Interface Assertion

**Where:** `internal/project/service/projects.go:40`, `internal/project/reader/reader.go:10`

```go
var _ project.Manager = &Service{}
var _ project.Reader  = (*reader.Reader[project.Project])(nil)
var _ couchbase.Auditor = &Permission{}      // internal/rbac/rbac.go
```

**Buys:** "does this type still satisfy that interface" becomes a build failure at
the point of definition, with a readable error, instead of a confusing one at a
distant call site.

**Cost:** one line. Put it in every implementation file. Non-negotiable.

---

## 4. Generic Repository

**Where:** `internal/project/reader/reader.go`

```go
func New(logger log.Logger, bucket string, cb couchbase.Storer) (*reader.Reader[project.Project], error) {
    return reader.NewReader(logger, cb, bucket, project.Scope, project.Collection,
                            project.Project{}, project.TypeKey, project.ErrNotFound)
}
```

`internal/couchbase/reader.Reader[T]` is written once. Every domain instantiates
it. Per-domain reader = 23 lines.

**Buys:** removes ~100 hand-written CRUD implementations. DRY at the type level.

**Trap:** the migration is incomplete. `store.Many` (`internal/project/store/store.go`)
converts `[]T` → `[]*T` with a comment citing AV-61081, because the old interface
returned pointers. Generic adoption leaves seams — expect adapters at the boundary.

---

## 5. Decorator via Function Type — the Morpher

**Where:** `internal/rbac/rbac.go:98`, `internal/rbac/morph.go`

```go
type Morpher     func(*One)                  // decorates a response envelope
type ListMorpher func(Identifier) Morpher    // FACTORY: a morpher per record

func Morph(data interface{}, m Morpher) *One {
    o := One{Data: data}
    m(&o)
    return &o
}

func MorphList(parent Identifier, data []Identifier, m ListMorpher) *One {
    if m == nil { m = func(Identifier) Morpher { return func(*One) {} } }   // nil-safe no-op
    elements := make([]*One, len(data))
    for i, id := range data { elements[i] = Morph(id, m(id)) }
    return Morph(elements, m(parent))
}
```

**Buys:** permission stamping is one composable function, applied uniformly to
single records, list rows, and the list itself. Handlers never build a permissions
object by hand, so the wire contract cannot drift per endpoint.

**Testing:** a `Morpher` is `func(*One)`. Pass a stub. No RBAC engine needed.

**Note the nil-guard.** `MorphList` substitutes a no-op rather than panicking.
That is what makes the access-denied path (`project.go:296`) able to call
`rbac.MorphList(t, nil, morpher)` and return a valid empty envelope.

**TS analogue:** a higher-order function returning a transform. `ListMorpher` is
exactly `(row) => (envelope) => void`.

---

## 6. Strategy — Authorisation as a Query Predicate

**Where:** `internal/rbac/rbac.go:55`

```go
type Resolver interface {
    Create(context.Context, ResourceType, Identifier) error
    Read(context.Context, ResourceType, Identifier) (Morpher, error)
    Update(context.Context, ResourceType, Identifier) error
    Delete(context.Context, ResourceType, Identifier) error
    List(context.Context, ResourceType, Identifier, ...ListOption) (ListMorpher, n1ql.QueryOpt, error)
    ScopedFilter(ctx context.Context, rt ResourceType, tenantId string) (n1ql.QueryOpt, error)
    ...
}
```

`List` returns a **`n1ql.QueryOpt`** — a WHERE clause. `project.go:308`:

```go
opts := append(pg.Filters, filter)
ct, err := p.projectStore.Count(ctx, opts...)
```

**Buys:** the database never returns rows the caller may not see. Two wins at once:

- Security — there is no in-memory list of forbidden records that a missed
  `continue` could leak.
- Performance — `Count` is correct without fetching, and paging is over the
  *authorised* set, so page sizes are right.

**This is the most transferable idea in the codebase.** The alternative
(fetch-then-filter-in-Go) is slower *and* one bug away from a cross-tenant leak.

Configuration is generated, not hand-written: `internal/rbac/README.md` documents
`resources.json` / `roles.json`, `//go:generate go-enum` at `rbac.go:13`, and
tests that fail if a role or resource lacks a config entry. Adding a role is four
steps, and forgetting one breaks the build.

**`ListOption` + `WithAnyChildMorpher()`** (`rbac.go:76-92`) is functional options
applied to authorisation — an escape hatch for "user has access via *some* child",
named and documented rather than special-cased in a handler.

---

## 7. Structural Decorator — Struct Embedding

**Where:** `cmd/cp-api/v2/project/project.go:85`, `cmd/cp-api/v2/pagination.go:65`

```go
type ProjectWithCount struct {
    project.Project              // embedded: promotes all fields + methods
    ClusterCount     int `json:"clusterCount"`
    SyncGatewayCount int `json:"syncGWCount"`
    ...
}

type PaginatedResponse struct {
    Cursor pagination.Cursor `json:"cursor"`
    rbac.One                    // embedded -> Data/Permissions flatten into the SAME JSON object
}
```

**Buys:** compose a response DTO without copying fields, and JSON-flatten by
default. `PaginatedResponse` marshals to `{cursor, data, permissions}` — no
wrapper type, no manual copying.

**Trap 1:** embedding promotes *methods* too, including interface satisfaction you
did not intend. `ProjectWithCount` overrides `GetID`/`GetType`/`Ownership`
deliberately (`:92-108`) so RBAC sees the DTO as a Project.

**Trap 2:** JSON tags are the contract, not the field name. `SyncGatewayCount` is
`syncGWCount` on the wire. Rename a Go field freely; change a tag and you break
the UI.

**Trap 3:** two embedded structs with the same field name = ambiguity, and the
field silently disappears from JSON. Real bug class.

---

## 8. Composition Root + Constructor Injection

**Where:** `cmd/cp-api/server/server.go` (~9,982 lines), `cmd/cp-api/server/v2.go:919`

```go
Projects: project.NewProjects(
    svr.Logger, responder, svr.rbacResolver, svr.projectStore,
    svr.projectService, svr.usersviewsManager, check,
    svr.trialManager, svr.featureManager,
),
```

No DI container. No reflection. No struct tags resolving dependencies. One
function, top to bottom, building everything in order.

**Buys:** the dependency graph is *readable*, and it is checked by the compiler. A
missing dependency is a build error at the line that caused it. Compare with a
runtime container: you find out in staging.

**Cost:** a 10k-line file. That is the honest trade, and this codebase takes it.
Do not "clean it up" without understanding what you lose.

**Startup validation** closes the gap for optional deps —
`internal/project/service/projects.go:66`:

```go
if err := validator.Validate(validator.ValidateOptions{Value: svr}); err != nil {
    return nil, fmt.Errorf("invalid project service dependencies: %w", err)
}
```

Struct-tag-driven. A nil dependency kills the process at boot, not on the first
request that touches it. Fail fast beats fail mysteriously.

The repo rule is `internal/validator.Validate()` — do **not** hand-roll
`var missing []string`. Note `internal/project/store/store.go` still has a
hand-rolled `validate()`; that is legacy, not the pattern to copy.

---

## 9. Middleware Chain (Chain of Responsibility)

**Where:** `cmd/cp-api/server/handler.go:150-232`

```go
r := mux.NewRouter()
r.Use(s.requestLogger.RequestLogger(variableRoutes, routeRedaction))  // :158 outermost
r.Use(commonmiddleware.Recovery(s.Logger, s.metricsClient))            // :159
r.Use(middleware.CrossOrigin(...)); r.Use(middleware.SetE2E(...))
r.Use(middleware.SetUserAgent(...)); r.Use(middleware.GetClientIP())

jwtRouter := r.PathPrefix("/").Subrouter()                            // :173
jwtRouter.Use(middleware.JWTAuthenticationMiddleware(s.Logger))
```

Signature: `func(http.Handler) http.Handler` — `middleware/jwtAuth.go:40`.

**Buys:** cross-cutting concerns compose without touching handlers. Order encodes
priority: logging outermost sees everything; `Recovery` next turns a panic into a
500 instead of a crashed pod.

**The big idea: one subrouter per auth scheme.** Nine of them (see doc 02). Auth
becomes a property of *where you register*, not of what you remembered to call.
A handler cannot be accidentally public. Reviewing `v2Endpoints`
(`handler.go:37`) and reading the router argument names is a complete audit of
which endpoints are internal-only.

**Trap, documented in the code** (`handler.go:151-155`): gorilla/mux does not
return 405 for subrouters with multiple routes, and gorilla/mux is unmaintained
(AV-128770). Workaround: `v2.Own()` sets `MethodNotAllowedHandler` explicitly.

**TS analogue:** Express middleware, or a Redux middleware chain.

---

## 10. Adapter over a One-Method Interface

**Where:** `cmd/cp-api/v2/endpoint.go`

```go
type Endpoint struct {
    Handler func(context.Context, http.ResponseWriter, *http.Request)
}
func (e *Endpoint) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    e.Handler(r.Context(), w, r)
}
```

**Buys:** every handler in 107 packages has the identical `ctx`-first signature.
Uniformity is what makes tracing, cancellation, and `UserData` retrieval work the
same way everywhere. `http.Handler` compatibility is preserved for free.

17 lines. Read them, then notice how much consistency they buy.

---

## 11. Context as the Request-Scoped Carrier

**Where:** everywhere. `middleware/jwtAuth.go:57`, `internal/project/service/projects.go:580`

```go
ctx, err := sessionService.AuthenticateJWT(ctx, tenantID, bearerToken, expiry)
next.ServeHTTP(w, r.WithContext(ctx))
...
ud := internalcontext.UserDataFromContext(ctx)     // identity, in the service layer
```

`ctx` carries: identity (`UserData`), request id, tracing span, tenant id, and
cancellation/deadline.

**Buys:** the service layer knows *who* is acting without an HTTP dependency and
without threading a user parameter through ten signatures.

**Traps:**
- Never store optional business parameters in `ctx`. Identity and deadlines, yes;
  "the sort order", no.
- `UserDataFromContext` can return `nil` — `projects.go:626` checks
  `if ud != nil`, but `:587` already dereferenced `ud.Name`. That ordering is a
  latent nil-panic if the middleware is ever bypassed. Good review exercise.
- `ctx.Err()` must be handled, which is exactly what `Goofify` does
  (`v2/responder.go`): `DeadlineExceeded` → 504, `Canceled` → 499.

---

## 12. Errorgroup Fan-Out

**Where:** `cmd/cp-api/v2/project/project.go:125` and `:170`

```go
g, gctx := errgroup.WithContext(ctx)
g.Go(func() error { var err error; counts.clusters,     err = p.projectManager.CountClustersForProject(gctx, projectID);     return err })
g.Go(func() error { var err error; counts.columnar,     err = ...; return err })
g.Go(func() error { var err error; counts.syncGateways, err = ...; return err })
g.Go(func() error { var err error; counts.users,        err = ...; return err })
if err := g.Wait(); err != nil { return projectCounts{}, err }
```

Uses the repo's own `internal/errgroup`.

**Buys:** latency = max(4 calls), not sum. First error cancels the siblings
through `gctx`, so a failed query does not leave three more running.

**Trap — say this out loud in review:** the four goroutines write four *different*
fields of one struct. That is race-free only because the fields are disjoint. Add
a fifth goroutine touching an existing field and you have a data race that
`-race` may not catch under low load. This is the pattern most likely to be
copied incorrectly.

**Sibling pattern — batch instead of loop.** The tenant-wide version
(`countResourcesPerProjectForTenant`, `:170`) runs 4 queries that each return
`map[projectID]int`, rather than 4 queries per project. N+1 eliminated by shape,
not by caching.

---

## 13. Code Generation for Contracts

Four generators. All driven by `//go:generate`, all producing files you must not
hand-edit (`*.generated.go`, `generated/`, `mocks/`, `v4.gen.go` are excluded from
lint and review).

### goof — errors declared as data

`internal/goof/goof.go:1` → `internal/goof/generate/generate.go` →
`internal/goof/errors.generated.go`, from `internal/**/*_errors.json`.

```json
"DeleteProjectsWithDatabases": {
  "code": 400,
  "one": "Unable to delete a Project with Cluster resources...",
  "doc": "Returned when trying to delete a Project that still has attached Clusters"
}
```
```go
func ActivationNotFound() Error { return newError(2, 404, "Unable to obtain...", "ActivationNotFound") }
```

The `Error` struct (`goof.go`) carries `Code` (HTTP status), `Message` (user-facing),
`Name` (stable machine key), `RetryAfter *int`, and field-level `Validation`.

**Buys:** every user-facing string is reviewable in one diff by a technical
writer. Status code lives with the message, so no handler picks 400-vs-422 by
feel. `Name` gives the UI a stable key to branch on and translators something to
key off. `responder.Error` sets the `Retry-After` header from `RetryAfter`
automatically. The JSON file sits next to the domain that owns it, but the
generated Go is global — one import, no cycles.

**Cost:** adding an error = edit JSON + regenerate. That friction is the feature.

### mockgen (`go.uber.org/mock`)

`//go:generate mockgen -destination mocks/mocks.go ... Manager,Reader,Storer,Writer`
(`internal/project/manager.go:11`). `golang/mock` is banned; use `go.uber.org/mock`.

### go-enum

`internal/rbac/rbac.go:13` generates `resource_type_enum.go`, `roles_enum.go`
from the enum declarations. Tests enforce that every role/resource has a config
entry (`internal/rbac/README.md`).

### oapi-codegen

`openapi.yaml` → `v4.gen.go` for `cp-open-api`. The spec is the source of truth
for the public API. (Slice 4 will cover this.)

---

## 14. Error Funnel with `errors.As` / `errors.Is`

**Where:** `cmd/cp-api/v2/responder.go` (`Goofify`), `cmd/cp-api/v2/decoder.go`

```go
switch {
case errors.As(err, &g):                                 // already a goof -> pass through
case ctxErr != nil:
    switch {
    case errors.Is(ctxErr, context.DeadlineExceeded): g = goof.GatewayTimeout()      // 504
    case errors.Is(ctxErr, context.Canceled):         g = goof.ClientClosedRequest() // 499
    default:                                          g = goof.InternalServerError()
    }
case errors.Is(err, couchbase.ErrUnambiguousTimeout): g = goof.GatewayTimeout()
case errors.Is(err, couchbase.ErrAmbiguousTimeout):   g = goof.GatewayTimeout()
default:
    msg = "unhandled error prevented from leaking to user"
    g = goof.InternalServerError()
}
```

And in the decoder, `errors.As` extracts *typed* JSON errors to build a
field-level message:

```go
case errors.As(err, &syntaxError):        return goof.JSONSyntaxError(offset, syntaxError.Error())
case errors.As(err, &unmarshalTypeError): return goof.JSONUnmarshalTypeError(t.Name(), field, value)
```

**Buys:** one place decides what the user sees. The real error is always logged
(`r.logger.ErrorWithContext`), the curated one is always returned. Internal detail
cannot leak by a handler forgetting to wrap.

**Rules (root `AGENTS.md`):** stdlib `errors`; wrap with
`fmt.Errorf("...: %w", err)`; compare with `errors.Is`/`errors.As`; never
`github.com/pkg/errors`. `%w` is what makes `errors.Is` work across layers —
`fmt.Errorf("...: %v", err)` breaks the chain silently.

**Sentinel + goof, two layers:** `project.ErrNotFound` is the *internal* sentinel
that layers switch on; `goof.ProjectsNotFound()` is the *external* HTTP answer.
Do not confuse them, and do not return a sentinel to a client.

---

## 15. Distributed Lock Guarding Check-Then-Act

**Where:** `internal/project/service/projects.go:597`

```go
ctx, unlock, err := s.locker.Lock(ctx, p.TenantID)
switch {
case err == nil:
case errors.Is(err, lock.ErrLockTimeout): return nil, fmt.Errorf("timed out waiting for lock: %w", err)
default:                                  return nil, fmt.Errorf("failed to acquire lock: %w", err)
}
defer unlock()

val, err := s.quotasManager.Residual(ctx, p.TenantID, quotas.KeyProjectCount)
if val <= 0 { return nil, goof.ProjectCountQuotaReached() }
if err := s.projectStorer.Create(ctx, &pr); err != nil { ... }
```

`internal/couchbase/lock` — the lock lives in Couchbase, so it works across
`cp-api` replicas.

**Buys:** quota check and write are atomic cluster-wide. Without the lock, two
concurrent creates both read "1 remaining" and both succeed. Classic TOCTOU.

**Three details worth teaching:**
1. **Lock granularity is the tenant**, not global. Tenants do not block each
   other. Choosing the key *is* the design.
2. **`defer unlock()` immediately after acquire.** Every early return is covered.
3. **`ErrLockTimeout` is handled distinctly** from other failures — a timeout is
   contention (retryable), anything else is broken (not).

**Optimistic concurrency, the other half:** `UpdateFieldsWithEtag(ctx, id, etag, ...)`
(`internal/project/manager.go:21`) plus `ErrEtagVersionConflict` (412) in
`project_errors.json`. Locks for check-then-act, ETags for lost-update. Know
which problem you have.

---

## 16. Fire-and-Forget Events

**Where:** `internal/project/service/projects.go:621`

```go
ctx = pr.Context(ctx)
if err := s.eventClient.EmitProjectCreated(ctx); err != nil {
    l.Warn("failed to emit project created event", zap.Error(err))
}
```

No return. Log and continue.

**Buys:** notification is decoupled from the transaction. A downstream outage
cannot fail a customer's project creation.

**Cost, stated plainly:** at-most-once delivery. The event can be lost. That is a
*product* decision encoded in one `l.Warn`. If the event mattered for billing or
correctness it would need an outbox. Know which of your events are which.

Same shape in `responder.go`'s `updateJWTDocIfRequired`: *"If we fail to update
the JWT document, only log, do not block the response."*

---

## 17. Facade over Server State (frontend, but the same idea)

**Where:** `cmd/cp-ui-v3/src/hooks/api/use-project-list/use-project-list.ts:33`

```ts
return { search, projectList, query, entireListReady, invalidate };
```

**Buys:** the component gets a domain API, not a TanStack Query object. The cache
key, `cacheTime`, `enabled` guard, and `invalidateQueries` call all live in one
place, so they cannot drift across ten call sites.

**Testing:** `use-project-list.test.tsx` renders a probe component that just calls
the hook, spies on `projectService.listProjects`, and asserts the arguments —
including the defaults (`{page: DEFAULT_PAGE, perPage: DEFAULT_PER_PAGE}`).
Pure logic (`getEntireProjectList`, `getSearchKeySelectors`) is extracted into
`.utils.ts` and tested with no React at all.

That extraction rule — *pure logic leaves the hook* — is the frontend equivalent
of "business rules live in the service layer".

**Type-level mutual exclusion**, worth teaching on its own:

```ts
} & ( { page?: number; perPage?: PerPageValue } | { entire: true } )
```

Paged and fetch-everything cannot both be passed. The compiler enforces the
product rule.

---

## 18. Layered Client with a Single Transport Seam (frontend)

**Where:** `cmd/cp-ui-v3/src/sync/request.ts`

```
pages/components -> hooks/api -> sync/<domain>-service -> sync/request.ts -> axios
```

`request.ts:26` is the only `axios.create()`. `:31` `handleError` normalises every
failure to a `CapellaError` and dispatches through a status-keyed handler map.
`:49` `request<T>` unwraps `response.data` so callers never see axios types.

**Buys:** one place for base URL, auth header (`:128 setAuthToken`), redirect
policy, and error normalisation. Proof that the abstraction is real: the *same
file* already contains a `fetch`-based implementation (`requestWithFetch`) used by
`postRequestDontProcessResults` for streaming responses. Two transports, one
interface, zero changes above.

**The rule for the team:** components never import `sync/`. The hook is the seam.

---

## 19. Route Loader as Guard + Prefetch (frontend)

**Where:** `cmd/cp-ui-v3/src/routing/root-authorised-loader.ts`,
`cmd/cp-ui-v3/src/routing/definitions/project.tsx`

```ts
await queryClient.ensureQueryData(
  ReactQueryKeys.PROJECT(organizationId, projectId),
  () => getProject({ projectId, organizationId })
);
```

React Router loaders run **before** render, and write into the same TanStack
Query cache the component's hook reads.

**Buys:** render-as-you-fetch. No spinner cascade, no double request, and the
authorisation decision happens before any component mounts.

**The error taxonomy is the lesson.** Four different outcomes:

| Condition | Outcome |
|---|---|
| no JWT / 401 | `removeJWT()` + `setAuthToken(null)` + redirect `/signed-out` |
| offline | `throw new OfflineError()` |
| genuine 404 | `throw new Response(resourceType, {status: 404})` → route `errorElement` |
| anything else | rethrow → retryable `PageErrorFallback` |

The comment cites CCF-552: a stale `lastAccessedTenant` used to produce a false
404. Fix was to *validate* each candidate org before using it. Classification of
failure modes is design work, not cleanup.

---

## 20. Ownership as Telemetry

**Where:** `cmd/cp-api/v2/own.go`, `internal/middleware/owners/owners.go`

```go
func Own(r *mux.Router, owner owners.JobOwner) *mux.Router {
    s := r.PathPrefix("/").Subrouter()
    s.Use(middleware.Ownership(owner))
    s.MethodNotAllowedHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
        w.WriteHeader(http.StatusMethodNotAllowed)
    })
    return s
}
```

`owners.JobOwner` constants are the GitHub team names
(`couchbase-capella-auth`, `couchbase-capella-billing`, ...). Every handler
registered under `Own(r, owners.Auth)` tags its span with the owning team.

**Buys:** a slow or erroring endpoint in Datadog is immediately attributable to a
team with no lookup table. Ownership stops being a wiki page and becomes a
dimension you can group by.

**Steal this.** It costs one line per `Register()` and it changes how on-call works.

---

## Anti-patterns the codebase explicitly bans

From root `AGENTS.md` — memorise, because CI enforces them:

| Do not | Use instead | Why |
|---|---|---|
| `github.com/pkg/errors` | stdlib `errors` + `%w` | stdlib wrapping is the standard; two systems break `errors.Is` |
| `golang/mock` | `go.uber.org/mock` | upstream is unmaintained |
| `gofrs/uuid` | `google/uuid` | one uuid library |
| `mitchellh/mapstructure` | `go-viper/mapstructure` | maintained fork |
| `x/exp/maps`, `x/exp/slices` | builtin `maps`, `slices` | now in stdlib |
| `k8s.io/utils/ptr` | `tools-common/types/ptr` | no k8s dep for a pointer helper |
| `gotest.tools/assert` | `testify/assert` | one assertion library |
| `io/ioutil` | `io` / `os` | deprecated since Go 1.16 |
| `internal/store` | `internal/couchbase` | deprecated data layer |
| any logger but `internal/log` | `internal/log` | structured fields + Datadog correlation |
| hand-rolled `var missing []string` | `internal/validator.Validate()` | consistent validation errors |
| hand-formatting | `make lint` (gofmt/gofumpt/goimports) | don't hand-police style |

---

## Review checklist distilled from this slice

Handler:
- [ ] Path vars validated (`keynames.ValidateIDKeyNames`)
- [ ] Ownership checked before authorisation (`check.Project` then `rbacResolver.Update`)
- [ ] Authorised via `rbacResolver`, and for `List` the returned filter is passed to the store
- [ ] Body decoded with `v2.Decode` (never raw `json.Decoder` on `r.Body`)
- [ ] Server-side fields overridden from the URL, never trusted from the body
- [ ] All errors go through `responder.Error`; response through `responder.Respond`
- [ ] Response wrapped with `rbac.Morph` / `MorphList` — never a hand-built envelope
- [ ] Status codes tested: 200/201/204/400/403/404/422/500 + RBAC denial

Service:
- [ ] `var _ Iface = &Impl{}` present
- [ ] Constructor ends with `validator.Validate`
- [ ] Check-then-act guarded by a lock, or made safe with an ETag
- [ ] Best-effort side effects logged, not returned
- [ ] Errors wrapped with `%w`

Store:
- [ ] Named params (`$tenantId`), never string interpolation into N1QL
- [ ] `couchbase.ErrNotFound` translated to the domain sentinel
- [ ] Results streamed (`for qr.Next()`), not accumulated blindly

Frontend:
- [ ] Component → hook → service → `request.ts`; no layer skipped
- [ ] Query key contains every input that changes the result
- [ ] `enabled` guard on any id that can be empty
- [ ] Pure logic extracted to `.utils.ts` with its own test
- [ ] `permissions` from the response drives what renders — never a client-side guess
- [ ] `data-auto-id` on every interactive element
- [ ] No `any`, no `as`, no new Redux slice for server data
