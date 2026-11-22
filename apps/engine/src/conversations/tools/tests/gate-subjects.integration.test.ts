import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { closeDb, type Db } from "../../../db/client.ts";
import {
  conversations,
  skillCandidates,
  tenants,
  toolApprovals,
  users,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { buildMcpStubCtx } from "../../../mcp/adapter.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { getSkillCandidate } from "../../../skill-candidates/service.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { grantApproval, hashToolArgs } from "../../../tools/approval.ts";
import { dispatchTool } from "../../../tools/dispatcher.ts";
import { getUnifiedRegistry } from "../../../tools/index.ts";
import { SUBKIT_CONFIRM_ID_META_KEY, SUBKIT_CONFIRM_META_KEY } from "../../../tools/policy.ts";
import type { ToolEnvelope } from "../../../tools/types.ts";
import { pendingPrompt } from "../../resume.ts";
import { freshSignals } from "../../tests/turn-signals.ts";
import type { TurnEvent } from "../../types.ts";
import { getTool, type ToolContext } from "../index.ts";
import { wrapOne } from "../sdk-wrap/invoke.ts";

const FABRICATED_ID = "00000000-0000-4000-8000-00000000f00d";
const MODEL_TITLE = "Model supplied title that must never be shown";

let tdb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;
let principal: ResolvedPrincipal;
let seq = 0;
const originalDatabaseUrl = testEnv.DATABASE_URL;

async function newConversation(): Promise<string> {
  const [row] = await tdb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation seed failed");
  return row.id;
}

function toolCtx(conversation_id: string): ToolContext {
  return {
    db,
    tenant_id: tenantId,
    conversation_id,
    actor_id: userId,
    principal,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: tenantId,
      actor_id: userId,
      actor_type: "user",
      db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    surface: "web",
  };
}

async function seedCandidates(
  count: number,
  status: "proposed" | "approved" = "proposed",
): Promise<Array<{ id: string; title: string }>> {
  const out: Array<{ id: string; title: string }> = [];
  for (let i = 0; i < count; i++) {
    seq += 1;
    const title = `Gate subject ${seq}`;
    const [row] = await tdb.db
      .insert(skillCandidates)
      .values({
        tenant_id: tenantId,
        scope: "global",
        pattern_kind: "success_pattern",
        title,
        body: `Stored body ${seq}`,
        evidence: [],
        confidence: "medium",
        status,
        fingerprint: `gate-subject-${seq}`,
      })
      .returning();
    if (!row) throw new Error("candidate seed failed");
    out.push({ id: row.id, title });
  }
  return out;
}

async function approvalCount(tool: string): Promise<number> {
  const rows = await tdb.db
    .select({ id: toolApprovals.id })
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, tenantId), eq(toolApprovals.tool, tool)));
  return rows.length;
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await tdb.db
    .select({ status: skillCandidates.status })
    .from(skillCandidates)
    .where(and(eq(skillCandidates.tenant_id, tenantId), eq(skillCandidates.id, id)));
  return row?.status;
}

async function chatCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; events: TurnEvent[] }> {
  const inner = getTool(name);
  if (!inner) throw new Error(`${name} is not registered`);
  const events: TurnEvent[] = [];
  const wrapped = wrapOne(inner, toolCtx(await newConversation()), freshSignals(), events, db, {});
  seq += 1;
  const result = await wrapped.execute!(args, {
    toolCallId: `gate-subjects-${seq}`,
    messages: [],
    context: {},
  });
  return { result, events };
}

