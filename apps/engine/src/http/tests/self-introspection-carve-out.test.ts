// Contract test: every route in `apps/engine/src/http/routes/identity/`
// either calls `requirePermission(...)` somewhere in its source OR
// appears in `SELF_INTROSPECTION_ROUTES`. This promotes the
// previously-comment-only carve-out at `sk-bootstrap.ts` into a
// hard contract — a future contributor adding a state-mutating
// route under `identity/` cannot inherit the "self-introspection"
// pass by copy-pasting the comment block. R5-S1 review fix.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SELF_INTROSPECTION_ROUTES } from "../../rbac/index.ts";

const IDENTITY_ROUTES_DIR = "apps/engine/src/http/routes/identity";

// Map filename → expected route slug used in `SELF_INTROSPECTION_ROUTES`.
// Keep the slug stable across renames; if a file is renamed without
// updating this map, the test fails loudly.
const FILE_TO_SLUG: Record<string, string> = {
  "whoami.ts": "whoami",
  "sk-bootstrap.ts": "sk-bootstrap",
  "providers.ts": "identity-providers",
  "login.ts": "identity-login",
  "sessions-oidc.ts": "identity-sessions-oidc",
};

// Files in `routes/identity/` that are NOT route modules (Zod
// schema bundles, type re-exports, helpers). They don't ship over
// HTTP, so the carve-out doesn't apply.
const NON_ROUTE_FILES = new Set<string>(["schemas.ts"]);

describe("self-introspection carve-out is a contract, not just a comment", () => {
  test("every identity/ route either gates with requirePermission OR is on the carve-out list", () => {
    const files = readdirSync(IDENTITY_ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
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

  test("SELF_INTROSPECTION_ROUTES has no duplicates", () => {
    const set = new Set(SELF_INTROSPECTION_ROUTES);
    expect(set.size).toBe(SELF_INTROSPECTION_ROUTES.length);
  });

  test("each carve-out slug names a real, stable family", () => {
    // Hand-pinned. If a slug here ever needs to change, the change
    // should land via a deliberate edit + a follow-up that updates
    // any consumer test, not via a silent rename.
    expect([...SELF_INTROSPECTION_ROUTES].sort()).toEqual([
      "health",
      "identity-login",
      "identity-providers",
      "identity-sessions-oidc",
      "metrics",
      "sk-bootstrap",
      "whoami",
    ]);
  });
});
