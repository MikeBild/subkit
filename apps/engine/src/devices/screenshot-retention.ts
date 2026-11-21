import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { deviceCommands } from "../db/schema/index.ts";
import { logger } from "../logging/index.ts";
import { getBoss } from "../queue/boss.ts";
import { DEVICE_WAIT_QUEUE, type DeviceWaitJob } from "../queue/queues.ts";
import { SCREENSHOT_KINDS, SCREENSHOT_RETENTION_MS } from "./core/screenshot-retention.ts";

export async function scheduleScreenshotExpiry(tenant_id: string, at: Date): Promise<void> {
  try {
    await getBoss().send(
      DEVICE_WAIT_QUEUE,
      { tenant_id, phase: "screenshot_expire" } satisfies DeviceWaitJob,
      { startAfter: at },
    );
  } catch (error) {
    logger.warn({
      module: "devices",
      action: "device_screenshot.expiry_unscheduled",
      msg: "the encrypted screenshot copy waits for the next expiry of this workspace",
      tenant_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function expireScreenshots(db: Db, tenant_id: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SCREENSHOT_RETENTION_MS);
  const rows = await db
    .update(deviceCommands)
    .set({ result: null })
    .where(
      and(
        eq(deviceCommands.tenant_id, tenant_id),
        inArray(deviceCommands.kind, [...SCREENSHOT_KINDS]),
        isNotNull(deviceCommands.result),
        sql`${deviceCommands.finished_at} <= ${cutoff}`,
      ),
    )
    .returning({ id: deviceCommands.id });
  return rows.length;
}
