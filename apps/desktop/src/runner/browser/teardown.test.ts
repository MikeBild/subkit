import { describe, expect, test } from "bun:test";
import pinJson from "../../../vendor/agent-browser.json";
import {
  BrowserPinSchema,
  browserLayout,
  sessionName,
} from "../../shared/local/browser-runtime.ts";
import type { AgentBrowserClient, AgentBrowserResult } from "./agent-browser.ts";
import { closeBrowser, killBrowserSession, type TeardownDeps } from "./teardown.ts";

const layout = browserLayout("/data", BrowserPinSchema.parse(pinJson), "darwin-arm64", "/t");

function fakeDeps(pidFile: string | null) {
  const killed: number[] = [];
  const removed: string[] = [];
  const deps: TeardownDeps = {
    readText: async (path) =>
      path === `/data/browser/r/${sessionName("p1")}.pid` ? pidFile : null,
    processes: async () => [
      { pid: 70, pgid: 70, command: "/res/agent-browser daemon" },
      { pid: 71, pgid: 70, command: "/chrome --user-data-dir=/data/browser/profiles/p1 --x" },
      { pid: 72, pgid: 70, command: "/chrome --user-data-dir=/data/browser/profiles/p2" },
    ],
    kill: (target) => killed.push(target),
    remove: async (path) => {
      removed.push(path);
    },
  };
  return { deps, killed, removed };
}

describe("browser teardown", () => {
  test("kills the partition's Chrome group and daemon and clears the pid file", async () => {
    const { deps, killed, removed } = fakeDeps("70\n");
    expect(await killBrowserSession(layout, "p1", deps)).toEqual([71, -70, 70]);
    expect(killed).toEqual([71, -70, 70]);
    expect(removed).toEqual([`/data/browser/r/${sessionName("p1")}.pid`]);
  });

  test("closes gracefully first, then removes what is left", async () => {
    const calls: string[] = [];
    const client: AgentBrowserClient = {
      call: async (tool, _args, signal): Promise<AgentBrowserResult> => {
        calls.push(tool);
        expect(signal.aborted).toBe(false);
        return { ok: true, data: null };
      },
    };
    const { deps, killed } = fakeDeps(null);
    expect(await closeBrowser(client, layout, "p1", deps)).toEqual([71, -70]);
    expect(calls).toEqual(["agent_browser_close"]);
    expect(killed).toEqual([71, -70]);
  });
});
