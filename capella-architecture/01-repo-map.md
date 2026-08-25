# 01 — Repo Map

Goal: know which directory to open, and which direction dependencies are allowed
to point.

---

## Top level

| Dir | Contains | Import rule |
|---|---|---|
| `cmd/` | One directory per binary. Entry points only. | May import `internal/`. Must **not** import another `cmd/`. |
| `internal/` | All shared domain logic. ~130 packages. | May import other `internal/`. Must **not** import `cmd/`. |
| `services/` | `ai`, `analytics` service-layer code | — |
| `terraform/` | IaC. `live/` = per-environment state, `modules/` = reusable | — |
| `helm/charts` | Helm charts | — |
| `lambda/` | AWS Lambda functions | — |
| `test/` | E2E framework | — |
| `cv/` | Commit Validation config (linters, CI tools) | — |
| `docs/agents/` | The architecture/convention docs that agents and humans share | — |

`internal/` is Go's enforced privacy boundary: nothing outside the module can
import it. That is deliberate — it means the whole monorepo is one deployable
unit with no public API surface except `cp-open-api`.

---

## The binaries that matter (`cmd/`)

### Control Plane — runs on Couchbase's own EKS

| Binary | Local port | Consumer | One-liner |
|---|---|---|---|
| `cp-api` | 8080 | Capella WebUI | Internal REST API. The one the UI talks to. |
| `cp-open-api` | 8084 | External users, Terraform provider | Public Management API v4, OpenAPI-generated |
| `cp-internal-api` | 8081 | DP agents | **The only** CP↔DP door |
| `cp-idp-gateway` | 8088 | `idp-ui` | Internal Developer Platform for Couchbase engineers |
| `cp-worker` | — | — | Background worker. Does the long provisioning work. |
| `cp-scheduler` | — | — | Job scheduler |
| `cp-jobs` | — | — | Scheduled jobs (billing runs, cleanup) |
| `cp-ns` | — | — | Notification service |
| `cp-bot` | — | — | Slack bot |
| `cp-fm-gateway` | — | — | Fleet Manager gateway (support tooling) |

### Data Plane — runs in customer-facing cloud accounts

`dp-agent-v2`, `dp-agent-v3`, `dp-ingestor`, `dp-observer`, `dp-backup`,
`dp-credential-service`, `dp-runtime-agent`, `datastore-agent`,
`model-serving-agent`, `sgw-agent`, `sgw-observer`.

Agents authenticate to `cp-internal-api` with basic auth; secrets live in AWS
Secrets Manager / Azure Key Vault / GCP Secret Manager.

### UIs

| Binary | Stack | Note |
|---|---|---|
| `cp-ui-v3` | React + TS + Webpack + Tailwind | Current generation. npm package name is `capella-guardians`. |
| `cp-ui-v2` | Svelte | Legacy. Still shipped, runs **alongside** v3 via Module Federation. |
| `fm-ui-v2` | React | Fleet Manager UI |
| `idp-ui` | React | Internal Developer Platform UI |

Two UI generations coexist in production. That is why `cp-ui-v3` has
`federation.config.cjs`, `make-federation-config.js`, and a `V3_ONLY` env flag
(`cmd/cp-ui-v3/package.json`). When `V3_ONLY` is unset the router mounts under
`/v3` (`cmd/cp-ui-v3/src/main.tsx`).

---

## The `internal/<domain>` package shape — memorise this

Nearly every domain package follows the same skeleton. `internal/project` is the
cleanest example:

```
internal/project/
  project.go            entity + JSON tags + Validate()
  manager.go            INTERFACES ONLY: Storer, Reader, Writer, Manager
                        + //go:generate mockgen  (manager.go:11)
  errors.go             sentinel errors (project.ErrNotFound)
  project_errors.json   goof catalogue for this domain (user-facing messages)
  lock.go               distributed-lock helpers
  reader/reader.go      concrete read adapter  (wraps generic reader.Reader[T])
  writer/writer.go      concrete write adapter
  store/store.go        composes reader+writer, owns the Couchbase collection
  service/projects.go   BUSINESS LOGIC. implements Manager.
  mocks/mocks.go        generated gomock
```

Read it in this order: `manager.go` → `service/` → `store/`. Interfaces first,
policy second, plumbing last.

**Why it's built this way (ports & adapters / hexagonal):**

- `manager.go` declares *ports*. `reader/`, `writer/`, `store/` are *adapters*.
- Handlers depend on the interface, never the Couchbase client. So handlers are
  unit-testable with a generated mock and no database.
- `Reader`/`Writer`/`Storer`/`Manager` are separate interfaces, not one fat one.
  That is Interface Segregation. A caller that only reads takes `Reader` and
  therefore *cannot* write — the compiler enforces least privilege.

Verify: `internal/project/manager.go:14` (`Storer`), `:30` (`Reader`), `:39`
(`Writer`), `:46` (`Manager`).

---

## The `cmd/cp-api` package shape

```
cmd/cp-api/
  main.go            9 lines of real work. Calls server.New(), ListenAndServe().
  server/
    server.go        ~9,982 lines. THE dependency-injection root.
    handler.go       router + middleware chain construction
    v2.go            ~985 lines. Struct holding every v2 service + their wiring.
    config.go        env-var config
  middleware/        basic_auth, jwtAuth, cors, token_auth, stripe_auth, metrics...
  service/           v1 endpoints (legacy: sessions, users, emails, registrations)
  v2/                107 subpackages — one per resource. THE current API.
    endpoint.go      the Endpoint type (17 lines, read it)
    responder.go     JSON + error writing
    decoder.go       request body decoding
    pagination.go    page/perPage/sortBy parsing + cursor building
    rbac.go          permissions endpoints
    utilities.go     the URL constants
    own.go           ownership/tracing subrouter helper
    project/         <- our slice
    clusters/ ... internal*/ ...
```

