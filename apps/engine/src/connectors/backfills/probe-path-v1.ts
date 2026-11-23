import type { Db } from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
import { PROBE_PATH_TEMPLATE_SLUGS, rewriteRetiredProbePath } from "../core/probe-path.ts";
import {
  connectorBackfillRan,
  markConnectorBackfillRan,
  templateConnectorRows,
  writeConnectorConfig,
} from "./persistence/probe-config-rows.ts";

export const PROBE_PATH_V1_BACKFILL_NAME = "connector_probe_path_v1";

export interface ProbePathV1Report {
  skipped: boolean;
  rewritten: number;
}

export async function runProbePathV1Backfill(db: Db): Promise<ProbePathV1Report> {
  if (await connectorBackfillRan(db, PROBE_PATH_V1_BACKFILL_NAME)) {
    return { skipped: true, rewritten: 0 };
  }
  let rewritten = 0;
  for (const row of await templateConnectorRows(db, PROBE_PATH_TEMPLATE_SLUGS)) {
    const rewrite = rewriteRetiredProbePath(row.template_slug, row.config);
    if (!rewrite.changed) continue;
    await writeConnectorConfig(db, row, rewrite.config);
    rewritten++;
  }
  await markConnectorBackfillRan(db, PROBE_PATH_V1_BACKFILL_NAME);
  logger.info({
    module: "connectors",
    action: "connector.probe_path_migration.completed",
    msg: "connector probe path backfill finished",
    rewritten,
  });
  return { skipped: false, rewritten };
}
