import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { proposeLearning } from "../../agent/sessions.ts";
import { apiKeys, users } from "../../db/schema/index.ts";
import { createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { getSkillCandidate } from "../../skill-candidates/service.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let curatorKey = "";

beforeAll(async () => {
  srv = await createHttpTestServer("fact-approval");
  const role = await createRole(srv.db, srv.tenantId, "skill-curator");
  for (const permission of ["skill:read", "skill:write", "skill:activate", "knowledge:read"]) {
    await grantPermissionToRole(srv.db, srv.tenantId, role.id, permission);
  }
  const [curator] = await srv.db
    .insert(users)
    .values({ tenant_id: srv.tenantId, email: "curator@test.local", role_id: role.id })
    .returning();
  curatorKey = `wf_live_${randomBytes(24).toString("base64url").slice(0, 32)}`; // allow-random: test only
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: curator?.id,
    prefix: curatorKey.slice(0, 12),
    token_sha256: createHash("sha256").update(curatorKey).digest("hex"),
    scopes: ["*"],
  });
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 60_000);

function propose(title: string, kind: "fact" | "practice") {
  return proposeLearning({
    tenant_id: srv.tenantId,
    title,
    body: `${title} — taught in a conversation.`,
    domains: ["ops"],
    kind,
    actor: null,
    confidence: "high",
    evidence_summary: "test",
    db: srv.db,
  });
}

function approve(id: string, key: string): Promise<Response> {
  return fetch(`${srv.baseUrl}/v1/skill-candidates/${id}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("POST /v1/skill-candidates/{id}/approve — a fact writes knowledge", () => {
  test("without knowledge:write a fact is refused and stays proposed", async () => {
    const fact = await propose("Pager rota", "fact");
    const res = await approve(fact.candidate_id ?? "", curatorKey);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { details?: { permission?: string } };
    expect(body.details?.permission).toBe("knowledge:write");
    const candidate = await getSkillCandidate(srv.tenantId, fact.candidate_id ?? "", srv.db);
    expect(candidate?.status).toBe("proposed");
  });

  test("the same caller still approves a practice", async () => {
    const practice = await propose("Confirm the page", "practice");
    const res = await approve(practice.candidate_id ?? "", curatorKey);
    expect(res.status).toBe(200);
  });

  test("a caller with knowledge:write approves the fact", async () => {
    const fact = await propose("Escalation lead", "fact");
    const res = await approve(fact.candidate_id ?? "", srv.apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { knowledge: { slug: string } | null };
    expect(body.knowledge?.slug).toBe("learnings-ops");
  });
});
