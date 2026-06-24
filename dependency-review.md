# Dependency Review — subkit

**Scope:** review-only audit of all ~111 npm dependencies (root `package.json`), comparing the
lockfile-installed version against the latest on npm + GitHub, with deep changelog/new-feature/risk
analysis on the strategically important set. No code or `package.json` changes are part of this report.

**Method:** `bun outdated` + `bun audit` (Bun 1.3.13) for the exact version + security snapshot, then a
`domain-architect`-led fan-out of per-cluster research agents that read our actual import sites and the
upstream release notes. Every breaking-change / new-feature claim below is backed by a primary source
(npm changelog or GitHub release); unverifiable claims were dropped.

**Baseline:** subkit @ v7.10.2 (`main`). Runtime: Bun 1.3.13, no `engines` constraint. AI SDK packages
are intentionally exact-pinned — recommendations respect that.

---

## 1. Executive summary

- **91 audit advisories** (3 critical, 40 high, 43 moderate, 5 low) — but almost all are **transitive
  and off the served path**. Only **4 direct deps** carry actionable security exposure: `xlsx`,
  `basic-ftp`, `ws`, and `@opentelemetry/auto-instrumentations-node`.
- **52 packages are behind latest**; the large majority are safe patch/minor bumps.
- **7 declared dependencies are entirely unused** (zero import sites, verified by grep) — removing them
  is the single highest-leverage action: it deletes audit surface (including one direct HIGH advisory)
  with zero behavioral risk.
- **No high-value runtime dependency has a breaking change that affects us.** The two most-feared
  surfaces — Zod's `toJSONSchema` output (gates the LLM tool loop + MCP) and the AI SDK cache-control
  shape (gates ~90% cache-read cost) — were both verified **shape-stable**.

### Top recommended actions (in priority order)

| # | Action | Why | Risk |
|---|---|---|---|
| 1 | **`xlsx` → CDN tarball `0.20.3`** | Only advisory where untrusted input reaches a prototype-pollution/ReDoS sink (docs-ingestion parses uploaded workbooks). Drop-in; same `XLSX.read` API. | low |
| 2 | **Remove 7 unused deps** (see §2.2) | Clears a direct HIGH advisory (`auto-instrumentations-node`) by removal + shrinks audit surface. | none |
| 3 | **`basic-ftp` → `5.3.1`** (lockfile only) | Fixes HIGH client-side DoS; reachable via user-supplied FTP DSN. **Not** the v6 major — `^5.3.0` already admits the fix. | low |
| 4 | **`@slack/web-api` → `7.17.0`** | Single most efficient transitive fix: clears the entire `axios` + `form-data` HIGH cluster on the shipped Slack path (7.17 pins axios ^1.16). | low |
| 5 | **`ws` → `8.21.0`** | Clears HIGH memory-exhaustion DoS. Near-zero real risk (no direct usage) but audit-clean. | low |
| 6 | **Bump the AI SDK cluster together** to latest | Lands the anthropic `3.0.77` stream cache-usage fix (cost telemetry fidelity) + Opus 4.6 support + free security patches in `ai`/`google`. | low |
| 7 | **OTel set → `0.219.0` / `2.8.0` together** | Clears transitive `@grpc/grpc-js` + `@protobufjs/utf8` + `exporter-prometheus` HIGH advisories. langfuse imposes no OTel ceiling. | low |

---

## 2. Security / must-fix

### 2.1 Direct-dependency advisories (actionable)

