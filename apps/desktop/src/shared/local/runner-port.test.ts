import { describe, expect, test } from "bun:test";
import { EMPTY_FILES_SNAPSHOT } from "./files-allowances.ts";
import {
  INITIAL_STOP_STATE,
  MainToRunnerSchema,
  markReported,
  markStopped,
  parseStopState,
  RunnerConfigSchema,
  RunnerToMainSchema,
  STOP_GRACE_MS,
  unreportedStop,
} from "./runner-port.ts";

describe("stop grace", () => {
  test("keeps the hard stop below one second", () => {
    expect(STOP_GRACE_MS).toBeLessThan(1_000);
  });
});

describe("port messages", () => {
  test("only the narrow message set passes", () => {
    expect(RunnerToMainSchema.safeParse({ type: "ready" }).success).toBe(true);
    expect(
      RunnerToMainSchema.safeParse({ type: "trash", request_id: "r", path: "/a" }).success,
    ).toBe(true);
    expect(RunnerToMainSchema.safeParse({ type: "open_window", url: "x" }).success).toBe(false);
    expect(
      RunnerToMainSchema.safeParse({ type: "sign_assertion", request_id: "r", assertion: "" })
        .success,
    ).toBe(false);
    expect(
      MainToRunnerSchema.safeParse({
        type: "start",
        config: {
          server_origin: "https://subkit.example",
          device_runner_id: "r1",
          ledger_path: "/tmp/ledger.json",
          runner_version: "11.2.0",
          os: "darwin",
          capabilities: ["files"],
          generation: 2,
          unreported_stop: null,
          private_key: "x",
        },
      }).success,
    ).toBe(false);
    expect(MainToRunnerSchema.safeParse({ type: "stop" }).success).toBe(false);
    expect(
      MainToRunnerSchema.safeParse({
        type: "stop",
        report: { generation: 3, stopped_at: "2026-11-21T10:00:00.000Z" },
      }).success,
    ).toBe(true);
    expect(RunnerToMainSchema.safeParse({ type: "stop_reported", generation: 3 }).success).toBe(
      true,
    );
  });

  test("allowances travel as a snapshot and quarantine marks as one path", () => {
    const files = {
      personal_enabled: true,
      home: "/Users/me",
      data_dir: "/Users/me/Library/Application Support/SubKit",
      folders: [
        {
          id: "f1",
          path: "/Users/me/Docs",
          display: "~/Docs",
          access: "write",
          volume_id: "1",
          file_id: "2",
        },
      ],
      keep_out: [{ id: "k1", path: "/Users/me/Private", display: "~/Private" }],
    };
    expect(MainToRunnerSchema.safeParse({ type: "allowances", files }).success).toBe(true);
    expect(
      MainToRunnerSchema.safeParse({ type: "allowances", files: { ...files, bookmark: "x" } })
        .success,
    ).toBe(false);
    expect(
      MainToRunnerSchema.safeParse({ type: "marked", request_id: "r", ok: true }).success,
    ).toBe(true);
    expect(
      RunnerToMainSchema.safeParse({ type: "mark", request_id: "r", path: "/a" }).success,
    ).toBe(true);
    expect(
      RunnerToMainSchema.safeParse({ type: "unlink", request_id: "r", path: "/a" }).success,
    ).toBe(false);
  });
});

