# 02 — Slice 1: React page → `cp-api` → Couchbase

The concrete question: **a user opens the Projects list. What happens?**

Endpoint traced: `GET /v2/organizations/{tenantId}/projects`
Also covered: `POST` (create), because the write path shows the interesting parts.

Every step has a file anchor. Open them side by side.

---

## The 14 steps, in order

```
 1  browser hits CloudFront  ->  S3 static bundle          (see doc 04)
 2  main.tsx mounts provider stack + React Router
 3  rootAuthorisedLoader gates the route (JWT + org resolution)
 4  route definition prefetches via queryClient.ensureQueryData
 5  page component calls useProjectList(...)
 6  hook calls sync/project-service.listProjects(...)
 7  sync/request.ts axios instance issues GET, Authorization: Bearer <jwt>
--- network ---
 8  nginx Ingress terminates TLS, forwards to cp-api Service :443
 9  gorilla/mux global middleware chain (logging, recovery, CORS, client IP)
10  jwtRouter middleware authenticates the JWT -> UserData in ctx
11  Projects.List() endpoint: validate path vars, parse pagination
12  rbacResolver.List() -> (ListMorpher, N1QL filter)
13  projectStore.Count + projectManager.ListWithUserInformation (N1QL)
    + countResourcesPerProjectForTenant (4 concurrent counts via errgroup)
14  rbac.MorphList stamps permissions -> pagination wraps -> responder writes JSON
--- back ---
    TanStack Query caches by key; hook returns projectList; component renders
```

---

## Frontend half

### Step 2 — Provider stack

`cmd/cp-ui-v3/src/main.tsx`

```
React.StrictMode
  ReduxProvider store={store}                    // client state
    PersistQueryClientProvider client={queryClient}   // server state + persistence
      AuthProvider                               // login/challenge/user context
        ChatProvider
          PreviewBanner
          RouterProvider router={router}
```

`const router = createBrowserRouter(routes, { basename: process.env.V3_ONLY ? '/' : '/v3' })`
— the `/v3` basename is the Module Federation coexistence with `cp-ui-v2`.

Note two performance decisions worth showing the team:
- Coralogix is imported dynamically only when `shouldLoadCoralogix()` — keeps the
  vendor out of the prod bundle.
- The 1.1 MB sprite sheet is deferred behind `requestIdleCallback`. The code
  comment honestly records the downside (no timeout, silent failure). Read the
  comment; that is the standard being set for review quality.

### Step 3 — The auth gate

`cmd/cp-ui-v3/src/routing/root-authorised-loader.ts`

React Router **loaders** run before the component renders. This one is the
security and context boundary:

1. `isJwtHere()` — else `resetAuthAndRedirect()` → `/signed-out`
2. `setAuthToken('Bearer ' + getJWT())` — pushes the token into the axios default
   header (`sync/request.ts:128`)
3. Resolve which organization the user is in, in priority order:
   `?oid` query param → `user.lastAccessedTenant` → first org in the list
4. Each candidate is **validated** with `getOrganization(...)` before use.
   The comment cites ticket CCF-552: a stale `lastAccessedTenant` used to send
   users to a false 404.
5. 401 → reset auth. 404 → `throw new Response(..., {status: 404})`, caught by
   the route `errorElement`. Anything else → rethrow so the user gets a
   *retryable* error, not a dead end.

Teaching point: error classification is a design decision, not an afterthought.
Offline, 401, 404, and unknown each get a different outcome.

Auth token storage: `cmd/cp-ui-v3/src/sync/jwt-service/jwt-service.ts`, key
`capella:auth_t`. It reads `localStorage` first, falls back to `sessionStorage`,
and every read/write is wrapped in `try/catch` because private-mode browsers
throw. Ticket AV-137788 is the reason.

### Step 4 — Route definition prefetch

`cmd/cp-ui-v3/src/routing/definitions/project.tsx`

```ts
loader: async ({ request }) => {
  ...
  await queryClient.ensureQueryData(
    ReactQueryKeys.PROJECT(organizationId, projectId),
    () => getProject({ projectId, organizationId })
  );
}
```

`ensureQueryData` warms the **same cache** the component's hook will read.
So the route loader and the component share one cache entry — no double fetch,
no loading flash. This is the render-as-you-fetch pattern.

### Steps 5–6 — Hook layer

`cmd/cp-ui-v3/src/hooks/api/use-project-list/use-project-list.ts:33`