`server.go` being ~10k lines is not accidental complexity to be cleaned up
casually — it is the single composition root. Every dependency is constructed
once, in order, and injected downward. It is ugly but it is honest: there is
exactly one place to look for "where does this service get its store from".

`internal*` prefixed packages under `v2/` (e.g. `internalclusters`,
`internalsupport`) mount on a **different router** guarded by a static token
(`handler.go:212-214`). They are support/ops endpoints. Never expose them.

---

## The `cmd/cp-ui-v3/src` shape

```
src/
  main.tsx               provider stack + router mount
  routing/
    routes.tsx           root route tree
    definitions/*.tsx    one file per product area (project, database, columnar…)
    root-authorised-loader.ts   the auth gate
  sync/                  API CLIENT LAYER — one dir per backend domain
    request.ts           the single axios instance + error normalisation
    <domain>-service/
      <domain>-service.ts        transport functions (one per endpoint)
      <domain>-service.types.ts  request/response DTOs
  hooks/
    api/use-<thing>/     TanStack Query wrapper. One folder per hook + test.
    shared/, use-flags/, use-permissions/ …
  store/                 Redux Toolkit slices — cross-cutting CLIENT state only
  providers/             React Context providers (DI)
  contexts/              auth.context, chat.context
  pages/, layouts/, partials/, components/
  utils/, types/, config/
```

Layering rule the team must internalise:

```
pages/components  ->  hooks/api  ->  sync/<domain>-service  ->  sync/request.ts
   (view)            (server state)      (transport + DTO)        (HTTP + errors)
```

Never let a component call `sync/` directly, and never let `sync/` know about
React. The hook is the seam.

`store/` (Redux) is **not** for server data. From `cmd/cp-ui-v3/AGENTS.md`:
"Server state via TanStack Query; do not add new Redux slices unless state is
genuinely cross-cutting."

---

## The shared design system

`@couchbasecloud/ui-platform` is a published npm package (version pinned in
`cmd/cp-ui-v3/package.json`). `tsconfig.json` remaps bare specifiers into it:

- `components/button` → `node_modules/@couchbasecloud/ui-platform/dist/components/button`
- `sync/response.types` → `.../dist/sync/response.types` (`tsconfig.json:424`)

So an import that *looks* local may resolve to the shared library. Check
`tsconfig.json` `paths` before assuming a file is in this repo. This is also why
`check-circular-deps.js` exists as a lint step.

---

## Build systems

Two, on purpose.

- `make` — primary for local dev. `make lint`, codegen, run.
- **Bazel** — CI/CD, Docker images, integration tests. `MODULE.bazel`,
  per-package `BUILD.bazel`.

Every Go package carries a `BUILD.bazel`. If you add a package and CI fails with
a missing target, that is why.

---

## Codegen — four generators you will meet

| Generator | Input | Output | Trigger |
|---|---|---|---|
| `goof` | `internal/**/*_errors.json` | `internal/goof/errors.generated.go` | `//go:generate` in `internal/goof/goof.go` |
| `go-enum` | `internal/rbac/resource_type.go`, `roles.go` | `*_enum.go` | `//go:generate` in `internal/rbac/rbac.go:13` |
| `mockgen` (`go.uber.org/mock`) | interface files | `mocks/mocks.go` | `//go:generate` per package, e.g. `internal/project/manager.go:11` |
| `oapi-codegen` | `openapi.yaml` | `v4.gen.go` | for `cp-open-api` |

Generated files (`*.generated.go`, `generated/`, `mocks/`, `v4.gen.go`) are
excluded from linting and review. Do not hand-edit them.

---

## Universal Go rules (from root `AGENTS.md`)

- Errors: stdlib `errors`. Wrap with `fmt.Errorf("...: %w", err)`. Compare with
  `errors.Is` / `errors.As`. **Never** `github.com/pkg/errors`.
- Logging: only `internal/log`.
- Data store: `internal/couchbase`. `internal/store` is **deprecated**.
- Validation: `internal/validator.Validate()`.
- Banned → use instead: `golang/mock`→`go.uber.org/mock`; `gofrs/uuid`→`google/uuid`;
  `mitchellh/mapstructure`→`go-viper/mapstructure`; `x/exp/maps|slices`→builtin
  `maps`/`slices`; `k8s.io/utils/ptr`→`tools-common/types/ptr`;
  `gotest.tools/assert`→`testify/assert`; `io/ioutil`→`io`/`os`.

---

## Frontend rules (from `cmd/cp-ui-v3/AGENTS.md`)

- Never `any`. Prefer `type` over `interface`. Avoid `as`.
- camelCase vars, PascalCase components/types, kebab-case files.
- Composition over configuration — no boolean-flag-driven rendering; extract a
  sub-component instead.
- No arbitrary `className` overrides on internal components; use variant props.
- Every interactive element needs a `data-auto-id` for Cypress/E2E.
- Spec-driven: update `spec/` **before** implementing. See
  `cmd/cp-ui-v3/spec/spec-driven-development.md`.
