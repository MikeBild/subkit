// User story: As an admin who ran `sk -p "..."` a few minutes ago,
// I re-run `sk -c "follow-up"` and sk attaches to the SAME
// conversation id on the engine side, appending my follow-up
// message rather than creating a new conversation. The local
// sessions cache (`~/.sk/sessions/*.json`) is the source of truth.
//
// Acceptance criteria:
//
//   AC1. runHeadless writes one cache file per conversation it
//        creates, with `engine_url` + `tenant_id` + `conversation_id`.
//   AC2. mostRecentSession(filter) returns the right entry when
//        multiple sessions exist across different engines/tenants.
//   AC3. runHeadless called with `resume: <id>` posts a
//        `POST /v1/conversations/:id/messages` against the engine
//        (i.e. reuses the conversation) — no new `conversation.created`
//        row is emitted for that id.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { ResolvedProfile } from "../../../../sk/src/config.ts";
import { runHeadless } from "../../../../sk/src/headless.ts";
import {
  listSessionMetadata,
  mostRecentSession,
  saveSessionMetadata,
} from "../../../../sk/src/sessions.ts";
import { auditLog } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx } from "./setup.ts";

const TEST_NOW_MS = Date.now();

let ctx: JourneyCtx;
let scratchHome: string;
let prevSkHome: string | undefined;

const makeBuf = () => {
  const chunks: string[] = [];
  return {
    write: (s: string) => chunks.push(s),
    toString: () => chunks.join(""),
  };
};

function profile(): ResolvedProfile {
  return {
    name: "journey",
    engine_url: ctx.baseUrl,
    api_key: ctx.apiKey,
    active_tenant_id: ctx.tenantId,
  };
}

describe("journey: sk-cli continue-session cache", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-11-continue");
    scratchHome = mkdtempSync(join(tmpdir(), "sk-cont-home-"));
    prevSkHome = process.env.SK_HOME;
    process.env.SK_HOME = scratchHome;
  });

  afterAll(async () => {
    if (prevSkHome !== undefined) process.env.SK_HOME = prevSkHome;
    else delete process.env.SK_HOME;
    rmSync(scratchHome, { recursive: true, force: true });
    await ctx.cleanup();
  });

  test("AC1: runHeadless writes a session cache entry for a new conversation", async () => {
    const result = await runHeadless({
      profile: profile(),
      prompt: "first turn",
      output: "text",
      noMemory: true,
      stdout: makeBuf(),
      stderr: makeBuf(),
    });
    expect(result.exitCode).toBe(0);
    const id = result.conversation_id as string;
    expect(id).toBeDefined();
    const listed = listSessionMetadata({
      engine_url: ctx.baseUrl,
      tenant_id: ctx.tenantId,
    });
    const hit = listed.find((s) => s.conversation_id === id);
    expect(hit).toBeDefined();
    expect(hit?.engine_url).toBe(ctx.baseUrl);
    expect(hit?.tenant_id).toBe(ctx.tenantId);
  });

  test("AC2: mostRecentSession filters by engine + tenant", () => {
    // Seed a "prod" session that the filter should NOT return when
    // asked for dev.
    saveSessionMetadata({
      conversation_id: "prod-only-12345678-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      engine_url: "https://prod.example.com",
      tenant_id: "prod-tenant",
      title: null,
      model: null,
      created_at: new Date(TEST_NOW_MS).toISOString(),
      last_used_at: new Date(TEST_NOW_MS).toISOString(),
    });
    const devLatest = mostRecentSession({
      engine_url: ctx.baseUrl,
      tenant_id: ctx.tenantId,
    });
    expect(devLatest).not.toBeNull();
    expect(devLatest?.engine_url).toBe(ctx.baseUrl);

    const prodLatest = mostRecentSession({
      engine_url: "https://prod.example.com",
      tenant_id: "prod-tenant",
    });
    expect(prodLatest?.conversation_id).toBe("prod-only-12345678-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  test("AC3: runHeadless with resume reuses the conversation (no new create row)", async () => {
    // Create once.
    const first = await runHeadless({
      profile: profile(),
      prompt: "turn A",
      output: "text",
      noMemory: true,
      stdout: makeBuf(),
      stderr: makeBuf(),
    });
    const id = first.conversation_id as string;

    // Snapshot the number of `conversation.created` rows for this id.
    const createdBefore = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "conversation.created"), eq(auditLog.resource_id, id)));

    // Resume with a second prompt.
    const second = await runHeadless({
      profile: profile(),
      prompt: "turn B — follow up",
      output: "text",
      noMemory: true,
      resume: id,
      stdout: makeBuf(),
      stderr: makeBuf(),
    });
    expect(second.exitCode).toBe(0);
    expect(second.conversation_id).toBe(id);

    // Still exactly one `conversation.created` row for this id.
    const createdAfter = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "conversation.created"), eq(auditLog.resource_id, id)));
    expect(createdAfter.length).toBe(createdBefore.length);
  });
});