```ts
const projectQueryKey = ReactQueryKeys.PROJECT_LIST({
  organizationId, page, perPage, entire, sortBy, sortDirection,
});

const query = useQuery(projectQueryKey, async () => {
  if (entire) return getEntireProjectList({ organizationId, startPage: page, perPage });
  return listProjects({ organizationId }, { page, perPage, sortBy, sortDirection });
}, { cacheTime: PROJECT_LIST_CACHE_TIME, refetchInterval, enabled: !!organizationId && enabled, onSuccess });
```

Four things to point out:

1. **The cache key contains every input.** Change page → different key → separate
   cache entry. Get this wrong and you serve page 1 data on page 2.
2. `enabled: !!organizationId` — the guard that stops a request firing with an
   empty tenant id.
3. The hook returns a **facade**, not the raw query:
   `{ search, projectList, query, entireListReady, invalidate }`. Components get
   a domain-shaped API. `invalidate()` wraps
   `queryClient.invalidateQueries({ queryKey: projectQueryKey })`.
4. `search()` is client-side fuzzy search (`fast-fuzzy`) over the already-fetched
   list, with exact-ID match short-circuiting and dedup by id. Cheap, and it
   works offline against cached data.

The union prop type is a nice TS trick worth teaching:

```ts
} & ( { page?: number; perPage?: PerPageValue } | { entire: true } )
```

Paged and "fetch everything" are mutually exclusive at the type level.

`use-project-list.utils.ts` holds `getEntireProjectList` — recursive page walk
that merges every page's `data` into the **first page's** RBAC envelope. Pulled
out of the hook so it is unit-testable with no React.

### Step 7 — Transport layer

`cmd/cp-ui-v3/src/sync/project-service/project-service.ts:34`

```ts
export function listProjects({ organizationId }: OrganizationContext,
                             params: QueryOptions = defaultPaginationQuery) {
  return getRequest<ProjectListResponse>(`/v2/organizations/${organizationId}/projects`, { params });
}
```

Pure function. No React. Typed response. One function per endpoint. Roughly 70
`*-service` directories, one per backend domain.

Note the argument shape: a **context object** (`OrganizationContext`,
`ProjectContext`, `ProjectUserContext` — from `sync/request.types`) plus an
optional payload. Consistent across the whole layer, so a new endpoint is
copy-paste-shaped.

`cmd/cp-ui-v3/src/sync/request.ts`

- `:26` one shared axios instance, `baseURL` from `getBaseUrl()`, `maxRedirects: 0`
- `:31` `handleError` normalises every axios error into a `CapellaError` via
  `parseNetworkCapellaError`, then dispatches to a status-keyed handler map
  (`500` → Datadog log in prod/preview), then **rethrows**
- `:49` `request<T>` unwraps `response.data` so callers never see axios types
- `:128` `setAuthToken` sets `httpClient.defaults.headers.common.Authorization`
- `:133+` thin `getRequest` / `postRequest` / `putRequest` / `patchRequest` /
  `deleteRequest` exports

Everything above this file is axios-agnostic. Swap axios out and only this file
changes. There is already a parallel `fetch` implementation in the same file
(`requestWithFetch`, used by `postRequestDontProcessResults` for streaming) —
proof the abstraction earns its keep.

### The response contract — the single most important thing for a UI dev

`cmd/cp-ui-v3/src/sync/project-service/project-service.types.ts:164`

```ts
export type ProjectResponse     = RbacResponse<Project>;
export type ProjectListResponse = RbacListResponse<ProjectResponse>;
```

`RbacResponse` / `RbacListResponse` live in the shared design-system package
(`@couchbasecloud/ui-platform/dist/sync/response.types`, aliased at
`cmd/cp-ui-v3/tsconfig.json:424`):

```ts
type RbacResponse<T> = {
  data: T;
  permissions: PermissionRecord;
  resources?: { [key: string]: PermissionRecord };
};

type RbacListResponse<T> = {
  cursor: { pages: PaginationResponse; href?: {} };
  data: T[];
  permissions: PermissionRecord;
  resources?: { [key: string]: PermissionRecord };
};
```

**Every payload is an envelope: `data` + `permissions`.** The list is
`data: T[]` where each `T` is itself an envelope — so each row carries its own
permissions.

That is why `useProjectList` does `query.data?.data.filter(r => r.data)` —
double `.data` is not a bug, it is envelope-then-row.

Consequence for the UI: **never guess whether to show a button.** Read
`permissions` off the record. The backend already computed it.

---

## Backend half

### Step 8–9 — Bootstrap and middleware

