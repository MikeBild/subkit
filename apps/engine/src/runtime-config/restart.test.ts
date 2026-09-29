import { describe, expect, test } from "bun:test";
import { restartFieldsDiffering } from "./document.ts";
import {
  ENGINE_RESTART_EXIT_CODE,
  registerRestartTrigger,
  scheduleProcessRestart,
  shutdownExitCode,
} from "./restart.ts";

describe("shutdown exit code", () => {
  test("a requested restart ends with 75 so the supervisor starts the engine again", () => {
    expect(ENGINE_RESTART_EXIT_CODE).toBe(75);
    expect(shutdownExitCode("restart")).toBe(75);
  });

  test("a signal stays a clean 0 and a timed-out drain stays 1", () => {
    expect(shutdownExitCode("signal")).toBe(0);
    expect(shutdownExitCode("timeout")).toBe(1);
  });
});

describe("process restart trigger", () => {
  test("without a registered trigger nothing ends the process", () => {
    expect(scheduleProcessRestart(0)).toBe(false);
  });

  test("a registered trigger runs after the delay, and only until unregistered", async () => {
    let calls = 0;
    const unregister = registerRestartTrigger(() => {
      calls += 1;
    });
    expect(scheduleProcessRestart(5)).toBe(true);
    expect(calls).toBe(0);
    await Bun.sleep(30);
    expect(calls).toBe(1);
    unregister();
    expect(scheduleProcessRestart(0)).toBe(false);
  });
});

describe("restart-sensitive fields waiting against the active document", () => {
  const active = { server: { port: 3000, restart_supervised: false }, log: { level: "info" } };

  test("a later hot change on top keeps the earlier restart-sensitive change waiting", () => {
    const next = { server: { port: 3001, restart_supervised: true }, log: { level: "debug" } };
    expect(restartFieldsDiffering(active, next)).toEqual(["server.port"]);
  });

  test("setting a restart-sensitive value back to the running one waits for nothing", () => {
    expect(restartFieldsDiffering(active, structuredClone(active))).toEqual([]);
  });
});
