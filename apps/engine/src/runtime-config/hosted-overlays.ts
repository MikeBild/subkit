import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { Executor } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { RuntimeConfigValidationError } from "./contracts.ts";

export async function assertNoHostedTenantOverlays(db: Executor, config: Config): Promise<void> {
  const tenantIds = Object.keys(config.tenants).filter((id) => z.uuid().safeParse(id).success);
  if (tenantIds.length === 0) return;
  const scopedTenants = await db
    .select({ id: tenants.id, origin: tenants.origin })
    .from(tenants)
    .where(inArray(tenants.id, tenantIds));
  if (scopedTenants.some((tenant) => tenant.origin === "self_service")) {
    throw new RuntimeConfigValidationError(
      "Self-service workspace settings are managed by the engine operator's global policy; tenant runtime configuration overlays are not allowed",
    );
  }
}