`cmd/cp-api/main.go` — deliberately tiny. `server.New()` then
`svr.ListenAndServe()`, with `defer svr.Deferrals()`. The comment records why
(AV-4578): the server lives in a package so E2E tests can run `cp-api`
in-process and get real error visibility.

`cmd/cp-api/server/handler.go:150` `newHTTPHandler` builds the router:

```go
r := mux.NewRouter()
r.Use(s.requestLogger.RequestLogger(variableRoutes, routeRedaction))  // :158
r.Use(commonmiddleware.Recovery(s.Logger, s.metricsClient))            // :159
if TLS && env == Development { r.Use(commonmiddleware.HSTS()) }        // :161
r.Use(middleware.CrossOrigin(s.cfg.EnableCORSBypass))                  // :163
r.Use(middleware.SetE2E(s.Logger))                                     // :164
r.Use(middleware.SetUserAgent(s.Logger))                               // :165
r.Use(middleware.GetClientIP())                                        // :166
```

Order matters. Logging is outermost so it sees everything. `Recovery` is next so
a panic becomes a 500 instead of killing the process.

Then **one subrouter per authentication scheme** — this is the whole auth
topology in 60 lines:

| Subrouter | Middleware | Serves | Line |
|---|---|---|---|
| `jwtRouter` | `JWTAuthenticationMiddleware` | almost everything | `:173` |
| `basicAuthRouter` | `BasicAuth` | `POST /sessions` (login) | `:181` |
| `zendeskBasicAuthRouter` | `BasicAuthZendeskWebhook` | Zendesk webhook | `:188` |
| `r` (bare) | none | status, email verify, forgot/reset password, MFA lost-device | `:192-208` |
| `signedRequestRouter` | `s.blocklist.Middleware()` | signed requests | `:210` |
| `internalSupportRouter` | `TokenAuth` + `WithUserData` | `/internal/support/**` | `:212` |
| `billingRouter` | `WorkatoLogicAuth` | activation endpoints | `:218` |
| `stripeRouter` | `StripeAuth` | Stripe webhooks | `:228` |
| `customer360router` | `TokenAuth` | customer360 | `:232` |

Architecture advantage: **auth is a property of the router, not the handler.** A
handler cannot accidentally be unauthenticated — it is only reachable if it was
registered on a router. Adding an endpoint to the wrong subrouter is a visible,
reviewable, one-line diff.

Note the honest bug comment at `:151-155`: gorilla/mux does not return 405 for
subrouters with multiple routes, gorilla/mux is unmaintained, ticket AV-128770
tracks it. Hence `Own()` explicitly sets `MethodNotAllowedHandler`
(`cmd/cp-api/v2/own.go`).

### Step 10 — JWT authentication

`cmd/cp-api/middleware/jwtAuth.go:40`

```go
ah := r.Header.Get("Authorization")
validateAuthHeader(ah)
bearerToken := ah[len("Bearer "):]
ctx, err := sessionService.AuthenticateJWT(ctx, getTenantIDFromRequest(r), bearerToken, defaultJWTExpirySeconds)
next.ServeHTTP(w, r.WithContext(ctx))
```

The authenticated identity travels in `context.Context`, retrieved later via
`internalcontext.UserDataFromContext(ctx)`. Sessions are server-side documents,
so a JWT can be revoked — it is not a bearer-only design.

`getTenantIDFromRequest` pulls `tenantId` out of `mux.Vars(r)` for `/v2/` paths.
This is why the tenant is in the URL: it is needed at authentication time, before
any handler runs.

Also worth showing: `tracer.StartSpan(ctx, "middleware.AuthenticateJWT")` +
`defer finish()`. Tracing is threaded through `ctx` everywhere.

### Step 11 — Dependency injection and registration

`cmd/cp-api/server/v2.go:919` — the composition root for our slice:

```go
Projects: project.NewProjects(
    svr.Logger, responder, svr.rbacResolver, svr.projectStore,
    svr.projectService, svr.usersviewsManager, check,
    svr.trialManager, svr.featureManager,
),
```

Nine explicit constructor arguments. No DI framework, no reflection, no magic.
Compile-time wiring: if a dependency is missing, the build breaks.

`cmd/cp-api/server/handler.go:37` `v2Endpoints(...)` then calls `.Register(...)`
on ~140 services, each handed the router(s) it is allowed to mount on:

```go
svc.Projects.Register(router)              // JWT router
svc.InternalClusters.Register(internal)    // internal-support router
svc.Stripe.Register(stripe)                // stripe router
svc.Billing.Register(workato, internal, router)
```

Read the argument names in that function and you can tell, at a glance, which
endpoints are internal-only. That is the security review surface.

