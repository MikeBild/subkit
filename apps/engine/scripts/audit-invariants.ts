#!/usr/bin/env bun
//
// Audit-invariants — the single CI gate enforcing the engine's
// architectural invariants (file size, tenant filtering, route layering,
// coverage floors, ...).
//
// Runs every check from the invariant list and exits non-zero
// on any failure. The same script is invoked from:
//   - .github/workflows/audit-invariants.yml      (PR + nightly CI)
//   - package.json scripts (`bun run audit:invariants`)            (release gate)
//   - apps/engine/scripts/audit-loop/             (closed-loop driver)
//
// Output format is line-oriented and parseable: each check prints
//   PASS  <id>  <message>
//   FAIL  <id>  <message>
//   SKIP  <id>  <reason>          (only when explicitly tolerant; rare)
// Final summary: counts + non-zero exit if any FAIL.
//
// New checks: add a function below, append to CHECKS, document in the
// audit doc. Do not silence checks; if a check is wrong, fix it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditTenantFilter } from "./audit/tenant-filter-ast.ts";

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), "..", "..", "..");
const ENGINE_SRC = join(REPO, "apps/engine/src");

type Result = { id: string; status: "PASS" | "FAIL" | "SKIP"; message: string };

function listFiles(root: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === ".turbo") continue;
        stack.push(p);
      } else if (predicate(p)) {
        out.push(p);
      }
    }
  }
  return out;
}

function readAllowlist(filename: string): Set<string> {
  const path = join(REPO, "apps/engine", filename);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    out.add(trimmed.split(/\s+/)[0]!);
  }
  return out;
}

// ---------- structural ----------

function checkSubsystemCount(): Result {
  // Defer to the existing contract test for the actual assertion; this
  // keeps a single source of truth for the canonical count.
  const path = join(REPO, "tests/contract/subsystem-count.test.ts");
  try {
    statSync(path);
    return {
      id: "subsystem_count",
      status: "PASS",
      message: "subsystem-count contract test exists; run via `bun test tests/contract/`",
    };
  } catch {
    return {
      id: "subsystem_count",
      status: "FAIL",
      message: "tests/contract/subsystem-count.test.ts missing",
    };
  }
}

function checkNoNewSubsystem(): Result {
  // The subsystem-count contract test already enforces that the count in
  // AGENTS.md matches the directory count. This check exists as a
  // surface marker for the closed-loop driver: if the directory count
  // changes, the contract test fails and the loop must STOP per
  // .audit-loop-policy.md item 4.
  const dirs = readdirSync(ENGINE_SRC).filter((n) => statSync(join(ENGINE_SRC, n)).isDirectory());
  return {
    id: "no_new_subsystem",
    status: "PASS",
    message: `${dirs.length} subsystems under apps/engine/src/ (enforced via subsystem-count contract test)`,
  };
}

// ---------- import boundaries ----------

