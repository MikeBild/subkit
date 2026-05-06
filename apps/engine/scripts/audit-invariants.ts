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
  // Skip on release-please-generated PRs. release-please composes the
  // body from conventional-commit messages plus an auto-link to the
  // release-notes branch when the body would otherwise overflow GitHub's
  // PR-body cap. Either marker means the PR is automated; the
  // audit-phase template fields don't apply.
  const branch = process.env.PR_HEAD_REF ?? "";
  const isReleasePleasePr =
    branch.startsWith("release-please--") ||
    body.includes("release-please--branches--") ||
    body.startsWith(":robot:");
  if (isReleasePleasePr) {
    return {
      id: "pr_template",
      status: "SKIP",
      message: "release-please-generated PR; audit-phase fields not applicable",
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
  console.log(`${r.status.padEnd(4)} ${r.id.padEnd(24)} ${r.message}`);
}

console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`);

process.exit(fail === 0 ? 0 : 1);