`cmd/cp-api/v2/project/project.go:70`

```go
func (p *Projects) Register(r *mux.Router) {
    r = v2.Own(r, owners.Auth)                                        // team ownership tag
    r.Handle(ProjectUsersUrl,             p.Users()).Methods(http.MethodGet)
    r.Handle(ProjectAvailableInviteesUrl, p.AvailableInvitees()).Methods(http.MethodGet)
    r.Handle(ProjectUserByIDUrl,          p.UserByID()).Methods(http.MethodGet)
    r.Handle(v2.ProjectRootUrl,           p.List()).Methods(http.MethodGet)
    r.Handle(v2.ProjectResourceUrl,       p.Get()).Methods(http.MethodGet)
    r.Handle(v2.ProjectResourceUrl,       p.Delete()).Methods(http.MethodDelete)
    r.Handle(v2.ProjectRootUrl,           p.Create()).Methods(http.MethodPost)
    r.Handle(v2.ProjectResourceUrl,       p.Update()).Methods(http.MethodPut)
}
```

URLs compose from constants (`cmd/cp-api/v2/utilities.go`):

```go
TenantResourceURL  = TenantRootURL + "/{tenantId:[0-9A-Za-z-]+}"       // :31
ProjectRootUrl     = TenantResourceURL + "/projects"                    // :33
ProjectResourceUrl = ProjectRootUrl + "/{projectId:[0-9A-Za-z-]+}"      // :35
DatabaseURL        = ProjectResourceUrl + "/databases/{databaseId:...}" // :39
```

The regex in the path variable is a first validation gate — a malformed id is a
404 from the router, never reaching your code.

`v2.Own(r, owners.Auth)` (`cmd/cp-api/v2/own.go`) creates a subrouter that tags
every span with the owning GitHub team (`internal/middleware/owners/owners.go`).
So a slow trace in Datadog is immediately attributable to a team. Ownership as
telemetry — steal this idea.

### The `Endpoint` type — 17 lines, read them

`cmd/cp-api/v2/endpoint.go`

```go
type Endpoint struct {
    Handler func(context.Context, http.ResponseWriter, *http.Request)
}

func (e *Endpoint) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    e.Handler(ctx, w, r)
}
```

A one-field struct that implements `http.Handler` and hands the handler the
`ctx` explicitly. Small, but it is why every handler in the codebase has the
identical signature — and `ctx` first is what makes cancellation, tracing, and
`UserData` uniform.

### Step 11–14 — The List handler, annotated

`cmd/cp-api/v2/project/project.go:271`

```go
func (p *Projects) List() *v2.Endpoint {
  return &v2.Endpoint{Handler: func(ctx context.Context, w http.ResponseWriter, r *http.Request) {

    // 1. Validate path variables
    vars := mux.Vars(r)
    m, err := keynames.ValidateIDKeyNames(vars, keynames.TenantIDKey)
    if err != nil { p.responder.Error(ctx, w, err); return }
    t := &tenant.Tenant{ID: m[keynames.TenantIDKey]}

    // 2. Parse pagination from query string
    pg, err := v2.NewPagination(r)
    if err != nil { p.responder.Error(ctx, w, err); return }

    // 3. Authorise. Returns BOTH a response morpher AND a N1QL filter.
    morpher, filter, err := p.rbacResolver.List(ctx, rbac.ResourceTypeProject, t)
    switch {
    case err == nil:
    case errors.Is(err, goof.RBACAccessDenied()):
        // "no access" is an EMPTY 200, not a 403.
        p.responder.Respond(ctx, w, http.StatusOK,
            pg.PaginatedResponse(*rbac.MorphList(t, nil, morpher), 0))
        return
    default: p.responder.Error(ctx, w, err); return
    }

    if len(pg.SortBy) == 0 { pg.SortBy = []string{defaultSortBy} }   // "name"

    // 4. Query: filter first (count), then filter + limit/offset/sort (page)
    opts := append(pg.Filters, filter)
    ct, err := p.projectStore.Count(ctx, opts...)
    opts = append(opts, pg.QueryOpts()...)
    projects, err := p.projectManager.ListWithUserInformation(ctx, opts...)
    // project.ErrNotFound -> empty 200, same as above

    // 5. Enrich: 4 concurrent aggregate counts
    counts, err := p.countResourcesPerProjectForTenant(ctx, t.ID)

    // 6. Assemble rbac.Identifier values
    results := make([]rbac.Identifier, len(projects))
    for i := range projects {
        results[i] = NewProjectWithCount(projects[i],
            counts.clusters[projects[i].ID], counts.columnar[projects[i].ID],
            counts.syncGateways[projects[i].ID], counts.users[projects[i].ID])
    }

    // 7. Stamp permissions, wrap in cursor, write
    one := rbac.MorphList(t, results, morpher)
    p.manyProjectMorphers(ctx, m[keynames.TenantIDKey], one, projects)
    p.responder.Respond(ctx, w, http.StatusOK, pg.PaginatedResponse(*one, ct))
  }}
}
```

