// RBAC gate on /v1/skill-candidates/* — the permission checks on approve/reject.
//
// Both were missing. `app.use` with a non-wildcard path matches that path only,
// so registering `/v1/skill-candidates/:id` never covered `/:id/approve` and
// `/:id/reject`: they ran on authentication alone, and a credential that could
// only READ skills could promote a candidate into one. Passing
// `status: "active"` additionally activated the promoted Skill, routing around
// `skill:activate`, which `POST /v1/skills/{id}/activate` does enforce.
//
// Pinned here:
//   - approve and reject require `skill:write`
//   - approve with `status: "active"` additionally requires `skill:activate`
//   - the controls: reading is gated, and the dedicated activate route rejects
//     the same write-only credential — so a green suite cannot come from a
//     broken harness
//
// Credential scopes are the mechanism: they are a ceiling that narrows even an
// admin key (`rbac/evaluator.ts` step 0), so they isolate one permission
// without needing custom roles.

import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { apiKeys, skillCandidates, skills } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

/** Key holding only `skill:read` — may list and read candidates, nothing else. */
let readOnlyKey = "";
/** Key holding `skill:read` + `skill:write`, but NOT `skill:activate`. */
let writeKey = "";
/** Key holding neither — the control that proves the ceiling bites here. */
let unrelatedKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

async function mintKey(scopes: string[]): Promise<string> {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
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

/** A fresh `proposed` candidate. Approve is one-shot, so every test needs its own. */
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

    // A credential that may only READ skills must not be able to promote one.
    expect(res.status).toBe(403);

    // …and nothing may have been promoted.
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

describe("the escalation — approve with status:active vs. the skill:activate gate", () => {
  test("the dedicated activate route DOES require skill:activate", async () => {
    // Establishes the baseline the other test is measured against: a write
    // credential cannot activate a skill through the route built for it.
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

    // Refused: the same credential is rejected by the dedicated activate route
    // above, so it must be rejected here too.
    expect(res.status).toBe(403);

    // The candidate stays untouched — no half-applied promotion.
    const [after] = await srv.db.select().from(skillCandidates).where(eq(skillCandidates.id, id));
    expect(after?.status).toBe("proposed");
    expect(after?.promoted_skill_id).toBeNull();
  });
});
