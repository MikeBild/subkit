import { eq } from "drizzle-orm";
import { z } from "zod";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Transaction } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { RuntimeConfigValidationError } from "./contracts.ts";
import { hostedWorkspaceSecretAllowed } from "./hosted-workspace-allowlist.ts";

export async function assertTenantRuntimeSecretAllowed(
  db: Transaction,
  name: string,
): Promise<void> {
  const tenantOverlay = name.startsWith("tenants.");
  if (!tenantOverlay && !name.startsWith("connection.")) return;
  if (
    !tenantOverlay &&
    !/^connection\.[0-9a-f-]{36}\.[a-z0-9][a-z0-9-]{0,62}\.(access_token|refresh_token)$/.test(name)
  )
    throw new RuntimeConfigValidationError(
      "Connection token secrets require an exact workspace-owned name",
    );
  const tenantId = name.split(".")[1];
  if (!z.uuid().safeParse(tenantId).success || !tenantId)
    throw new RuntimeConfigValidationError(
      "Tenant runtime secrets require a known active workspace",
    );
  await lockCatalogVocabulary(db, tenantId);
  const [tenant] = await db
    .select({ origin: tenants.origin, status: tenants.status, deleted_at: tenants.deleted_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for("share")
    .limit(1);
  if (tenant?.status !== "active" || tenant.deleted_at !== null)
    throw new RuntimeConfigValidationError(
      "Tenant runtime secrets require a known active workspace",
    );
  if (
    tenantOverlay &&
    tenant.origin === "self_service" &&
    !hostedWorkspaceSecretAllowed(name, tenantId)
  )
    throw new RuntimeConfigValidationError(
      "Self-service workspace settings use the engine operator's global policy; the only tenant runtime secret allowed is the workspace's own model provider key",
    );
}
