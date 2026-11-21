import { describe, expect, test } from "bun:test";
import { enrollOutcome, runnerDirName, runnerKeyName } from "./enrollment-model.ts";

const ID = "0b0e9c1c-3f4f-4a59-9a3e-2f6f0a4f4a11";

describe("runner enrollment", () => {
  test("a 201 with a runner id enrolls", () => {
    expect(enrollOutcome(201, { device_runner_id: ID, device_label: "Mac" })).toEqual({
      kind: "enrolled",
      device_runner_id: ID,
    });
  });

  test("an unreadable 201 or a server error is retried", () => {
    expect(enrollOutcome(201, { device_runner_id: "x" })).toEqual({ kind: "retry" });
    expect(enrollOutcome(500, null)).toEqual({ kind: "retry" });
    expect(enrollOutcome(0, null)).toEqual({ kind: "retry" });
  });

  test("a refusal is not retried until the next sign-in or start", () => {
    for (const status of [400, 401, 403])
      expect(enrollOutcome(status, {})).toEqual({ kind: "refused" });
  });

  test("keys and folders are named per server", () => {
    expect(runnerKeyName("https://a.example")).toBe("runner-key:https://a.example");
    expect(runnerDirName("p:1/x")).toBe("p_1_x");
  });
});
