// Tests for resolveSessionRef — the alias/id resolution used by the
// new `sk ls/show/rename/rm` commands.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getTestNow } from "../../../engine/src/test-helpers/determinism/clock.ts";
import { resolveSessionRef, saveSessionMetadata, type SessionMetadata } from "../sessions.ts";

const TEST_NOW_MS = getTestNow();

let tmpHome: string;
let origSkHome: string | undefined;

const now = new Date(TEST_NOW_MS).toISOString();

function meta(overrides: Partial<SessionMetadata>): SessionMetadata {
  return {
    conversation_id: "00000000-0000-0000-0000-000000000000",
    engine_url: "http://localhost:8080",
    tenant_id: "t-1",
    title: null,
    model: null,
    created_at: now,
    last_used_at: now,
    ...overrides,
  };
}

describe("resolveSessionRef", () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "sk-sessions-resolve-"));
    origSkHome = process.env.SK_HOME;
    process.env.SK_HOME = tmpHome;
  });
  afterEach(() => {
    if (origSkHome !== undefined) process.env.SK_HOME = origSkHome;
    else delete process.env.SK_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("direct conversation_id resolves", () => {
    const m = meta({ conversation_id: "11111111-1111-1111-1111-111111111111" });
    saveSessionMetadata(m);
    const got = resolveSessionRef("11111111-1111-1111-1111-111111111111");
    expect(got?.conversation_id).toBe(m.conversation_id);
  });

  test("alias resolves when id does not", () => {
    const m = meta({
      conversation_id: "22222222-2222-2222-2222-222222222222",
      alias: "stripe-onboarding",
    });
    saveSessionMetadata(m);
    const got = resolveSessionRef("stripe-onboarding");
    expect(got?.conversation_id).toBe(m.conversation_id);
  });

  test("cross-profile lookup filtered by engine_url + tenant_id", () => {
    saveSessionMetadata(
      meta({
        conversation_id: "33333333-3333-3333-3333-333333333333",
        alias: "prod-ingest",
        engine_url: "https://prod.example.test",
        tenant_id: "t-prod",
      }),
    );
    // Looking under a different engine URL won't find it.
    const wrong = resolveSessionRef("prod-ingest", {
      engine_url: "https://staging.example.test",
      tenant_id: "t-prod",
    });
    expect(wrong).toBeNull();
    // Matching profile returns the row.
    const right = resolveSessionRef("prod-ingest", {
      engine_url: "https://prod.example.test",
      tenant_id: "t-prod",
    });
    expect(right?.conversation_id).toBe("33333333-3333-3333-3333-333333333333");
  });

  test("unknown ref returns null", () => {
    expect(resolveSessionRef("does-not-exist")).toBeNull();
  });

  test("direct id under wrong profile returns null (isolation)", () => {
    const m = meta({
      conversation_id: "44444444-4444-4444-4444-444444444444",
      engine_url: "http://dev",
      tenant_id: "dev-tenant",
    });
    saveSessionMetadata(m);
    const leaked = resolveSessionRef(m.conversation_id, {
      engine_url: "http://prod",
      tenant_id: "prod-tenant",
    });
    expect(leaked).toBeNull();
  });
});
