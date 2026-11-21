import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserStep } from "@shared/device/browser.ts";
import { CLOSED_RULES, type ProxySiteRules } from "@shared/local-policy/proxy-decision.ts";
import pinJson from "../../../vendor/agent-browser.json";
import type { BrowserAllowances } from "../../shared/local/browser-rules.ts";
import {
  agentBrowserEnv,
  type BrowserLayout,
  BrowserPinSchema,
  browserLayout,
  browserTargetFor,
} from "../../shared/local/browser-runtime.ts";
import type { RunnerBrowserConfig } from "../../shared/local/runner-port.ts";
import type { DeviceAdapter } from "../adapter.ts";
import { type BrowserFiles, createBrowserAdapter, type DownloadSink } from "./actions.ts";
import { type AgentBrowserClient, createAgentBrowserProcess } from "./agent-browser.ts";
import { type FilteringProxy, type ProxyDecisionEvent, startFilteringProxy } from "./proxy.ts";
import { closeBrowser } from "./teardown.ts";

export interface BrowserCapability {
  readonly adapter: DeviceAdapter;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserCapabilityOptions {
  readonly config: RunnerBrowserConfig;
  readonly sink: DownloadSink;
  readonly onStep?: (step: BrowserStep) => void;
  readonly onDecision?: (event: ProxyDecisionEvent) => void;
}

const CALL_TIMEOUT_MS = 5 * 60 * 1000;

export const nodeBrowserFiles: BrowserFiles = {
  read: (path) =>
    readFile(path)
      .then((buffer) => new Uint8Array(buffer))
      .catch(() => null),
  remove: (path) => rm(path, { force: true }),
  async purge(folder) {
    const entries = await readdir(folder).catch(() => [] as string[]);
    await Promise.all(
      entries.map((entry) => rm(join(folder, entry), { recursive: true, force: true })),
    );
  },
  mkdir: async (folder) => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  },
};

export function createBrowserCapability(
  options: BrowserCapabilityOptions,
): BrowserCapability | null {
  const target = browserTargetFor(process.platform, process.arch);
  if (target === null) return null;
  const pin = BrowserPinSchema.parse(pinJson);
  const layout: BrowserLayout = browserLayout(options.config.data_dir, pin, target, tmpdir());
  const allowances: BrowserAllowances = {
    sites: options.config.sites,
  };
  let rules: ProxySiteRules = CLOSED_RULES;
  let lastRefusal: string | null = null;
  let proxy: Promise<FilteringProxy> | null = null;
  const clients = new Map<string, AgentBrowserClient>();
  const secret = randomBytes(24).toString("hex");

  const proxyReady = () => {
    proxy ??= startFilteringProxy({
      secret,
      rules: () => rules,
      onDecision: (event) => {
        if (!event.allowed) lastRefusal = event.code ?? "origin_not_allowed";
        options.onDecision?.(event);
      },
    });
    return proxy;
  };

  const clientFor = (partition: string, url: string): AgentBrowserClient => {
    const known = clients.get(partition);
    if (known) return known;
    const client = createAgentBrowserProcess({
      command: [options.config.cli_path],
      env: agentBrowserEnv({ layout, partition, proxy: url, path: process.env.PATH }),
      cwd: layout.root,
      version: options.config.version,
      timeoutMs: CALL_TIMEOUT_MS,
    });
    clients.set(partition, client);
    return client;
  };

  const lazyClient = (partition: string): AgentBrowserClient => ({
    async call(tool, args, signal) {
      const running = await proxyReady();
      return clientFor(partition, running.url).call(tool, args, signal);
    },
  });

  const adapter = createBrowserAdapter({
    layout,
    version: options.config.version,
    clientFor: lazyClient,
    setRules: (next) => {
      rules = next;
    },
    refusals: {
      reset: () => {
        lastRefusal = null;
      },
      last: () => lastRefusal,
    },
    allowances: () => allowances,
    sink: options.sink,
    files: nodeBrowserFiles,
    async teardown(partition) {
      rules = CLOSED_RULES;
      const running = proxy === null ? null : await proxy;
      running?.closeConnections();
      await closeBrowser(lazyClient(partition), layout, partition);
    },
    ...(options.onStep ? { onStep: options.onStep } : {}),
  });

  const stop = async () => {
    rules = CLOSED_RULES;
    if (proxy !== null) (await proxy).closeConnections();
    await Promise.all(
      [...clients.keys()].map((partition) =>
        closeBrowser(lazyClient(partition), layout, partition),
      ),
    );
  };

  return {
    adapter,
    stop,
    async close() {
      await stop();
      if (proxy !== null) await (await proxy).close();
    },
  };
}
