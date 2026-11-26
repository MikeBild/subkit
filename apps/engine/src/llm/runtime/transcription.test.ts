import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { authIdentities, llmUsage, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { now } from "../../utils/clock.ts";
import { currentMonthBucket, recordUsage } from "../accounting/budget.ts";
import {
  transcriptionKeyOwner,
  transcriptionModelName,
  transcriptionSpendAllows,
} from "./transcription.ts";

const skip = testEnv.REQUIRES_PG === "0";

let testDb: TestDb;
let configDir = "";
let selfHosted = "";
let hosted = "";
let hostedWithKey = "";

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("llm_transcription_usage");
  configDir = mkdtempSync(join(tmpdir(), "subkit-transcription-usage-"));
  const file = join(configDir, "subkit.config.json");
  writeFileSync(
    file,
    JSON.stringify({ llm: { providers: { openai: { api_key: "sk-operator-openai" } } } }),
  );
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: testDb.url, NODE_ENV: "test" },
    configPathOverride: file,
  });
  selfHosted = (await seedTenant(testDb.db, { slug: "stt-self-hosted" })).id;
  await configureHostedPolicyForTests(testDb.db, testDb.url);
  const owners = await testDb.db
    .insert(authIdentities)
    .values([
      { issuer_url: "https://id.example.test", subject: "stt-a", email: "a@example.test" },
      { issuer_url: "https://id.example.test", subject: "stt-b", email: "b@example.test" },
    ])
    .returning();
  hosted = (
    await seedTenant(testDb.db, {
      slug: "stt-hosted",
      origin: "self_service",
      owner_identity_id: owners[0]?.id ?? null,
    })
  ).id;
  hostedWithKey = (
    await seedTenant(testDb.db, {
      slug: "stt-hosted-own-key",
      origin: "self_service",
      owner_identity_id: owners[1]?.id ?? null,
    })
  ).id;
  const options = { tenantId: hostedWithKey, force: true };
  await setConfigKey(["llm", "provider"], "openai", options);
  await setConfigKey(["llm", "providers", "openai", "api_key"], "sk-workspace-openai", options);
}, 120_000);

afterEach(async () => {
  if (skip) return;
  await testDb.db.delete(llmUsage);
  await testDb.db.update(tenants).set({ spend_limit_usd: 50 });
});

afterAll(async () => {
  if (skip) return;
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await testDb?.cleanup();
}, 60_000);

describe.skipIf(skip)("transcription spend", () => {
  test("a transcription row is named by provider and its default model", () => {
    expect(transcriptionModelName("openai", undefined)).toBe("openai/gpt-4o-mini-transcribe");
    expect(transcriptionModelName("azure", "gpt-4o-transcribe")).toBe("azure/gpt-4o-transcribe");
  });

  test("a hosted workspace keeps the row of a call its provider key rejected", async () => {
    await recordUsage(
      {
        tenant_id: hosted,
        flow: "converse",
        model: "gpt-4.1",
        prompt_tokens: 0,
        completion_tokens: 0,
        latency_ms: 10,
        result: "key_rejected",
        error: "invalid api key",
      },
      testDb.db,
    );
    const rows = await testDb.db.select().from(llmUsage).where(eq(llmUsage.tenant_id, hosted));
    expect(rows.map((row) => row.result)).toEqual(["key_rejected"]);
  });

  test("the spend limit gates cloud transcription like every other model call", async () => {
    expect(await transcriptionSpendAllows(selfHosted, testDb.db)).toBe(true);
    await testDb.db
      .update(tenants)
      .set({ spend_limit_usd: 0.01 })
      .where(eq(tenants.id, selfHosted));
    const at = new Date(now());
    await testDb.db.insert(llmUsage).values({
      tenant_id: selfHosted,
      flow: "transcription",
      model: "openai/gpt-4o-mini-transcribe",
      audio_seconds: 600,
      result: "success",
      month_bucket: currentMonthBucket(at),
      created_at: at,
    });
    expect(await transcriptionSpendAllows(selfHosted, testDb.db)).toBe(false);
  });
});

describe.skipIf(skip)("who may transcribe with which key", () => {
  test("the operator key serves a self-hosted workspace", async () => {
    expect(await transcriptionKeyOwner("openai", selfHosted, testDb.db)).toBe("operator");
  });

  test("the operator key is refused to a self-service workspace, as for chat", async () => {
    expect(await transcriptionKeyOwner("openai", hosted, testDb.db)).toBeNull();
  });

  test("a self-service workspace with its own key transcribes with it", async () => {
    expect(await transcriptionKeyOwner("openai", hostedWithKey, testDb.db)).toBe("workspace");
  });

  test("a provider without credentials is never offered", async () => {
    expect(await transcriptionKeyOwner("gemini", selfHosted, testDb.db)).toBeNull();
  });
});
