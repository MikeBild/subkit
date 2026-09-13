// Shared OAuth requested-vs-granted scope diff helper.
//
// G6 (runtime-logs review plan): pre-fix the engine wrote credential
// rows that silently 401'd against APIs the user did not consent to.
// 6.2.4 added the data path (requested_scopes on state, granted_scopes
// on credential). 6.2.6 surfaced the diff on the conversation tool.
// H1 / H4 collapse the duplication so the REST + MCP + conversation
// surfaces all carry the same diff envelope, and so an explicit
// "unknown" sentinel disambiguates "fully granted" from "we have no
// recorded scope data" (legacy pre-6.2.4 credential rows).

import { and, eq, isNull, ne } from "drizzle-orm";

import { type Db } from "../db/client.ts";
import { credentials } from "../db/schema/index.ts";
import type { ConnectorView } from "./types.ts";

export interface ScopeDiff {
  /**
   * - `true`  — granted ⊊ expected (real partial grant; missing_scopes
   *             enumerates the gap).
   * - `false` — granted ⊇ expected (every requested scope is present).
   * - `"unknown"` — credential row predates the 6.2.4 G6 migration; no
   *                 granted_scopes was recorded. The LLM must NOT infer
   *                 "fully granted" from missing data — re-authorising
   *                 is the only safe way to learn the actual grant set.
   */
  partial_grant: boolean | "unknown";
  expected: string[];
  granted: string[];
  /** Always [] when partial_grant is false or "unknown". */
  missing: string[];
  /** Actionable hint for the LLM, populated only when partial_grant=true. */
  note?: string;
}

function splitScopes(s: string): string[] {
  return s
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Pure-function diff used by both surfaces (and the unit test). Returns
 * null when the diff is structurally not applicable:
 *   - the connector is not oauth2,
 *   - the connector template declared no expected scope set
 *     (`connector.config.oauth.scope` missing/empty),
 *   - the credential row's granted_scopes is missing AND expected is
 *     missing (nothing to compare).
 *
 * Returns `partial_grant: "unknown"` when expected is known but
 * granted is null — H4's explicit-unknown contract.
 */
export function diffOauthScopes(
  expectedScopeStr: string | null | undefined,
  grantedScopeStr: string | null | undefined,
): ScopeDiff | null {
  if (!expectedScopeStr) return null;
  const expected = splitScopes(expectedScopeStr);
  if (expected.length === 0) return null;
  if (grantedScopeStr === null || grantedScopeStr === undefined || grantedScopeStr === "") {
    // H4: expected is known but we never recorded granted (pre-G6 row).
    // Surface as "unknown" so the LLM can prompt the user to re-auth
    // rather than assuming the credential is fully provisioned.
    return {
      partial_grant: "unknown",
      expected,
      granted: [],
      missing: [],
      note: "this credential was issued before the engine started tracking OAuth grant scopes; cannot verify whether every requested scope was granted. Re-run authenticate_oauth to record the current grant set.",
    };
  }
  const granted = splitScopes(grantedScopeStr);
  const grantedSet = new Set(granted);
  const missing = expected.filter((s) => !grantedSet.has(s));
  if (missing.length === 0) {
    return { partial_grant: false, expected, granted, missing: [] };
  }
  return {
    partial_grant: true,
    expected,
    granted,
    missing,
    note: `the IdP granted ${granted.length}/${expected.length} requested scopes; calls against APIs covered by [${missing.join(", ")}] will 401. Re-run authenticate_oauth and tick every box on the consent screen, OR enable any APIs in the provider console whose scope was rejected by default.`,
  };
}

/**
 * Load the credential row's `granted_scopes` for a connector and compute
 * the diff against `connector.config.oauth.scope`. Best-effort: a DB
 * blip returns null (callers treat null as "no diff signal").
 */
export async function computeConnectorScopeDiff(
  db: Db,
  tenant_id: string,
  connector: ConnectorView,
): Promise<ScopeDiff | null> {
  if (connector.auth_type !== "oauth2") return null;
  try {
    const credRows = await db
      .select({ granted_scopes: credentials.granted_scopes })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, tenant_id),
          eq(credentials.connector_id, connector.id),
          eq(credentials.environment, connector.environment),
          ne(credentials.mode, "oauth2_client"),
          isNull(credentials.deleted_at),
        ),
      )
      .limit(1);
    const granted = credRows[0]?.granted_scopes ?? null;
    const expected =
      connector.config &&
      typeof connector.config === "object" &&
      "oauth" in connector.config &&
      connector.config.oauth &&
      typeof connector.config.oauth === "object" &&
      "scope" in (connector.config.oauth as Record<string, unknown>)
        ? ((connector.config.oauth as { scope?: unknown }).scope as string | null | undefined)
        : null;
    return diffOauthScopes(expected ?? null, granted);
  } catch {
    return null;
  }
}