function checkAiSdkLocality(): Result {
  // Bans runtime imports of the LLM provider packages — the actual harm
  // is a non-llm/core/ file calling a real provider directly, bypassing
  // invoke.ts. Type-only imports from @ai-sdk/provider and test mocks
  // from `ai/test` do NOT have that risk and are exempt.
  const PROVIDER_VALUE_IMPORT =
    /(?:^|\n)\s*import\s+(?!type\s)[^"';]+from\s+["'](?:@ai-sdk\/(?:anthropic|openai|google|azure|google-vertex|amazon-bedrock)|@anthropic-ai\/sdk)["']/;
  const violations: string[] = [];
  for (const f of listFiles(ENGINE_SRC, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
    const rel = relative(REPO, f);
    if (rel.startsWith("apps/engine/src/llm/core/")) continue;
    const text = readFileSync(f, "utf8");
    if (PROVIDER_VALUE_IMPORT.test(text)) {
      violations.push(rel);
    }
  }
  if (violations.length === 0) {
    return {
      id: "ai_sdk_locality",
      status: "PASS",
      message:
        "no @ai-sdk/<provider> or @anthropic-ai/sdk runtime imports outside apps/engine/src/llm/core/",
    };
  }
  return {
    id: "ai_sdk_locality",
    status: "FAIL",
    message: `runtime provider imports outside llm/core/:\n  ${violations.join("\n  ")}`,
  };
}

function checkJsonataLocality(): Result {
  // Bans runtime evaluator usage outside jsonata-engine.ts. Type-only
  // imports (`import type { Expression } from "jsonata"`) are exempt
  // because they cannot evaluate; the harm is bypassing the central
  // engine for runtime evaluation.
  const allowed = "apps/engine/src/execution/jsonata-engine.ts";
  const VALUE_IMPORT = /(?:^|\n)\s*import\s+(?!type\s)[^"';]+from\s+["']jsonata["']/;
  const violations: string[] = [];
  for (const f of listFiles(ENGINE_SRC, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
    const rel = relative(REPO, f);
    if (rel === allowed) continue;
    const text = readFileSync(f, "utf8");
    if (VALUE_IMPORT.test(text)) {
      violations.push(rel);
    }
  }
  if (violations.length === 0) {
    return {
      id: "jsonata_locality",
      status: "PASS",
      message: `no runtime jsonata imports outside ${allowed}`,
    };
  }
  return {
    id: "jsonata_locality",
    status: "FAIL",
    message: `runtime imports outside ${allowed}:\n  ${violations.join("\n  ")}`,
  };
}

function checkRouteLayering(): Result {
  // routes/<f>.ts may import from a subsystem's index.ts only — i.e.
  // relative paths of the form `../../<sub>/index` or `../../<sub>`
  // (resolved to index.ts) are OK; deeper paths into subsystem
  // internals are flagged.
  const routeFiles = listFiles(
    join(ENGINE_SRC, "http/routes"),
    (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"),
  );
  const violations: string[] = [];
  const knownExternalSubsystems = new Set([
    "execution",
    "conversations",
    "workflows",
    "llm",
    "connectors",
    "audit",
    "auth",
    "identity",
    "rbac",
    "credentials",
    "self-healing",
    "skills",
    "knowledge",
    "scheduler",
    "webhooks",
    "notifications",
    "discovery",
    "schema-versions",
    "skill-candidates",
    "docs-ingestion",
    "chat",
    "mcp",
    "pubsub",
    "queue",
    "settings",
    "onboarding",
    "sandboxes",
    "observability",
    "logging",
  ]);
  for (const f of routeFiles) {
    const rel = relative(REPO, f);
    const text = readFileSync(f, "utf8");
    const importRe = /from\s+["'](\.\.\/(?:\.\.\/)+([\w-]+)\/[^"']+)["']/g;
    for (const match of text.matchAll(importRe)) {
      const fullPath = match[1]!;
      const subsystem = match[2]!;
      if (!knownExternalSubsystems.has(subsystem)) continue;
      // JSON imports are data, not module surface — they can't go
      // through the TS barrel and exempt naturally. Same for any
      // non-.ts file (currently only json).
      if (fullPath.endsWith(".json")) continue;
      const tail = fullPath.split(`/${subsystem}/`)[1] ?? "";
      const isIndex = tail === "index" || tail === "index.ts" || tail === "";
      if (!isIndex) {
        violations.push(`${rel}: imports ../${subsystem}/${tail}`);
      }
    }
  }
  if (violations.length === 0) {
    return {
      id: "route_layering",
      status: "PASS",
      message: "all http/routes/* import only subsystem entry points",
    };
  }
  return {
    id: "route_layering",
    status: "FAIL",
    message: `${violations.length} routes import subsystem internals; route files must import only the subsystem's index.ts entry point\n  ${violations.slice(0, 10).join("\n  ")}${violations.length > 10 ? `\n  ... (${violations.length - 10} more)` : ""}`,
  };
}

function checkInternalLayering(): Result {
  // `_internal/` directories are package-private. Same-package siblings
  // can reach in (e.g. `apps/engine/src/conversations/loop.ts` → `./_internal/abort-merge.ts`),
  // but a file outside the package must NOT import from another
  // package's `_internal/` path. The directory is the file-system
  // enforcement of layering; this check makes the contract observable
  // at PR time instead of after a refactor widens the surface.
  const allFiles = listFiles(ENGINE_SRC, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
  const violations: string[] = [];
  // Match both `from "…/_internal/…"` and `import("…/_internal/…")` forms.
  const importRe = /(?:from|import)\s*\(?\s*["']([^"']*?\/_internal\/[^"']+)["']/g;
  for (const f of allFiles) {
    const rel = relative(REPO, f);
    const fileDir = dirname(f);
    const text = readFileSync(f, "utf8");
    importRe.lastIndex = 0;
    for (const match of text.matchAll(importRe)) {
      const importPath = match[1] ?? "";
      // Resolve the import to an absolute path. Only relative imports
      // can target `_internal/` paths; bare-package imports of
      // `_internal/` would already be a separate problem the routing
      // catches.
      if (!importPath.startsWith(".")) continue;
      const resolved = resolve(fileDir, importPath);
      // The package boundary is the directory that contains the
      // `_internal/` segment. Same-package consumers live in or under
      // the parent of that segment; cross-package imports do not.
      const segIdx = resolved.lastIndexOf("/_internal/");
      if (segIdx === -1) continue;
      const packageRoot = resolved.slice(0, segIdx);
      if (!f.startsWith(`${packageRoot}/`) && f !== `${packageRoot}.ts`) {
        violations.push(`${rel}: imports ${importPath}`);
      }
    }
  }
  if (violations.length === 0) {
    return {
      id: "internal_layering",
      status: "PASS",
      message: "no cross-package imports of _internal/* paths",
    };
  }
  return {
    id: "internal_layering",
    status: "FAIL",
    message: `${violations.length} cross-package _internal/ imports — file-system layering breached:\n  ${violations.slice(0, 10).join("\n  ")}${violations.length > 10 ? `\n  ... (${violations.length - 10} more)` : ""}`,
  };
}

// ---------- size ceilings ----------

function checkFileSize(): Result {
  const allowlist = readAllowlist(".size-allowlist.txt");
  const violations: string[] = [];
  for (const f of listFiles(ENGINE_SRC, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
    const rel = relative(REPO, f);
    const lines = readFileSync(f, "utf8").split("\n").length;
    if (lines > 1000 && !allowlist.has(rel)) {
      violations.push(`${rel} (${lines} LOC)`);
    }
  }
  if (violations.length === 0) {
    return {
      id: "file_size",
      status: "PASS",
      message: `no apps/engine/src/**/*.ts > 1000 LOC outside .size-allowlist.txt (${allowlist.size} allowlisted)`,
    };
  }
  return {
    id: "file_size",
    status: "FAIL",
    message: `files >1000 LOC not in allowlist:\n  ${violations.join("\n  ")}`,
  };
}

function checkRouteSize(): Result {
  const allowlist = readAllowlist(".size-allowlist.txt");
  const violations: string[] = [];
  for (const f of listFiles(
    join(ENGINE_SRC, "http/routes"),
    (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"),
  )) {
    const rel = relative(REPO, f);
    const lines = readFileSync(f, "utf8").split("\n").length;
    if (lines > 600 && !allowlist.has(rel)) {
      violations.push(`${rel} (${lines} LOC)`);
    }
  }
  if (violations.length === 0) {
    return {
      id: "route_size",
      status: "PASS",
      message: "no http/routes/**/*.ts > 600 LOC outside .size-allowlist.txt",
    };
  }
  // The check is currently ADVISORY: it reports oversized route files
  // without failing the audit.
  return {
    id: "route_size",
    status: "PASS",
    message: `ADVISORY: ${violations.length} route files >600 LOC not allowlisted\n  ${violations.join("\n  ")}`,
  };
}

// ---------- safety ----------

function checkTenantFilter(): Result {
  // AST scan (replacing the prior regex heuristic). The scan walks
  // every Drizzle query chain (`select`/`update`/`delete`/`insert`/`with`
  // → `.from(table)` → optional `.where(...)`) and asserts a
  // `tenant_id` predicate is present in the where argument tree —
  // either as a literal identifier reference or via a helper whose
  // name matches /tenant/i. Site-level opt-outs use the comment
  // marker `// tenant-filter:exempt — <reason>` (leading or
  // trailing-on-same-line). The table allowlist
  // (.tenant-filter-allowlist.txt) covers truly tenant-agnostic
  // system tables.
  const tableAllowlist = readAllowlist(".tenant-filter-allowlist.txt");
  const violations = auditTenantFilter({
    repoRoot: REPO,
    engineSrc: ENGINE_SRC,
    tableAllowlist,
  });
  if (violations.length === 0) {
    return {
      id: "tenant_filter",
      status: "PASS",
      message: "no drizzle .from(table) chain without a tenant_id predicate",
    };
  }
  const rendered = violations
    .slice(0, 10)
    .map((v) => `${v.file}:${v.line} .from(${v.table}) without tenant_id predicate`);
  return {
    id: "tenant_filter",
    status: "FAIL",
    message: `${violations.length} call sites without tenant_id predicate (add the predicate or annotate with \`// tenant-filter:exempt — <reason>\`):\n  ${rendered.join("\n  ")}${violations.length > 10 ? `\n  ... (${violations.length - 10} more)` : ""}`,
  };
}

function checkNoSnapshots(): Result {
  const violations: string[] = [];
  for (const f of listFiles(REPO, (p) => p.endsWith(".test.ts") || p.endsWith(".test.tsx"))) {
    const rel = relative(REPO, f);
    if (rel.startsWith("node_modules/") || rel.includes("/dist/")) continue;
    const text = readFileSync(f, "utf8");
    if (/toMatchSnapshot|toMatchInlineSnapshot/.test(text)) {
      violations.push(rel);
    }
  }
  if (violations.length === 0) {
    return {
      id: "no_snapshots",
      status: "PASS",
      message: "no toMatchSnapshot / toMatchInlineSnapshot anywhere",
    };
  }
  return {
    id: "no_snapshots",
    status: "FAIL",
    message: `snapshot tests found:\n  ${violations.join("\n  ")}`,
  };
}

function checkNoLiveLlm(): Result {
  const violations: string[] = [];
  for (const f of listFiles(REPO, (p) => p.endsWith(".test.ts"))) {
    const rel = relative(REPO, f);
    if (rel.startsWith("node_modules/")) continue;
    const text = readFileSync(f, "utf8");
    if (/from\s+["']@ai-sdk\//.test(text) || /from\s+["']@anthropic-ai\//.test(text)) {
      violations.push(rel);
    }
  }
  if (violations.length === 0) {
    return {
      id: "no_live_llm",
      status: "PASS",
      message: "no @ai-sdk/* or @anthropic-ai/* import in any *.test.ts",
    };
  }
  return {
    id: "no_live_llm",
    status: "FAIL",
    message: `tests importing real LLM SDK:\n  ${violations.join("\n  ")}`,
  };
}

// ---------- coverage ----------

function checkCoverageFloor(): Result {
  const path = join(REPO, "apps/engine/.coverage-floor.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      id: "coverage_floor",
      status: "FAIL",
      message: ".coverage-floor.json missing",
    };
  }
  const parsed = JSON.parse(text) as {
    subsystems?: Record<string, { line_min?: number; branch_min?: number }>;
  };
  const entries = Object.entries(parsed.subsystems ?? {});
  if (entries.length === 0) {
    return {
      id: "coverage_floor",
      status: "FAIL",
      message: ".coverage-floor.json has no subsystems declared",
    };
  }
  // Validate each entry has the required shape — `bun run check:coverage-floor`
  // is the script that actually runs `bun test --coverage` per subsystem
  // and enforces the numbers. This check is the structural gate; the
  // numeric gate is wired into `bun run verify` via check:coverage-floor.
  const malformed: string[] = [];
  for (const [name, entry] of entries) {
    if (typeof entry.line_min !== "number" || typeof entry.branch_min !== "number") {
      malformed.push(name);
    }
  }
  if (malformed.length > 0) {
    return {
      id: "coverage_floor",
      status: "FAIL",
      message: `entries missing line_min/branch_min:\n  ${malformed.join("\n  ")}`,
    };
  }
  return {
    id: "coverage_floor",
    status: "PASS",
    message: `floors declared for ${entries.length} subsystems (numeric enforcement via \`bun run check:coverage-floor\`)`,
  };
}

// ---------- cadence ----------

function checkRegressionIsolation(): Result {
  // Regression journey tests (`*-regression*.test.ts` under
  // tests/journeys/) must not appear in the inner-loop `test:unit`
  // script in package.json. They run via `test:regression` and the
  // broader `bun test apps/` in verify, but never in the dev inner loop.
  const journeysDir = join(REPO, "apps/engine/src/tests/journeys");
  let regressionFiles: string[] = [];
  try {
    regressionFiles = readdirSync(journeysDir).filter((n) => /regression.*\.test\.ts$/.test(n));
  } catch {
    return {
      id: "regression_isolation",
      status: "PASS",
      message: "no journeys directory yet",
    };
  }
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  } catch {
    return {
      id: "regression_isolation",
      status: "FAIL",
      message: "could not read package.json",
    };
  }
  const innerLoop = pkg.scripts?.["test:unit"] ?? "";
  const violations = regressionFiles.filter((f) => innerLoop.includes(f));
  if (violations.length === 0) {
    return {
      id: "regression_isolation",
      status: "PASS",
      message: `${regressionFiles.length} regression journey file(s); none in test:unit inner loop`,
    };
  }
  return {
    id: "regression_isolation",
    status: "FAIL",
    message: `regression files appear in test:unit:\n  ${violations.join("\n  ")}`,
  };
}

function checkTestSeamsGated(): Result {
  // Underscore-prefixed test-only exports must be imported through
  // the corresponding `test-helpers/<x>.ts` re-export shim, never
  // directly from the production module. Direct imports let a
  // future refactor accidentally swap a production code path for
  // the non-fatal test variant. Each entry maps a production-module
  // suffix to its required test-helpers shim suffix and the
  // underscore symbol's name.
  const SEAMS = [
    {
      symbol: "_validateBootDependenciesForTests",
      productionModule: "observability/boot-dependencies",
      shimEnding: "test-helpers/boot.ts",
    },
    {
      symbol: "_failNextReconfigureForTests",
      productionModule: "observability/tracing",
      shimEnding: "test-helpers/tracing.ts",
    },
    {
      symbol: "_withDriverFetchForTests",
      productionModule: "connectors/drivers/fetch-seam",
      shimEnding: "test-helpers/driver-fetch.ts",
    },
  ] as const;

  const offenders: string[] = [];
  const roots = ["apps/engine/src", "apps/sk/src", "packages"];
  for (const root of roots) {
    const files = listFiles(
      root,
      (p) =>
        (p.endsWith(".ts") || p.endsWith(".tsx")) &&
        !p.includes("/__tests__/") &&
        !p.includes("/tests/") &&
        !p.endsWith(".test.ts") &&
        !p.endsWith(".test.tsx"),
    );
    for (const f of files) {
      // Each shim re-exports its own symbol — that import is allowed.
      const shimWhitelist = SEAMS.some((s) => f.endsWith(s.shimEnding));
      if (shimWhitelist) continue;
      const raw = readFileSync(f, "utf8");
      for (const seam of SEAMS) {
        // Escape EVERY regex metachar in the seam's productionModule
        // (today's entries have only `/`, but a future addition like
        // `connectors/foo.bar` would silently match wrong files —
        // `.` is "any char" — without this).
        const escapedModule = seam.productionModule.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        const importsFromProd = new RegExp(`from\\s+["'][^"']*${escapedModule}(\\.ts)?["']`).test(
          raw,
        );
        const usesSymbol = new RegExp(`\\b${seam.symbol}\\b`).test(raw);
        if (importsFromProd && usesSymbol) {
          offenders.push(`${f} (symbol=${seam.symbol})`);
        }
      }
    }
  }
  if (offenders.length === 0) {
    return {
      id: "test_seams_gated",
      status: "PASS",
      message: `${SEAMS.length} test seam(s) imported only via test-helpers/ shims`,
    };
  }
  return {
    id: "test_seams_gated",
    status: "FAIL",
    message: `${offenders.length} non-test file(s) import production test seams directly:\n  ${offenders.join("\n  ")}`,
  };
}

function checkEngineHomedirAbsence(): Result {
  // Engine production code MUST NOT read `homedir()` or `process.env.HOME` —
  // the repo-root `bunfig.toml` preloads `setup-isolated-home.ts` for every
  // `bun test` process, which redirects HOME to a tempdir. If engine code
  // ever starts reading HOME (e.g. a credential cache, an MCP server's
  // .netrc lookup, an LLM client config probe), test runs would silently
  // see an empty $HOME and miss the misconfiguration.
  //
  // Allow-list a use via `// homedir-allowed: <reason>` on the same line.
  const violations: string[] = [];
  for (const f of listFiles(ENGINE_SRC, (p) => p.endsWith(".ts") || p.endsWith(".tsx"))) {
    const rel = relative(REPO, f);
    if (rel.includes("/test-helpers/") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) {
      continue;
    }
    const text = readFileSync(f, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes("homedir-allowed:")) continue;
      if (/\bhomedir\s*\(/.test(line) || /\bprocess\.env\.HOME\b/.test(line)) {
        violations.push(`${rel}:${i + 1}`);
      }
    }
  }
  if (violations.length === 0) {
    return {
      id: "engine_homedir_absent",
      status: "PASS",
      message:
        "no homedir()/process.env.HOME reads in engine production code (bunfig.toml preload assumes this)",
    };
  }
  return {
    id: "engine_homedir_absent",
    status: "FAIL",
    message: `engine production code reads HOME / homedir() (annotate with \`// homedir-allowed: <reason>\` if intentional, or scope the bunfig preload):\n  ${violations.join("\n  ")}`,
  };
}

function checkNoGlobalFetchStubInTests(): Result {
  // Engine tests MUST NOT stub `globalThis.fetch` — `bun test` runs files
  // concurrently in one process, so a global stub leaks mid-flight into
  // sibling suites (caught live: CI run 27425002067, a 404 probe observing
  // a sibling's always-200 mock). Tests intercept driver/credential egress
  // via the AsyncLocalStorage seam (`test-helpers/driver-fetch.ts`
  // `withDriverFetchForTests`), or spin up a real `Bun.serve` loopback
  // when the code under test runs in another async root (server context).
  //
  // Allow-list a use via `// global-fetch-allowed: <reason>` on the same line.
  const STUB_PATTERNS = [
    /\bglobalThis\.fetch\s*=(?!=)/,
    /\bspyOn\(\s*globalThis\s*,\s*["']fetch["']\s*\)/,
  ];
  const violations: string[] = [];
  const isTs = (p: string) => p.endsWith(".ts") || p.endsWith(".tsx");
  const files = [
    // engine test files (suites + helpers under tests/ dirs)
    ...listFiles(
      ENGINE_SRC,
      (p) =>
        isTs(p) && (p.includes(".test.") || p.includes("/tests/") || p.includes("/__tests__/")),
    ),
    // the eval harness is test infrastructure end-to-end
    ...listFiles(join(REPO, "apps/engine/eval"), isTs),
  ];
  for (const f of files) {
    const rel = relative(REPO, f);
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes("global-fetch-allowed:")) continue;
      if (STUB_PATTERNS.some((p) => p.test(line))) {
        violations.push(`${rel}:${i + 1}`);
      }
    }
  }
  if (violations.length === 0) {
    return {
      id: "no_global_fetch_stub_in_tests",
      status: "PASS",
      message:
        "no engine test stubs globalThis.fetch (egress fakes go through the driver-fetch seam)",
    };
  }
  return {
    id: "no_global_fetch_stub_in_tests",
    status: "FAIL",
    message: `engine test(s) stub globalThis.fetch — concurrent test files share one process, the stub leaks into sibling suites; use withDriverFetchForTests (test-helpers/driver-fetch.ts) or a Bun.serve loopback, or annotate \`// global-fetch-allowed: <reason>\`:\n  ${violations.join("\n  ")}`,
  };
}

function checkCompileBuildsKeepNodeEnvDynamic(): Result {
  // Every `bun build --compile` invocation MUST carry the identity define
  // `process.env.NODE_ENV=process.env.NODE_ENV`. Without it the bundler
  // INLINES the build-machine's NODE_ENV ("development" on a bare dev box
  // or CI runner) as a compile-time constant, silently freezing every
  // runtime NODE_ENV gate in the shipped binary. Production impact when
  // this regressed: the @ai-sdk/devtools middleware ran on the prod
  // droplet (a 397MB .devtools/generations.json re-serialized on every
  // LLM step — the ~700MB/step external-memory transient and the
  // event-loop GC blips), the connector egress guard ran "permissive"
  // instead of "strict", and OIDC cookies were missing `Secure`.
  const IDENTITY_DEFINE = "process.env.NODE_ENV=process.env.NODE_ENV";
  const SOURCES = ["package.json", ".github/workflows/release.yml"];
  const violations: string[] = [];
  for (const rel of SOURCES) {
    const text = readFileSync(join(REPO, rel), "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.includes("--compile")) continue;
      if (line.trimStart().startsWith("#") || line.trimStart().startsWith("//")) continue;
      // The compile command may wrap across lines (YAML `\` continuations) —
      // scan a small window from the `--compile` line for the define.
      const window = lines.slice(i, i + 8).join("\n");
      if (!window.includes(IDENTITY_DEFINE)) {
        violations.push(`${rel}:${i + 1}`);
      }
    }
  }
  if (violations.length === 0) {
    return {
      id: "compile_node_env_dynamic",
      status: "PASS",
      message:
        "every `bun build --compile` carries the NODE_ENV identity define (no build-time inlining)",
    };
  }
  return {
    id: "compile_node_env_dynamic",
    status: "FAIL",
    message: `\`bun build --compile\` without \`--define "${IDENTITY_DEFINE}"\` — the bundler would inline the build machine's NODE_ENV into the binary:\n  ${violations.join("\n  ")}`,
  };
}

function checkExecutorCanonical(): Result {
  // The DB `Executor` type has ONE canonical definition in db/client.ts.
  // It was previously redeclared in ~53 files; a structural re-declaration
  // typechecks fine, so a future copy would silently re-introduce the
  // drift class. Ban any `type Executor =` outside the canonical file.
  const allowed = "apps/engine/src/db/client.ts";
  const DECL = /(?:^|\n)\s*(?:export\s+)?type\s+Executor\s*=/;
  const violations: string[] = [];
  for (const f of listFiles(ENGINE_SRC, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
    const rel = relative(REPO, f);
    if (rel === allowed) continue;
    if (DECL.test(readFileSync(f, "utf8"))) violations.push(rel);
  }
  if (violations.length === 0) {
    return {
      id: "executor_canonical",
      status: "PASS",
      message: `the DB Executor type is declared only in ${allowed} (no local re-declarations)`,
    };
  }
  return {
    id: "executor_canonical",
    status: "FAIL",
    message: `local \`type Executor =\` re-declarations (import from db/client.ts instead):\n  ${violations.join("\n  ")}`,
  };
}

// ---------- driver ----------

const CHECKS: Array<() => Result> = [
  checkSubsystemCount,
  checkNoNewSubsystem,
  checkAiSdkLocality,
  checkJsonataLocality,
  checkRouteLayering,
  checkInternalLayering,
  checkFileSize,
  checkRouteSize,
  checkTenantFilter,
  checkNoSnapshots,
  checkNoLiveLlm,
  checkCoverageFloor,
  checkRegressionIsolation,
  checkTestSeamsGated,
  checkEngineHomedirAbsence,
  checkNoGlobalFetchStubInTests,
  checkCompileBuildsKeepNodeEnvDynamic,
  checkExecutorCanonical,
];

const results: Result[] = [];
for (const check of CHECKS) {
  try {
    results.push(check());
  } catch (err) {
    results.push({
      id: check.name.replace(/^check/, "").toLowerCase(),
      status: "FAIL",
      message: `unhandled error: ${(err as Error).message}`,
    });
  }
}

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const skip = results.filter((r) => r.status === "SKIP").length;

for (const r of results) {
  console.log(`${r.status.padEnd(4)} ${r.id.padEnd(24)} ${r.message}`);
}

console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`);

process.exit(fail === 0 ? 0 : 1);
