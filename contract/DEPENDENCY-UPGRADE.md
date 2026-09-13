# Dependency baseline — 2026-09-13

This repository keeps its own copy of `dependency-baseline.json`. The six products remain independently buildable and deployable. Updating a copied baseline is a reviewed change, never a runtime dependency on a sibling checkout.

## Intended stack

- AI SDK 7.0.99 with matching stable provider packages; exact versions are in the baseline and manifests.
- React 19.3, Vite 8.3, Tailwind 4.3, TanStack Query/Router, Zod 4.6, MCP SDK 1.30, PostgreSQL client 8.23 where used.
- ESLint 10 and Prettier 3.9. Type checking explicitly invokes TypeScript 7.0.2 through the `@typescript/native` npm alias. The separate `typescript` API dependency remains 5.9.3 because openapi-typescript 7.13 requires the 5.x API. No forced peer resolution.
- Bun 1.4.2 for five products; ContentKit retains its Node 24.21.0 / npm 12.0.2 JavaScript server and separately locked cockpit. Node types follow the 24.x runtime.
- SubKit retains Hono and Drizzle; the other products retain their existing HTTP/database architecture. No shared service, database, authority model, or migration rewrite.

## Required verification

1. Use the pinned tools. Install from the checked-in lockfile (`bun install --frozen-lockfile`, or `npm ci` in both ContentKit scopes). Installation must not rewrite the lockfile.
2. Run `check:dependencies`: compare common declarations, installed direct resolutions, runtime pins and package-manager versions. Frozen installation and a clean Git diff additionally establish lockfile consistency; this script does not claim to audit every transitive duplicate.
3. Run `check:ai-sdk`. Each OpenAI, Anthropic and Google provider talks to a local HTTP fixture through the real SDK: text/usage, streaming/usage, structured output, tool round trip, retryable 429, non-retryable 401, cancellation. No live model credentials or billed calls. Product tests additionally cover the surrounding orchestration; this probe does not cover every optional provider.
4. Run the repository's complete `gate` / `verify`, including ESLint, Prettier, explicit TypeScript 7 checks where applicable, generated-document/API drift, unit/contract tests, real PostgreSQL tests, browser behavior and compiled binaries. In SubKit, the existing isolated-test shards may cover the same complete test-file inventory. Run AI evals with the deterministic CI test key and mock provider; do not rewrite eval floors to conceal a failure.
5. Regenerate changed artifacts with their generators, review the diff, stage the expected result, then repeat drift checks. Preserve byte-sensitive CSS/CSP and historical migration bytes. Never automatically accept screenshot baselines.
6. Audit the complete resolved tree including development dependencies. High/critical findings block acceptance. Document remaining advisories with their dependency path and reachability.
7. Native CI builds and executes artifacts on Linux x64/arm64, macOS x64/arm64 and Windows x64. Linux jobs also build and execute the Docker image. A macOS build or cross-compiled file is not proof that the other targets execute. Existing browser screenshot authority remains the canonical judge.

## Compatibility exceptions and review notes

- ContentKit: FloatingVue 5.3.0 is pinned. 5.4.0 breaks Slidev's Twoslash integration (`components.Popper`); the real deck browser check passes with 5.3.0.
- SubKit: SheetJS 0.20.3 is vendored from the official download with SHA256 documented in `vendor/README.md`; npm's 0.18.5 is not an acceptable security downgrade. pdf-parse/pdfjs and Transformers/ONNX packages remain compatible tested pairs, including the upstream ONNX prerelease coupling. jsdom 30.0.1 retains the reviewed standalone-binary asset patch.
- Zod's generated JSON Schema changes include nullable type unions and updated email/datetime patterns. In particular, RFC3339 datetime validation now requires seconds. These are upstream validation changes requiring API compatibility review; generated artifacts are not evidence of identical acceptance behavior.
- The ESLint migration preserves existing explicit suppressions with their reasons. SubKit currently reports warnings for existing import-type/unused-variable/hook issues; zero lint errors is not a claim that every warning was eliminated or that ESLint and Biome have identical rule semantics.
- Local verification evidence and remote CI results must be reported separately. This change does not deploy, publish a release, or authorize business actions.

## Remaining audit finding

`drizzle-kit@0.31.10 → @esbuild-kit/esm-loader@2.6.5 → @esbuild-kit/core-utils@3.3.2 → esbuild@0.18.20`: moderate GHSA-67mh-4wv8-2f99, concerning the esbuild development server. This path is development tooling; the application uses embedded SQL migrations and does not expose that development server. Drizzle Kit is already its current stable version. `bun why esbuild` is the dependency-path evidence; npm's tree inspector misinterprets development edges in Bun's isolated store.
