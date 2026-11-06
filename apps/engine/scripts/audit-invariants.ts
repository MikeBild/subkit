#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staleSnapshotsIn } from "../../../scripts/lib/migration-snapshots.ts";
import { COMMENT_EXEMPT, COMMENT_SCOPE, findComments } from "./audit/comments.ts";
import { parseFloorFile } from "./audit/coverage-floor.ts";
import { listFiles } from "./audit/files.ts";
import { createCache, evaluateRatchet, RATCHETS, writeRatchetBaseline } from "./audit/ratchets.ts";
import { isTestPath } from "./audit/rules.ts";
import { auditTenantFilter } from "./audit/tenant-filter-ast.ts";
import { loadTestLayers } from "./audit/test-layer-source.ts";

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), "..", "..", "..");
const ENGINE_SRC = join(REPO, "apps/engine/src");

type Result = { id: string; status: "PASS" | "FAIL" | "SKIP"; message: string };

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

function checkAiSdkLocality(): Result {
  const PROVIDER_VALUE_IMPORT =
    /(?:^|\n)\s*import\s+(?!type\s)[^"';]+from\s+["'](?:@ai-sdk\/(?:anthropic|openai|google|azure|google-vertex|amazon-bedrock)|@anthropic-ai\/sdk)["']/;
  const violations: string[] = [];
  for (const f of listFiles(ENGINE_SRC, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
    const rel = relative(REPO, f);
    if (rel.startsWith("apps/engine/src/llm/runtime/")) continue;
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
        "no @ai-sdk/<provider> or @anthropic-ai/sdk runtime imports outside apps/engine/src/llm/runtime/",
    };
  }
  return {
    id: "ai_sdk_locality",
    status: "FAIL",
    message: `runtime provider imports outside llm/runtime/:\n  ${violations.join("\n  ")}`,
  };
}

