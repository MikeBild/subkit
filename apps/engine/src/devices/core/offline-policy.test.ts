import { describe, expect, test } from "bun:test";
import { DEVICE_COMMAND_KINDS } from "@shared/device/protocol.ts";
import {
  type AdmissionFacts,
  admissionVerdict,
  attentionDueAt,
  COMMAND_DEADLINE_MS,
  commandDeadlineAt,
  commandEffect,
  DEVICE_ONLINE_WINDOW_MS,
  deviceRetryLimit,
  OFFLINE_POLICIES,
  unavailableMessage,
  WAIT_ATTENTION_AFTER_MS,
  WAIT_CAP_MS,
  waitCapAt,
} from "./offline-policy.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

const facts: AdmissionFacts = {
  revoked: false,
  online: true,
  policy: "wait",
  waiting_since_ms: NOW,
  authority_valid_until_ms: null,
};

describe("the device is online", () => {
  test("with a heartbeat within the last 45 seconds", () => {
    expect(DEVICE_ONLINE_WINDOW_MS).toBe(45_000);
  });
});

describe("admission of a run with a local step", () => {
  test("an online device gets the run at once", () => {
    expect(admissionVerdict(facts, NOW)).toEqual({ kind: "dispatch" });
  });

  test("a revoked device fails the run, even with a heartbeat", () => {
    expect(admissionVerdict({ ...facts, revoked: true }, NOW)).toEqual({
      kind: "fail",
      code: "device_revoked",
    });
  });

  test("an offline device makes the run wait, with attention after 15 minutes", () => {
    expect(admissionVerdict({ ...facts, online: false }, NOW)).toEqual({
      kind: "wait",
      cap_at_ms: NOW + WAIT_CAP_MS,
      attention_at_ms: NOW + WAIT_ATTENTION_AFTER_MS,
    });
    expect(WAIT_ATTENTION_AFTER_MS).toBe(15 * 60_000);
    expect(WAIT_CAP_MS).toBe(24 * HOUR);
  });

  test("a workflow either waits or fails at once", () => {
    expect([...OFFLINE_POLICIES]).toEqual(["wait", "fail"]);
  });

  test("a workflow that does not wait fails at once", () => {
    expect(admissionVerdict({ ...facts, online: false, policy: "fail" }, NOW)).toEqual({
      kind: "fail",
      code: "device_offline",
    });
  });

  test("the wait ends at the cap with a timeout", () => {
    const offline = { ...facts, online: false, waiting_since_ms: NOW - 24 * HOUR };
    expect(admissionVerdict(offline, NOW)).toEqual({
      kind: "fail",
      code: "device_offline_timeout",
    });
    expect(admissionVerdict(offline, NOW - 1).kind).toBe("wait");
  });

  test("the wait never outlasts the approval", () => {
    const offline = { ...facts, online: false, authority_valid_until_ms: NOW + HOUR };
    expect(admissionVerdict(offline, NOW)).toEqual({
      kind: "wait",
      cap_at_ms: NOW + HOUR,
      attention_at_ms: NOW + WAIT_ATTENTION_AFTER_MS,
    });
    expect(admissionVerdict(offline, NOW + HOUR)).toEqual({
      kind: "fail",
      code: "device_offline_timeout",
    });
  });
});

describe("the wait cap and attention", () => {
  test("the cap is 24 hours or the approval's end, whichever comes first", () => {
    expect(waitCapAt(NOW, null)).toBe(NOW + 24 * HOUR);
    expect(waitCapAt(NOW, NOW + HOUR)).toBe(NOW + HOUR);
    expect(waitCapAt(NOW, NOW + 48 * HOUR)).toBe(NOW + 24 * HOUR);
  });

  test("attention is due 15 minutes into the wait", () => {
    expect(attentionDueAt(NOW)).toBe(NOW + 15 * 60_000);
  });
});

describe("retries of device runs", () => {
  test("only runs whose local effects all read may retry once", () => {
    expect(deviceRetryLimit(["read"])).toBe(1);
    expect(deviceRetryLimit(["read", "read"])).toBe(1);
    expect(deviceRetryLimit(["read", "write"])).toBe(0);
    expect(deviceRetryLimit(["unknown"])).toBe(0);
    expect(deviceRetryLimit(["destructive"])).toBe(0);
    expect(deviceRetryLimit([])).toBe(0);
  });
});

describe("command effect and deadline", () => {
  test("reads are listed; every other kind counts as a write", () => {
    const reads = DEVICE_COMMAND_KINDS.filter((kind) => commandEffect(kind) === "read");
    expect(reads).toEqual([
      "files.list",
      "files.read_text",
      "browser.wait",
      "browser.extract",
      "browser.snapshot",
      "browser.screenshot",
      "computer.apps",
      "computer.snapshot",
      "computer.find",
      "computer.screenshot",
    ]);
    expect(commandEffect("files.write")).toBe("write");
    expect(commandEffect("browser.press")).toBe("write");
  });

  test("files get 60 seconds, browser and computer 5 minutes", () => {
    expect(COMMAND_DEADLINE_MS).toEqual({ files: 60_000, browser: 300_000, computer: 300_000 });
    expect(commandDeadlineAt("files.write", NOW)).toBe(NOW + 60_000);
    expect(commandDeadlineAt("browser.open", NOW)).toBe(NOW + 300_000);
    expect(commandDeadlineAt("computer.press", NOW)).toBe(NOW + 300_000);
  });
});

describe("the remedy names the device", () => {
  test("each code tells what happened and what to do", () => {
    expect(unavailableMessage("device_revoked", "Mac")).toBe(
      "“Mac” is no longer connected to this workspace. Nothing ran on it. Connect the device again in SubKit Desktop, then start the run again.",
    );
    expect(unavailableMessage("device_offline", "Mac")).toBe(
      "“Mac” is offline and this workflow does not wait. Nothing ran on it. Open SubKit on “Mac”, then start the run again.",
    );
    expect(unavailableMessage("device_offline_timeout", "Mac")).toBe(
      "“Mac” stayed offline for as long as this run may wait. Nothing ran on it. Open SubKit on “Mac”, then start the run again.",
    );
  });
});
