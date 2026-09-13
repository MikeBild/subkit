// The in-band tool-call repair pays a provider. It has to say so.
//
// `repairToolCall` reaches the model through `generateObject` directly rather
// than through `invoke()`, so none of the accounting wrapped around the latter
// applied to it. From the day it was written until 2026-08-19 the tokens were
// spent, billed by the provider, and absent from `llm_usage` — findable only by
// reconciling an invoice against the ledger, which is to say not findable.
//
// Small in volume: the loop caps it at two per turn. That is an argument for
// why it stayed unnoticed, not for leaving it out.
//
// Tested at the entry shape rather than through the DB, the same way
// `accountant.attribution.test.ts` does, so this stays a fast unit test.

import type { LanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { _resetConfigForTests } from "../../config/loader.ts";
import { recordRepairUsage } from "./repair-tool-call.ts";

interface CapturedRow {
  tenant_id: string;
  flow: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  conversation_id: string | null | undefined;
  user_id: string | null | undefined;
  actor_type: string;
}

function captureSpy(): { rows: CapturedRow[]; exec: never } {
  const rows: CapturedRow[] = [];
  const exec = {
    insert: () => ({
      values: (row: CapturedRow) => {
        rows.push(row);
        return Promise.resolve();
      },
    }),
  } as unknown as never;
  return { rows, exec };
}

const MODEL = { modelId: "claude-haiku-4-5" } as unknown as LanguageModel;
const TENANT = "5d0c9b2a-1e3f-4a6b-8c7d-9e0f1a2b3c4d";
const CONVO = "7b6a5c4d-3e2f-4109-8a7b-6c5d4e3f2a1b";

const RESULT = {
  usage: { inputTokens: 812, outputTokens: 47 },
  providerMetadata: undefined,
};

beforeAll(async () => {
  try {
    const { getConfig } = await import("../../config/loader.ts");
    getConfig();
  } catch {
    const { loadConfig } = await import("../../config/loader.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "sk-cfg-repair-acct-"));
    await loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/unit-test", NODE_ENV: "test" },
      configPathOverride: join(dir, "subkit.config.json"),
    });
  }
});

afterAll(() => {
  _resetConfigForTests();
});

describe("recordRepairUsage", () => {
  it("writes a row under its own flow, not the patch-repair one", async () => {
    const { rows, exec } = captureSpy();
    await recordRepairUsage(
      { tenant_id: TENANT, conversation_id: CONVO, user_id: null, db: exec },
      MODEL,
      RESULT,
      1234,
    );

    expect(rows).toHaveLength(1);
    // `repair` is the self-healing patch proposal — a different mechanism with
    // a different cost profile. One name over both makes either unreadable.
    expect(rows[0]?.flow).toBe("tool_repair");
    expect(rows[0]?.tenant_id).toBe(TENANT);
    expect(rows[0]?.model).toBe("claude-haiku-4-5");
    expect(rows[0]?.prompt_tokens).toBe(812);
    expect(rows[0]?.completion_tokens).toBe(47);
    expect(rows[0]?.conversation_id).toBe(CONVO);
  });

  it("carries the actor through, so the row is attributable like every other", async () => {
    const { rows, exec } = captureSpy();
    const user = "1a2b3c4d-5e6f-4718-8293-a4b5c6d7e8f9";
    await recordRepairUsage(
      { tenant_id: TENANT, user_id: user, actor_type: "user", db: exec },
      MODEL,
      RESULT,
      10,
    );
    expect(rows[0]?.user_id).toBe(user);
    expect(rows[0]?.actor_type).toBe("user");
  });

  it("writes nothing when there is no tenant to bill", async () => {
    const { rows, exec } = captureSpy();
    await recordRepairUsage(undefined, MODEL, RESULT, 10);
    expect(rows).toHaveLength(0);
    void exec;
  });

  it("never throws — a bookkeeping failure must not lose a recovered tool call", async () => {
    // The corrected arguments are already in hand at this point. Refusing to
    // return them because a row would not insert turns a recovered turn into a
    // failed one, which is a strictly worse trade than a missing row.
    const exploding = {
      insert: () => ({
        values: () => Promise.reject(new Error("connection reset")),
      }),
    } as unknown as never;

    await expect(
      recordRepairUsage({ tenant_id: TENANT, db: exploding }, MODEL, RESULT, 10),
    ).resolves.toBeUndefined();
  });
});
