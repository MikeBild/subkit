import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { sendCockpitPushAttention } from "../identity/index.ts";
import { logger } from "../logging/logger.ts";

function pushSubject(): string | null {
  try {
    const value = getConfig().server.public_base_url.trim();
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

export async function dispatchCockpitPushAttention(db: Db, tenantId: string): Promise<void> {
  const subject = pushSubject();
  if (!subject) return;
  try {
    await sendCockpitPushAttention({ db, tenant_id: tenantId, subject });
  } catch (error) {
    logger.error({
      module: "notifications",
      action: "cockpit_push.dispatch_failed",
      msg: "cockpit push dispatch failed",
      tenant_id: tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