Six behaviours to call out:

**a) `Count` runs before `limit`/`offset` are appended.** `opts` is mutated in
place: `Count` sees the RBAC filter only; the page query sees filter + paging.
Order-dependent slice mutation. It works, and it is exactly the kind of line a
reviewer must slow down for.

**b) Access denied → empty 200, not 403.** Deliberate: it prevents the API
leaking "this tenant exists but you can't see it". Enumeration defence.

**c) The RBAC filter is pushed into the database.** `rbacResolver.List` returns a
`n1ql.QueryOpt` — a WHERE clause. The DB never returns rows the user cannot see.
Compare with filtering in Go after fetching: that version is both slower and one
missed `continue` away from a data leak. **Authorisation as a query predicate**
is the single most transferable idea in this file.

**d) N+1 avoided by design.** Naively, per-project counts = 4 queries × N
projects. Instead `countResourcesPerProjectForTenant` runs **4 total** queries,
each returning `map[projectID]int`, in parallel. `project.go:125` is the
per-project variant used by `Get`.

`cmd/cp-api/v2/project/project.go:125` and the tenant-wide version:

```go
g, gctx := errgroup.WithContext(ctx)
g.Go(func() error { var err error; counts.clusters, err = ...; return err })
g.Go(func() error { ... columnar ... })
g.Go(func() error { ... syncGateways ... })
g.Go(func() error { ... users ... })
if err := g.Wait(); err != nil { return tenantProjectCounts{}, err }
```

`errgroup` (the repo's own `internal/errgroup`) gives fan-out plus
first-error-cancels-the-rest via `gctx`. Latency is max(4), not sum(4).

Subtlety: each goroutine writes a **different field** of the same struct. That is
data-race-free only because the fields are disjoint. Say this out loud in review;
it is a pattern that gets copied wrongly.

**e) `ProjectWithCount` is a response DTO, not the entity.**
`cmd/cp-api/v2/project/project.go:85`

```go
type ProjectWithCount struct {
    project.Project
    ClusterCount     int `json:"clusterCount"`
    ColumnarCount    int `json:"columnarCount"`
    SyncGatewayCount int `json:"syncGWCount"`
    Users            int `json:"userCount"`
}
func (p *ProjectWithCount) GetID() string   { return p.Project.ID }
func (p *ProjectWithCount) GetType() string { return keynames.ProjectKey }
func (p *ProjectWithCount) Ownership() map[string]string {
    return map[string]string{keynames.TenantIDKey: p.Project.TenantID}
}
```

Struct embedding + three methods = it satisfies `rbac.Identifier`. The stored
entity stays clean; the API adds UI-shaped fields. Note `syncGWCount` — the JSON
tag does not match the Go field name. The wire contract is set by the tag, always.

**f) `permissions` on the response comes from the `Morpher`.** `Get` at `:236`:

```go
morpher, err := p.rbacResolver.Read(ctx, rbac.ResourceTypeProject, prWithCount)
p.responder.Respond(ctx, w, http.StatusOK, rbac.Morph(prWithCount, morpher))
```

`internal/rbac/morph.go`:

```go
func Morph(data interface{}, m Morpher) *One {
    o := One{Data: data}
    m(&o)                 // the morpher fills in Permissions / Resources
    return &o
}

func MorphList(parent Identifier, data []Identifier, m ListMorpher) *One {
    if m == nil { m = func(Identifier) Morpher { return func(*One) {} } }  // nil-safe
    elements := make([]*One, len(data))
    for i, id := range data { elements[i] = Morph(id, m(id)) }
    return Morph(elements, m(parent))
}
```

`internal/rbac/rbac.go:229`:

```go
type One struct {
    Data        interface{}     `json:"data"`
    Resources   AccessSummaries `json:"resources,omitempty"`
    Permissions AccessSummary   `json:"permissions"`
}
```

**`rbac.One` in Go === `RbacResponse<T>` in TypeScript.** That is the contract.
`MorphList` produces `One{ Data: []*One }` — envelope of envelopes, matching
`RbacListResponse<RbacResponse<Project>>`.