function mcpCall(
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<ToolEnvelope> {
  return dispatchTool(
    {
      registry: getUnifiedRegistry(),
      db,
      principal,
      buildMcpStubCtx: () => buildMcpStubCtx({ db, principal }),
      mcpMode: "authoring",
    },
    { surface: "mcp", name, args, ...(meta ? { meta } : {}) },
  );
}

function elicitRequest(events: TurnEvent[]): Record<string, unknown> {
  const event = events.find((e) => e.type === "elicit_request") as
    | (TurnEvent & { input?: unknown; pending_output?: Record<string, unknown> })
    | undefined;
  if (!event) throw new Error("no confirmation was requested");
  return event as unknown as Record<string, unknown>;
}

beforeAll(async () => {
  tdb = await createTestDb("gate-subjects");
  db = tdb.db as unknown as Db;
  await closeDb();
  testEnv.DATABASE_URL = tdb.url;
  const [tenant] = await tdb.db
    .insert(tenants)
    .values({ slug: "t-gate-subjects", display_name: "Gate Subjects" })
    .returning();
  if (!tenant) throw new Error("tenant seed failed");
  tenantId = tenant.id;
  const [person] = await tdb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "approver@gate-subjects.test.local",
      role_id: await builtinRoleId(tdb.db, "admin"),
    })
    .returning();
  if (!person) throw new Error("user seed failed");
  userId = person.id;
  principal = { provider: "test", kind: "user", id: userId, tenant_id: tenantId, roles: ["admin"] };
}, 30_000);

afterAll(async () => {
  await closeDb();
  if (originalDatabaseUrl === undefined) delete testEnv.DATABASE_URL;
  else testEnv.DATABASE_URL = originalDatabaseUrl;
  await tdb.cleanup();
}, 30_000);

