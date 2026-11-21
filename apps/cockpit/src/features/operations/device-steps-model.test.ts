import { describe, expect, test } from "bun:test";
import {
  type DeviceStepState,
  deviceStepRecords,
  deviceStepRows,
  NO_DEVICE_STEPS,
  stepScreenshotPath,
  stepsStillMoving,
} from "./device-steps-model";

describe("deviceStepRecords", () => {
  test("keeps known kinds, hides a target the viewer may not read and drops unknown kinds", () => {
    expect(
      deviceStepRecords([
        {
          command_id: "a",
          kind: "files.write",
          target: "a.md",
          state: "done",
          screenshot: false,
        },
        {
          command_id: "b",
          kind: "browser.open",
          target: null,
          state: "running",
          screenshot: false,
        },
        { command_id: "c", kind: "shell.run", target: "x", state: "done", screenshot: true },
      ]),
    ).toEqual([
      { command_id: "a", kind: "files.write", target: "a.md", state: "done", screenshot: false },
      { command_id: "b", kind: "browser.open", target: "", state: "running", screenshot: false },
    ]);
  });
});

describe("stepsStillMoving", () => {
  test("only queued or running steps keep the timeline refreshing", () => {
    const step = (state: DeviceStepState) => ({
      command_id: state,
      kind: "files.list" as const,
      target: "",
      state,
      screenshot: false,
    });
    expect(stepsStillMoving([step("queued")])).toBe(true);
    expect(stepsStillMoving([step("done"), step("running")])).toBe(true);
    expect(stepsStillMoving([step("done"), step("stopped"), step("confirmation_required")])).toBe(
      false,
    );
    expect(stepsStillMoving(NO_DEVICE_STEPS)).toBe(false);
  });
});

const record = (state: DeviceStepState) => ({
  command_id: `c-${state}`,
  kind: "computer.set_value" as const,
  target: "B2:C4",
  state,
  screenshot: false,
});

describe("deviceStepRows", () => {
  test("a device step shows its action, target and a tone per state", () => {
    const states: DeviceStepState[] = [
      "queued",
      "running",
      "done",
      "confirmation_required",
      "refused",
      "failed",
      "stopped",
    ];
    expect(deviceStepRows(states.map(record), "e1")).toEqual([
      {
        id: "c-queued",
        action: "fill",
        target: "B2:C4",
        state: "queued",
        tone: "neutral",
        thumbnail: null,
      },
      {
        id: "c-running",
        action: "fill",
        target: "B2:C4",
        state: "running",
        tone: "info",
        thumbnail: null,
      },
      {
        id: "c-done",
        action: "fill",
        target: "B2:C4",
        state: "done",
        tone: "success",
        thumbnail: null,
      },
      {
        id: "c-confirmation_required",
        action: "fill",
        target: "B2:C4",
        state: "confirmation_required",
        tone: "warning",
        thumbnail: null,
      },
      {
        id: "c-refused",
        action: "fill",
        target: "B2:C4",
        state: "refused",
        tone: "danger",
        thumbnail: null,
      },
      {
        id: "c-failed",
        action: "fill",
        target: "B2:C4",
        state: "failed",
        tone: "danger",
        thumbnail: null,
      },
      {
        id: "c-stopped",
        action: "fill",
        target: "B2:C4",
        state: "stopped",
        tone: "neutral",
        thumbnail: null,
      },
    ]);
  });

  test("a kept screenshot links its thumbnail, others link nothing", () => {
    const rows = deviceStepRows(
      [
        { ...record("done"), command_id: "c 1", kind: "browser.screenshot", screenshot: true },
        record("done"),
      ],
      "e/1",
    );
    expect(rows.map((row) => row.thumbnail)).toEqual([
      "/v1/executions/e%2F1/device-steps/c%201/screenshot",
      null,
    ]);
    expect(stepScreenshotPath("e", "c")).toBe("/v1/executions/e/device-steps/c/screenshot");
  });

  test("a run without device steps has no rows", () => {
    expect(deviceStepRows(NO_DEVICE_STEPS, "e1")).toEqual([]);
  });
});
