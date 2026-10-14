import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import {
  apiKeys,
  auditLog,
  skillCandidates,
  skills,
  systemAccounts,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const nextHex = createDeterministicHexFactory(0x5c1bac);

let srv: HttpTestServer;

let readOnlyKey = "";
let writeKey = "";
let unrelatedKey = "";
let systemWriteKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

async function mintKey(scopes: string[]): Promise<string> {
  const rand = Buffer.from(nextHex(24), "hex").toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: srv.userId,
    prefix: plaintext.slice(0, 12),
    token_sha256: sha256Hex(plaintext),
    scopes,
  });
  return plaintext;
}

async function seedCandidate(label: string): Promise<string> {
  const [row] = await srv.db
    .insert(skillCandidates)
    .values({
      tenant_id: srv.tenantId,
      scope: "global",
      pattern_kind: "success_pattern",
      title: `candidate ${label}`,
      body: `body ${label}`,
      evidence: { note: label },
      confidence: "high",
      status: "proposed",
      fingerprint: `fp-${label}`,
    })
    .returning();
  if (!row) throw new Error("seed candidate failed");
  return row.id;
}

function auth(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

beforeAll(async () => {
  srv = await createHttpTestServer("skill-cand-rbac");
  readOnlyKey = await mintKey(["skill:read"]);
  writeKey = await mintKey(["skill:read", "skill:write"]);
  unrelatedKey = await mintKey(["workflow:read"]);
  await srv.db
    .update(systemAccounts)
    .set({ role_id: await builtinRoleId(srv.db, "admin") })
    .where(eq(systemAccounts.id, srv.systemAccountId));
  const systemPlaintext = `wf_live_${Buffer.from(nextHex(24), "hex").toString("base64url").slice(0, 32)}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: srv.systemAccountId,
    prefix: systemPlaintext.slice(0, 12),
    token_sha256: sha256Hex(systemPlaintext),
    scopes: ["skill:read", "skill:write"],
  });
  systemWriteKey = systemPlaintext;
});

afterAll(async () => {
  await srv.cleanup();
});

describe("control — the credential ceiling does gate this router", () => {
  test("GET /v1/skill-candidates with skill:read → 200", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates`, { headers: auth(readOnlyKey) });
    expect(res.status).toBe(200);
  });

  test("GET /v1/skill-candidates without skill:read → 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates`, { headers: auth(unrelatedKey) });
    expect(res.status).toBe(403);
  });

  test("unauthenticated → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates`);
    expect(res.status).toBe(401);
  });
});

describe("the finding — approve/reject on a read-only credential", () => {
  test("POST /v1/skill-candidates/{id}/approve without skill:write must be denied", async () => {
    const id = await seedCandidate("approve-readonly");
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates/${id}/approve`, {
      method: "POST",
      headers: { ...auth(readOnlyKey), "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(403);

    const [after] = await srv.db.select().from(skillCandidates).where(eq(skillCandidates.id, id));
    expect(after?.status).toBe("proposed");
    expect(after?.promoted_skill_id).toBeNull();
  });

  test("POST /v1/skill-candidates/{id}/reject without skill:write must be denied", async () => {
    const id = await seedCandidate("reject-readonly");
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates/${id}/reject`, {
      method: "POST",
      headers: { ...auth(readOnlyKey), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);

    const [after] = await srv.db.select().from(skillCandidates).where(eq(skillCandidates.id, id));
    expect(after?.status).toBe("proposed");
  });
});

describe("system-account rejection attribution", () => {
  test("reject audit keeps the system-account actor pair", async () => {
    const id = await seedCandidate("system-account-reject");
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates/${id}/reject`, {
      method: "POST",
      headers: { ...auth(systemWriteKey), "content-type": "application/json" },
      body: JSON.stringify({ reason: "machine review" }),
    });
    expect(res.status).toBe(200);
    const [entry] = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.resource_id, id),
          eq(auditLog.action, AuditAction.SKILL_CANDIDATE_REJECTED),
        ),
      );
    expect([entry?.actor_type, entry?.actor_id]).toEqual(["system_account", srv.systemAccountId]);
  });
});

describe("the escalation — approve with status:active vs. the skill:activate gate", () => {
  test("the dedicated activate route DOES require skill:activate", async () => {
    const [skill] = await srv.db
      .insert(skills)
      .values({
        tenant_id: srv.tenantId,
        scope: "global",
        title: "activate-gate-probe",
        body: "probe",
        lifecycle: "draft",
      })
      .returning();
    if (!skill) throw new Error("seed skill failed");

    const res = await fetch(`${srv.baseUrl}/v1/skills/${skill.id}/activate`, {
      method: "POST",
      headers: { ...auth(writeKey), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  test("approve with status:active must not mint an ACTIVE skill without skill:activate", async () => {
    const id = await seedCandidate("approve-active-escalation");
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates/${id}/approve`, {
      method: "POST",
      headers: { ...auth(writeKey), "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });

    expect(res.status).toBe(403);

    const [after] = await srv.db.select().from(skillCandidates).where(eq(skillCandidates.id, id));
    expect(after?.status).toBe("proposed");
    expect(after?.promoted_skill_id).toBeNull();
  });
});
