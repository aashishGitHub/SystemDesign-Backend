# 05 — UI → Fullstack Ramp Plan

Audience: React/TypeScript engineers who have never shipped Go and have never
owned infrastructure. Goal: within one quarter, each can ship a full vertical
slice — React page through `cp-api` to Couchbase — and defend it in review.

This is a plan you can run, not a syllabus. Every week ends with a merged PR or a
written artefact.

---

## Principle: cross the wire on day one

The failure mode is teaching Go for three weeks and React-to-Go in week four. Do
the opposite. Week 1 changes one field end-to-end. The stack becomes concrete
before it becomes deep.

The second principle: **the codebase is the curriculum.** No toy projects. Every
exercise is a real, reviewable change in `couchbase-cloud`.

---

## Week 0 — Environment (half a day, do it together)

Nobody learns anything while fighting tooling. Pair on this.

- [ ] Repo cloned; `AGENTS.md` and `docs/agents/*.md` skimmed
- [ ] Go toolchain per `go.mod` (currently `go 1.26.4`; root `AGENTS.md` still says 1.25.5+ — trust `go.mod`); `make lint` runs clean on a clean tree
- [ ] AWS SSO / `AWS_PROFILE=dbaas-test-0005-temp` working; `aws sts get-caller-identity` returns
- [ ] `cp-api` runs locally on `:8080` (see `docs/agents/build-test-run.md`)
- [ ] `cd cmd/cp-ui-v3 && npm run dev:v3:local` serves against your local API
- [ ] Also confirm `npm run dev:v3` works against dev, as a fallback
- [ ] `docs/agents/build-test-run.md` bookmarked for codegen commands

Deliverable: everyone can set a breakpoint in a Go handler and hit it by clicking
in the browser. **Do not proceed until this is true for every person.**

---

## Week 1 — The vertical slice

Read [02](02-slice-01-ui-to-cp-api.md) once. Then, with devtools Network open,
load the Projects page and match every one of the 14 steps to a file.

**Exercise (each person individually):** add one field to the Projects list
response and render it.

Touch points, in order — this is the muscle memory:

1. `internal/project/project.go` — add the field to the entity
2. `cmd/cp-api/v2/project/project.go:85` — add it to `ProjectWithCount` with a JSON tag
3. `cmd/cp-api/v2/project/project_test.go` — assert it in the response
4. `cmd/cp-ui-v3/src/sync/project-service/project-service.types.ts` — extend the DTO
5. The page component — render it
6. The component test

**Debrief questions.** Answering these is the point of the week:

- Where exactly did the JSON envelope get built? *(`rbac.Morph`)*
- Why does `useProjectList` do `query.data?.data`? *(envelope, then row)*
- Which line decided the HTTP status code? *(`responder`, from the `goof`)*
- What would happen if you set `enabled: true` unconditionally on the hook?
- Why is the field name `syncGWCount` and not `syncGatewayCount` on the wire?

---

## Week 2 — Go, as a language, on purpose

Do **not** teach Go top to bottom. Teach the eight things this codebase uses on
every page, each against a real file.

| # | Concept | Read | The point |
|---|---|---|---|
| 1 | Struct + interface, no classes | `internal/project/manager.go` | Interfaces are satisfied implicitly. No `implements`. |
| 2 | Explicit error returns | `internal/project/service/projects.go` | No exceptions. `if err != nil` is the control flow. |
| 3 | Error wrapping | `fmt.Errorf("...: %w", err)`, `errors.Is/As` | `%w` preserves the chain; `%v` silently breaks it |
| 4 | `context.Context` | `cmd/cp-api/middleware/jwtAuth.go:40` | Cancellation, deadline, identity, tracing — always the first parameter |
| 5 | Struct embedding | `cmd/cp-api/v2/project/project.go:85` | Composition, and JSON flattening |
| 6 | Slices/maps as references | `project.go:307` (`opts` mutation) | `append` may or may not alias. Know when. |
| 7 | Goroutines + errgroup | `project.go:125` | Fan-out with first-error cancellation |
| 8 | Generics | `internal/project/reader/reader.go` | `Reader[T]` — one repository, every domain |

**Exercise:** write `internal/project/service/projects_test.go` cases for a method
that currently lacks coverage. Use the generated mock in
`internal/project/mocks/`. Constraint: **no Couchbase**. If you need a database,
you are testing the wrong layer.

**Mapping table to hand out** — this is what makes Go click for a TS developer:

| TypeScript | Go |
|---|---|
| `interface` (structural) | `interface` (also structural, but methods only) |
| `class` | `struct` + methods with a receiver |
| `throw` / `try/catch` | `return err` / `if err != nil` |
| `Promise.all` | `errgroup.Group` + `g.Wait()` |
| `AbortController` | `context.Context` |
| options object | functional options (`WithLimit(10)`) |
| `T \| undefined` | `*T` (nil pointer) or `(T, bool)` |
| `jest.mock` | `mockgen` + generated mock |
| decorator / HOF | `func(*One)` — see `Morpher` |
| barrel `index.ts` | package. **No cyclic imports, ever — it will not compile.** |

