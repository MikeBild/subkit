// Repo-grep invariant: `PermissionCheck.quiet` is a probe-only escape
// hatch. A `can(..., { quiet: true })` deny is logged at DEBUG instead
// of WARN — appropriate ONLY for a probe-style check where a "no" is an
// expected, routine outcome (e.g. `permittedMcpScopes` enumerating
// which `mcp:*` scopes a role holds). On a GENUINE enforcement check
// `quiet: true` would silence an operator-actionable deny.
//
// The single legitimate production caller is `permittedMcpScopes` in
// `apps/engine/src/http/routes/oauth/shared.ts`. This test scans the
// repo source for any `quiet: true` (object-literal) site and asserts
// the file set is exactly that one production file plus the evaluator's
// own type + tests. A future caller adding `quiet: true` elsewhere
// fails this test loudly — forcing a deliberate review of whether the
// deny truly is a routine probe.
//
// Mirrors the repo-grep style of `permission-catalog-coverage.test.ts`.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

// Repo-root resolution — identical strategy to permission-catalog-coverage:
// `SUBKIT_REPO_ROOT` override wins; otherwise resolve five levels up from
// this file (`apps/engine/src/rbac/tests/`), then sanity-assert the tree.
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
  } catch {
    /* fall through to existsSync */
  }
  if (pkgName !== "subkit" || !existsSync(resolve(ROOT, "apps/engine"))) {
    throw new Error(
      `quiet-flag-guard: resolved ROOT (${ROOT}) does not look like the subkit repo. ` +
        `Set SUBKIT_REPO_ROOT or move the test back under apps/engine/src/rbac/tests/.`,
    );
  }
}

// Matches `quiet: true` and `quiet:true` (any inner whitespace).
const QUIET_TRUE = /quiet\s*:\s*true\b/;

// The ONLY files allowed to contain `quiet: true`:
//   - the production caller (`permittedMcpScopes`)
//   - the MCP-connect operator-digest probe (`stats:read` capability check on
//     every connect — a user without it is normal, not an incident, so the
//     denial logs at DEBUG instead of flooding `rbac.denied` WARN)
//   - the evaluator's own type definition (the `quiet?: boolean` doc) and
//     the `connectorAccessLevel` probe (read/write level introspection —
//     a "no" on write is a routine level outcome, not an incident)
//   - the evaluator's own unit tests (exercise the probe path)
//   - this guard test itself (references the literal in prose/regex)
const ALLOWED = new Set<string>([
  "apps/engine/src/http/routes/oauth/shared.ts",
  "apps/engine/src/mcp/server.ts",
  "apps/engine/src/rbac/evaluator.ts",
  "apps/engine/src/rbac/tests/evaluator.test.ts",
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
    // If `permittedMcpScopes` ever drops the flag, this allowlist entry
    // is dead — fail so the allowlist is trimmed in the same change.
    const src = readFileSync(resolve(ROOT, "apps/engine/src/http/routes/oauth/shared.ts"), "utf8");
    expect(QUIET_TRUE.test(src)).toBe(true);
  });
});
