import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SELF_INTROSPECTION_ROUTES } from "../../rbac/index.ts";

const IDENTITY_ROUTES_DIR = "apps/engine/src/http/routes/identity";
const ROUTES_DIR = "apps/engine/src/http/routes";

const FILE_TO_SLUG: Record<string, string> = {
  "whoami.ts": "whoami",
  "permissions.ts": "identity-permissions",
  "sk-bootstrap.ts": "sk-bootstrap",
  "cockpit.ts": "cockpit-bootstrap",
  "providers.ts": "identity-providers",
  "login.ts": "identity-login",
  "sessions.ts": "identity-sessions",
  "memberships.ts": "identity-memberships",
  "owned-tenant.ts": "identity-owned-tenant",
  "cli-session.ts": "identity-cli-session",
  "desktop-login.ts": "identity-desktop-login",
  "onboarding.ts": "identity-onboarding",
  "workspace.ts": "identity-workspace",
};

const TOP_LEVEL_FILE_TO_SLUG: Record<string, string> = {
  "health.ts": "health",
};

const OPERATIONS_DIR = "apps/engine/src/api/operations";

const OPERATION_IMPORT =
  /import\s*\{([^}]*)\}\s*from\s*"(?:\.\.\/)+api\/operations\/([\w-]+)\.ts"/g;

function importedOperationPermissions(src: string): (string | null)[] {
  const permissions: (string | null)[] = [];
  for (const [, names = "", module = ""] of src.matchAll(OPERATION_IMPORT)) {
    const opSrc = readFileSync(join(OPERATIONS_DIR, `${module}.ts`), "utf8");
    for (const name of names.split(",").map((part) => part.trim())) {
      if (!name.endsWith("Operation")) continue;
      const declared = new RegExp(
        `export const ${name} = defineOperation[\\s\\S]*?\\n\\s+permission: (null|"[^"]+")`,
      ).exec(opSrc);
      if (!declared?.[1])
        throw new Error(`${module}.ts does not declare ${name} with a permission`);
      permissions.push(declared[1] === "null" ? null : declared[1]);
    }
  }
  return permissions;
}

describe("self-introspection carve-out is a contract, not just a comment", () => {
  test("every identity/ route gates with requirePermission or an operation permission, OR is on the carve-out list", () => {
    const files = readdirSync(IDENTITY_ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => !f.endsWith(".test.ts"));
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(join(IDENTITY_ROUTES_DIR, file), "utf8");
      const operations = importedOperationPermissions(src);
      const gated =
        /requirePermission\s*\(/.test(src) || operations.some((permission) => permission !== null);
      const selfOperations = operations.some((permission) => permission === null);
      if (gated && !selfOperations) continue;
      const slug = FILE_TO_SLUG[file];
      if (!slug) {
        violations.push(
          `${file} has no requirePermission() call or gated operation AND no entry in FILE_TO_SLUG; either gate it or document it on the carve-out`,
        );
        continue;
      }
      if (!SELF_INTROSPECTION_ROUTES.includes(slug as never)) {
        violations.push(
          `${file} maps to slug "${slug}" but slug is missing from SELF_INTROSPECTION_ROUTES`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test("health.ts at the route root is on the carve-out list (not gated)", () => {
    const violations: string[] = [];
    for (const [file, slug] of Object.entries(TOP_LEVEL_FILE_TO_SLUG)) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      const gated = /requirePermission\s*\(/.test(src);
      if (gated) {
        violations.push(
          `${file} now gates with requirePermission — drop "${slug}" from the carve-out list`,
        );
        continue;
      }
      if (!SELF_INTROSPECTION_ROUTES.includes(slug as never)) {
        violations.push(`${file} expected slug "${slug}" missing from SELF_INTROSPECTION_ROUTES`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("SELF_INTROSPECTION_ROUTES has no duplicates", () => {
    const set = new Set(SELF_INTROSPECTION_ROUTES);
    expect(set.size).toBe(SELF_INTROSPECTION_ROUTES.length);
  });

  test("each carve-out slug names a real, stable family", () => {
    expect([...SELF_INTROSPECTION_ROUTES].sort()).toEqual([
      "cockpit-bootstrap",
      "health",
      "identity-cli-session",
      "identity-desktop-login",
      "identity-login",
      "identity-memberships",
      "identity-onboarding",
      "identity-owned-tenant",
      "identity-permissions",
      "identity-providers",
      "identity-sessions",
      "identity-workspace",
      "sk-bootstrap",
      "whoami",
    ]);
  });
});
