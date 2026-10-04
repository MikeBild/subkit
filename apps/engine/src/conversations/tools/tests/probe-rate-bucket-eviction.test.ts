import { afterEach, describe, expect, test } from "bun:test";
import {
  _consumeRateTokenForTests,
  _probeRateBucketCountForTests,
  _RATE_BUCKET_HARD_CAP_FOR_TESTS,
  resetProbeRateLimit,
} from "../probe-connector.ts";

afterEach(() => {
  resetProbeRateLimit();
});

describe("probe_connector rate-bucket cache", () => {
  test("starts empty + reset clears", () => {
    resetProbeRateLimit();
    expect(_probeRateBucketCountForTests()).toBe(0);
  });

  test("each new conversation_id adds exactly one bucket", () => {
    for (let i = 0; i < 100; i++) {
      _consumeRateTokenForTests(`conv-${i}`);
    }
    expect(_probeRateBucketCountForTests()).toBe(100);
  });

  test("repeat calls for the same conversation_id stay at one bucket", () => {
    for (let i = 0; i < 19; i++) {
      _consumeRateTokenForTests("conv-x");
    }
    expect(_probeRateBucketCountForTests()).toBe(1);
  });

  test("hard cap drops the oldest entry when exceeded", () => {
    const cap = _RATE_BUCKET_HARD_CAP_FOR_TESTS;
    for (let i = 0; i < cap; i++) {
      _consumeRateTokenForTests(`conv-${i}`);
    }
    expect(_probeRateBucketCountForTests()).toBe(cap);
    _consumeRateTokenForTests("conv-overflow");
    expect(_probeRateBucketCountForTests()).toBe(cap);
    const allowed = _consumeRateTokenForTests("conv-0");
    expect(allowed).toBe(true);
    expect(_probeRateBucketCountForTests()).toBe(cap);
  });

  test("resetProbeRateLimit(id) targets one entry without touching others", () => {
    _consumeRateTokenForTests("conv-a");
    _consumeRateTokenForTests("conv-b");
    expect(_probeRateBucketCountForTests()).toBe(2);
    resetProbeRateLimit("conv-a");
    expect(_probeRateBucketCountForTests()).toBe(1);
    _consumeRateTokenForTests("conv-b");
    expect(_probeRateBucketCountForTests()).toBe(1);
  });
});
