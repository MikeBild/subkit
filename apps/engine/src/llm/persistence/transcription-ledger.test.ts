import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import { llmUsage, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { readSpend } from "../accounting/spend.ts";
import {
  priorTranscription,
  reconcileTranscription,
  releaseTranscription,
  reserveTranscription,
  settleTranscription,
  sweepTranscriptionReservations,
} from "./transcription-ledger.ts";

const skip = testEnv.REQUIRES_PG === "0";
const MODEL = "openai/gpt-4o-mini-transcribe";

let testDb: TestDb;
let configDir = "";
let tenant = "";

const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const reservation = (n: number, estimate_seconds = 300) => ({
  tenant_id: tenant,
  client_request_id: requestId(n),
  model: MODEL,
  estimate_seconds,
  user_id: null,
  actor_type: "system" as const,
});

const rowOf = async (n: number) =>
  (
    await testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, tenant), eq(llmUsage.client_request_id, requestId(n))))
  )[0];

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("llm_transcription_ledger");
  configDir = mkdtempSync(join(tmpdir(), "subkit-transcription-ledger-"));
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
  tenant = (await seedTenant(testDb.db, { slug: "stt-ledger" })).id;
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

describe.skipIf(skip)("transcription reservation ledger", () => {
  test("a reservation charges its estimate until settlement books the real time", async () => {
    expect(await reserveTranscription(reservation(1), testDb.db)).toEqual({ kind: "reserved" });
    expect(await rowOf(1)).toMatchObject({
      flow: "transcription",
      model: MODEL,
      reservation: "reserved",
      audio_seconds: 300,
      transcript: null,
    });
    expect((await readSpend(tenant, testDb.db)).spent_usd).toBeCloseTo(0.015, 6);
    const settled = await settleTranscription(
      { ...reservation(1), audio_seconds: 60, latency_ms: 800, transcript: "hello" },
      testDb.db,
    );
    expect(settled).toBe(true);
    expect(await rowOf(1)).toMatchObject({
      reservation: "settled",
      audio_seconds: 60,
      latency_ms: 800,
      transcript: "hello",
      lease_until: null,
      result: "success",
    });
    expect((await readSpend(tenant, testDb.db)).spent_usd).toBeCloseTo(0.003, 6);
  });

  test("a retry after settlement replays the stored outcome and adds no row", async () => {
    await reserveTranscription(reservation(2), testDb.db);
    await settleTranscription(
      { ...reservation(2), audio_seconds: 5, latency_ms: 40, transcript: "once" },
      testDb.db,
    );
    const replay = { kind: "replay" as const, text: "once", model: MODEL, latency_ms: 40 };
    expect(await priorTranscription(reservation(2), testDb.db)).toEqual(replay);
    expect(await reserveTranscription(reservation(2), testDb.db)).toEqual(replay);
    expect(await testDb.db.select().from(llmUsage)).toHaveLength(1);
  });

  test("a second reservation of an open request is in progress, not a second charge", async () => {
    await reserveTranscription(reservation(3), testDb.db);
    expect(await reserveTranscription(reservation(3), testDb.db)).toEqual({ kind: "in_progress" });
    expect(await testDb.db.select().from(llmUsage)).toHaveLength(1);
  });

  test("a provider failure releases the charge and a retry reserves the same row again", async () => {
    await reserveTranscription(reservation(4), testDb.db);
    expect(await releaseTranscription({ ...reservation(4), latency_ms: 30 }, testDb.db)).toBe(true);
    expect(await rowOf(4)).toMatchObject({
      reservation: "released",
      audio_seconds: 0,
      result: "error",
      error: "transcription_failed",
    });
    expect((await readSpend(tenant, testDb.db)).spent_usd).toBe(0);
    expect(await releaseTranscription({ ...reservation(4), latency_ms: 30 }, testDb.db)).toBe(
      false,
    );
    expect(await reserveTranscription(reservation(4), testDb.db)).toEqual({ kind: "reserved" });
    expect(await testDb.db.select().from(llmUsage)).toHaveLength(1);
  });

  test("an ambiguous failure retains its charge and cannot reserve again", async () => {
    await reserveTranscription(reservation(6), testDb.db);
    expect(await reconcileTranscription({ ...reservation(6), latency_ms: 30 }, testDb.db)).toBe(
      true,
    );
    expect(await rowOf(6)).toMatchObject({
      reservation: "reconciliation_required",
      audio_seconds: 300,
      lease_until: null,
      result: "error",
      error: "transcription_failed",
    });
    expect((await readSpend(tenant, testDb.db)).spent_usd).toBeCloseTo(0.015, 6);
    expect(await reserveTranscription(reservation(6), testDb.db)).toEqual({ kind: "unsettled" });
    expect(await reconcileTranscription({ ...reservation(6), latency_ms: 30 }, testDb.db)).toBe(
      false,
    );
    expect(await testDb.db.select().from(llmUsage)).toHaveLength(1);
  });

  test("settlement never reopens a released request", async () => {
    await reserveTranscription(reservation(5), testDb.db);
    await releaseTranscription({ ...reservation(5), latency_ms: 0 }, testDb.db);
    const late = { ...reservation(5), audio_seconds: 9, latency_ms: 0, transcript: "late" };
    expect(await settleTranscription(late, testDb.db)).toBe(false);
    expect((await rowOf(5))?.reservation).toBe("released");
  });

  test("concurrent reservations never exceed the spend limit", async () => {
    await testDb.db.update(tenants).set({ spend_limit_usd: 0.05 }).where(eq(tenants.id, tenant));
    const outcomes = await Promise.all(
      [10, 11, 12, 13, 14, 15].map((n) => reserveTranscription(reservation(n), testDb.db)),
    );
    const kinds = outcomes.map((outcome) => outcome.kind).sort();
    expect(kinds).toEqual([
      "reserved",
      "reserved",
      "reserved",
      "spend_limit",
      "spend_limit",
      "spend_limit",
    ]);
    const reading = await readSpend(tenant, testDb.db);
    expect(reading.spent_usd).toBeCloseTo(0.045, 6);
    expect(reading.spent_usd).toBeLessThanOrEqual(0.05);
  });

  test("a released reservation frees its budget for the next recording", async () => {
    await testDb.db.update(tenants).set({ spend_limit_usd: 0.02 }).where(eq(tenants.id, tenant));
    await reserveTranscription(reservation(20), testDb.db);
    expect((await reserveTranscription(reservation(21), testDb.db)).kind).toBe("spend_limit");
    await releaseTranscription({ ...reservation(20), latency_ms: 0 }, testDb.db);
    expect((await reserveTranscription(reservation(21), testDb.db)).kind).toBe("reserved");
  });

  test("a stuck reservation is moved to reconciliation and stays charged", async () => {
    await reserveTranscription(reservation(30, 42), testDb.db);
    await reserveTranscription(reservation(31, 42), testDb.db);
    await testDb.db
      .update(llmUsage)
      .set({ lease_until: new Date("2000-01-01T00:00:00Z") })
      .where(eq(llmUsage.client_request_id, requestId(30)));
    expect(await sweepTranscriptionReservations(testDb.db)).toBe(1);
    expect(await rowOf(30)).toMatchObject({
      reservation: "reconciliation_required",
      audio_seconds: 42,
      lease_until: null,
    });
    expect((await rowOf(31))?.reservation).toBe("reserved");
    expect(await priorTranscription(reservation(30), testDb.db)).toEqual({ kind: "unsettled" });
    expect(await reserveTranscription(reservation(30), testDb.db)).toEqual({ kind: "unsettled" });
    expect(await sweepTranscriptionReservations(testDb.db)).toBe(0);
  });

  test("a late provider answer settles a reservation under reconciliation", async () => {
    await reserveTranscription(reservation(40), testDb.db);
    await testDb.db
      .update(llmUsage)
      .set({ lease_until: new Date("2000-01-01T00:00:00Z") })
      .where(eq(llmUsage.client_request_id, requestId(40)));
    await sweepTranscriptionReservations(testDb.db);
    const late = { ...reservation(40), audio_seconds: 12, latency_ms: 0, transcript: "late" };
    expect(await settleTranscription(late, testDb.db)).toBe(true);
    expect(await rowOf(40)).toMatchObject({ reservation: "settled", audio_seconds: 12 });
  });

  test("the same request id in another tenant is a separate reservation", async () => {
    const other = (await seedTenant(testDb.db, { slug: "stt-ledger-other" })).id;
    await reserveTranscription(reservation(50), testDb.db);
    expect(await reserveTranscription({ ...reservation(50), tenant_id: other }, testDb.db)).toEqual(
      { kind: "reserved" },
    );
  });
});
