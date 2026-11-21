import { describe, expect, test } from "bun:test";
import {
  askedEvent,
  CONFIRMATION_REQUESTED,
  confirmationsPath,
  type PendingAsk,
  pendingAsks,
  requestedDevice,
  respondBody,
  respondPath,
} from "./live-confirmations.ts";

const confirmation = {
  device_id: "dev-1",
  capability: "browser" as const,
  target: "„Bestellen“ auf shop.example",
  deadline_at: "2026-11-21T10:15:00.000Z",
  command_id: "c".repeat(64),
  binding_hash: "b".repeat(64),
};
const ask: PendingAsk = { confirmation_id: "tc-1", conversation_id: "conv-1", confirmation };

describe("a step on this device waits for the person", () => {
  test("the engine stream names the device that asks", () => {
    expect(requestedDevice(CONFIRMATION_REQUESTED, JSON.stringify({ device_id: "dev-1" }))).toBe(
      "dev-1",
    );
    expect(requestedDevice("device.command", JSON.stringify({ device_id: "dev-1" }))).toBeNull();
    expect(requestedDevice("", JSON.stringify({ device_id: "dev-1" }))).toBeNull();
    expect(requestedDevice(CONFIRMATION_REQUESTED, JSON.stringify({ device_id: 7 }))).toBeNull();
    expect(requestedDevice(CONFIRMATION_REQUESTED, "null")).toBeNull();
    expect(requestedDevice(CONFIRMATION_REQUESTED, "{")).toBeNull();
  });

  test("the device's waiting steps are read, anything malformed is dropped as a whole", () => {
    expect(pendingAsks({ items: [ask] })).toEqual([ask]);
    expect(pendingAsks({ items: [{ ...ask, confirmation: { device_id: "x" } }] })).toEqual([]);
    expect(pendingAsks(null)).toEqual([]);
    expect(confirmationsPath("dev 1")).toBe("/v1/devices/dev%201/confirmations");
  });

  test("each waiting step becomes an ask in the live view", () => {
    expect(askedEvent(ask, 1000)).toEqual({
      type: "asked",
      command_id: "c".repeat(64),
      confirmation_id: "tc-1",
      confirmation,
      at: 1000,
    });
    expect(
      askedEvent({ ...ask, confirmation: { ...confirmation, command_id: null } }, 5),
    ).toMatchObject({ command_id: "tc-1" });
  });

  test("the answer goes to the conversation's tool-call respond route", () => {
    expect(respondPath({ conversation_id: "conv 1", confirmation_id: "tc/1" })).toBe(
      "/v1/conversations/conv%201/tool-calls/tc%2F1/respond",
    );
    expect(JSON.parse(respondBody("confirm"))).toEqual({ output: { confirmed: true } });
    expect(JSON.parse(respondBody("decline"))).toEqual({ output: { confirmed: false } });
  });
});
