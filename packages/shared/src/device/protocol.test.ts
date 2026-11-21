import { describe, expect, test } from "bun:test";
import {
  capabilityOfKind,
  DEVICE_CAPABILITIES,
  DEVICE_COMMAND_KINDS,
  DEVICE_OS,
  DEVICE_REFUSALS,
  DEVICE_RESULT_STATUSES,
  type DeviceCommand,
  DeviceCommandSchema,
  type DeviceResult,
  DeviceResultSchema,
  type DeviceStopReport,
  DeviceStopReportSchema,
  type Heartbeat,
  HeartbeatSchema,
} from "./protocol.ts";

const FROZEN_KINDS = [
  "files.list",
  "files.read_text",
  "files.import",
  "files.write",
  "files.mkdir",
  "files.move",
  "files.trash",
  "browser.open",
  "browser.wait",
  "browser.extract",
  "browser.fill",
  "browser.press",
  "browser.download",
  "browser.pdf",
  "browser.snapshot",
  "browser.screenshot",
  "browser.handover",
  "computer.apps",
  "computer.open",
  "computer.snapshot",
  "computer.find",
  "computer.screenshot",
  "computer.press",
  "computer.focus",
  "computer.select",
  "computer.set_value",
  "computer.type",
  "computer.key",
  "computer.scroll",
  "computer.handover",
];

const FROZEN_REFUSALS = [
  "outside_allowance",
  "outside_boundary",
  "folder_changed",
  "path_moved",
  "secret_file",
  "hidden_path",
  "executable",
  "too_large",
  "private_address",
  "origin_not_allowed",
  "credential_field",
  "blocked_app",
  "blocked_shortcut",
  "secure_focus",
  "stale",
  "owner_active",
  "stopped",
  "deadline_passed",
  "permission_missing",
  "trash_unavailable",
];

const command: DeviceCommand = {
  command_id: "c1",
  tenant_id: "t1",
  execution_id: "e1",
  task_run_id: null,
  conversation_id: null,
  step_id: "read",
  authority_id: "a1",
  manifest_digest: "m1",
  kind: "files.read_text",
  args: { folder_id: "f1", relative_path: "a.txt" },
  deadline_at: "2026-11-21T10:01:00.000Z",
  generation: 0,
  confirmation: null,
};

describe("the frozen device protocol enums", () => {
  test("capabilities, kinds and refusals match the frozen contract exactly", () => {
    expect([...DEVICE_CAPABILITIES]).toEqual(["files", "browser", "computer"]);
    expect<string[]>([...DEVICE_COMMAND_KINDS]).toEqual(FROZEN_KINDS);
    expect<string[]>([...DEVICE_REFUSALS]).toEqual(FROZEN_REFUSALS);
    expect(new Set(DEVICE_REFUSALS).size).toBe(DEVICE_REFUSALS.length);
    expect(new Set(DEVICE_COMMAND_KINDS).size).toBe(DEVICE_COMMAND_KINDS.length);
    expect([...DEVICE_OS]).toEqual(["darwin", "win32"]);
  });

  test("every command kind belongs to the capability named by its prefix", () => {
    for (const kind of DEVICE_COMMAND_KINDS) {
      expect(capabilityOfKind(kind)).toBe(
        kind.split(".")[0] as (typeof DEVICE_CAPABILITIES)[number],
      );
    }
  });
});

describe("device commands", () => {
  test("round-trip unchanged", () => {
    expect(DeviceCommandSchema.parse(command)).toEqual(command);
    const confirmed = {
      ...command,
      execution_id: null,
      task_run_id: "r1",
      authority_id: null,
      manifest_digest: null,
      kind: "browser.press" as const,
      deadline_at: "2026-11-21T11:00:00+01:00",
      generation: 3,
      confirmation: { confirmation_id: "k1", binding_hash: "h1" },
    };
    expect(DeviceCommandSchema.parse(confirmed)).toEqual(confirmed);
  });

  test("reject unknown kinds, extra fields, bad deadlines and negative generations", () => {
    expect(DeviceCommandSchema.safeParse({ ...command, kind: "files.delete" }).success).toBe(false);
    expect(DeviceCommandSchema.safeParse({ ...command, path: "/etc" }).success).toBe(false);
    expect(DeviceCommandSchema.safeParse({ ...command, deadline_at: "soon" }).success).toBe(false);
    expect(DeviceCommandSchema.safeParse({ ...command, generation: -1 }).success).toBe(false);
    expect(DeviceCommandSchema.safeParse({ ...command, generation: 1.5 }).success).toBe(false);
    expect(DeviceCommandSchema.safeParse({ ...command, command_id: "" }).success).toBe(false);
    expect(
      DeviceCommandSchema.safeParse({ ...command, confirmation: { confirmation_id: "k" } }).success,
    ).toBe(false);
  });
});