`Morpher` is `func(*One)` — a decorator applied per record. `ListMorpher` is
`func(Identifier) Morpher` — a morpher factory, so each row can get different
permissions.

### Pagination

`cmd/cp-api/v2/pagination.go`

```go
type PaginatedResponse struct {          // :65
    Cursor pagination.Cursor `json:"cursor"`
    rbac.One                              // embedded -> flattens into the same JSON object
}
```

So the wire shape is `{ cursor, data, permissions, resources? }` — exactly
`RbacListResponse<T>`.

- `:81` `NewPagination(r)` parses `page`, `perPage`, `sortBy`, `sortDirection`
- `:97` **`perPage > 1000` → `goof.PaginationLimitExceeded()`**. The comment names
  the reason: unbounded `perPage` is an amplification DoS and a memory risk.
- `:102-106` `sortBy` values are rejected if they contain characters (backticks)
  that could break out of the escaped N1QL identifier. **This is N1QL injection
  defence in the pagination parser** — show this to the team, it is the clearest
  "why we don't concatenate query strings" example in the repo.
- `:158` `QueryOpts()` converts the parsed values into `[]n1ql.QueryOpt`:
  `WithLimit`, `WithOffset` (`perPage * (page-1)`, with the 1-based-indexing
  comment), `WithSortDirection`, `WithSortBy`
- `:190` `PaginatedResponse(one, total)` builds the cursor: `last = total/perPage`
  (+1 on remainder), plus `previous`/`next`

### The write path — `Create`

`cmd/cp-api/v2/project/project.go:354`

```go
m, err := keynames.ValidateIDKeyNames(vars, keynames.TenantIDKey)   // 1 validate
err = p.rbacResolver.Create(ctx, rbac.ResourceTypeProject, t)        // 2 authorise
var create *project.CreateProjectPayload
if err := v2.Decode(r, &create); err != nil { ... }                  // 3 decode
create.TenantID = tenantID                                           // 4 server-side override
id, err := p.projectManager.Create(ctx, create)                      // 5 delegate
p.responder.Respond(ctx, w, http.StatusCreated, &v2.ID{ID: *id})     // 6 201 + id
```

Step 4 matters: `TenantID` is set from the **authenticated URL**, never from the
request body. A client cannot create a project in someone else's tenant by
lying in the JSON. Standard, and worth stating explicitly to a team new to
server-side trust boundaries.

`Update` at `:400` adds one step: `p.check.Project(ctx, tenantID, projectID)`
**before** the RBAC check — confirm the child actually belongs to the parent
before asking whether the user may edit it. Skipping this is the classic
IDOR/cross-tenant bug.

The handler ordering rule, worth memorising as a review checklist:

```
validate path -> ownership check -> authorise -> decode body -> business call -> respond
```

### Decoding

`cmd/cp-api/v2/decoder.go`

```go
const max = 10000000                 // 10MB, "10X NGINX default but small enough"
rd := io.LimitReader(r.Body, max)
...
if b.Len() == 0 { return goof.JSONInputMissing() }
err := json.Unmarshal(b.Bytes(), v)
switch {
case errors.As(err, &syntaxError):        return goof.JSONSyntaxError(offset, ...)
case errors.As(err, &unmarshalTypeError): return goof.JSONUnmarshalTypeError(type, field, value)
case goof.IsError(err):                   return err
default:                                  return goof.JSONFailedToUnmarshal()
}
```

`io.LimitReader` before reading — memory-exhaustion defence. And the JSON error
is translated into a *field-level* message so the UI can point at the bad input.
That is `errors.As` doing real work.

### Responding, and errors

`cmd/cp-api/v2/responder.go`

`Goofify(ctx, err)` is the error funnel. Priority order:

1. Already a `goof.Error` (`errors.As`) → pass through
2. `ctx.Err() != nil` → `DeadlineExceeded` → 504, `Canceled` → 499, else 500
3. `couchbase.ErrUnambiguousTimeout` / `ErrAmbiguousTimeout` → 504
4. anything else → **500, and log the real error**

The comments say it plainly: *"unhandled error prevented from leaking to user"*.
The user gets a curated message; the operator gets the stack in Datadog. One
place, so it cannot be forgotten per-handler.

`Respond` marshals, sets Content-Type by reflected kind (`setContentType`),
writes the status, writes the body. It also does one non-obvious thing
(`updateJWTDocIfRequired`, AV-40613): for multi-tenant users on v2 endpoints
without an org in the path, it refreshes the JWT document if the tenant changed —
and if that fails it **only logs**, never blocks the response.

