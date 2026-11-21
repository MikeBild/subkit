import { describe, expect, test } from "bun:test";
import { RUNNER_ASSERTION_AUDIENCE } from "@shared/device/runner-wire.ts";
import {
  assertionPayload,
  needsToken,
  parseStreamEvent,
  personalCapabilities,
  TOKEN_REFRESH_MARGIN_MS,
} from "./runner-channel.ts";

const NOW = Date.parse("2026-11-21T10:00:00Z");

describe("assertionPayload", () => {
  test("is canonical JSON with audience, runner, time and nonce", () => {
    expect(assertionPayload({ device_runner_id: "r1", now: NOW, nonce: "n1" })).toBe(
      `{"aud":"${RUNNER_ASSERTION_AUDIENCE}","device_runner_id":"r1","iat":"2026-11-21T10:00:00.000Z","nonce":"n1"}`,
    );
  });
});

describe("needsToken", () => {
  test("asks for a token when none exists or it expires within the margin", () => {
    const at = (ms: number) => ({ access_token: "t", expires_at: new Date(ms).toISOString() });
    expect(needsToken(null, NOW)).toBe(true);
    expect(needsToken(at(NOW + TOKEN_REFRESH_MARGIN_MS), NOW)).toBe(true);
    expect(needsToken(at(NOW + TOKEN_REFRESH_MARGIN_MS + 1), NOW)).toBe(false);
  });
});

describe("parseStreamEvent", () => {
  test("accepts only the three id-only events", () => {
    expect(parseStreamEvent("command.available", '{"command_id":"c1"}')).toEqual({
      type: "command.available",
      command_id: "c1",
    });
    expect(parseStreamEvent("command.cancelled", '{"command_id":"c1"}')).toEqual({
      type: "command.cancelled",
      command_id: "c1",
    });
    expect(parseStreamEvent("runner.revoked", "")).toEqual({ type: "runner.revoked" });
  });

  test("rejects other events, extra fields and broken data", () => {
    expect(parseStreamEvent("ping", "{}")).toBeNull();
    expect(parseStreamEvent("command.available", '{"command_id":"c1","args":{}}')).toBeNull();
    expect(parseStreamEvent("command.available", "{")).toBeNull();
    expect(parseStreamEvent("command.available", "[]")).toBeNull();
    expect(parseStreamEvent("command.available", "{}")).toBeNull();
  });
});

describe("the personal capabilities a heartbeat names", () => {
  test("the switch on names each offered capability once", () => {
    expect(personalCapabilities(["files", "computer", "files"], true)).toEqual([
      "files",
      "computer",
    ]);
  });

  test("the switch off names none", () => {
    expect(personalCapabilities(["files", "computer"], false)).toEqual([]);
  });
});
