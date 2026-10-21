import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

function resolveRepoRoot(): string {
  const fromEnv = process.env.SUBKIT_REPO_ROOT;
  if (fromEnv && existsSync(resolve(fromEnv, "package.json"))) return fromEnv;
  return resolve(import.meta.dir, "..", "..", "..", "..", "..");
}

const ROOT = resolveRepoRoot();
{
  const pkgPath = resolve(ROOT, "package.json");
  let pkgName: string | undefined;
  try {
    pkgName = (JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string }).name;
  } catch {}
  if (pkgName !== "subkit" || !existsSync(resolve(ROOT, "apps/engine"))) {
    throw new Error(
      `quiet-flag-guard: resolved ROOT (${ROOT}) does not look like the subkit repo. ` +
        `Set SUBKIT_REPO_ROOT or move the test back under apps/engine/src/rbac/tests/.`,
    );
  }
}

const QUIET_TRUE = /quiet\s*:\s*true\b/;

const ALLOWED = new Set<string>([
  "apps/engine/src/http/routes/oauth/shared.ts",
  "apps/engine/src/http/routes/agent-briefing.ts",
  "apps/engine/src/http/routes/identity/cockpit.ts",
  "apps/engine/src/http/routes/identity/users.ts",
  "apps/engine/src/http/routes/workflows.ts",
  "apps/engine/src/rbac/workflow-start-access.ts",
  "apps/engine/src/conversations/tools/engine-api/metrics.ts",
  "apps/engine/src/mcp/server.ts",
  "apps/engine/src/mcp/capabilities/resources.ts",
  "apps/engine/src/mcp/capabilities/completion.ts",
  "apps/engine/src/operator/attention.ts",
  "apps/engine/src/http/routes/workflow-authorities.ts",
  "apps/engine/src/http/routes/workflow-invocation.ts",
  "apps/engine/src/conversations/automation-context.ts",
  "apps/engine/src/conversations/tools/review-workflow-automation.ts",
  "apps/engine/src/conversations/playbook.ts",
  "apps/engine/src/conversations/playbook-evidence.ts",
  "apps/engine/src/http/routes/cockpit-events.ts",
  "apps/engine/src/http/routes/categories.ts",
  "apps/engine/src/http/routes/intake.ts",
  "apps/engine/src/rbac/evaluator.ts",
  "apps/engine/src/rbac/tests/evaluator.test.ts",
  "apps/engine/src/http/routes/rbac/group-history-tenant-boundary.integration.test.ts",
  "apps/engine/src/rbac/tests/resource-access.test.ts",
  "apps/engine/src/rbac/tests/quiet-flag-guard.test.ts",
]);

describe("RBAC quiet-flag invariant", () => {
  test("`quiet: true` appears only in the sanctioned files", async () => {
    const glob = new Glob("apps/engine/src/**/*.ts");
    const offenders: string[] = [];
    for await (const file of glob.scan({ cwd: ROOT, absolute: false, onlyFiles: true })) {
      const normalized = file.split("\\").join("/");
      const src = readFileSync(resolve(ROOT, file), "utf8");
      if (QUIET_TRUE.test(src) && !ALLOWED.has(normalized)) {
        offenders.push(normalized);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the sanctioned production caller still uses `quiet: true` (guard is not stale)", async () => {
    const src = readFileSync(resolve(ROOT, "apps/engine/src/http/routes/oauth/shared.ts"), "utf8");
    expect(QUIET_TRUE.test(src)).toBe(true);
  });
});
