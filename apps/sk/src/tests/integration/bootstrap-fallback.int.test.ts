// loadBootstrap end-to-end against the fake EngineClient.
//
// Exercises the resolution:
//   1. disk cache hit → no network call
//   2. /v1/sk/bootstrap success → cache populated
//   3. /v1/sk/bootstrap rejection → no-grant profile-only snapshot

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBootstrap } from "../../lib/bootstrap.ts";
import {
  ANONYMOUS_PROFILE,
  createFakeEngineClient,
  fakeClientCallCounts,
} from "../_helpers/fake-engine-client.ts";

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "sk-bootstrap-int-"));
});
afterEach(() => {
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("integration: bootstrap network -> cache -> fallback", () => {
  test("first call hits the network; second hits the cache", async () => {
    const client = createFakeEngineClient();
    const a = await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir });
    const b = await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir });
    expect(a.source).toBe("network");
    expect(b.source).toBe("cache");
    const counts = fakeClientCallCounts(client);
    expect(counts.bootstrap).toBe(1);
    expect(counts.whoami).toBe(0);
  });

  test("/v1/sk/bootstrap rejection grants nothing and probes nothing", async () => {
    const client = createFakeEngineClient({
      errorOnBootstrap: new Error("HTTP 500"),
      rbacAllow: () => true,
    });
    const snap = await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir });
    expect(snap.source).toBe("fallback");
    const counts = fakeClientCallCounts(client);
    expect(counts.bootstrap).toBe(1);
    expect(counts.whoami).toBe(0);
    expect(counts.rbacCan).toBe(0);
    expect(snap.allowed.size).toBe(0);
  });

  test("forceRefresh re-fetches even after a fresh cache write", async () => {
    const client = createFakeEngineClient();
    await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir });
    await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir, forceRefresh: true });
    expect(fakeClientCallCounts(client).bootstrap).toBe(2);
  });

  test("ttl=0 disables disk cache and forces network on every call", async () => {
    const client = createFakeEngineClient();
    await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir, cacheTtlMs: 0 });
    await loadBootstrap(client, ANONYMOUS_PROFILE, { cacheDir, cacheTtlMs: 0 });
    expect(fakeClientCallCounts(client).bootstrap).toBe(2);
  });
});