function checkJsonataLocality(): Result {
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

function checkConversationModelSelection(): Result {
  const PREMIUM_LITERAL = /["'`]claude-(?:opus|sonnet)[a-z0-9.-]*["'`]/;
  const root = join(ENGINE_SRC, "conversations");
  const violations: string[] = [];
  for (const f of listFiles(root, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
    const text = readFileSync(f, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (PREMIUM_LITERAL.test(code)) {
        violations.push(`${relative(REPO, f)}:${i + 1}`);
      }
    }
  }
  if (violations.length === 0) {
    return {
      id: "conversation_model_selection",
      status: "PASS",
      message: "no premium model literals in the conversation path",
    };
  }
  return {
    id: "conversation_model_selection",
    status: "FAIL",
    message:
      "premium model named in code — model choice belongs to config, escalation to the step-router:\n  " +
      violations.join("\n  "),
  };
}

function checkRouteLayering(): Result {
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
  const allFiles = listFiles(ENGINE_SRC, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
  const violations: string[] = [];
  const importRe = /(?:from|import)\s*\(?\s*["']([^"']*?\/_internal\/[^"']+)["']/g;
  for (const f of allFiles) {
    const rel = relative(REPO, f);
    const fileDir = dirname(f);
    const text = readFileSync(f, "utf8");
    importRe.lastIndex = 0;
    for (const match of text.matchAll(importRe)) {
      const importPath = match[1] ?? "";
      if (!importPath.startsWith(".")) continue;
      const resolved = resolve(fileDir, importPath);
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

function checkFileSize(): Result {
  const allowlist = readAllowlist(".size-allowlist.txt");
  const violations: string[] = [];
  const SIZE_ROOTS = [
    ENGINE_SRC,
    join(REPO, "apps/sk/src"),
    join(REPO, "packages/shared/src"),
    join(REPO, "packages/cli-core/src"),
    join(REPO, "packages/chat-ui/src"),
  ];
  const isProdSource = (p: string): boolean =>
    (p.endsWith(".ts") || p.endsWith(".tsx")) &&
    !p.endsWith(".test.ts") &&
    !p.endsWith(".test.tsx") &&
    !p.includes("/tests/") &&
    !p.includes("/engine-api/");
  for (const root of SIZE_ROOTS) {
    for (const f of listFiles(root, isProdSource)) {
      const rel = relative(REPO, f);
      const lines = readFileSync(f, "utf8").split("\n").length;
      if (lines > 1000 && !allowlist.has(rel)) {
        violations.push(`${rel} (${lines} LOC)`);
      }
    }
  }
  if (violations.length === 0) {
    return {
      id: "file_size",
      status: "PASS",
      message: `no production .ts(x) in apps/*/src or packages/*/src > 1000 LOC outside .size-allowlist.txt (${allowlist.size} allowlisted)`,
    };
  }
  return {
    id: "file_size",
    status: "FAIL",
    message: `files >1000 LOC not in allowlist:\n  ${violations.join("\n  ")}`,
  };
}

function checkTenantFilter(): Result {
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

function checkSingleMigrationSnapshot(): Result {
  const stale = staleSnapshotsIn(join(ENGINE_SRC, "db/migrations/meta"));
  if (stale.length === 0) {
    return {
      id: "single_migration_snapshot",
      status: "PASS",
      message: "only the latest drizzle snapshot is tracked",
    };
  }
  return {
    id: "single_migration_snapshot",
    status: "FAIL",
    message: `older drizzle snapshots found; run \`bun run scripts/prune-migration-snapshots.ts\`:\n  ${stale.join("\n  ")}`,
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

function checkCoverageFloor(): Result {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(REPO, "apps/engine/.coverage-floor.json"), "utf8"));
  } catch (err) {
    return {
      id: "coverage_floor",
      status: "FAIL",
      message: `.coverage-floor.json missing or not JSON: ${(err as Error).message}`,
    };
  }
  const parsed = parseFloorFile(raw);
  if ("errors" in parsed) {
    return {
      id: "coverage_floor",
      status: "FAIL",
      message: `.coverage-floor.json invalid:\n  ${parsed.errors.join("\n  ")}`,
    };
  }
  const { subsystems, files, core_default } = parsed.floors;
  return {
    id: "coverage_floor",
    status: "PASS",
    message: `floors declared for ${Object.keys(subsystems).length} subsystems and ${Object.keys(files).length} files${core_default ? `, core default ${core_default.line_min}/${core_default.branch_min}` : ""} (numeric enforcement via \`bun run check:coverage-floor\`)`,
  };
}

function checkRegressionIsolation(): Result {
  const regressionFiles = ["apps", "packages", "tests"]
    .flatMap((root) => listFiles(join(REPO, root), (p) => /\.regression\.test\.tsx?$/.test(p)))
    .map((f) => relative(REPO, f))
    .sort();
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
  const unitLayer = innerLoop.includes("scripts/test-layer.ts")
    ? new Set(loadTestLayers(REPO).unit)
    : new Set<string>();
  const violations = regressionFiles.filter((f) => innerLoop.includes(f) || unitLayer.has(f));
  if (violations.length === 0) {
    return {
      id: "regression_isolation",
      status: "PASS",
      message: `${regressionFiles.length} *.regression.test.ts(x) file(s); none in the test:unit inner loop`,
    };
  }
  return {
    id: "regression_isolation",
    status: "FAIL",
    message: `regression files appear in test:unit:\n  ${violations.join("\n  ")}`,
  };
}

function checkTestSeamsGated(): Result {
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
      const shimWhitelist = SEAMS.some((s) => f.endsWith(s.shimEnding));
      if (shimWhitelist) continue;
      const raw = readFileSync(f, "utf8");
      for (const seam of SEAMS) {
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

function checkTestFixturesGated(): Result {
  const offenders: string[] = [];
  for (const root of ["apps/engine/src", "apps/sk/src", "apps/cockpit/src", "packages"]) {
    const files = listFiles(
      root,
      (p) => (p.endsWith(".ts") || p.endsWith(".tsx")) && !isTestPath(relative(REPO, p)),
    );
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      if (/from\s+["'][^"']*-fixtures(\.tsx?)?["']/.test(raw)) offenders.push(relative(REPO, f));
    }
  }
  if (offenders.length === 0) {
    return {
      id: "test_fixtures_gated",
      status: "PASS",
      message: "no production file imports a *-fixtures.ts test helper",
    };
  }
  return {
    id: "test_fixtures_gated",
    status: "FAIL",
    message: `${offenders.length} production file(s) import *-fixtures.ts test helpers:\n  ${offenders.join("\n  ")}`,
  };
}

function checkEngineHomedirAbsence(): Result {
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
  // Allow-list a use via `// global-fetch-allowed: <reason>` on the same line.
  const STUB_PATTERNS = [
    /\bglobalThis\.fetch\s*=(?!=)/,
    /\bspyOn\(\s*globalThis\s*,\s*["']fetch["']\s*\)/,
  ];
  const violations: string[] = [];
  const isTs = (p: string) => p.endsWith(".ts") || p.endsWith(".tsx");
  const files = [
    ...listFiles(
      ENGINE_SRC,
      (p) =>
        isTs(p) && (p.includes(".test.") || p.includes("/tests/") || p.includes("/__tests__/")),
    ),
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
  const IDENTITY_DEFINE = "process.env.NODE_ENV=process.env.NODE_ENV";
  const SOURCES = ["package.json", "Dockerfile"];
  const violations: string[] = [];
  for (const rel of SOURCES) {
    const text = readFileSync(join(REPO, rel), "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.includes("--compile")) continue;
      if (line.trimStart().startsWith("#") || line.trimStart().startsWith("//")) continue;
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

function checkAuditLogSingleWriter(): Result {
  const isTs = (p: string) => p.endsWith(".ts") || p.endsWith(".tsx");
  const isTestFile = (p: string) =>
    p.includes(".test.") || p.includes("/tests/") || p.includes("/__tests__/");
  const files = [
    ...listFiles(ENGINE_SRC, (p) => isTs(p) && !isTestFile(p)),
    ...listFiles(join(REPO, "packages"), (p) => isTs(p) && !isTestFile(p)),
  ];
  const WRITER = join(ENGINE_SRC, "db", "audit.ts");
  const INSERT = /\.insert\s*\(\s*auditLog\s*\)|INSERT\s+INTO\s+audit_log/gi;

  const violations: string[] = [];
  for (const f of files) {
    if (f === WRITER) continue;
    const src = readFileSync(f, "utf8");
    INSERT.lastIndex = 0;
    let m = INSERT.exec(src);
    while (m !== null) {
      violations.push(`${relative(REPO, f)}:${src.slice(0, m.index).split("\n").length}`);
      m = INSERT.exec(src);
    }
  }

  if (violations.length === 0) {
    return {
      id: "audit_log_single_writer",
      status: "PASS",
      message:
        "audit_log has a single writer (db/audit.ts#writeAudit), so the scrub cannot be bypassed",
    };
  }
  return {
    id: "audit_log_single_writer",
    status: "FAIL",
    message: `production code inserts into audit_log outside db/audit.ts — such a row skips the payload scrub in \`writeAudit\` and lands in the append-only trail (and every ndjson export) unredacted. Route the write through \`writeAudit\` / \`auditAwait\`:\n  ${violations.join("\n  ")}`,
  };
}

function checkTestServersBindLoopback(): Result {
  // `// bind-wildcard-allowed: <reason>` on the `serve(` line.
  const LOOPBACK = /hostname\s*:\s*["'`](?:127\.0\.0\.1|localhost|::1)["'`]/;
  const isTs = (p: string) => p.endsWith(".ts") || p.endsWith(".tsx");
  const isTestFile = (p: string) =>
    p.includes(".test.") || p.includes("/tests/") || p.includes("/__tests__/");
  const files = [
    ...listFiles(ENGINE_SRC, (p) => isTs(p) && isTestFile(p)),
    ...listFiles(join(REPO, "tests"), (p) => isTs(p) && isTestFile(p)),
    ...listFiles(join(REPO, "packages"), (p) => isTs(p) && isTestFile(p)),
  ];

  const violations: string[] = [];
  for (const f of files) {
    const rel = relative(REPO, f);
    const src = readFileSync(f, "utf8");
    const marker = /(?:\bBun\.serve|(?<![.\w])serve)\s*\(\s*\{/g;
    let m = marker.exec(src);
    while (m !== null) {
      const lineNo = src.slice(0, m.index).split("\n").length;
      // `// bind-wildcard-allowed:` on the `serve(` line does not survive the
      // formatter — biome moves it onto the next line — so requiring it there
      // let a formatting pass silently disarm the allow-list. Reading the
      // lead-in comment instead is both formatter-proof and where a reason
      // long enough to be worth anything actually fits.
      const lines = src.split("\n");
      const scope = lines.slice(Math.max(0, lineNo - 4), lineNo).join("\n");
      if (!scope.includes("bind-wildcard-allowed:")) {
        const open = src.indexOf("{", m.index);
        if (open !== -1) {
          let depth = 0;
          let k = open;
          for (; k < src.length; k++) {
            if (src[k] === "{") depth++;
            else if (src[k] === "}") {
              depth--;
              if (depth === 0) break;
            }
          }
          const body = src.slice(open, k + 1);
          if (!LOOPBACK.test(body)) violations.push(`${rel}:${lineNo}`);
        }
      }
      m = marker.exec(src);
    }
  }

  if (violations.length === 0) {
    return {
      id: "test_servers_bind_loopback",
      status: "PASS",
      message:
        "every Bun.serve and @hono/node-server serve in a test pins a loopback hostname (no wildcard bind)",
    };
  }
  return {
    id: "test_servers_bind_loopback",
    status: "FAIL",
    message: `test server(s) bind the wildcard address while the suite dials 127.0.0.1 — the OS may hand out a port a foreign process already owns on loopback, and the test then measures that stranger (red for no reason, or green for the wrong one). Add \`hostname: "127.0.0.1"\`, or annotate \`// bind-wildcard-allowed: <reason>\`:\n  ${violations.join("\n  ")}`,
  };
}

function checkNoComments(): Result {
  const files = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter((f) => COMMENT_SCOPE.test(f) && !COMMENT_EXEMPT.test(f));
  const violations: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(REPO, file), "utf8");
    } catch {
      continue;
    }
    for (const hit of findComments(file, text)) violations.push(`${file}:${hit.line} ${hit.text}`);
  }
  if (violations.length === 0) {
    return {
      id: "no_comments",
      status: "PASS",
      message: `no comments outside tool directives in ${files.length} files`,
    };
  }
  return {
    id: "no_comments",
    status: "FAIL",
    message: `${violations.length} comment(s); only tool directives are allowed:\n  ${violations.slice(0, 20).join("\n  ")}`,
  };
}

const CHECKS: Array<() => Result> = [
  checkAiSdkLocality,
  checkJsonataLocality,
  checkConversationModelSelection,
  checkRouteLayering,
  checkInternalLayering,
  checkFileSize,
  checkTenantFilter,
  checkNoSnapshots,
  checkSingleMigrationSnapshot,
  checkNoLiveLlm,
  checkCoverageFloor,
  checkAuditLogSingleWriter,
  checkRegressionIsolation,
  checkTestSeamsGated,
  checkTestFixturesGated,
  checkEngineHomedirAbsence,
  checkNoGlobalFetchStubInTests,
  checkCompileBuildsKeepNodeEnvDynamic,
  checkExecutorCanonical,
  checkTestServersBindLoopback,
  checkNoComments,
];

const cache = createCache(REPO);

if (process.argv.includes("--update-baseline")) {
  for (const ratchet of RATCHETS) {
    const count = writeRatchetBaseline(REPO, ratchet, cache, process.argv.includes("--accept-new"));
    console.log(`${ratchet.id.padEnd(28)} ${count} allowlisted`);
  }
  process.exit(0);
}

const ratchetChecks = RATCHETS.map((ratchet) => {
  const run = (): Result => evaluateRatchet(REPO, ratchet, cache);
  Object.defineProperty(run, "name", { value: ratchet.id });
  return run;
});

const results: Result[] = [];
for (const check of [...CHECKS, ...ratchetChecks]) {
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
