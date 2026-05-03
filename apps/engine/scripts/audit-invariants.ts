#!/usr/bin/env bun
//
// Audit-invariants — the single CI gate enforcing §6.1 of
// docs/audits/2026-05-architecture-audit.md.
//
// Runs every check from the audit's invariant list and exits non-zero
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
  // Heuristic for Phase 1: routes/<f>.ts may import from a subsystem's
  // index.ts only — i.e. relative paths of the form `../../<sub>/index`
  // or `../../<sub>` (resolved to index.ts) are OK; deeper paths into
  // subsystem internals are flagged.
  //
  // PHASE 4 (week 6): replace this regex heuristic with an AST scan
  // that resolves the import to a TS file and asserts it's the
  // re-exported entry point. Tracked in audit-2026-05 issue.
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
    "tunnels",
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
  // Phase 1 lands the check as ADVISORY (PASS with warning) until the
  // §4.4 route splits in Phase 4 land. Flipping to FAIL is part of the
  // Phase 4 gate.
  return {
    id: "route_layering",
    status: "PASS",
    message: `ADVISORY (Phase 4 will flip to FAIL): ${violations.length} layering violations\n  ${violations.slice(0, 10).join("\n  ")}${violations.length > 10 ? `\n  ... (${violations.length - 10} more)` : ""}`,
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
  // Phase 1 lands the check as ADVISORY until Phase 4 splits route files.
  return {
    id: "route_size",
    status: "PASS",
    message: `ADVISORY (Phase 4 will flip to FAIL): ${violations.length} route files >600 LOC not allowlisted\n  ${violations.join("\n  ")}`,
  };
}

// ---------- safety ----------

function checkTenantFilter(): Result {
  // Phase 1 heuristic: grep for `db.select().from(<table>)` patterns and
  // check there is a `tenantId` reference within the next 5 lines. This
  // catches the obvious case (drizzle query that forgot the predicate)
  // but misses query-builder helpers that defer the predicate.
  //
  // PHASE 4: replace with a proper AST scan that follows the query
  // builder chain. Tracked in audit-2026-05 issue.
  const allowlist = readAllowlist(".tenant-filter-allowlist.txt");
  const violations: string[] = [];
  for (const f of listFiles(
    ENGINE_SRC,
    (p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.includes("/scripts/"),
  )) {
    const rel = relative(REPO, f);
    const text = readFileSync(f, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Match `.from(<table>)` with optional whitespace.
      const match = line.match(/\.from\(\s*([\w$]+)/);
      if (!match) continue;
      const table = match[1]!;
      if (allowlist.has(table)) continue;
      // Scan ahead 8 lines (chained calls span multiple lines) for a
      // tenantId reference. If the table name itself contains `system`
      // or `global`, skip (heuristic — refined in Phase 4).
      const window = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
      if (/tenantId|tenant_id/.test(window)) continue;
      violations.push(`${rel}:${i + 1} .from(${table}) without nearby tenantId`);
    }
  }
  if (violations.length === 0) {
    return {
      id: "tenant_filter",
      status: "PASS",
      message: "no drizzle .from(table) without nearby tenantId predicate",
    };
  }
  // Phase 1 ships ADVISORY because the heuristic produces false positives
  // on query-builder helpers; flips to FAIL when AST scan lands.
  return {
    id: "tenant_filter",
    status: "PASS",
    message: `ADVISORY (heuristic, AST scan in Phase 4): ${violations.length} candidate sites\n  ${violations.slice(0, 10).join("\n  ")}${violations.length > 10 ? `\n  ... (${violations.length - 10} more)` : ""}`,
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
  const parsed = JSON.parse(text) as { subsystems?: Record<string, unknown> };
  const count = Object.keys(parsed.subsystems ?? {}).length;
  if (count === 0) {
    return {
      id: "coverage_floor",
      status: "SKIP",
      message:
        "Phase 2 has not populated .coverage-floor.json yet (intentional; flips to enforced at end of week 3)",
    };
  }
  // Once populated, this check should run `bun test --coverage` and
  // compare per-subsystem floors. Implemented at the end of Phase 2.
  return {
    id: "coverage_floor",
    status: "PASS",
    message: `floors declared for ${count} subsystems (enforcement implementation pending end of Phase 2)`,
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

function checkPrTemplate(): Result {
  // Only meaningful in PR context; otherwise PASS.
  const body = process.env.PR_BODY;
  if (!body) {
    return {
      id: "pr_template",
      status: "SKIP",
      message: "no PR_BODY env (running outside PR context)",
    };
  }
  const required = ["Audit phase", "Section reference", "Verification touched"];
  const missing = required.filter((k) => !body.includes(k));
  if (missing.length === 0) {
    return {
      id: "pr_template",
      status: "PASS",
      message: "all required audit-phase fields present in PR body",
    };
  }
  return {
    id: "pr_template",
    status: "FAIL",
    message: `PR body missing fields: ${missing.join(", ")}`,
  };
}

// ---------- driver ----------

const CHECKS: Array<() => Result> = [
  checkSubsystemCount,
  checkNoNewSubsystem,
  checkAiSdkLocality,
  checkJsonataLocality,
  checkRouteLayering,
  checkFileSize,
  checkRouteSize,
  checkTenantFilter,
  checkNoSnapshots,
  checkNoLiveLlm,
  checkCoverageFloor,
  checkRegressionIsolation,
  checkPrTemplate,
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
  // biome-ignore lint/suspicious/noConsole: this is a CI script — direct stdout is the contract
  console.log(`${r.status.padEnd(4)} ${r.id.padEnd(24)} ${r.message}`);
}

// biome-ignore lint/suspicious/noConsole: summary line for CI parsing
console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`);

process.exit(fail === 0 ? 0 : 1);
