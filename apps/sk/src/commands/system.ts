import { isEngineError, isTransportError, reportCommandError } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import type { EngineClient, EngineRestartStatus } from "../engine-client.ts";
import { makeClientFromArgs, withCommandErrors } from "./command-runtime.ts";

export const RESTART_WAIT_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 2_000;

const MANUAL_RESTART =
  "Restart it where it runs: `systemctl restart subkit-engine` or `docker compose restart engine`.";

export const REFUSAL_GUIDANCE: Record<string, string> = {
  not_supervised: `SubKit does not restart itself here: no supervisor is declared. ${MANUAL_RESTART} Or declare the supervisor: \`sk settings set server.restart_supervised true\`.`,
  nothing_pending: "Nothing waits for a restart: every saved setting is already active.",
  multiple_replicas: `More than one engine instance is live; a restart from here would take down only one. ${MANUAL_RESTART}`,
  restart_in_progress:
    "A restart was requested a moment ago and is still running (or ended less than a minute ago). Check again with `sk settings list` in a minute.",
  not_ready: "The engine is still starting and cannot restart yet. Try again in a moment.",
};

export type RestartWaitOutcome =
  | { kind: "restarted"; status: EngineRestartStatus }
  | { kind: "not_activated"; status: EngineRestartStatus }
  | { kind: "timeout" };

function stillRestarting(error: unknown): boolean {
  if (isTransportError(error)) return true;
  return isEngineError(error) && [502, 503, 504].includes(error.status);
}

export async function waitForRestart(args: {
  fromBootId: string;
  fetchStatus: () => Promise<EngineRestartStatus>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<RestartWaitOutcome> {
  const sleep = args.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = args.now ?? Date.now;
  const deadline = now() + (args.timeoutMs ?? RESTART_WAIT_TIMEOUT_MS);
  const interval = args.intervalMs ?? POLL_INTERVAL_MS;
  while (now() < deadline) {
    await sleep(interval);
    let status: EngineRestartStatus;
    try {
      status = await args.fetchStatus();
    } catch (error) {
      if (stillRestarting(error)) continue;
      throw error;
    }
    if (status.boot_id === args.fromBootId) continue;
    return status.active_revision === status.saved_revision
      ? { kind: "restarted", status }
      : { kind: "not_activated", status };
  }
  return { kind: "timeout" };
}

const restartCommand = defineCommand({
  meta: {
    name: "restart",
    description:
      "Restart the engine so a saved restart-sensitive setting takes effect (needs a supervisor)",
  },
  args: {
    wait: {
      type: "boolean" as const,
      description: "Wait (up to 240 s) until the restarted engine runs the saved settings",
    },
    "engine-url": { type: "string" as const, description: "Engine base URL" },
    "api-key": { type: "string" as const, description: "API key" },
    profile: { type: "string" as const, description: "Profile name" },
    json: { type: "boolean" as const, description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClientFromArgs(args);
    const json = Boolean(args.json);
    let accepted: Awaited<ReturnType<EngineClient["requestEngineRestart"]>>;
    try {
      accepted = await client.requestEngineRestart();
    } catch (error) {
      if (isEngineError(error) && error.status === 409 && REFUSAL_GUIDANCE[error.code]) {
        if (json) printJson({ accepted: false, code: error.code, message: error.message });
        else process.stderr.write(`${pc.yellow("sk:")} ${REFUSAL_GUIDANCE[error.code]}\n`);
        process.exitCode = error.code === "nothing_pending" ? 0 : 1;
        return;
      }
      reportCommandError(error, { json });
    }
    if (!args.wait) {
      if (json) printJson({ accepted: true, ...accepted });
      else
        process.stdout.write(
          `Restart accepted. SubKit is briefly unreachable; running steps get up to 2 minutes and continue after the start.\nOnce it answers again, ${pc.cyan("sk settings list")} shows whether anything still waits.\n`,
        );
      return;
    }
    if (!json) process.stdout.write("Restarting…\n");
    return withCommandErrors(
      async () => {
        const outcome = await waitForRestart({
          fromBootId: accepted.boot_id,
          fetchStatus: () => client.getEngineRestartStatus(),
        });
        if (json) {
          printJson({ accepted: true, ...accepted, outcome: outcome.kind });
        } else if (outcome.kind === "restarted") {
          process.stdout.write(
            `${pc.green("Restarted.")} Revision ${outcome.status.active_revision} is active. Audit entry: ${accepted.audit_id}\n`,
          );
        } else if (outcome.kind === "not_activated") {
          process.stderr.write(
            `${pc.red("Restarted, but the saved settings are not active:")} saved ${outcome.status.saved_revision}, active ${outcome.status.active_revision} (${outcome.status.activation_status}). See \`sk logs\` and the audit entry ${accepted.audit_id}.\n`,
          );
        } else {
          process.stderr.write(
            `${pc.red("Restart not confirmed after 240 s.")} ${MANUAL_RESTART} Check the engine log for exit code 75 and the supervisor's start limit.\n`,
          );
        }
        if (outcome.kind !== "restarted") process.exitCode = 1;
      },
      { json },
    );
  },
});

export const systemCommand = defineCommand({
  meta: { name: "system", description: "Engine process operations (restart)" },
  subCommands: { restart: restartCommand },
});
