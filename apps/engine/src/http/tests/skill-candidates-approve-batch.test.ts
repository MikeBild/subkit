import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { auditLog, skillCandidates, skills } from "../../db/schema/index.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let seq = 0;

async function seedCandidate(label: string): Promise<string> {
  const [row] = await srv.db
    .insert(skillCandidates)
    .values({
      tenant_id: srv.tenantId,
      scope: "global",
      pattern_kind: "success_pattern",
      title: `batch candidate ${label}`,
      body: `batch body ${label}`,
      evidence: { note: label },
      confidence: "high",
      status: "proposed",
      fingerprint: `batch-fp-${label}-${++seq}`,
    })
    .returning();
  if (!row) throw new Error("seed candidate failed");
  return row.id;
}

async function digestOf(id: string): Promise<string> {
  const res = await fetch(`${srv.baseUrl}/v1/skill-candidates/${id}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
  const body = (await res.json()) as { review_digest?: string };
  if (!body.review_digest) throw new Error("candidate without review digest");
  return body.review_digest;
}

async function approve(headers: Record<string, string>, candidates: unknown): Promise<Response> {
  return fetch(`${srv.baseUrl}/v1/skill-candidates/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ candidates }),
  });
}

beforeAll(async () => {
  srv = await createHttpTestServer("skill-cand-batch");
});

afterAll(async () => {
  await srv.cleanup();
});

describe("POST /v1/skill-candidates/approve", () => {
  test("an API key with every scope cannot approve in a batch", async () => {
    const id = await seedCandidate("api-key");
    const res = await approve({ authorization: `Bearer ${srv.apiKey}` }, [
      { id, expected_review_digest: await digestOf(id) },
    ]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("human_confirmation_required");
    const [after] = await srv.db.select().from(skillCandidates).where(eq(skillCandidates.id, id));
    expect(after?.status).toBe("proposed");
  });

  test("a signed-in person approves each candidate on its own with its own audit entry", async () => {
    const first = await seedCandidate("person-a");
    const second = await seedCandidate("person-b");
    const changed = await seedCandidate("person-changed");
    const res = await approve(await browserSessionHeaders(srv, srv.userId), [
      { id: first, expected_review_digest: await digestOf(first) },
      { id: second, expected_review_digest: await digestOf(second) },
      { id: changed, expected_review_digest: "0".repeat(64) },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      approved: number;
      results: { id: string; outcome: string; skill_id: string | null }[];
    };
    expect(body.approved).toBe(2);
    expect(body.results.map((result) => [result.id, result.outcome])).toEqual([
      [first, "approved"],
      [second, "approved"],
      [changed, "changed_since_review"],
    ]);

    const rows = await srv.db
      .select()
      .from(skillCandidates)
      .where(inArray(skillCandidates.id, [first, second, changed]));
    const status = new Map(rows.map((row) => [row.id, row.status]));
    expect(status.get(first)).toBe("approved");
    expect(status.get(second)).toBe("approved");
    expect(status.get(changed)).toBe("proposed");

    const promoted = body.results.flatMap((result) => (result.skill_id ? [result.skill_id] : []));
    const created = await srv.db.select().from(skills).where(inArray(skills.id, promoted));
    expect(created.map((skill) => skill.lifecycle)).toEqual(["active", "active"]);

    const entries = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, AuditAction.SKILL_CANDIDATE_APPROVED),
          inArray(auditLog.resource_id, [first, second, changed]),
        ),
      );
    expect(entries.map((entry) => entry.resource_id).sort()).toEqual([first, second].sort());
    for (const entry of entries) expect(entry.actor_id).toBe(srv.userId);
  });

  test("an already decided candidate reports its outcome without stopping the batch", async () => {
    const decided = await seedCandidate("decided");
    const open = await seedCandidate("open");
    const decidedDigest = await digestOf(decided);
    await srv.db
      .update(skillCandidates)
      .set({ status: "rejected" })
      .where(and(eq(skillCandidates.tenant_id, srv.tenantId), eq(skillCandidates.id, decided)));
    const res = await approve(await browserSessionHeaders(srv, srv.userId), [
      { id: decided, expected_review_digest: decidedDigest },
      { id: open, expected_review_digest: await digestOf(open) },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id: string; outcome: string }[] };
    expect(body.results.map((result) => result.outcome)).toEqual(["already_decided", "approved"]);
  });

  test("a batch naming the same candidate twice is refused before anything changes", async () => {
    const id = await seedCandidate("twice");
    const digest = await digestOf(id);
    const res = await approve(await browserSessionHeaders(srv, srv.userId), [
      { id, expected_review_digest: digest },
      { id, expected_review_digest: digest },
    ]);
    expect(res.status).toBe(400);
    const [after] = await srv.db.select().from(skillCandidates).where(eq(skillCandidates.id, id));
    expect(after?.status).toBe("proposed");
  });
});
