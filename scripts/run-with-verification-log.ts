import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startOwnedChild } from "./lib/owned-process-watchdog.ts";
import {
  createVerificationRun,
  finalizeVerificationRun,
  type RetentionClass,
  verificationRunsRoot,
} from "./lib/verification-run-lifecycle.ts";

export type VerificationLogCommand = Readonly<{
  root: string;
  owner: string;
  command: string;
  args: readonly string[];
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  sourceDigest?: string;
  retention?: Exclude<RetentionClass, "historical">;
}>;

export async function runWithVerificationLog(command: VerificationLogCommand): Promise<number> {
  const run = createVerificationRun({
    root: command.root,
    owner: command.owner,
    ...(command.retention === undefined ? {} : { retention: command.retention }),
    logPath: "runner.log",
    ...(command.sourceDigest === undefined ? {} : { sourceDigest: command.sourceDigest }),
  });
  const log = join(run.directory, "runner.log");
  const result = join(run.directory, "result.json");
  writeFileSync(log, "", { mode: 0o600, flag: "wx" });
  const child = startOwnedChild(
    command.command,
    [...command.args],
    { cwd: command.cwd ?? process.cwd(), env: command.env, stdio: ["ignore", "pipe", "pipe"] },
    command.timeoutMs,
    100,
  );
  let parentInterrupted = false;
  const stopForParentSignal = () => {
    parentInterrupted = true;
    child.stop();
  };
  process.once("SIGINT", stopForParentSignal);
  process.once("SIGTERM", stopForParentSignal);
  const collect = (stream: NodeJS.ReadableStream) =>
    new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        stream.off("data", data);
        stream.off("end", end);
        stream.off("error", failed);
        if (error === undefined) resolve();
        else reject(error);
      };
      const data = (chunk: Buffer) => {
        try {
          appendFileSync(log, chunk);
        } catch (error) {
          child.stop();
          finish(error);
        }
      };
      const end = () => finish();
      const failed = (error: Error) => {
        child.stop();
        finish(error);
      };
      stream.on("data", data);
      stream.once("end", end);
      stream.once("error", failed);
    });
  try {
    const [outcomeResult, stdoutResult, stderrResult] = await Promise.allSettled([
      child.completed,
      collect(child.child.stdout!),
      collect(child.child.stderr!),
    ]);
    if (outcomeResult.status !== "fulfilled") throw outcomeResult.reason;
    const outcome = outcomeResult.value;
    const streamError = [stdoutResult, stderrResult].find((item) => item.status === "rejected");
    const status =
      outcome.exitCode === 0 &&
      !outcome.timedOut &&
      !outcome.error &&
      !parentInterrupted &&
      streamError === undefined
        ? "passed"
        : "failed";
    const receipt = {
      status,
      command: command.command,
      args: command.args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      parentInterrupted,
      error:
        outcome.error ?? (streamError?.status === "rejected" ? String(streamError.reason) : null),
    };
    writeFileSync(result, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    finalizeVerificationRun(run, { status, resultPath: "result.json" });
    return status === "passed"
      ? 0
      : outcome.exitCode && outcome.exitCode !== 0
        ? outcome.exitCode
        : 1;
  } catch (error) {
    child.stop();
    await child.completed;
    let resultPath: string | undefined;
    try {
      writeFileSync(
        result,
        `${JSON.stringify({ status: "failed", command: command.command, args: command.args, error: String(error) }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      resultPath = "result.json";
    } finally {
      finalizeVerificationRun(run, { status: "failed", ...(resultPath ? { resultPath } : {}) });
    }
    throw error;
  } finally {
    process.off("SIGINT", stopForParentSignal);
    process.off("SIGTERM", stopForParentSignal);
  }
}

export function parseVerificationLogArgs(args: readonly string[]): VerificationLogCommand {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1)
    throw new Error(
      "usage: bun run scripts/run-with-verification-log.ts --owner <name> [--timeout-ms <ms>] -- <command> [args...]",
    );
  let owner: string | undefined;
  let timeoutMs = 60 * 60 * 1000;
  for (let index = 0; index < separator; index += 1) {
    const arg = args[index];
    if (arg === "--owner") owner = args[++index];
    else if (arg === "--timeout-ms") timeoutMs = Number(args[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!owner || !Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("owner and a positive timeout are required");
  return {
    root: verificationRunsRoot(process.cwd()),
    owner,
    command: args[separator + 1]!,
    args: args.slice(separator + 2),
    timeoutMs,
  };
}

if (import.meta.main)
  process.exit(await runWithVerificationLog(parseVerificationLogArgs(process.argv.slice(2))));
