import { runProbePathV1Backfill } from "../connectors/index.ts";
import { createDbFromUrl } from "../db/index.ts";
import { errorFields, logger } from "../logging/index.ts";
import {
  runLoopToForEachV2Backfill,
  runModelStepV1Backfill,
  runRequestProtocolV1Backfill,
} from "../workflows/index.ts";

const BACKFILLS = [
  { name: "loop to for_each", run: runLoopToForEachV2Backfill },
  { name: "request protocol", run: runRequestProtocolV1Backfill },
  { name: "model step", run: runModelStepV1Backfill },
  { name: "connector probe path", run: runProbePathV1Backfill },
] as const;

export async function runDataBackfillsFromUrl(url: string): Promise<void> {
  const { pool, db } = createDbFromUrl(url);
  try {
    for (const backfill of BACKFILLS) {
      try {
        await backfill.run(db);
      } catch (err) {
        logger.error({
          module: "db",
          action: "migrate.code_backfill_failed",
          msg: `${backfill.name} backfill failed (non-fatal; retried on next boot)`,
          ...errorFields(err),
        });
      }
    }
  } finally {
    await pool.end();
  }
}
