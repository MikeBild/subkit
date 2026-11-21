import {
  checkForUpdate,
  defaultUpdaterConfig,
  listRetainedVersions,
  performUpdate,
  rollbackTo,
  type UpdaterConfig,
} from "@cli-core/updater.ts";
import { VERSION } from "@cli-core/version.ts";
import {
  recordEngineUpdateCompleted,
  recordEngineUpdateFailed,
  recordEngineUpdateInitiated,
  recordEngineUpdateRolledBack,
} from "./audit/recorders/index.ts";
import type { DeploymentMode } from "./config/deployment-mode.ts";
import { getConfig, isConfigLoaded, loadConfig } from "./config/loader.ts";
import type { Db } from "./db/client.ts";
import { getDb } from "./db/client.ts";
import { logger } from "./logging/index.ts";
import { recordEngineUpdate } from "./observability/instrumentation.ts";

const CHANNEL = "stable" as const;

function openAuditDb(): Db {
  try {
    return getDb();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `--self-update / --rollback need DATABASE_URL set so the audit row can be written. ` +
        `On a systemd host, source the unit's EnvironmentFile first (root cause: ${cause}).`,
    );
  }
}

interface SwapPlan {
  request_source: "self-update" | "rollback";
  from_version: string;
  to_version: string;
  log_action_initiated: "engine.update.initiated";
  human_label: string;
}

interface SwapResultOk {
  to_version: string;
  sha256: string;
}

async function instrumentBinarySwap(
  plan: SwapPlan,
  swap: (db: Db) => Promise<SwapResultOk>,
  recordSuccess: (
    db: Db,
    fields: { from_version: string; to_version: string; sha256: string },
  ) => Promise<unknown>,
  successMetric: "success" | "rollback",
  successLogAction: "engine.update.completed" | "engine.update.rolled_back",
): Promise<void> {
  const db = openAuditDb();

  await recordEngineUpdateInitiated({
    from_version: plan.from_version,
    to_version: plan.to_version,
    channel: CHANNEL,
    request_source: plan.request_source,
    executor: db,
  });
  logger.info({
    module: "self-update",
    action: plan.log_action_initiated,
    msg: `${plan.human_label} ${plan.from_version} → ${plan.to_version} initiated`,
    from_version: plan.from_version,
    to_version: plan.to_version,
    channel: CHANNEL,
    request_source: plan.request_source,
  });

  process.stdout.write(
    `engine: ${plan.human_label} ${plan.from_version} → ${plan.to_version}...\n`,
  );

  try {
    const result = await swap(db);
    await recordSuccess(db, {
      from_version: plan.from_version,
      to_version: result.to_version,
      sha256: result.sha256,
    });
    logger.info({
      module: "self-update",
      action: successLogAction,
      msg: `${plan.human_label} ${plan.from_version} → ${result.to_version} completed`,
      from_version: plan.from_version,
      to_version: result.to_version,
      sha256: result.sha256,
      channel: CHANNEL,
      request_source: plan.request_source,
    });
    recordEngineUpdate({ result: successMetric, channel: CHANNEL });
    process.stdout.write(
      `engine: ${plan.human_label} → ${result.to_version}. Restart the engine to use the new version.\n`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordEngineUpdateFailed({
      from_version: plan.from_version,
      to_version: plan.to_version,
      channel: CHANNEL,
      request_source: plan.request_source,
      reason,
      executor: db,
    });
    logger.error({
      module: "self-update",
      action: "engine.update.failed",
      msg: `${plan.human_label} ${plan.from_version} → ${plan.to_version} failed: ${reason}`,
      from_version: plan.from_version,
      to_version: plan.to_version,
      channel: CHANNEL,
      request_source: plan.request_source,
      error: reason,
    });
    recordEngineUpdate({ result: "failed", channel: CHANNEL });
    throw err;
  }
}

export async function assertSelfUpdateAllowed(mode?: DeploymentMode): Promise<void> {
  const resolved = mode ?? (isConfigLoaded() ? getConfig() : await loadConfig()).deployment.mode;
  if (resolved === "local_workspace")
    throw new Error(
      "SubKit Desktop updates this engine with the app; self-update is off in local mode",
    );
}

export async function runSelfUpdate(
  fetchImpl?: typeof fetch,
  configOverride?: UpdaterConfig,
): Promise<void> {
  await assertSelfUpdateAllowed();
  const config = configOverride ?? defaultUpdaterConfig("engine", VERSION);
  process.stdout.write("engine: checking for updates...\n");

  const info = await checkForUpdate(config, true, fetchImpl);
  if (!info || info.assets.length === 0) {
    process.stdout.write(`engine: already at latest version ${VERSION}\n`);
    return;
  }

  await instrumentBinarySwap(
    {
      request_source: "self-update",
      from_version: VERSION,
      to_version: info.version,
      log_action_initiated: "engine.update.initiated",
      human_label: "updating",
    },
    async () => {
      const result = await performUpdate(config, info, fetchImpl);
      return { to_version: result.to_version, sha256: result.sha256 };
    },
    (db, fields) =>
      recordEngineUpdateCompleted({
        ...fields,
        channel: CHANNEL,
        request_source: "self-update",
        executor: db,
      }),
    "success",
    "engine.update.completed",
  );
}

export async function runRollback(
  target: string | "previous" = "previous",
  configOverride?: UpdaterConfig,
): Promise<void> {
  await assertSelfUpdateAllowed();
  const config = configOverride ?? defaultUpdaterConfig("engine", VERSION);
  const retained = listRetainedVersions(config);
  if (retained.length === 0) {
    const db = openAuditDb();
    await recordEngineUpdateFailed({
      from_version: VERSION,
      to_version: target === "previous" ? "<none>" : target,
      channel: CHANNEL,
      request_source: "rollback",
      reason: "no retained binaries available — nothing to roll back to",
      executor: db,
    });
    logger.warn({
      module: "self-update",
      action: "engine.update.failed",
      msg: "engine rollback rejected — no retained binaries",
      from_version: VERSION,
      request_source: "rollback",
    });
    recordEngineUpdate({ result: "failed", channel: CHANNEL });
    throw new Error(
      "no retained binaries — there is nothing to roll back to. Self-update at least once first.",
    );
  }

  const tentativeTarget = target === "previous" ? retained[0]!.version : target;

  await instrumentBinarySwap(
    {
      request_source: "rollback",
      from_version: VERSION,
      to_version: tentativeTarget,
      log_action_initiated: "engine.update.initiated",
      human_label: "rolling back",
    },
    async () => {
      const result = rollbackTo(config, target);
      return { to_version: result.to_version, sha256: result.sha256 };
    },
    (db, fields) =>
      recordEngineUpdateRolledBack({
        ...fields,
        channel: CHANNEL,
        executor: db,
      }),
    "rollback",
    "engine.update.rolled_back",
  );
}
