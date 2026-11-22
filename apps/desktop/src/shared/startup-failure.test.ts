import { describe, expect, test } from "bun:test";
import { t } from "./i18n.ts";
import {
  classifyStartupFailure,
  STARTUP_PHASES,
  type StartupFailureKind,
  startupActionAt,
} from "./startup-failure.ts";

describe("startup failure", () => {
  test.each<[string, Parameters<typeof classifyStartupFailure>, StartupFailureKind]>([
    ["port", ["engine", "listen EADDRINUSE: address already in use 127.0.0.1:47811"], "port"],
    ["database", ["engine", "PostgreSQL ended while starting; see postgres.log"], "database"],
    ["database phase", ["database", "timed out"], "database"],
    ["version", ["engine", "downgrade_refused"], "version"],
    ["engine", ["engine", "the engine ended while starting (exit 1); see engine.log"], "engine"],
    ["engine by text", ["app", "the engine did not become healthy in time"], "engine"],
    ["runner", ["runner", "exit 9"], "engine"],
    ["disk", ["database", "initdb failed: No space left on device"], "disk"],
    ["permission", ["app", "EACCES: permission denied, mkdir"], "permission"],
    ["folder", ["app", "cloud_synced_folder"], "folder"],
    ["window", ["window", "ERR_FILE_NOT_FOUND"], "window"],
    ["anything else", ["app", "Cannot read properties of undefined"], "app"],
  ])("%s", (_name, [phase, reason], kind) => {
    const failure = classifyStartupFailure(phase, reason);
    expect(failure.kind).toBe(kind);
    expect(failure.phase).toBe(phase);
    expect(failure.reason).toBe(reason);
  });

  test("every failure names what failed and the next step in both languages", () => {
    for (const phase of STARTUP_PHASES) {
      const failure = classifyStartupFailure(phase, "");
      for (const locale of ["de", "en"] as const) {
        expect(t(locale, failure.title).length).toBeGreaterThan(0);
        expect(t(locale, failure.next).length).toBeGreaterThan(0);
      }
    }
  });

  test("dialog buttons map to actions and anything unknown quits", () => {
    expect([0, 1, 2, 7].map(startupActionAt)).toEqual(["copy", "logs", "quit", "quit"]);
  });
});