describe("candidate confirmations show only server-resolved subjects", () => {
  test("chat: fabricated ids are refused before any approval exists", async () => {
    const before = await approvalCount("reject_skill_candidate");
    const { result, events } = await chatCall("reject_skill_candidate", {
      candidate_ids: [FABRICATED_ID],
    });
    expect(JSON.stringify(result)).toContain("not_found");
    expect(JSON.stringify(result)).toContain(FABRICATED_ID);
    expect(events.some((e) => e.type === "elicit_request")).toBe(false);
    expect(await approvalCount("reject_skill_candidate")).toBe(before);
  });

  test("chat: a batch mixing proposed and decided ids is refused and nothing changes", async () => {
    const [open] = await seedCandidates(1);
    const [decided] = await seedCandidates(1, "approved");
    if (!open || !decided) throw new Error("seed failed");
    const before = await approvalCount("reject_skill_candidate");
    const { result, events } = await chatCall("reject_skill_candidate", {
      candidate_ids: [open.id, decided.id],
    });
    expect(JSON.stringify(result)).toContain("already_decided");
    expect(JSON.stringify(result)).toContain(decided.id);
    expect(events.some((e) => e.type === "elicit_request")).toBe(false);
    expect(await approvalCount("reject_skill_candidate")).toBe(before);
    expect(await statusOf(open.id)).toBe("proposed");
  });

  test("chat: 45 ids show 45 stored titles on the card", async () => {
    const seeded = await seedCandidates(45);
    const { events } = await chatCall("reject_skill_candidate", {
      candidate_ids: seeded.map((c) => c.id),
      titles: seeded.map(() => MODEL_TITLE),
    });
    const request = elicitRequest(events);
    const pending = request.pending_output as { subjects: unknown[] };
    expect(pending.subjects).toEqual(
      seeded.map((c) => ({ id: c.id, title: c.title, status: "proposed" })),
    );
    const projected = pendingPrompt(request.input).prompt?.subjects;
    expect(projected).toEqual(seeded.map((c) => c.title));
    expect(JSON.stringify(request.pending_output)).not.toContain(MODEL_TITLE);
    expect(JSON.stringify(projected)).not.toContain(MODEL_TITLE);
  });

  test("mcp: 45 ids show 45 stored titles and model titles never reach the card", async () => {
    const seeded = await seedCandidates(45);
    const before = await approvalCount("reject_skill_candidate");
    const envelope = await mcpCall("reject_skill_candidate", {
      candidate_ids: seeded.map((c) => c.id),
    });
    expect(envelope.status).toBe("needs_confirm");
    if (envelope.status !== "needs_confirm") throw new Error("expected needs_confirm");
    expect(envelope.confirm.pending_output).toMatchObject({
      candidate_count: 45,
      subjects: seeded.map((c) => ({ id: c.id, title: c.title, status: "proposed" })),
    });
    expect(await approvalCount("reject_skill_candidate")).toBe(before + 1);

    const withTitles = await mcpCall("reject_skill_candidate", {
      candidate_ids: seeded.slice(0, 2).map((c) => c.id),
      titles: [MODEL_TITLE, MODEL_TITLE],
    });
    expect(withTitles.status).toBe("error");
    if (withTitles.status === "error") expect(withTitles.error_code).toBe("invalid_args");
    expect(JSON.stringify(withTitles)).not.toContain(MODEL_TITLE);
  });

  test("mcp: fabricated and mixed ids are refused before any approval exists", async () => {
    const [open] = await seedCandidates(1);
    if (!open) throw new Error("seed failed");
    const before = await approvalCount("reject_skill_candidate");
    const fabricated = await mcpCall("reject_skill_candidate", {
      candidate_ids: [open.id, FABRICATED_ID],
    });
    expect(fabricated.status).toBe("error");
    if (fabricated.status === "error") expect(fabricated.error_code).toBe("not_found");
    expect(JSON.stringify(fabricated)).toContain(FABRICATED_ID);
    expect(await approvalCount("reject_skill_candidate")).toBe(before);
    expect(await statusOf(open.id)).toBe("proposed");
  });

  test("chat: the approval card shows the stored candidate and the approval binds its digest", async () => {
    const [candidate] = await seedCandidates(1);
    if (!candidate) throw new Error("seed failed");
    const { events } = await chatCall("approve_skill_candidate", { candidate_id: candidate.id });
    const request = elicitRequest(events);
    expect(request.pending_output).toEqual({
      candidate_id: candidate.id,
      subjects: [{ id: candidate.id, title: candidate.title, status: "proposed" }],
      target: { kind: "skill_draft" },
      body_excerpt: expect.stringContaining("Stored body"),
    });
    expect(pendingPrompt(request.input).prompt?.subjects).toEqual([
      candidate.title,
      "Target: new draft skill (needs activation)",
      expect.stringContaining("Stored body"),
    ]);
    const reviewed = await getSkillCandidate(tenantId, candidate.id, db);
    const rows = await tdb.db
      .select({ args_hash: toolApprovals.args_hash, surface: toolApprovals.surface })
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.tenant_id, tenantId),
          eq(toolApprovals.tool, "approve_skill_candidate"),
        ),
      );
    expect(rows.filter((r) => r.surface === "chat").map((r) => r.args_hash)).toContain(
      hashToolArgs({ candidate_id: candidate.id, expected_review_digest: reviewed?.review_digest }),
    );
  });

  test("mcp: an approval replays the reviewed digest and refuses a candidate changed meanwhile", async () => {
    const [candidate] = await seedCandidates(1);
    if (!candidate) throw new Error("seed failed");
    const envelope = await mcpCall("approve_skill_candidate", { candidate_id: candidate.id });
    expect(envelope.status).toBe("needs_confirm");
    if (envelope.status !== "needs_confirm") throw new Error("expected needs_confirm");
    expect(envelope.confirm.pending_output).toMatchObject({
      subjects: [{ id: candidate.id, title: candidate.title, status: "proposed" }],
      target: { kind: "skill_draft" },
      body_excerpt: expect.stringContaining("Stored body"),
    });
    const approvalId = envelope.confirm.tool_call_id;
    const reviewed = await getSkillCandidate(tenantId, candidate.id, db);
    const [stored] = await tdb.db
      .select({ args_hash: toolApprovals.args_hash })
      .from(toolApprovals)
      .where(and(eq(toolApprovals.tenant_id, tenantId), eq(toolApprovals.id, approvalId)));
    expect(stored?.args_hash).toBe(
      hashToolArgs({ candidate_id: candidate.id, expected_review_digest: reviewed?.review_digest }),
    );

    await tdb.db
      .update(skillCandidates)
      .set({ body: "Edited after the card was shown" })
      .where(and(eq(skillCandidates.tenant_id, tenantId), eq(skillCandidates.id, candidate.id)));
    const granted = await grantApproval({
      db,
      approval_id: approvalId,
      tenant_id: tenantId,
      granted_by_user_id: userId,
      via: "portal",
    });
    expect(granted.ok).toBe(true);
    const replay = await mcpCall(
      "approve_skill_candidate",
      {},
      { [SUBKIT_CONFIRM_META_KEY]: true, [SUBKIT_CONFIRM_ID_META_KEY]: approvalId },
    );
    expect(replay.status).toBe("error");
    if (replay.status === "error") expect(replay.error_code).toBe("changed_since_review");
    expect(await statusOf(candidate.id)).toBe("proposed");
  });
});