| Package | Installed | Advisory | Remediation | Exploitable in subkit? |
|---|---|---|---|---|
| **xlsx** | 0.18.5 | HIGH prototype-pollution ([GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)) + HIGH ReDoS ([GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)) | **CDN `0.20.3`** (`npm i -S https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) — npm registry is frozen at 0.18.5; SheetJS ships off-npm. `XLSX.read`/`sheet_to_json` API unchanged → drop-in. | **Yes** — `apps/engine/src/docs-ingestion/parsers/xlsx.ts` parses uploaded/knowledge-source workbooks. Existing 60s timeout partly mitigates ReDoS, not the prototype pollution. |
| **basic-ftp** | 5.3.0 | HIGH client-side DoS via unbounded multiline control response ([GHSA-rpmf-866q-6p89](https://github.com/advisories/GHSA-rpmf-866q-6p89)) | **`5.3.1`** — advisory range is `<=5.3.0`; `^5.3.0` already admits 5.3.1, so **lockfile bump only, not the v6 major**. v6 is optional and non-breaking for our `ftp.ts` usage but unnecessary. | **Yes** — connector points at arbitrary user-supplied FTP/FTPS DSN. |
| **ws** | 8.20.0 | HIGH memory-exhaustion DoS ([GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p)) + MODERATE uninit-memory ([GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx)) | **`8.21.0`** (fixes both). | **No direct usage** — declared dep with zero `import "ws"` in source; consumed only transitively. Bump for hygiene. |
| **@opentelemetry/auto-instrumentations-node** | 0.72.0 | HIGH Prometheus-exporter crash ([GHSA-q7rr-3cgh-j5r3](https://github.com/advisories/GHSA-q7rr-3cgh-j5r3)) | **Remove** (see §2.2) — zero import sites; never loaded. | **No** — not on any loaded path. |

### 2.2 Unused dependencies — remove rather than bump (verified zero import sites)

`grep` over `apps/`, `packages/`, `scripts/` returns **0** import files for each:

| Package | Note |
|---|---|
| `@opentelemetry/auto-instrumentations-node` | Carries a direct HIGH advisory; removal clears it. `tracing.ts` builds `NodeSDK` with a manual exporter only. |
| `pino`, `pino-http`, `pino-opentelemetry-transport`, `pino-pretty` | The logger (`apps/engine/src/logging/logger.ts`) is a custom `picocolors` implementation; pino is never imported. |
| `drizzle-zod` | No `createInsertSchema`/`createSelectSchema` anywhere. |
| `zod-validation-error` | No import sites. |
| `@anthropic-ai/tokenizer` | Never imported; tokenization is `js-tiktoken` (`apps/engine/src/llm/accounting/count.ts`). |
| `@hono/otel`, `stoker`, `hono-rate-limiter` | Declared but no import sites. |
| `cockatiel` | Declared `^3.2.1` but zero imports — a dead dep. (Its v4 is ESM-only/Node≥22; irrelevant. Adopt fresh later if circuit-breaking is wanted.) |
| `testcontainers` (consider) | Effectively dead: the sole import (`s3-driver.test.ts`) uses it only as a capability probe, then deliberately starts MinIO via `Bun.spawn("docker run")` due to a Bun/testcontainers hang. `createTestDb` does **not** use it. Dropping it also removes its transitive `@grpc/grpc-js`/`brace-expansion`/`uuid` advisories. |

> Removing the unused set is the cleanest way to cut the 91-advisory count: it deletes whole transitive
> subtrees (pino→OTel transports, testcontainers→grpc/protobuf/brace-expansion) without touching behavior.

### 2.3 Notable transitive advisories — fix by parent bump

| Advisory | Sev | Path (introduced by) | Shipped/dev | Fix |
|---|---|---|---|---|
| `axios` prototype-pollution / proxy-cred-leak / ReDoS (20+) | HIGH | `@slack/web-api` (shipped), `openapi-diff` (dev) | shipped | **`@slack/web-api` → 7.17.0** (pins axios ^1.16) clears all `<1.16` advisories + pulls `form-data` ≥4.0.6 |
| `form-data` CRLF injection ([GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx)) | HIGH | via axios → @slack/web-api | shipped | resolves with the axios bump above |
| `@grpc/grpc-js` + `@protobufjs/utf8` crashes | HIGH/mod | OpenTelemetry exporters, testcontainers | shipped | **OTel set → 0.219.0** (grpc-js 1.14.4, protobufjs/utf8 1.1.1), or drop testcontainers |
| `fast-uri` host-confusion / path-traversal | HIGH | `ajv` → fast-uri | shipped (via MCP-sdk) + dev | needs `overrides: fast-uri@^4` — ajv's `^3` range won't auto-widen; bumping ajv 8.18→8.20 alone does **not** clear it |
| `qs` DoS ([GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26)) | MODERATE | `@modelcontextprotocol/sdk` → express | shipped (but off subkit's served path — engine mounts MCP on Hono, not express) | already resolves to qs 6.15.1; `overrides: qs@^6.15.2` to fully clear |
| `shell-quote` newline-escape ([GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p)) | CRITICAL (CVSS) | `react-devtools-core` → shell-quote | **dev/CLI-only**, non-shipping | lowest urgency; `overrides: shell-quote@^1.8.4` or bump react-devtools-core |
| `uuid` bounds-check, `brace-expansion` DoS | MODERATE | resend/mssql/langchain; ts-morph/openapi-typescript | mixed | not exploitable in our usage (no `uuid.v5(...,buf)`; build-time glob only); `overrides` to silence audit |

---

## 3. Needs update (ranked)

### 3.1 Safe bumps — no code change expected

| Package | Current → Latest | Gap | Note |
|---|---|---|---|
| AI SDK cluster: `ai` → 6.0.209, `@ai-sdk/anthropic` → 3.0.86, `@ai-sdk/openai` → 3.0.74, `@ai-sdk/google` → 3.0.83, `@ai-sdk/google-vertex` → 4.0.149, `@ai-sdk/azure` → 3.0.77, `@ai-sdk/amazon-bedrock` → 4.0.121 | patch | Bump as one set (shared `provider-utils` peer train). cacheControl + `providerMetadata.anthropic.usage.*` shapes verified unchanged. `@ai-sdk/provider` already latest (3.0.10). |
| `zod` | 4.3.6 → 4.4.3 | minor | `toJSONSchema` output verified stable (only change is a redundant `$defs.id` strip, no exposure). Zero exposure to the 4.4.0 parse-behavior breaks (no `z.undefined()`, no tuple defaults). |
| `@hono/zod-openapi` | 1.3.0 → 1.4.0 | minor | Bump **together** with zod (single graph, peer admits 4.4.x; hono peer `>=4.10` satisfied). |
| `hono` | 4.12.12 → 4.12.27 | patch | — |
| `@hono/node-server` | 1.19.14 → 2.0.6 | MAJOR | Safe on Bun: `serve({fetch,port,hostname})` signature unchanged; v2 only drops Node 18 + the Vercel adapter (neither used). Verify `.close()` shutdown once. |
| `pg` | 8.20.0 → 8.22.0 | minor | Global-Pool pattern unaffected. Adds `sslnegotiation=direct` (latent perf for PG17+TLS). |
| `pg-boss` | 12.15.0 → 12.21.1 | minor | `getQueues()`/`createQueue({deadLetter})`/lifecycle shapes verified unchanged. |
| OTel set: `@opentelemetry/sdk-node` → 0.219.0, `sdk-trace-node` → 2.8.0, `exporter-trace-otlp-http` → 0.219.0 | minor (0.x/2.x) | Bump as one locked set; hold `@opentelemetry/api` at 1.9.1 (peers require `<1.10`). Clears transitive grpc/protobuf advisories. |
| `@biomejs/biome` | 2.4.11 → 2.5.1 | minor | **Gate behind a `biome check` dry-run** — 2.5.0 promoted 73 nursery rules; `noReturnAssign`/`noProto`/`useGlobalThis` may newly fire. New: `useSortedPackageJson` assist. |
| `react` → 19.2.7, `ink` → 7.1.0, `@types/react` → 19.2.17 | patch/minor | ink peers `react >=19.2` (satisfied). ink 7.1 adds `suspendTerminal()` — useful for TUI subprocess handoff. |
| `playwright` | 1.59.1 → 1.61.1 | minor | Crawler API (`goto`/`content`/`evaluate`) unchanged; bundled Chromium ~149. Triggers a browser re-download on CI. |
| `@clack/prompts` | 1.2.0 → 1.6.0 | minor | Adds Standard Schema validation (fits sk's zod-first surface). Eyeball the `note()` styling change. |
| Leaf bumps: `@napi-rs/keyring` 1.3.0, `@slack/web-api` 7.17.0, `cron-parser` 5.6.0, `dayjs` 1.11.21, `eventsource-parser` 3.1.0, `fuse.js` 7.4.2, `jsonata` 2.2.1, `mssql` 12.6.0, `normalize-url` 9.0.1, `openid-client` 6.8.4, `resend` 6.14.0, `string-width` 8.2.1, `yauzl` 3.4.0 | patch/minor | All drop-in. |
| Dev: `bun-types` 1.3.14, `ajv` 8.20.0, `msw` 2.14.6, `@ai-sdk/devtools` 0.0.20, `@types/yauzl` 3.4.0 | patch/minor/major(types) | `@types/yauzl` v3 is types-only, works on current TS5.9. |

### 3.2 Plan deliberately (major / needs a guard or smoke test)

| Package | Current → Latest | Why it needs care |
|---|---|---|
| `typescript` + `@types/node` + `bun-types` | 5.9.3 → **6.0.3**, 25.6.0 → **26.0.0**, → 1.3.14 | Atomic 3-way bump. TS6 keeps every `tsconfig.base.json` option; `types:["bun-types"]` dodges the v6 `types:[]` footgun; new `noUncheckedSideEffectImports` default has zero exposure (no side-effect imports). `@types/node` v26 dist-tags support both TS5.9 and TS6. Run full `tsc` after. Do **not** jump to the TS `7.0.x-rc` (separate Go-rewrite track). |
| `js-yaml` | 4.1.1 → **5.1.0** (MAJOR) | Only 2 import sites (both `load`), so removed-symbol breaks don't apply — **but** v5 `load()` **throws on empty input** (v4 returned `undefined`). Both sites parse *remote/fetched* YAML that can be empty (`openapi-direct.ts`, `cascade.ts`). Add empty-input guards **before** bumping. |
| `redis` | 5.12.1 → **6.0.0** (MAJOR) | One driver (`drivers/redis.ts`); commands used return scalars (RESP2/RESP3-identical), so low risk — but v6 defaults to **RESP3**. Smoke-test get/set/publish or pin `RESP: 2` in `createClient`. |
| `graphql` | 16.13.2 → **17.0.1** (MAJOR) | 4 import sites, all schema/introspection helpers with unchanged signatures. Real risk is the Node `^22+` engine field + ESM-first packaging; Bun has no `engines` gate but **smoke-test a GraphQL introspection** before shipping. |
| `testcontainers` | 11.14.0 → **12.0.3** (MAJOR) | Integration-test infra only, and effectively unused (see §2.2). v12 needs Node ≥22.22 + changes default wait strategy. Prefer **dropping** over bumping. |
| `@electric-sql/pglite` | 0.4.4 → **0.5.3** (0.x minor = breaking) | Confirm whether `apps/engine/src/db/tests/setup.ts` uses pglite vs shared PG; run the db test layer before accepting. |
| `drizzle-orm` / `drizzle-kit` | already newest **stable** (0.45.2 / 0.31.10) | **Nothing to bump** — 1.0 is still `rc` (`1.0.0-rc.3`), not on `latest`. 1.0 is a planned future major (JIT row mappers ~25-30% faster, Relational Query Builder v2, new casing API) that must move in lockstep and be validated against the snake_case casing + migration-diff CI gate. |

---

## 4. Useful new features worth adopting

Even where we're not forced to upgrade, these capabilities are worth pulling in:

- **`@ai-sdk/anthropic` 3.0.77 — stream cache-usage reporting fix.** subkit reads
  `providerMetadata.anthropic.usage.cache_read_input_tokens`/`cache_creation_input_tokens` for cost
  telemetry, and is ~90% cache-reads. This fix improves the fidelity of exactly those numbers. Highest-
  value adoption in the AI cluster. ([changelog](https://raw.githubusercontent.com/vercel/ai/main/packages/anthropic/CHANGELOG.md))
- **`@ai-sdk/anthropic` 3.0.85 — Opus 4.6 model support**, and security/SSRF/prototype-pollution
  hardening across the `ai` 6.0.x and `@ai-sdk/google` 3.0.81 gap — free defensive upgrades.
- **`zod` 4.4 — `globalConfig` via `globalThis`** (fixes locale/config drift when mixed ESM/CJS copies
  load zod — relevant to a Bun-compiled binary) and **`ZodCodec.invert()`** (subkit uses codecs).
  ([4.4.0 release](https://github.com/colinhacks/zod/releases/tag/v4.4.0))
- **`ink` 7.1 — `suspendTerminal()`**: hands the terminal to a child process then resumes the TUI —
  the clean primitive for sk's interactive subprocess handoffs (editor/pager/OAuth browser).
  ([v7.1.0](https://github.com/vadimdemedes/ink/releases/tag/v7.1.0))
- **`@clack/prompts` 1.5 — Standard Schema validation**: prompts validate directly against a zod schema,
  a natural fit for sk's zod-first surface.
- **`@biomejs/biome` 2.5 — `useSortedPackageJson` assist** (subkit has many manifests) + `--watch` mode.
- **`pg` 8.22 — `sslnegotiation=direct`** (PG17+ direct-SSL, saves a TLS round-trip) — latent infra win.
- **(Future major) `drizzle-orm` 1.0 — JIT row mappers (~25-30% mapping-latency reduction) + RQB v2.**
  Track for when 1.0 leaves rc; meaningful for the hot query paths.

---

## 5. Hold / blocked

- **AI SDK exact pins** are intentional and correct — recommend bumping the pinned versions as a
  coordinated set, **not** normalizing to carets (keeps the `provider-utils` peer train consistent).
- **`@modelcontextprotocol/sdk`** is already latest (1.29.0); all deep subpaths subkit imports are
  present/stable, and the express→qs concern is already resolved (qs 6.15.1). MCP 2.x is alpha — a
  future major with its own migration. **Hold.**
- **`jsdom` (patched) + `css-tree` (patched)**: both are already at npm-latest (29.1.1 / 3.2.1) with
  **no open advisory**. The local patches (`patches/*.patch`) are Bun `--compile` build-portability
  fixes (inlining stylesheet/JSON requires), not CVE patches — they still apply and remain needed.
  **No action**; if jsdom ever ships a major past 29.x, the line-context patch must be re-based.
- **`@opentelemetry/api`**: hold at 1.9.1 — the OTel SDK peers require `<1.10.0`.
- **`langfuse` / `langfuse-vercel`**: 3.38.20 is latest (no v4 exists); imposes no OTel ceiling. Hold.
  If the OTel set is bumped, runtime-smoke that `LangfuseExporter` still satisfies `SpanExporter@2.8`
  (it's duck-typed via `as any`, so `tsc` won't catch drift).
- **`c12`**: on the 4.0 beta track (`4.0.0-beta.5` is `latest`; stable line is 3.x). Staying on the beta
  is the only way to be "current"; no stable 4.0 yet.

---

## 6. Cross-cutting risks (architect sanity pass)

- **zod → LLM + MCP + OpenAPI.** A zod `toJSONSchema` output change would silently break the submit/abort
  tool loop (`invoke.ts`, `repair-tool-call.ts`) and MCP `inputSchema` (`mcp/adapter.ts`,
  `mcp/capabilities/tenant-tools.ts`) — all reached via `(z as any)`, invisible to `tsc`. **Verified
  stable for 4.3.6→4.4.3**, but this is the surface to re-check on every future zod bump. Bump zod and
  `@hono/zod-openapi` **together** to avoid a dual-zod graph across the ~200 `.openapi()` route sites.
- **drizzle `transaction` signature → `Executor` type → every service.** The `Executor` type is derived
  structurally from drizzle's transaction callback; a drizzle major (1.0) would ripple to audit/llm/all
  services as a typecheck-gate canary. Stable at the current pin.
- **TS6 × @types/node v26 × bun-types** is one atomic bump — don't split.
- **OTel SDK packages are internally version-locked** (`sdk-node` pins exact `core`/`sdk-trace-*`) — move
  the set together or npm dedupes to mismatched copies.

---

## 7. Appendix — full version snapshot

Source: `bun outdated` (Bun 1.3.13). Packages not listed are already at latest. "Current" = lockfile-installed.

### Runtime
| Package | Current | Latest | Gap |
|---|---|---|---|
| @ai-sdk/amazon-bedrock | 4.0.83 | 4.0.121 | patch |
| @ai-sdk/anthropic | 3.0.64 | 3.0.86 | patch |
| @ai-sdk/azure | 3.0.49 | 3.0.77 | patch |
| @ai-sdk/google | 3.0.53 | 3.0.83 | patch |
| @ai-sdk/google-vertex | 4.0.95 | 4.0.149 | patch |
| @ai-sdk/openai | 3.0.48 | 3.0.74 | patch |
| @clack/prompts | 1.2.0 | 1.6.0 | minor |
| @hono/node-server | 1.19.14 | 2.0.6 | MAJOR |
| @hono/otel | 1.1.1 | 1.1.2 | patch (unused — drop) |
| @hono/zod-openapi | 1.3.0 | 1.4.0 | minor |
| @napi-rs/keyring | 1.2.0 | 1.3.0 | minor |
| @opentelemetry/auto-instrumentations-node | 0.72.0 | 0.77.0 | minor — unused, HIGH advisory → drop |
| @opentelemetry/exporter-trace-otlp-http | 0.214.0 | 0.219.0 | minor |
| @opentelemetry/sdk-node | 0.214.0 | 0.219.0 | minor |
| @opentelemetry/sdk-trace-node | 2.6.1 | 2.8.0 | minor |
| @slack/web-api | 7.15.1 | 7.17.0 | minor (clears axios cluster) |
| ai | 6.0.159 | 6.0.209 | patch |
| basic-ftp | 5.3.0 | 6.0.1 | (fix at 5.3.1 — HIGH) |
| c12 | 4.0.0-beta.4 | 4.0.0-beta.5 | prerelease |
| cockatiel | 3.2.1 | 4.0.0 | MAJOR (unused — drop) |
| cron-parser | 5.5.0 | 5.6.0 | minor |
| dayjs | 1.11.20 | 1.11.21 | patch |
| eventsource-parser | 3.0.6 | 3.1.0 | minor |
| fuse.js | 7.3.0 | 7.4.2 | minor |
| graphql | 16.13.2 | 17.0.1 | MAJOR (16.14.2 in-range) |
| hono | 4.12.12 | 4.12.27 | patch |
| ink | 7.0.0 | 7.1.0 | minor |
| jose | 6.2.2 | 6.2.3 | patch |
| js-yaml | 4.1.1 | 5.1.0 | MAJOR (4.2.0 in-range) |
| jsonata | 2.1.0 | 2.2.1 | minor |
| mssql | 12.3.1 | 12.6.0 | minor |
| normalize-url | 9.0.0 | 9.0.1 | patch |
| openid-client | 6.8.3 | 6.8.4 | patch |
| pg | 8.20.0 | 8.22.0 | minor |
| pg-boss | 12.15.0 | 12.21.1 | minor |
| playwright | 1.59.1 | 1.61.1 | minor |
| react | 19.2.5 | 19.2.7 | patch |
| redis | 5.12.1 | 6.0.0 | MAJOR |
| resend | 6.12.0 | 6.14.0 | minor |
| string-width | 8.2.0 | 8.2.1 | patch |
| ws | 8.20.0 | 8.21.0 | minor — HIGH advisory |
| yauzl | 3.3.0 | 3.4.0 | minor |
| zod | 4.3.6 | 4.4.3 | minor |

Direct deps with security advisories not shown above because already at npm-latest: **xlsx** 0.18.5
(fix off-npm at CDN 0.20.3).

### Dev / tooling
| Package | Current | Latest | Gap |
|---|---|---|---|
| @ai-sdk/devtools | 0.0.17 | 0.0.20 | patch |
| @biomejs/biome | 2.4.11 | 2.5.1 | minor |
| @electric-sql/pglite | 0.4.4 | 0.5.3 | minor (0.x = breaking) |
| @types/node | 25.6.0 | 26.0.0 | MAJOR |
| @types/react | 19.2.14 | 19.2.17 | patch |
| @types/yauzl | 2.10.3 | 3.4.0 | MAJOR (types-only) |
| ajv | 8.18.0 | 8.20.0 | minor |
| bun-types | 1.3.12 | 1.3.14 | patch |
| msw | 2.13.4 | 2.14.6 | minor |
| testcontainers | 11.14.0 | 12.0.3 | MAJOR (effectively unused — drop) |
| typescript | 5.9.3 | 6.0.3 | MAJOR |

### Unused (drop, don't bump) — verified zero import sites
`@opentelemetry/auto-instrumentations-node`, `pino`, `pino-http`, `pino-opentelemetry-transport`,
`pino-pretty`, `drizzle-zod`, `zod-validation-error`, `@anthropic-ai/tokenizer`, `@hono/otel`,
`stoker`, `hono-rate-limiter`, `cockatiel`; `testcontainers` (probe-only, bypassed via `Bun.spawn`).
