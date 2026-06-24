// WS-1 attribution regression — pins that account() threads
// execution_id and conversation_id from metadata into the recordUsage
// call. When both are absent the entry carries nullish values;
// when either is present the entry carries the exact string.
//
// We test the _entry shape_ produced by account() rather than the DB
// row so this stays a fast unit test (no testcontainers required).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { _resetConfigForTests } from "../../config/loader.ts";
import type { SubkitLlmTelemetryMetadata, SubkitLlmUsage } from "../core/base-types.ts";
import { type AccountParams, account } from "./accountant.ts";

// account() calls recordUsage(), which calls getDb(). In a unit
// context there is no live DB pool — we capture the call by replacing
// the Drizzle executor with an in-memory spy via the optional `exec`
// argument that account() and recordUsage() both accept.
//
// The spy implements only the `insert().values()` chain because that
// is all recordUsage() calls. We capture every call to `insert` so we
// can inspect the row shape.

interface CapturedRow {
  execution_id: string | null | undefined;
  conversation_id: string | null | undefined;
  flow: string;
  tenant_id: string;
}

// Minimal Drizzle-executor-shaped spy that captures the values passed
// to insert().values() without touching the database.
function makeCaptureSpy(): { rows: CapturedRow[]; exec: Parameters<typeof account>[1] } {
  const rows: CapturedRow[] = [];

  // The executor surface is whatever `getDb()` returns — a Drizzle
  // db instance. We only need the `insert` method chain used by
  // recordUsage: db.insert(table).values(row).
  const exec = {
    insert: (_table: unknown) => ({
      values: (row: CapturedRow) => {
        rows.push(row);
        // recordUsage awaits the result — return a resolved promise.
        return Promise.resolve();
      },
    }),
  } as unknown as Parameters<typeof account>[1];

  return { rows, exec };
}

const USAGE: SubkitLlmUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

function baseParams(meta: SubkitLlmTelemetryMetadata): AccountParams {
  return {
    tenant_id: meta.tenant_id,
    metadata: meta,
    model: "claude-haiku-4-5",
    usage: USAGE,
    latency_ms: 100,
    result: "success",
  };
}

// Config must be loaded for the logger not to throw on the debug
// path inside account(). The shared ensureConfigLoaded from
// http/tests/setup boots a placeholder config — replicate the same
// pattern from the base types test in the accounting dir.
beforeAll(async () => {
  try {
    const { getConfig } = await import("../../config/loader.ts");
    getConfig();
  } catch {
    const { loadConfig } = await import("../../config/loader.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "sk-cfg-account-test-"));
    await loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/unit-test", NODE_ENV: "test" },
      configPathOverride: join(dir, "subkit.config.json"),
    });
  }
});

afterAll(() => {
  _resetConfigForTests();
});

describe("account() — WS-1 execution_id / conversation_id attribution", () => {
  it("threads execution_id and conversation_id when both present in metadata", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-abc",
      flow: "generate",
      execution_id: "exec-1111-2222-3333-4444",
      conversation_id: "conv-aaaa-bbbb-cccc-dddd",
    };
    await account(baseParams(meta), exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id).toBe("exec-1111-2222-3333-4444");
    expect(rows[0]?.conversation_id).toBe("conv-aaaa-bbbb-cccc-dddd");
  });

  it("carries null execution_id when metadata has no execution_id", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-abc",
      flow: "converse",
      conversation_id: "conv-only-0000",
    };
    await account(baseParams(meta), exec);
    expect(rows).toHaveLength(1);
    // recordUsage writes `entry.execution_id ?? null`; when the key
    // was never set on entry, that evaluates to null.
    expect(rows[0]?.execution_id === null || rows[0]?.execution_id === undefined).toBe(true);
    expect(rows[0]?.conversation_id).toBe("conv-only-0000");
  });

  it("carries null conversation_id when metadata has no conversation_id", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-abc",
      flow: "extract",
      execution_id: "exec-only-9999",
    };
    await account(baseParams(meta), exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id).toBe("exec-only-9999");
    expect(rows[0]?.conversation_id === null || rows[0]?.conversation_id === undefined).toBe(true);
  });

  it("carries null for both when metadata has neither", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-abc",
      flow: "repair",
    };
    await account(baseParams(meta), exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id === null || rows[0]?.execution_id === undefined).toBe(true);
    expect(rows[0]?.conversation_id === null || rows[0]?.conversation_id === undefined).toBe(true);
  });

  it("still records the correct flow and tenant_id alongside attribution fields", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-xyz",
      flow: "judge",
      execution_id: "exec-flow-check",
    };
    await account(baseParams(meta), exec);
    expect(rows[0]?.flow).toBe("judge");
    expect(rows[0]?.tenant_id).toBe("tenant-xyz");
  });

  it("returns the correct drift_pct and recorded token counts", async () => {
    const { exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "t",
      flow: "generate",
    };
    const result = await account({ ...baseParams(meta), estimated_prompt_tokens: 80 }, exec);
    // |100 - 80| / 80 = 0.25
    expect(result.drift_pct).toBeCloseTo(0.25, 5);
    expect(result.recorded_input_tokens).toBe(100);
    expect(result.recorded_output_tokens).toBe(50);
  });
});