describe("computer port messages", () => {
  const config = {
    server_origin: "https://subkit.example",
    device_runner_id: "r1",
    ledger_path: "/tmp/ledger.json",
    runner_version: "11.2.0",
    locale: "de",
    os: "darwin",
    capabilities: ["computer"],
    generation: 0,
    unreported_stop: null,
    files: EMPTY_FILES_SNAPSHOT,
  };

  test("a start without computer settings starts with computer use off", () => {
    const parsed = MainToRunnerSchema.parse({ type: "start", config });
    expect(parsed.type === "start" && parsed.config.computer.enabled).toBe(false);
  });

  test("idle answers have a fixed shape and no second stop path exists", () => {
    expect(
      MainToRunnerSchema.safeParse({ type: "idle", request_id: "r", seconds: 2 }).success,
    ).toBe(true);
    expect(
      MainToRunnerSchema.safeParse({ type: "idle", request_id: "r", seconds: null }).success,
    ).toBe(true);
    expect(
      MainToRunnerSchema.safeParse({ type: "idle", request_id: "r", seconds: -1 }).success,
    ).toBe(false);
    expect(RunnerToMainSchema.safeParse({ type: "idle_query", request_id: "r" }).success).toBe(
      true,
    );
    expect(RunnerToMainSchema.safeParse({ type: "computer_activity", active: true }).success).toBe(
      false,
    );
  });

  test("live progress crosses the port only in the wire shapes", () => {
    expect(
      RunnerToMainSchema.safeParse({ type: "live", event: { type: "owner_typing" } }).success,
    ).toBe(true);
    expect(
      RunnerToMainSchema.safeParse({
        type: "live",
        event: { type: "screenshot", png: "raw", sha256: "x" },
      }).success,
    ).toBe(false);
  });

  test("computer settings reach the runner only as a valid snapshot", () => {
    const computer = {
      enabled: true,
      personal_enabled: true,
      apps: [],
      keep_out: [],
      permissions: { accessibility: true, screen: false },
      helper: {
        path: "/Applications/SubKit.app/Contents/Helpers/agent-desktop/agent-desktop",
        state_root: "/tmp/s",
      },
    };
    expect(MainToRunnerSchema.safeParse({ type: "computer", computer }).success).toBe(true);
    expect(
      MainToRunnerSchema.safeParse({
        type: "computer",
        computer: { ...computer, helper: { path: "x", state_root: "/s" } },
      }).success,
    ).toBe(false);
  });
});

describe("stop state", () => {
  const NOW_ISO = "2026-11-21T10:00:00.000Z";
  const at = Date.parse(NOW_ISO);

  test("a stop raises the generation and stays unreported until acknowledged", () => {
    const stopped = markStopped(INITIAL_STOP_STATE, at);
    expect(stopped).toEqual({ generation: 1, stopped_at: NOW_ISO, reported: false });
    expect(unreportedStop(stopped)).toEqual({ generation: 1, stopped_at: NOW_ISO });
    expect(unreportedStop(markReported(stopped, 1))).toBeNull();
  });

  test("an acknowledgement of an older generation does not count", () => {
    const twice = markStopped(markStopped(INITIAL_STOP_STATE, at), at + 1);
    expect(markReported(twice, 1).reported).toBe(false);
    expect(markReported(twice, 2).reported).toBe(true);
  });

  test("a broken or missing file starts at generation 0", () => {
    expect(parseStopState(null)).toEqual(INITIAL_STOP_STATE);
    expect(parseStopState({ generation: -1, stopped_at: null, reported: true })).toEqual(
      INITIAL_STOP_STATE,
    );
    expect(unreportedStop(INITIAL_STOP_STATE)).toBeNull();
  });
});

describe("runner browser config", () => {
  const base = {
    server_origin: "https://subkit.example.com",
    device_runner_id: "r1",
    ledger_path: "/data/ledger.json",
    runner_version: "11.2.0",
    locale: "de",
    os: "darwin",
    capabilities: ["browser"],
    generation: 0,
    unreported_stop: null,
    files: EMPTY_FILES_SNAPSHOT,
  };
  const site = {
    kind: "site" as const,
    id: "s1",
    origin: "http://192.168.1.5",
    private: true,
    digest: "a".repeat(64),
    entered_by: "person" as const,
  };
  const browser = {
    cli_path: "/App/Contents/Resources/agent-browser/agent-browser",
    version: "0.43.0",
    data_dir: "/data",
    sites: [site],
  };

  test("the browser block is optional and strict", () => {
    expect(RunnerConfigSchema.safeParse(base).success).toBe(true);
    expect(RunnerConfigSchema.safeParse({ ...base, browser: null }).success).toBe(true);
    expect(RunnerConfigSchema.parse({ ...base, browser }).browser).toEqual(browser);
    expect(
      RunnerConfigSchema.safeParse({ ...base, browser: { ...browser, headed: true } }).success,
    ).toBe(false);
    expect(
      RunnerConfigSchema.safeParse({
        ...base,
        browser: { ...browser, sites: [{ ...site, entered_by: "model" }] },
      }).success,
    ).toBe(false);
  });
});
