# 24 — OpenAPI Contract and Typed Clients

The engine publishes a single OpenAPI 3.1 contract and treats it as the source of truth for every external integration. The contract is **generated from the route definitions**, not hand-written and not generated from the database. One Zod schema underpins each route and feeds three places at once: runtime validation, OpenAPI documentation, and compile-time client types. This file specifies the generation pipeline, the runtime endpoints that serve the contract, the in-repo typed client, the path for external-language SDKs, and the versioning policy.

## Generation pipeline

`@hono/zod-openapi` is the single tool. Each route is declared with `createRoute(...)` carrying request and response schemas as Zod objects, plus tags, security, and example data. The same route registers a Hono handler and contributes a path entry to the OpenAPI document. Building `openapi.json` is a single call against the application instance.

Trade-off: deriving the contract from route definitions means the document can never drift from what the engine actually serves — they are produced from the same code. The cost is that route files carry more ceremony than plain handlers; that ceremony pays for itself the first time a downstream client breaks because the docs lied.

## Runtime endpoints

| Path | Behaviour |
|---|---|
| `/openapi.json` | The generated OpenAPI 3.1 document, served as `application/json`. Cached behind an `ETag` derived from the engine's build hash. |
| `/docs` | An interactive OpenAPI UI rendered by **Scalar**. Served as a single static HTML page that loads `/openapi.json` at runtime. No build step, no asset pipeline. |
| `/openapi.json?version=v1` | Optional version pin for clients that want to lock against the contract a specific engine release shipped with. The current build always responds; the engine does not store historical OpenAPI documents — they live in release artifacts. |

Trade-off: Scalar over a build-time UI like Redoc-static keeps the engine's footprint smaller and lets the docs page stay in sync with the live engine without rebuild. The cost is one extra runtime fetch when the docs page loads; that's acceptable on an admin surface.

## In-repo typed TypeScript client

The CLI, integration tests, and any internal tooling consume the engine through `hono/client`, **not** through a generated client. `hono/client` derives fetcher types directly from the route type export — there is zero codegen step, and a route change reflects in the client's types on the next `tsc` run.

```ts
// shared/route-types.ts — exported by the server build
import type { app } from "../src/app";
export type AppType = typeof app;

// client/engine-client.ts — consumed by CLI and tests
import { hc } from "hono/client";
import type { AppType } from "shared/route-types";

export function createEngineClient(baseUrl: string, apiKey: string) {
  return hc<AppType>(baseUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

// usage — every path and method is a checked property access
const client = createEngineClient(engineUrl, apiKey);
const res = await client.v1.workflows.$get({ query: { limit: 50 } });
if (res.ok) {
  const list = await res.json(); // list.data is fully typed
}
```

Trade-off: `hono/client` ties internal callers to the same TypeScript build as the server, which is a feature for a single repo and a problem for cross-repo consumers. That is exactly why the engine also exports `openapi.json` for external consumers — the right tool for each side.

## External-language SDKs

External consumers (anyone outside the engine repo, in any language) generate their client from `openapi.json`. The recommended TypeScript path is **`@hey-api/openapi-ts`**, which produces a small, type-safe client without relying on the engine's internal route type. For other languages, any standards-compliant OpenAPI codegen works — the engine's contract sticks to OpenAPI 3.1 features that all common generators understand.

| Consumer | Recommended path | Trade-off |
|---|---|---|
| In-repo CLI / tests | `hono/client` | Zero codegen, compile-time safety, requires the same TypeScript repo. |
| External TypeScript | `@hey-api/openapi-ts` against `openapi.json` | One generation step, no runtime dep on the server's TS code. |
| Python / Go / Rust / Java | Any OpenAPI codegen of the team's choice (`openapi-generator`, `oapi-codegen`, etc.) against `openapi.json` | Familiar tooling per language; the engine commits to a stable OpenAPI 3.1 surface. |

## Single-route definition pattern

Every route follows the same skeleton: define the input and output Zod schemas, declare the route metadata, register the handler. The route export is what `hono/client` and `openapi.json` both read.

```ts
import { createRoute, z, OpenAPIHono } from "@hono/zod-openapi";

const ListWorkflowsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const WorkflowSummary = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  current_version: z.number().int(),
});

const ListWorkflowsResponse = z.object({
  data: z.array(WorkflowSummary),
  total: z.number().int(),
  has_more: z.boolean(),
});

export const listWorkflows = createRoute({
  method: "get",
  path: "/v1/workflows",
  tags: ["workflows"],
  request: { query: ListWorkflowsQuery },
  responses: {
    200: { content: { "application/json": { schema: ListWorkflowsResponse } }, description: "OK" },
  },
});

export const app = new OpenAPIHono().openapi(listWorkflows, async (c) => {
  const { limit, offset } = c.req.valid("query");
  const result = await listForTenant(c.var.principal.tenantId, limit, offset);
  return c.json(result, 200);
});
```

The route export carries every piece of information the engine needs:

1. **Runtime validation** — `c.req.valid("query")` reads the parsed and coerced query object.
2. **OpenAPI emission** — the same Zod schemas produce the schema entries in `openapi.json` automatically.
3. **Client types** — exporting the application type from the entry module gives `hc<AppType>(...)` the property tree the CLI uses.

Trade-off: every route file is one source of truth that touches three concerns at once, which makes them slightly heavier than a plain Hono route. The payoff is that it is impossible to ship an engine build whose runtime, documentation, and client types disagree about the shape of a request.

## Versioning policy

The contract is semver-tagged with the engine release. Every published binary ships a matching `openapi.json` artifact. Versioning rules:

| Change | Bump |
|---|---|
| New endpoint, new optional field on a request, new field on a response | minor |
| Bug fix that does not change the surface | patch |
| Removed endpoint, removed field, type narrowed, required-ness added, semantics changed | major |

Major bumps come with a deprecation window: the previous behaviour is kept reachable for at least one minor release after the deprecation is announced, with a `Deprecation` header on the affected endpoints. The deprecation window is documented in the release notes and in `openapi.json` itself via `x-deprecated-since` and `x-removal-target` extensions on the affected schema entries.

Trade-off: a hard deprecation window costs the engine one release worth of dual-coding for every breaking change, which keeps external clients from breaking on upgrade. The alternative — breaking on the bump — is cheaper for the engine but corrosive for downstream consumers, and that's exactly the audience the OpenAPI contract exists for.

## Release artifacts

Every tagged release publishes:

1. The compiled engine binaries per target.
2. `openapi.json` for that release, alongside a `CHANGELOG.md` excerpt.
3. A bundled TypeScript types package built from the same Zod schemas, for consumers that prefer types over codegen.

The release CI verifies that the served `/openapi.json` byte-matches the artifact for that tag, so a deployed binary is guaranteed to serve the same contract its release shipped with.