That last row matters more than it looks. Go's compiler forbids import cycles, so
the layering in doc 01 is not a convention — it is enforced.

---

## Week 3 — RBAC and the response envelope

This is the week that changes how they build UI.

Read: `internal/rbac/README.md`, `internal/rbac/rbac.go` (interfaces + `One`),
`internal/rbac/morph.go`, and doc 03 §5–6.

The two ideas:

1. **`rbac.One` (Go) === `RbacResponse<T>` (TS).** Every payload is
   `{data, permissions}`.
2. **Authorisation is a query predicate.** `rbacResolver.List` returns a
   `n1ql.QueryOpt` that goes into the WHERE clause. Forbidden rows never leave
   the database.

**Exercise:** find a UI component that decides button visibility from a client-side
role check or an inferred condition. Change it to read `permissions` off the
response. Then answer: *what class of bug did that remove?*

Answer to look for: the client and server could disagree. The server is the only
authority, and it already told you.

**Exercise 2:** add a role to `internal/rbac/configuration`. Follow the four steps
in `internal/rbac/README.md`, run `go generate ./internal/rbac/...`, watch the
tests that fail if you skip a step. This teaches codegen-as-contract better than
any explanation.

---

## Week 4 — Errors, validation, observability

Read: `internal/goof/goof.go`, `internal/project/project_errors.json`,
`cmd/cp-api/v2/responder.go`, `cmd/cp-api/v2/decoder.go`.

The insight: **a user-facing error message is a product artefact.** It lives in
JSON, next to its domain, gets code-generated, and is reviewable by a writer.

**Exercise:** add a new goof to a domain's `*_errors.json`, regenerate, return it
from a handler, and surface it in the UI keyed off `name` (not the message
string — messages change, names do not).

**Exercise 2:** trace one request end-to-end in Datadog. Find the span named after
its owning team (`v2.Own(r, owners.Auth)` → `internal/middleware/owners`).
Then explain `routeRedaction` and `variableRoutes`
(`cmd/cp-api/server/handler.go:17-23`) and why unbounded metric label cardinality
is an outage.

---

## Week 5 — AWS, only what this slice needs

Read doc 04. Then open the Terraform and read it as code, not as configuration.

Concept checklist. Each person explains one to the group, from the actual file:

- [ ] Private S3 + CloudFront OAI — why a public website bucket is wrong
- [ ] Cache key design — why cookies are excluded, and when that would be a leak
- [ ] The four CloudFront trigger points, and why the router is on `origin-request`
- [ ] ACM DNS validation + `create_before_destroy`
- [ ] Route53 A-ALIAS vs CNAME at a zone apex
- [ ] EKS: Deployment / Service / Ingress / ConfigMap / Secret / ServiceAccount / PDB
- [ ] ingress-nginx vs AWS ALB Ingress — the multi-cloud trade-off
- [ ] mTLS: `auth-tls-verify-client`, `verify-depth = 1`
- [ ] Secrets Manager + IRSA — why no static keys exist anywhere
- [ ] Cross-account `AssumeRole` — the DBaaS trust model

**Exercise:** `terraform plan` a trivial, safe change in a sandbox and read the
diff aloud. The goal is to stop finding Terraform output frightening.

---

## Week 6 — Testing to the house standard

The bar, measured:

| File | Lines |
|---|---|
| `cmd/cp-api/v2/project/project.go` | 722 |
| `cmd/cp-api/v2/project/project_test.go` | 2,018 |

~2.8× test-to-code. `cmd/cp-api/AGENTS.md` requires status-code coverage for
200/201/204/400/403/404/422/500, plus RBAC denials and goof mapping.

| Layer | Tool | Fake what |
|---|---|---|
| Handler | `httptest` + `mockgen` mocks | the Manager |
| Service | `mockgen` mocks | the Storer |
| Store | integration (Bazel) | nothing |
| Hook | `@testing-library/react` + `jest.spyOn` on the service | the transport |
| Pure fn | plain jest | nothing |
| E2E | Cypress | nothing (needs `data-auto-id`) |

**Read as the model:** `cmd/cp-ui-v3/src/hooks/api/use-project-list/use-project-list.test.tsx`.
Note the technique — a probe component that only calls the hook and assigns the
result to a closure variable. That is how you test a hook's contract without a UI.

**Exercise:** take an untested handler branch and cover it. Then delete a line of
production code and confirm a test fails. If nothing fails, the test was theatre.

---

## Week 7+ — Own a slice from the loop

