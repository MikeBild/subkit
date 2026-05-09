// Engine self-update + rollback logic, extracted for testability.
// Invoked via `engine --self-update` and `engine --rollback`. Neither
// path requires DATABASE_URL for the binary swap itself, but they DO
// open a short-lived db handle to land an audit row — the only
// paper-trail surface for a privileged change that mutates the
// running binary (issue #151 P0-2 / P0-4).

import {
  checkForUpdate,
  defaultUpdaterConfig,
  listRetainedVersions,
  performUpdate,
  rollbackTo,
} from "@cli-core/updater.ts";
import { VERSION } from "@cli-core/version.ts";
import {
  recordEngineUpdateCompleted,
  recordEngineUpdateFailed,
  recordEngineUpdateInitiated,
  recordEngineUpdateRolledBack,
} from "./audit/recorders/index.ts";
import { getDb } from "./db/client.ts";
import { logger } from "./logging/index.ts";
import { recordEngineUpdate } from "./observability/instrumentation.ts";

const CHANNEL = "stable" as const;

export async function runSelfUpdate(fetchImpl?: typeof fetch): Promise<void> {
  const config = defaultUpdaterConfig("engine", VERSION);
  process.stdout.write("engine: checking for updates...\n");

  const info = await checkForUpdate(config, true, fetchImpl);
  if (!info || info.assets.length === 0) {
    process.stdout.write(`engine: already at latest version ${VERSION}\n`);
    return;
  }

  const fromVersion = VERSION;
  const toVersion = info.version;
  const db = getDb();

  // INITIATED — emit before the download. If the binary swap crashes
  // the process before COMPLETED lands, the operator still sees the
  // attempt in audit_log.
  await recordEngineUpdateInitiated({
    from_version: fromVersion,
    to_version: toVersion,
    channel: CHANNEL,
    request_source: "self-update",
    executor: db,
  });
  logger.info({
    module: "self-update",
    action: "engine.update.initiated",
    msg: `engine update ${fromVersion} → ${toVersion} initiated`,
    from_version: fromVersion,
    to_version: toVersion,
    channel: CHANNEL,
  });

  process.stdout.write(`engine: updating ${fromVersion} → ${toVersion}...\n`);
  try {
    const result = await performUpdate(config, info, fetchImpl);
    await recordEngineUpdateCompleted({
      from_version: result.from_version,
      to_version: result.to_version,
      channel: CHANNEL,
      sha256: result.sha256,
      request_source: "self-update",
      executor: db,
    });
    logger.info({
      module: "self-update",
      action: "engine.update.completed",
      msg: `engine update ${result.from_version} → ${result.to_version} completed`,
      from_version: result.from_version,
      to_version: result.to_version,
      sha256: result.sha256,
      channel: CHANNEL,
    });
    recordEngineUpdate({ result: "success", channel: CHANNEL });
    process.stdout.write(
      `engine: updated to ${result.to_version}. Restart the engine to use the new version.\n`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordEngineUpdateFailed({
      from_version: fromVersion,
      to_version: toVersion,
      channel: CHANNEL,
      request_source: "self-update",
      reason,
      executor: db,
    });
    logger.error({
      module: "self-update",
      action: "engine.update.failed",
      msg: `engine update ${fromVersion} → ${toVersion} failed: ${reason}`,
      from_version: fromVersion,
      to_version: toVersion,
      channel: CHANNEL,
      error: reason,
    });
    recordEngineUpdate({ result: "failure", channel: CHANNEL });
    throw err;
  }
}

/** Restore a previously retained signed binary in place of the
 *  currently running one. Issue #151 P0-4. */
export async function runRollback(target: string | "previous" = "previous"): Promise<void> {
  const config = defaultUpdaterConfig("engine", VERSION);
  const retained = listRetainedVersions(config);
  if (retained.length === 0) {
    process.stdout.write(
      "engine: no retained binaries — there is nothing to roll back to. " +
        "Self-update at least once first.\n",
    );
    return;
  }

  const fromVersion = VERSION;
  const tentativeTarget = target === "previous" ? retained[0]!.version : target;
  const db = getDb();

  await recordEngineUpdateInitiated({
    from_version: fromVersion,
    to_version: tentativeTarget,
    channel: CHANNEL,
    request_source: "rollback",
    executor: db,
  });
  logger.info({
    module: "self-update",
    action: "engine.update.initiated",
    msg: `engine rollback ${fromVersion} → ${tentativeTarget} initiated`,
    from_version: fromVersion,
    to_version: tentativeTarget,
    request_source: "rollback",
  });

  process.stdout.write(`engine: rolling back ${fromVersion} → ${tentativeTarget}...\n`);
  try {
    const result = rollbackTo(config, target);
    await recordEngineUpdateRolledBack({
      from_version: result.from_version,
      to_version: result.to_version,
      channel: CHANNEL,
      sha256: result.sha256,
      request_source: "rollback",
      executor: db,
    });
    logger.info({
      module: "self-update",
      action: "engine.update.rolled_back",
      msg: `engine rolled back ${result.from_version} → ${result.to_version}`,
      from_version: result.from_version,
      to_version: result.to_version,
      sha256: result.sha256,
    });
    recordEngineUpdate({ result: "rollback", channel: CHANNEL });
    process.stdout.write(
      `engine: rolled back to ${result.to_version}. Restart the engine to use it.\n`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordEngineUpdateFailed({
      from_version: fromVersion,
      to_version: tentativeTarget,
      channel: CHANNEL,
      request_source: "rollback",
      reason,
      executor: db,
    });
    logger.error({
      module: "self-update",
      action: "engine.update.failed",
      msg: `engine rollback ${fromVersion} → ${tentativeTarget} failed: ${reason}`,
      from_version: fromVersion,
      to_version: tentativeTarget,
      request_source: "rollback",
      error: reason,
    });
    recordEngineUpdate({ result: "failure", channel: CHANNEL });
    throw err;
  }
}
