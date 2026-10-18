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
  "cli-session.ts": "identity-cli-session",
};

const TOP_LEVEL_FILE_TO_SLUG: Record<string, string> = {
  "health.ts": "health",
};

const NON_ROUTE_FILES = new Set<string>(["schemas.ts"]);

describe("self-introspection carve-out is a contract, not just a comment", () => {
  test("every identity/ route either gates with requirePermission OR is on the carve-out list", () => {
    const files = readdirSync(IDENTITY_ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => !NON_ROUTE_FILES.has(f));
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(join(IDENTITY_ROUTES_DIR, file), "utf8");
      const gated = /requirePermission\s*\(/.test(src);
      if (gated) continue;
      const slug = FILE_TO_SLUG[file];
      if (!slug) {
        violations.push(
          `${file} has no requirePermission() call AND no entry in FILE_TO_SLUG; either gate it or document it on the carve-out`,
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
      "identity-login",
      "identity-permissions",
      "identity-providers",
      "identity-sessions",
      "sk-bootstrap",
      "whoami",
    ]);
  });
});