Each person takes a slice from the [tracker in doc 00](00-INDEX.md#loop-tracker),
traces it, and writes the doc. Constraint: **`path:line` anchors, or it does not
count.** Writing the trace is how they prove they understand it, and it grows this
folder.

Suggested assignment order by prior interest:

| Interest | Slice |
|---|---|
| Async / queues / state machines | 2 — cluster provisioning |
| Distributed systems / agents | 3 — CP↔DP seam |
| API design / contracts | 4 — `cp-open-api` v4 + OpenAPI codegen |
| Security | 5 — auth end-to-end |
| Product / commercial | 6 — billing |
| Reliability | 7 — observability pipeline |

---

## Product knowledge — run this in parallel, 30 min/week

Architecture without product understanding produces technically correct, useless
features.

Week 1: **The DBaaS value proposition.** Why does a customer pay Capella instead
of running Couchbase on EC2? (Provisioning, upgrades, backups, monitoring,
scaling, support, multi-cloud.) Every one of those maps to a binary in `cmd/`.

Week 2: **The resource hierarchy.**
`Organization (tenant) → Project → Cluster (Database) → Bucket → Scope → Collection`.
Say the `tenantId` vs `organizationId` split out loud. It costs new joiners days.

Week 3: **The product surfaces.** Provisioned clusters, Columnar (analytics),
App Services / Sync Gateway (mobile), Capella iQ (AI). Find the `cmd/` and
`internal/` package for each.

Week 4: **The commercial model.** Free trial → credits → paid. Read
`internal/billing/`, `internal/tenant/trial`, `internal/tenant/quotas`. Notice
that `internal/project/service/projects.go:608` enforces a **project count
quota** — a commercial rule living in a service method. Product decisions are in
the code; go and read them.

Week 5: **The personas.** Customer (`cp-ui-v3`), Couchbase support/ops
(`fm-ui-v2`, Fleet Manager), Couchbase engineers (`idp-ui`, Capella IDP). Three
UIs because three audiences. Look at what `internal*` endpoints exist and you can
infer the whole support workflow.

Week 6: **Read a real incident or CBSE ticket** with someone who handled it.
Nothing teaches the architecture faster than a post-mortem.

---

## Standing review checklist

Pin this. It is the same list as doc 03, condensed to what a reviewer actually
scans for.

**Go handler**
- [ ] Path vars validated (`keynames.ValidateIDKeyNames`)
- [ ] Ownership checked *before* authorisation
- [ ] `rbacResolver` called; for `List`, the returned filter reaches the store
- [ ] Body via `v2.Decode`; server-side fields overridden from the URL
- [ ] All errors through `responder.Error`; response via `responder.Respond`
- [ ] Response wrapped by `rbac.Morph` / `MorphList`
- [ ] Status codes tested: 200/201/204/400/403/404/422/500 + RBAC denial

**Go service**
- [ ] `var _ Iface = &Impl{}`
- [ ] Constructor ends with `validator.Validate`
- [ ] Check-then-act under a lock, or an ETag for lost-update
- [ ] Errors wrapped with `%w`; sentinel errors not returned to clients
- [ ] Best-effort side effects logged, not returned
- [ ] Concurrent writes touch disjoint fields only

**Frontend**
- [ ] component → hook → service → `request.ts`; no layer skipped
- [ ] Query key includes every input that changes the result
- [ ] `enabled` guard on ids that can be empty
- [ ] Pure logic in `.utils.ts` with its own test
- [ ] `permissions` from the response drives what renders
- [ ] `data-auto-id` on interactive elements
- [ ] No `any`, no `as`, no new Redux slice for server data
- [ ] `spec/` updated *before* implementation for anything non-trivial

**Any PR**
- [ ] `make lint` clean; generated files not hand-edited
- [ ] No banned package introduced (doc 03, last table)
- [ ] Jira id in the branch/commit per `docs/agents/conventions.md`
- [ ] API PRs include sample request/response and before/after diffs
      (`cmd/cp-api/AGENTS.md`)

---

## The five sentences a ramped engineer can say without notes

1. Capella is a DBaaS; the control plane orchestrates, the data plane runs the
   customer's Couchbase, and they only talk through `cp-internal-api`.
2. A request goes router → auth middleware → endpoint → RBAC resolver → service →
   store → Couchbase, and comes back as `{data, permissions}` because
   `rbac.Morph` wraps it.
3. Authorisation is pushed into the N1QL query, so forbidden rows never leave the
   database.
4. Errors are declared as JSON per domain, code-generated into `goof`, and funnelled
   through one `Responder` so internal detail cannot leak.
5. The UI is static assets on a private S3 bucket behind CloudFront with three
   Lambda@Edge functions; `cp-api` is a Deployment on EKS behind ingress-nginx,
   with three separate authentication tiers depending on which router the endpoint
   was registered on.

If someone can say those five and point at a file for each, they are ramped.
