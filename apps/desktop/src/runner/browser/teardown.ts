import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserLayout,
  browserProcesses,
  type ProcessRow,
  parsePidFile,
  parseProcessTable,
  profileDir,
  STOP_CLOSE_MS,
  sessionName,
} from "../../shared/local/browser-runtime.ts";
import type { AgentBrowserClient } from "./agent-browser.ts";

export interface TeardownDeps {
  readText(path: string): Promise<string | null>;
  processes(): Promise<ProcessRow[]>;
  kill(target: number): void;
  remove(path: string): Promise<void>;
}

export const systemTeardown: TeardownDeps = {
  readText: (path) => readFile(path, "utf8").catch(() => null),
  processes: () =>
    new Promise((resolve) => {
      execFile(
        "/bin/ps",
        ["-axww", "-o", "pid=,pgid=,command="],
        { maxBuffer: 16 << 20 },
        (error, stdout) => resolve(error ? [] : parseProcessTable(stdout)),
      );
    }),
  kill(target) {
    try {
      process.kill(target, "SIGKILL");
    } catch {}
  },
  remove: (path) => rm(path, { force: true }).catch(() => {}),
};

export async function killBrowserSession(
  layout: BrowserLayout,
  partition: string,
  deps: TeardownDeps = systemTeardown,
): Promise<number[]> {
  const pidFile = join(layout.sockets, `${sessionName(partition)}.pid`);
  const [pidText, rows] = await Promise.all([deps.readText(pidFile), deps.processes()]);
  const targets = browserProcesses(rows, {
    profile: profileDir(layout, partition),
    daemon: parsePidFile(pidText ?? ""),
    self: process.pid,
  });
  for (const target of targets) deps.kill(target);
  await deps.remove(pidFile);
  return targets;
}

export async function closeBrowser(
  client: AgentBrowserClient,
  layout: BrowserLayout,
  partition: string,
  deps: TeardownDeps = systemTeardown,
): Promise<number[]> {
  await client.call("agent_browser_close", {}, AbortSignal.timeout(STOP_CLOSE_MS));
  return killBrowserSession(layout, partition, deps);
}