describe("device results", () => {
  const results: DeviceResult[] = [
    { status: "done", output: { entries: [] }, evidence: {} },
    {
      status: "done",
      output: null,
      evidence: { before_version: "v1", after_version: "v2", screenshot_ref: "s1" },
    },
    { status: "refused", code: "secret_file", detail: "The file looks like a secret." },
    {
      status: "confirmation_required",
      binding_hash: "h1",
      target: "Senden auf example.com/form",
    },
    { status: "stopped" },
    { status: "failed", code: "device_lost_during_write", detail: "" },
  ];

  test("every status round-trips unchanged", () => {
    for (const result of results) expect(DeviceResultSchema.parse(result)).toEqual(result);
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(DEVICE_RESULT_STATUSES));
  });

  test("every refusal code is accepted and nothing else", () => {
    for (const code of DEVICE_REFUSALS) {
      expect(DeviceResultSchema.safeParse({ status: "refused", code, detail: "" }).success).toBe(
        true,
      );
    }
    expect(
      DeviceResultSchema.safeParse({ status: "refused", code: "nope", detail: "" }).success,
    ).toBe(false);
  });

  test("reject unknown statuses and extra fields", () => {
    expect(DeviceResultSchema.safeParse({ status: "maybe" }).success).toBe(false);
    expect(DeviceResultSchema.safeParse({ status: "stopped", reason: "x" }).success).toBe(false);
    expect(
      DeviceResultSchema.safeParse({ status: "done", output: 1, evidence: { extra: "x" } }).success,
    ).toBe(false);
    expect(DeviceResultSchema.safeParse({ status: "failed", code: "", detail: "" }).success).toBe(
      false,
    );
  });
});

describe("heartbeats", () => {
  const heartbeat: Heartbeat = {
    runner_version: "11.3.0",
    os: "darwin",
    capabilities: ["files", "computer"],
    personal: [],
    permissions: { accessibility: true, screen: false },
    allowances_digest: "d1",
    generation: 4,
  };

  test("round-trip unchanged, with or without permissions", () => {
    expect(HeartbeatSchema.parse(heartbeat)).toEqual(heartbeat);
    const windows = { ...heartbeat, os: "win32" as const, permissions: {} };
    expect(HeartbeatSchema.parse(windows)).toEqual(windows);
  });

  test("name the capabilities whose personal switch is on", () => {
    const switched = { ...heartbeat, personal: ["browser" as const] };
    expect(HeartbeatSchema.parse(switched)).toEqual(switched);
    expect(HeartbeatSchema.safeParse({ ...heartbeat, personal: ["shell"] }).success).toBe(false);
    const { personal: _, ...unnamed } = heartbeat;
    expect(HeartbeatSchema.safeParse(unnamed).success).toBe(false);
  });

  test("reject other systems and unknown capabilities", () => {
    expect(HeartbeatSchema.safeParse({ ...heartbeat, os: "linux" }).success).toBe(false);
    expect(HeartbeatSchema.safeParse({ ...heartbeat, capabilities: ["shell"] }).success).toBe(
      false,
    );
    expect(
      HeartbeatSchema.safeParse({ ...heartbeat, permissions: { microphone: true } }).success,
    ).toBe(false);
  });

  test("carry a whole, non-negative generation", () => {
    const { generation: _, ...withoutGeneration } = heartbeat;
    expect(HeartbeatSchema.safeParse(withoutGeneration).success).toBe(false);
    expect(HeartbeatSchema.safeParse({ ...heartbeat, generation: -1 }).success).toBe(false);
    expect(HeartbeatSchema.safeParse({ ...heartbeat, generation: 0.5 }).success).toBe(false);
    expect(HeartbeatSchema.parse({ ...heartbeat, generation: 0 }).generation).toBe(0);
  });
});

describe("stop reports", () => {
  const report: DeviceStopReport = {
    generation: 5,
    stopped_at: "2026-11-21T10:00:00.000Z",
    command_id: "c1",
  };

  test("round-trip unchanged, with or without the command", () => {
    expect(DeviceStopReportSchema.parse(report)).toEqual(report);
    const { command_id: _, ...idle } = report;
    expect(DeviceStopReportSchema.parse(idle)).toEqual(idle);
  });

  test("reject bad generations, times, empty commands and extra fields", () => {
    expect(DeviceStopReportSchema.safeParse({ ...report, generation: -1 }).success).toBe(false);
    expect(DeviceStopReportSchema.safeParse({ ...report, generation: 1.5 }).success).toBe(false);
    expect(DeviceStopReportSchema.safeParse({ ...report, stopped_at: "now" }).success).toBe(false);
    expect(
      DeviceStopReportSchema.safeParse({ ...report, stopped_at: "2026-11-21T10:00:00" }).success,
    ).toBe(false);
    expect(DeviceStopReportSchema.safeParse({ ...report, command_id: "" }).success).toBe(false);
    expect(DeviceStopReportSchema.safeParse({ ...report, reason: "x" }).success).toBe(false);
  });
});
