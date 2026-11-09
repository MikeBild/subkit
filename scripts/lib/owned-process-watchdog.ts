import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

export interface WatchdogResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
}

export interface OwnedChild {
  child: ChildProcess;
  completed: Promise<WatchdogResult>;
  stop: () => void;
}

export interface OwnedChildOptions extends SpawnOptions {
  detached?: boolean;
}

export function terminateOwnedProcessGroup(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
) {
  if (process.platform !== "win32" && child.pid) {
    try {
      kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

export function startOwnedChild(
  command: string,
  args: string[],
  options: OwnedChildOptions,
  timeoutMs: number,
  graceMs = 30_000,
): OwnedChild {
  const detached = options.detached ?? process.platform !== "win32";
  const child = spawn(command, args, {
    ...options,
    detached,
  });
  let timedOut = false;
  let stopped = false;
  let hardKillComplete = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let closeResult: Omit<WatchdogResult, "timedOut"> | undefined;
  let finish: (() => void) | undefined;
  const terminate = () => {
    if (stopped) return;
    stopped = true;
    if (detached) {
      terminateOwnedProcessGroup(child, "SIGTERM");
      graceTimer = setTimeout(() => {
        terminateOwnedProcessGroup(child, "SIGKILL");
        hardKillComplete = true;
        finish?.();
      }, graceMs);
    } else {
      child.kill("SIGTERM");
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        hardKillComplete = true;
        finish?.();
      }, graceMs);
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const completed = new Promise<WatchdogResult>((resolve) => {
    let error: string | undefined;
    finish = () => {
      if (!closeResult || (stopped && !hardKillComplete)) return;
      resolve({ ...closeResult, timedOut, ...(error ? { error } : {}) });
    };
    child.once("error", (value) => {
      error = value instanceof Error ? value.message : String(value);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      closeResult = { exitCode, signal };
      if (!stopped && graceTimer) clearTimeout(graceTimer);
      finish?.();
    });
  });
  return { child, completed, stop: terminate };
}
