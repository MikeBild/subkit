import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { proposeLearning } from "../../agent/sessions.ts";
import { apiKeys, users } from "../../db/schema/index.ts";
import { getContext } from "../../logging/context.ts";
import { logger } from "../../logging/logger.ts";
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

test("source-specific proposals deny a skill-only reader through the normal permission warning", async () => {
  const role = await createRole(srv.db, srv.tenantId, "skill-only-reader");
  await grantPermissionToRole(srv.db, srv.tenantId, role.id, "skill:read");
  const [reader] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "skill-only@test.local",
      role_id: role.id,
    })
    .returning();
  if (!reader) throw new Error("missing skill reader");
  const key = "wf_live_skill_only_reader_fixture_token";
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: reader.id,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes: ["*"],
  });
  const headers = { authorization: `Bearer ${key}` };
  const permitted = await fetch(`${srv.baseUrl}/v1/skill-candidates`, { headers });
  expect(permitted.status).toBe(200);
  await permitted.text();
  const warnings: Record<string, unknown>[] = [];
  const originalWarn = logger.warn;
  const warning = spyOn(logger, "warn").mockImplementation((fields) => {
    warnings.push({ ...getContext(), ...fields });
    originalWarn(fields);
  });
  try {
    const response = await fetch(
      `${srv.baseUrl}/v1/skill-candidates?knowledge_source_id=00000000-0000-4000-8000-000000000123`,
      { headers },
    );
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("Reading source-specific proposals needs knowledge:read");
    expect(body).not.toContain(key);
    const denials = warnings.filter(
      (entry) => entry.module === "rbac" && entry.action === "denied",
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      tenant_id: srv.tenantId,
      principal_id: reader.id,
      principal_kind: "user",
      permission: "knowledge:read",
      request_source: "api",
    });
    expect(denials[0]?.resource_id).toBeUndefined();
    expect(denials[0]?.resource_type).toBeUndefined();
    expect(JSON.stringify(denials)).not.toContain(key);
    expect(JSON.stringify(denials)).not.toContain(createHash("sha256").update(key).digest("hex"));
    expect(JSON.stringify(denials)).not.toContain("Bearer");
  } finally {
    warning.mockRestore();
  }
});
