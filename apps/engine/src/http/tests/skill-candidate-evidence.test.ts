// HTTP-layer coverage for `GET /v1/skill-candidates/{id}/evidence`.
//
// The route wraps the previously-unused `getSkillCandidateEvidence`
// (skill-candidates/service.ts). That service function returns `[]` both
// for "no evidence" AND for "candidate belongs to another tenant" — the
// route adds an existence check (`getSkillCandidate`) ahead of it so a
// foreign candidate answers 404, not an empty list that reads as "no
// evidence yet".
//
// Pinned here:
//   - N evidence rows come back in full, newest-first (captured_at DESC)
//   - zero evidence → { items: [] } + 200, not 404
//   - unknown id → 404
//   - a candidate belonging to another tenant → 404, not []
//   - evidence_count on the list row equals items.length from this route
//   - skill:read-denied credential → 403 (mirrors skill-candidates-rbac.test.ts)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  apiKeys,
  skillCandidateEvidence,
  skillCandidates,
  tenants,
} from "../../db/schema/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

interface EvidenceItem {
  id: string;
  skill_candidate_id: string;
  execution_id: string | null;
  patch_candidate_id: string | null;
  evidence_type: string;
  summary: string;
  captured_at: string;
}

interface EvidenceListBody {
  items: EvidenceItem[];
}

interface CandidateListBody {
  items: Array<{ id: string; evidence_count: number }>;
}

let srv: HttpTestServer;

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

function auth(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

async function seedCandidate(tenant_id: string, label: string): Promise<string> {
  const [row] = await srv.db
    .insert(skillCandidates)
    .values({
      tenant_id,
      scope: "global",
      pattern_kind: "success_pattern",
      title: `candidate ${label}`,
      body: `body ${label}`,
      evidence: { note: label },
      confidence: "high",
      status: "proposed",
      fingerprint: `fp-evidence-${label}`,
    })
    .returning();
  if (!row) throw new Error("seed candidate failed");
  return row.id;
}

let readOnlyKey = "";
let unrelatedKey = "";
let candidateWithEvidenceId = "";
let candidateNoEvidenceId = "";
let foreignCandidateId = "";

beforeAll(async () => {
  srv = await createHttpTestServer("skill-cand-evidence");
  readOnlyKey = await mintKey(["skill:read"]);
  unrelatedKey = await mintKey(["workflow:read"]);

  candidateWithEvidenceId = await seedCandidate(srv.tenantId, "with-evidence");
  candidateNoEvidenceId = await seedCandidate(srv.tenantId, "no-evidence");

  // Insert three evidence rows out of chronological order so a naive
  // insertion-order read would fail the "newest first" assertion.
  // A frozen instant, not the wall clock: the ordering assertion below is about
  // relative timestamps, and a test that reads the real clock is one that can
  // fail on a slow machine for reasons unrelated to what it measures.
  const base = FROZEN_NOW;
  await srv.db.insert(skillCandidateEvidence).values([
    {
      skill_candidate_id: candidateWithEvidenceId,
      evidence_type: "step_success",
      summary: "oldest evidence row",
      captured_at: new Date(base - 120_000),
    },
    {
      skill_candidate_id: candidateWithEvidenceId,
      evidence_type: "step_success",
      summary: "newest evidence row",
      captured_at: new Date(base),
    },
    {
      skill_candidate_id: candidateWithEvidenceId,
      evidence_type: "patch_applied",
      summary: "middle evidence row",
      captured_at: new Date(base - 60_000),
    },
  ]);

  // A second tenant row in the SAME database — proves the foreign-tenant
  // 404 path without spinning up a second server (mirrors
  // conversation-fork.test.ts).
  const [otherTenant] = await srv.db
    .insert(tenants)
    .values({ slug: "t-skill-cand-evidence-other", display_name: "other" })
    .returning();
  if (!otherTenant) throw new Error("seed other tenant failed");
  foreignCandidateId = await seedCandidate(otherTenant.id, "foreign");
});

afterAll(async () => {
  await srv.cleanup();
});

describe("GET /v1/skill-candidates/{id}/evidence", () => {
  test("a candidate with N evidence rows returns all N, newest first", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/skill-candidates/${candidateWithEvidenceId}/evidence`,
      { headers: auth(readOnlyKey) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EvidenceListBody;
    expect(body.items.length).toBe(3);
    expect(body.items.map((i) => i.summary)).toEqual([
      "newest evidence row",
      "middle evidence row",
      "oldest evidence row",
    ]);
    expect(body.items.every((i) => i.skill_candidate_id === candidateWithEvidenceId)).toBe(true);
    // Full row shape, not a projection that drops fields silently.
    const first = body.items[0];
    expect(first?.evidence_type).toBe("step_success");
    expect(typeof first?.captured_at).toBe("string");
  });

  test("a candidate with no evidence returns { items: [] } + 200, not 404", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/skill-candidates/${candidateNoEvidenceId}/evidence`,
      { headers: auth(readOnlyKey) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EvidenceListBody;
    expect(body.items).toEqual([]);
  });

  test("an unknown candidate id → 404", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/skill-candidates/00000000-0000-0000-0000-000000000000/evidence`,
      { headers: auth(readOnlyKey) },
    );
    expect(res.status).toBe(404);
  });

  test("a candidate belonging to ANOTHER tenant → 404, not an empty list", async () => {
    // The service (getSkillCandidateEvidence) returns [] for a foreign
    // candidate, which reads as "no evidence" — the route's existence
    // check ahead of it is what turns that into a 404 instead.
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates/${foreignCandidateId}/evidence`, {
      headers: auth(readOnlyKey),
    });
    expect(res.status).toBe(404);
  });

  test("evidence_count on the list row equals the number of rows this route returns", async () => {
    const listRes = await fetch(`${srv.baseUrl}/v1/skill-candidates?limit=200`, {
      headers: auth(readOnlyKey),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as CandidateListBody;
    const listItem = listBody.items.find((i) => i.id === candidateWithEvidenceId);
    expect(listItem).toBeDefined();

    const evidenceRes = await fetch(
      `${srv.baseUrl}/v1/skill-candidates/${candidateWithEvidenceId}/evidence`,
      { headers: auth(readOnlyKey) },
    );
    const evidenceBody = (await evidenceRes.json()) as EvidenceListBody;
    expect(listItem?.evidence_count).toBe(evidenceBody.items.length);
  });

  test("without skill:read → 403", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/skill-candidates/${candidateWithEvidenceId}/evidence`,
      { headers: auth(unrelatedKey) },
    );
    expect(res.status).toBe(403);
  });

  test("unauthenticated → 401", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/skill-candidates/${candidateWithEvidenceId}/evidence`,
    );
    expect(res.status).toBe(401);
  });
});
