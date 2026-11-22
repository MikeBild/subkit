import { describe, expect, test } from "bun:test";
import { classifyLocalFailure } from "./local-workspace-model.ts";
import { engineEndedReason, parseEngineBootFailed } from "./supervisor-model.ts";

const LINE = JSON.stringify({
  ts: "2026-11-22T10:00:00.000Z",
  level: "fatal",
  module: "engine",
  action: "boot.failed",
  msg: "engine failed to boot",
  error: "listen EADDRINUSE: address already in use 127.0.0.1:47811",
  error_class: "unknown",
  phase: "listen",
  next: "Free the port or set PORT to a free one, then restart.",
});

describe("engine boot failure", () => {
  test("reads phase, cause and next step from the engine's boot.failed line", () => {
    expect(parseEngineBootFailed(LINE)).toEqual({
      phase: "listen",
      error: "listen EADDRINUSE: address already in use 127.0.0.1:47811",
      next: "Free the port or set PORT to a free one, then restart.",
    });
  });

  test("ignores other lines", () => {
    expect(parseEngineBootFailed('{"action":"ready"}')).toBeNull();
    expect(parseEngineBootFailed("boot.failed but not json")).toBeNull();
    expect(parseEngineBootFailed('{"action":"boot.failed"}')).toEqual({
      phase: "unknown",
      error: "unknown",
      next: null,
    });
  });

  test("the exit reason carries the cause so the failure is classified", () => {
    const reason = engineEndedReason(1, parseEngineBootFailed(LINE));
    expect(reason).toBe(
      "the engine ended while starting (exit 1) in listen: listen EADDRINUSE: address already in use 127.0.0.1:47811; see engine.log",
    );
    expect(classifyLocalFailure(reason)).toBe("port");
    expect(engineEndedReason(null, null)).toBe(
      "the engine ended while starting (exit null); see engine.log",
    );
  });
});
