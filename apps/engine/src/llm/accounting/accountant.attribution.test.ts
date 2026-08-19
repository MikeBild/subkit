// WS-1 attribution regression — pins that account() threads
// execution_id and conversation_id from metadata into the recordUsage
// call. When both are absent the entry carries nullish values;
// when either is present the entry carries the exact string.
//
// The fixtures are real uuids. They used to be readable stand-ins like
// "exec-1111-2222-3333-4444", which no `uuid` column could ever have
// stored — so these tests proved the plumbing while saying nothing about
// whether the value could survive the INSERT. That gap is how a
// `self_healing_scans.id` ended up in `llm_usage.execution_id` for two
// months, and how the literal "proactive" silently destroyed whole rows.
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
      execution_id: "0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b",
      conversation_id: "3b1e9c7d-2a4f-4e6b-8c9d-1f2a3b4c5d6e",
    };
    await account(baseParams(meta), exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id).toBe("0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b");
    expect(rows[0]?.conversation_id).toBe("3b1e9c7d-2a4f-4e6b-8c9d-1f2a3b4c5d6e");
  });

  it("carries null execution_id when metadata has no execution_id", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-abc",
      flow: "converse",
      conversation_id: "3b1e9c7d-2a4f-4e6b-8c9d-1f2a3b4c5d6e",
    };
    await account(baseParams(meta), exec);
    expect(rows).toHaveLength(1);
    // recordUsage writes `entry.execution_id ?? null`; when the key
    // was never set on entry, that evaluates to null.
    expect(rows[0]?.execution_id === null || rows[0]?.execution_id === undefined).toBe(true);
    expect(rows[0]?.conversation_id).toBe("3b1e9c7d-2a4f-4e6b-8c9d-1f2a3b4c5d6e");
  });

  it("carries null conversation_id when metadata has no conversation_id", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-abc",
      flow: "extract",
      execution_id: "0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b",
    };
    await account(baseParams(meta), exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id).toBe("0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b");
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
      execution_id: "0f4c7f4a-1c2b-4d3e-9a8b-7c6d5e4f3a2b",
    };
    await account(baseParams(meta), exec);
    expect(rows[0]?.flow).toBe("judge");
    expect(rows[0]?.tenant_id).toBe("tenant-xyz");
  });

  // The uuid guard, and the exact split of responsibility around it.
  //
  // account() checks SHAPE only. It cannot check existence — it has a spy or
  // a pool, not a query budget on the hot path — so a well-formed uuid that
  // names nothing still gets through here on purpose. That case belongs to
  // the foreign key added in migration 0040. What this layer must prevent is
  // a value the column cannot physically hold, because recordUsage runs
  // inside a best-effort catch: a rejected INSERT does not degrade to a
  // missing attribution, it discards the whole billing row.
  it("drops a non-uuid execution_id and still writes the row", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-abc",
      flow: "repair",
      // What self-healing/service.ts passed before this fix when a proactive
      // scan had neither an execution nor a scan id.
      execution_id: "proactive",
    };
    await account(baseParams(meta), exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id === null || rows[0]?.execution_id === undefined).toBe(true);
    // The point of dropping it: the row survives.
    expect(rows[0]?.flow).toBe("repair");
  });

  it("drops a non-uuid conversation_id and still writes the row", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-abc",
      flow: "converse",
      conversation_id: "not-a-uuid",
    };
    await account(baseParams(meta), exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conversation_id === null || rows[0]?.conversation_id === undefined).toBe(true);
    expect(rows[0]?.flow).toBe("converse");
  });

  it("lets a well-formed uuid through — existence is the foreign key's job", async () => {
    const { rows, exec } = makeCaptureSpy();
    const meta: SubkitLlmTelemetryMetadata = {
      tenant_id: "tenant-abc",
      flow: "repair",
      execution_id: "9c2f1a5e-7b3d-4c8a-9e1f-2d3c4b5a6978",
    };
    await account(baseParams(meta), exec);
    expect(rows[0]?.execution_id).toBe("9c2f1a5e-7b3d-4c8a-9e1f-2d3c4b5a6978");
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
