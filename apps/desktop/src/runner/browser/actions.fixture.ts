import type { BrowserStep } from "@shared/device/browser.ts";
import type { DeviceCommand, DeviceResult } from "@shared/device/protocol.ts";
import type { ProxySiteRules } from "@shared/local-policy/proxy-decision.ts";
import pin from "../../../vendor/agent-browser.json";
import { BrowserPinSchema, browserLayout } from "../../shared/local/browser-runtime.ts";
import {
  type BrowserFiles,
  createBrowserAdapter,
  type DownloadSink,
  REFUSING_SINK,
} from "./actions.ts";
import type { AgentBrowserClient, AgentBrowserResult } from "./agent-browser.ts";
import type { SecretTickets } from "./vault-actions.ts";
import type { ScriptLedger } from "./vault-fill.ts";

export const layout = browserLayout(
  "/data",
  BrowserPinSchema.parse(pin),
  "darwin-arm64",
  "/tmp-test",
);

export type Handler = (
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<AgentBrowserResult>;

export interface Page {
  url: string;
  title: string;
  fields?: unknown;
  attrs?: Record<string, string | null>;
}

export function ok(data: unknown): Promise<AgentBrowserResult> {
  return Promise.resolve({ ok: true, data });
}

export function fakeClient(page: Page, extra: Record<string, Handler> = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, Handler> = {
    agent_browser_get_url: () => ok({ url: page.url }),
    agent_browser_get_title: () => ok({ title: page.title }),
    agent_browser_open: (args) => {
      page.url = String(args.url);
      return ok({ url: page.url });
    },
    agent_browser_click: () => ok({}),
    agent_browser_press: () => ok({}),
    agent_browser_scroll: () => ok({}),
    agent_browser_fill: () => ok({}),
    agent_browser_type: () => ok({}),
    agent_browser_select: () => ok({}),
    agent_browser_snapshot: () => ok({ snapshot: '- button "Buy" [ref=e1]', refs: { e1: {} } }),
    agent_browser_get_text: () => ok({ text: "Hello page" }),
    agent_browser_wait_for_load: () => ok({}),
    agent_browser_wait_for_text: () => ok({}),
    agent_browser_wait_ms: () => ok({}),
    agent_browser_get_attr: (args) => ok({ value: page.attrs?.[String(args.name)] ?? null }),
    agent_browser_eval: () => ok({ result: JSON.stringify(page.fields ?? { dpr: 1, fields: [] }) }),
    agent_browser_screenshot: () => ok({ path: "x" }),
    agent_browser_download: () => ok({}),
    ...extra,
  };
  const client: AgentBrowserClient = {
    call(tool, args, signal) {
      calls.push({ tool, args });
      const handler = handlers[tool];
      if (!handler) return Promise.resolve({ ok: false, code: "unknown_tool", error: tool });
      return handler(args, signal);
    },
  };
  return { client, calls };
}

export function memoryFiles(seed: Record<string, Uint8Array> = {}) {
  const store = new Map(Object.entries(seed));
  const purged: string[] = [];
  const files: BrowserFiles = {
    read: async (path) => store.get(path) ?? null,
    remove: async (path) => {
      store.delete(path);
    },
    purge: async (folder) => {
      purged.push(folder);
      for (const key of [...store.keys()]) if (key.startsWith(`${folder}/`)) store.delete(key);
    },
    mkdir: async () => {},
  };
  return { files, store, purged };
}

export function command(
  kind: DeviceCommand["kind"],
  args: unknown,
  overrides: Partial<DeviceCommand> = {},
) {
  return {
    command_id: "cmd-1",
    tenant_id: "t1",
    execution_id: null,
    task_run_id: "task-1",
    conversation_id: null,
    step_id: "s1",
    authority_id: null,
    manifest_digest: null,
    kind,
    args,
    deadline_at: "2026-11-21T10:00:00.000Z",
    generation: 0,
    confirmation: null,
    ...overrides,
  } satisfies DeviceCommand;
}

export function setup(
  page: Page,
  options: {
    extra?: Record<string, Handler>;
    seed?: Record<string, Uint8Array>;
    sink?: DownloadSink;
    refusal?: string | null;
    download?: Uint8Array;
    tickets?: SecretTickets;
    scripts?: ScriptLedger;
  } = {},
) {
  const memory = memoryFiles(options.seed);
  const delivered = options.download;
  const downloadHandler: Record<string, Handler> =
    delivered === undefined
      ? {}
      : {
          agent_browser_download: (args) => {
            memory.store.set(String(args.path), delivered);
            return ok({});
          },
        };
  const { client, calls } = fakeClient(page, { ...downloadHandler, ...options.extra });
  const rules: ProxySiteRules[] = [];
  const steps: BrowserStep[] = [];
  const teardowns: string[] = [];
  const adapter = createBrowserAdapter({
    layout,
    version: "0.43.0",
    clientFor: () => client,
    setRules: (next) => rules.push(next),
    refusals: { reset: () => {}, last: () => options.refusal ?? null },
    allowances: () => ({
      sites: [
        { origin: "https://shop.example.com", entered_by: "approval" },
        { origin: "http://192.168.1.5", entered_by: "person" },
      ],
    }),
    sink: options.sink ?? REFUSING_SINK,
    files: memory.files,
    teardown: async (partition) => {
      teardowns.push(partition);
    },
    onStep: (step) => steps.push(step),
    ...(options.tickets ? { tickets: options.tickets } : {}),
    ...(options.scripts ? { scripts: options.scripts } : {}),
  });
  return { adapter, calls, rules, steps, teardowns, memory };
}

export const live = () => new AbortController().signal;

export function outputOf(result: DeviceResult): Record<string, unknown> {
  if (result.status !== "done") throw new Error(`expected done, got ${JSON.stringify(result)}`);
  return result.output as Record<string, unknown>;
}
