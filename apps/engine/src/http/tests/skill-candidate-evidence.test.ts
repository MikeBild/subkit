import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, skillCandidateEvidence, skillCandidates } from "../../db/schema/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
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

  const otherTenant = await seedTenant(srv.db, {
    slug: "t-skill-cand-evidence-other",
    display_name: "other",
  });
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