### `goof` — the error system

`internal/goof/goof.go`

```go
type Error struct {
    Code        int      `json:"code,omitempty"`         // HTTP status
    Message     string   `json:"message,omitempty"`      // user-facing
    Validation  []...    `json:"validation,omitempty"`
    SourcedFrom string   `json:"-"`                      // code point, not serialised
    Name        string   `json:"name,omitempty"`         // stable machine key
    RetryAfter  *int     `json:"retryAfter,omitempty"`
    Fields      map[string]string `json:"validations,omitempty"`
}
```

Errors are **declared in JSON, next to the domain that owns them**, and
code-generated into one Go file:

`internal/project/project_errors.json`
```json
{ "version": 1, "mode": "global", "goofs": {
  "DeleteProjectsWithDatabases": {
    "code": 400,
    "one": "Unable to delete a Project with Cluster resources...",
    "doc": "Returned when trying to delete a Project that still has attached Clusters" },
  "ErrEtagVersionConflict": { "code": 412, "one": "...", "doc": "..." }
}}
```

→ `internal/goof/errors.generated.go`
```go
func ActivationNotFound() Error { return newError(2, 404, "Unable to obtain...", "ActivationNotFound") }
```

Generator: `internal/goof/generate/generate.go` (text/template + `go/format`),
driven by `//go:generate` at `internal/goof/goof.go:1`.

Why this is good:
- Every user-facing message is reviewable in one diff, by a writer, not buried in
  a `fmt.Errorf`
- `Name` is a stable key the UI can branch on and translators can key off
- The status code lives with the message — no handler picking 400 vs 422 by feel
- `RetryAfter` is a first-class field; `responder.Error` sets the `Retry-After`
  header from it automatically

Cost: adding an error means editing JSON and regenerating. That friction is the
point.

---

## Service layer — where business rules live

`internal/project/service/projects.go`

```go
var _ project.Manager = &Service{}          // :40 compile-time interface assertion
```

That one line is a pattern to teach immediately: it makes "does `Service` still
satisfy `Manager`?" a **compile error** instead of a runtime surprise.

Constructor (`:66`) takes 14 dependencies, all interfaces, and finishes with:

```go
if err := validator.Validate(validator.ValidateOptions{Value: svr}); err != nil {
    return nil, fmt.Errorf("invalid project service dependencies: %w", err)
}
```

Struct-tag-driven dependency validation. A nil dependency fails at **startup**,
not on first request. Fail fast.

`Create` (`:578`) is the business-rule showcase:

```go
id := identifier.New()
ud := internalcontext.UserDataFromContext(ctx)                 // who is acting
pr := project.Project{ ID: id, Name: strings.TrimSpace(p.Name), ... }
if err := pr.Validate(); err != nil { return nil, err }        // entity validates itself

ctx, unlock, err := s.locker.Lock(ctx, p.TenantID)             // distributed lock, keyed by tenant
switch {
case err == nil:
case errors.Is(err, lock.ErrLockTimeout): return nil, fmt.Errorf("timed out waiting for lock: %w", err)
default:                                  return nil, fmt.Errorf("failed to acquire lock: %w", err)
}
defer unlock()

val, err := s.quotasManager.Residual(ctx, p.TenantID, quotas.KeyProjectCount)
if val <= 0 { return nil, goof.ProjectCountQuotaReached() }     // quota enforced INSIDE the lock

if err := s.projectStorer.Create(ctx, &pr); err != nil { ... }

ctx = pr.Context(ctx)
if err := s.eventClient.EmitProjectCreated(ctx); err != nil {
    l.Warn("failed to emit project created event", zap.Error(err))   // non-fatal
}

if ud.APIKey { s.rbacSvc.Update(ctx, p.TenantID, ud.ID, ...RoleProjectOwner...) }
```

Five design decisions in ~40 lines:

1. **Distributed lock keyed by tenant** (`internal/couchbase/lock`), because the
   quota check and the write must be atomic across API replicas. Check-then-act
   without the lock = quota bypass under concurrency.
2. **Quota check inside the lock**, before the write. Ordering is the correctness.
3. **`defer unlock()`** immediately after acquiring — no early-return path leaks
   the lock.
4. **Event emission is best-effort**: log and continue. Failing to notify must not
   fail the create. That is a product decision encoded in one `l.Warn`.
5. **Creator gets `RoleProjectOwner`** — the actor is derived from `ctx`
   (`UserData`), never from the request body.

`List` in the same file shows the query builder:

