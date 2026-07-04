// Unit coverage for the `probe_connector` rate-bucket eviction logic.
//
// The Map at module scope used to grow one entry per unique
// `conversation_id` forever — investigation of the 2026-05-28 engine
// memory-stuck incident flagged it as an unbounded module-level cache
// on the conversation hot path. The fix in `probe-connector.ts` does
// two things:
//   1. Sweep expired buckets every SWEEP_EVERY_N_READS reads
//      (amortised; no setInterval timer needed).
//   2. Hard-cap the Map size at BUCKET_HARD_CAP entries, dropping the
//      oldest-insertion key when the cap is hit.

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
    // Fill exactly to the cap.
    const cap = _RATE_BUCKET_HARD_CAP_FOR_TESTS;
    for (let i = 0; i < cap; i++) {
      _consumeRateTokenForTests(`conv-${i}`);
    }
    expect(_probeRateBucketCountForTests()).toBe(cap);
    // One more entry should evict the oldest insertion (conv-0).
    _consumeRateTokenForTests("conv-overflow");
    expect(_probeRateBucketCountForTests()).toBe(cap);
    // conv-overflow is in the Map; conv-0 was evicted. Trigger a fresh
    // call for conv-0 — it should be treated as a new entry (count 1).
    // We assert indirectly: a fresh call should succeed (returns true),
    // and the Map size stays at cap (because adding conv-0 back evicts
    // the next-oldest entry, conv-1).
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
    // conv-b's bucket survived — a re-call increments rather than
    // creating a fresh entry (size stays at 1).
    _consumeRateTokenForTests("conv-b");
    expect(_probeRateBucketCountForTests()).toBe(1);
  });
});
