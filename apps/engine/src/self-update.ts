// Engine self-update + rollback logic, extracted for testability.
// Invoked via `engine --self-update` and `engine --rollback`. Both
// paths require DATABASE_URL because the audit row is the only paper
// trail for a privileged change that mutates the running binary.
//
// DB requirements per branch:
//   `runSelfUpdate` "already at latest" → no DB (returns before the recorder).
//   `runSelfUpdate` update path         → needs DB (INITIATED + COMPLETED|FAILED).
//   `runRollback` retained empty        → needs DB (writes a FAILED row).
//   `runRollback` retained available    → needs DB (INITIATED + ROLLED_BACK|FAILED).

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
import type { Db } from "./db/client.ts";
import { getDb } from "./db/client.ts";
import { logger } from "./logging/index.ts";
import { recordEngineUpdate } from "./observability/instrumentation.ts";

const CHANNEL = "stable" as const;

/** Open the engine db handle for the audit recorders, with a clearer
 *  error message than the bare `pg.Pool` stack when DATABASE_URL is
 *  missing. The flag-handler in `index.ts` exits non-zero on this
 *  error; the message is for the operator on stderr. */
function openAuditDb(): Db {
  try {
    return getDb();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `--self-update / --rollback need DATABASE_URL set so the audit row can be written. ` +
        `On the droplet, source /etc/default/sk-engine first (root cause: ${cause}).`,
    );
  }
}

interface SwapPlan {
  request_source: "self-update" | "rollback";
  from_version: string;
  /** Best-effort target known before the swap. For self-update this is
   *  the new release; for rollback it's the version of the retained
   *  binary picked. Used in the INITIATED row + log line. */
  to_version: string;
  log_action_initiated: "engine.update.initiated";
  human_label: string;
}

interface SwapResultOk {
  /** Final to_version (same as plan.to_version unless the swap helper
   *  refines it — e.g. rollbackTo can substitute "previous"). */
  to_version: string;
  sha256: string;
}

/**
 * Wrap a binary-swap operation in the audit + log + metric envelope.
 * Both `runSelfUpdate` and `runRollback` share the same skeleton:
 * INITIATED row + log → run the swap → COMPLETED|ROLLED_BACK row +
 * log + metric. On throw, FAILED row + log + metric.
 *
 * The two complete-vs-rolled-back rows are different audit actions
 * (compliance treats them separately), so the caller passes a
 * `recordSuccess` callback rather than the helper hard-coding one.
 */
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

export async function runSelfUpdate(
  fetchImpl?: typeof fetch,
  /** Override the default `~/.engine` cache config. Used by integration
   *  tests so the binary swap doesn't write into the developer's real
   *  cache dir; production callers omit. */
  configOverride?: UpdaterConfig,
): Promise<void> {
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

/** Restore a previously retained signed binary in place of the
 *  currently running one. */
export async function runRollback(
  target: string | "previous" = "previous",
  /** See `runSelfUpdate`. */
  configOverride?: UpdaterConfig,
): Promise<void> {
  const config = configOverride ?? defaultUpdaterConfig("engine", VERSION);
  const retained = listRetainedVersions(config);
  if (retained.length === 0) {
    // Compliance: an operator *did* invoke a privileged action — the
    // audit_log should show the attempt even though the binary was not
    // touched. This row uses `request_source: "rollback"` and a fixed
    // FAILED reason so a forensic SELECT can distinguish "rollback was
    // attempted but rejected" from "rollback succeeded". Issue #151
    // round-2 review S5.
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
    // S1 (round-3 review): the audit row says `result: error`, so the
    // process exit code must match. Throwing causes the outer
    // `runRollback` flag handler in `index.ts` to write to stderr and
    // exit 1, keeping shell wrappers / CI in sync with the audit log.
    throw new Error(
      "no retained binaries — there is nothing to roll back to. Self-update at least once first.",
    );
  }

  // Best-effort target for the INITIATED row; rollbackTo will throw if
  // the picked binary fails its integrity check, in which case the
  // FAILED row also carries this version.
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
