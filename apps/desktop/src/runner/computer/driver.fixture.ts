import { expect } from "bun:test";
import type { DeviceCommand, DeviceCommandKind, DeviceResult } from "@shared/device/protocol.ts";
import type { ComputerSnapshot } from "../../shared/local/computer-allowances.ts";
import type { LiveProgress } from "../../shared/local/live-progress.ts";
import { type ComputerDeps, createComputerAdapter } from "./driver.ts";
import { createFakeHelper, type FakeHelper } from "./fake-helper.fixture.ts";

export const NOW = Date.parse("2027-01-15T08:00:00.000Z");
export const DEADLINE = "2027-01-15T08:01:00.000Z";
export const DEVICE = "device-1";
export const NUMBERS = "com.apple.iWork.Numbers";
export const WINDOW = { x: 100, y: 200, width: 400, height: 300 };

export const ok = (command: string, data: unknown) => ({ version: "2.6", ok: true, command, data });
export const error = (command: string, code: string, delivery = "not_delivered") => ({
  version: "2.6",
  ok: false,
  command,
  error: {
    code,
    message: code,
    disposition: { delivery, retry: delivery === "not_delivered" ? "safe" : "unsafe" },
  },
});

export function windows(focused = "w-1") {
  return ok("list-windows", [
    {
      id: "w-1",
      app_name: "Numbers",
      pid: 10,
      title: "Budget",
      bounds: WINDOW,
      is_focused: focused === "w-1",
    },
    {
      id: "w-2",
      app_name: "Terminal",
      pid: 20,
      title: "zsh",
      bounds: WINDOW,
      is_focused: focused === "w-2",
    },
    {
      id: "w-3",
      app_name: "1Password",
      pid: 30,
      title: "Vault",
      bounds: { x: 450, y: 450, width: 100, height: 100 },
      is_focused: false,
    },
    {
      id: "w-4",
      app_name: "Safari",
      pid: 40,
      title: "News",
      bounds: WINDOW,
      is_focused: focused === "w-4",
    },
  ]);
}

export const APPS = ok("list-apps", {
  apps: [
    { bundle_id: NUMBERS, name: "Numbers", pid: 10 },
    { bundle_id: "com.apple.Terminal", name: "Terminal", pid: 20 },
    { bundle_id: "com.agilebits.onepassword7", name: "1Password", pid: 30 },
    { bundle_id: "com.apple.Safari", name: "Safari", pid: 40 },
  ],
});

export function tree(passwordStates: string[] = ["secure"], sendName = "Send") {
  return {
    role: "window",
    name: "Budget",
    bounds: WINDOW,
    children: [
      {
        role: "textfield",
        name: "Amount",
        value: "12",
        ref_id: "@s1:e1",
        states: ["focused"],
        bounds: { x: 120, y: 260, width: 80, height: 20 },
      },
      {
        role: "button",
        name: sendName,
        ref_id: "@s1:e2",
        bounds: { x: 300, y: 400, width: 60, height: 20 },
      },
      {
        role: "textfield",
        name: "PIN",
        ref_id: "@s1:e3",
        states: passwordStates,
        bounds: { x: 110, y: 220, width: 100, height: 20 },
      },
    ],
  };
}

export const snap = (body: unknown = tree()) =>
  ok("snapshot", {
    app: "Numbers",
    snapshot_id: "s1",
    ref_count: 3,
    complete: true,
    window: { id: "w-1", title: "Budget" },
    tree: body,
  });

export const ON: Omit<ComputerSnapshot, "helper"> = {
  enabled: true,
  personal_enabled: true,
  apps: [
    { bundle_id: NUMBERS, team_id: null, display: "Numbers" },
    { bundle_id: "com.apple.Safari", team_id: null, display: "Safari" },
  ],
  keep_out: [],
  permissions: { accessibility: true, screen: true },
};

export function command(kind: DeviceCommandKind, args: unknown, id: string = kind): DeviceCommand {
  return {
    command_id: id,
    tenant_id: "tenant",
    execution_id: null,
    task_run_id: "task-run",
    conversation_id: null,
    step_id: "step",
    authority_id: null,
    manifest_digest: null,
    kind,
    args,
    deadline_at: DEADLINE,
    generation: 0,
    confirmation: null,
  };
}

export interface Harness {
  fake: FakeHelper;
  run(cmd: DeviceCommand, signal?: AbortSignal): Promise<DeviceResult>;
  sleeps: number[];
  progress: { kind: string; progress: LiveProgress }[];
  idleAsked: () => number;
  adapter: ReturnType<typeof createComputerAdapter>;
}

export function harness(
  scenario: Record<string, unknown>,
  overrides: Partial<ComputerDeps> = {},
  base = ON,
): Harness {
  const fake = createFakeHelper();
  fake.script({ "list-windows": windows(), "list-apps": APPS, snapshot: snap(), ...scenario });
  const sleeps: number[] = [];
  const progress: { kind: string; progress: LiveProgress }[] = [];
  let idle = 0;
  const adapter = createComputerAdapter(
    {
      device_id: DEVICE,
      snapshot: () => ({ ...base, helper: { path: fake.path, state_root: fake.state_root } }),
      idleSeconds: async () => {
        idle += 1;
        return 5;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => NOW,
      progress: (cmd, item) => {
        progress.push({ kind: cmd.kind, progress: item });
      },
      ...overrides,
    },
    "1.0.0",
  );
  return {
    fake,
    adapter,
    sleeps,
    progress,
    idleAsked: () => idle,
    run: (cmd, signal = new AbortController().signal) => adapter.execute(cmd, signal),
  };
}

export async function snapshotFirst(h: Harness): Promise<void> {
  const read = await h.run(command("computer.snapshot", { window_id: "w-1" }));
  expect(read.status).toBe("done");
}