```go
options := []couchbase.CommandOption{
    couchbase.WithQuerySelect(s.projectStorer.BucketName() + ".*"),
    couchbase.WithQueryFrom(s.projectStorer.BucketName()),
    couchbase.WithWhere(fmt.Sprintf("tenantId=$%s", keynames.TenantIDKey)),
    couchbase.WithNamedParams(np),                    // <- parameterised, not interpolated
    couchbase.WithTimeoutIncrease(defaultTimeoutIncrease),
    couchbase.WithExponentialBackoffRetry(),
    couchbase.WithAttemptIncrease(defaultAttemptIncrease),
    couchbase.WithPagination(paginationOption),
}
```

Named params (`$tenantId`) not string concatenation. Retry with exponential
backoff declared as an option, not hand-rolled per call site.

And result streaming, not slurping:

```go
qr, err := s.projectStorer.Query(ctx, options...)
defer qr.Close()
for qr.Next() { var c project.Project; if err := qr.Row(&c); err != nil { continue }; projects = append(projects, &c) }
```

---

## Store layer — the adapter

`internal/project/store/store.go`

`New()` does four things: validate deps, open the Couchbase collection, build the
reader and writer, build an N1QL generator.

```go
svc.projects, err = store.Collection(
    svc.bucket, project.Scope, project.Collection, project.Project{},
    couchbase.WithTypeKey(project.TypeKey),
    couchbase.WithChangeLogEnabled(),          // audit trail
)
```

`WithChangeLogEnabled()` is why `GetWithHistory(ctx, id, action, changelogs)`
exists on the interface — document history is a store capability, opted into
per collection.

Then `Store` is a thin facade delegating to `reader`/`writer`, adding logging and
error translation (`couchbase.ErrNotFound` → `project.ErrNotFound`). Note the
comment in `Many`: AV-61081 moved to generic readers, so it converts `[]T` to
`[]*T`. Honest debt, documented.

The doc comments on `One` and `Many` are runnable usage examples. That is the
house style — copy it.

`internal/project/reader/reader.go` is the payoff:

```go
var _ project.Reader = (*reader.Reader[project.Project])(nil)

func New(logger log.Logger, bucket string, cb couchbase.Storer) (*reader.Reader[project.Project], error) {
    return reader.NewReader(logger, cb, bucket,
        project.Scope, project.Collection, project.Project{},
        project.TypeKey, project.ErrNotFound)
}
```

**One generic reader serves every domain.** Go generics remove ~100 copies of
identical CRUD. The whole per-domain reader is 23 lines.

---

## Layer summary

| Layer | Location | Knows about | Must not know about |
|---|---|---|---|
| Route/DI | `server/handler.go`, `server/v2.go` | everything | — |
| Endpoint | `v2/<resource>/` | HTTP, RBAC resolver, Manager iface | Couchbase, N1QL |
| Service | `internal/<d>/service/` | business rules, Storer iface, quotas, locks, events | HTTP |
| Store | `internal/<d>/store/` | Couchbase, N1QL | HTTP, business rules |
| Reader/Writer | `internal/<d>/reader,writer/` | generic couchbase adapter | domain rules |

Dependencies point **inward and downward** through interfaces declared in the
consumer's package (`manager.go`). That is Dependency Inversion, and it is why
`cmd/cp-api/v2/project/project_test.go` is 2,018 lines against a 722-line
handler — mocks make every branch reachable.

---

## Test-file ratio — the standard being set

| File | Lines |
|---|---|
| `cmd/cp-api/v2/project/project.go` | 722 |
| `cmd/cp-api/v2/project/project_test.go` | 2,018 |

Roughly **2.8× test-to-code**. `cmd/cp-api/AGENTS.md` requires HTTP status-code
coverage for 200/201/204/400/403/404/422/500, RBAC denials, and goof mapping.
Frontend mirrors it: every `hooks/api/use-*` folder ships a `.test.tsx`
alongside the hook.

---

## Try it locally

From `docs/agents/build-test-run.md` and `cmd/cp-ui-v3/package.json`:

```bash
# backend: cp-api on :8080  (needs AWS_PROFILE, JWT, INTERNAL_SUPPORT_TOKEN)
make ...            # see docs/agents/build-test-run.md

# frontend against your local cp-api
cd cmd/cp-ui-v3 && npm run dev:v3:local     # -a http://localhost:8080

# or against dev
npm run dev:v3                              # -a https://api.dev.nonprod-project-avengers.com
```

Then, with devtools Network open, click the Projects page and match every step
above. That exercise is the whole point of this document.
