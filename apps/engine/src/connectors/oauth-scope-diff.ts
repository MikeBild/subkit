import { and, eq, isNull, ne } from "drizzle-orm";
import { parseScopeList } from "../credentials/authority-scopes.ts";
import type { Db } from "../db/client.ts";
import { vaultItems } from "../db/schema/index.ts";
import type { ConnectorView } from "./types.ts";

interface ScopeDiff {
  partial_grant: boolean | "unknown";
  expected: string[];
  granted: string[];
  missing: string[];
  note?: string;
}

export function diffOauthScopes(
  expectedScopeStr: string | null | undefined,
  grantedScopeStr: string | null | undefined,
): ScopeDiff | null {
  if (!expectedScopeStr) return null;
  const expected = parseScopeList(expectedScopeStr);
  if (expected.length === 0) return null;
  const granted = parseScopeList(grantedScopeStr ?? "");
  if (granted.length === 0) {
    return {
      partial_grant: "unknown",
      expected,
      granted: [],
      missing: [],
      note: "no granted scope set is recorded for this credential; cannot verify whether every requested scope was granted. Re-run authenticate_oauth to record the current grant set.",
    };
  }
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

export async function computeConnectorScopeDiff(
  db: Db,
  tenant_id: string,
  connector: ConnectorView,
): Promise<ScopeDiff | null> {
  if (connector.auth_type !== "oauth2") return null;
  try {
    const credRows = await db
      .select({ granted_scopes: vaultItems.granted_scopes })
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.tenant_id, tenant_id),
          eq(vaultItems.connector_id, connector.id),
          eq(vaultItems.environment, connector.environment),
          ne(vaultItems.mode, "oauth2_client"),
          isNull(vaultItems.deleted_at),
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
