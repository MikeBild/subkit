import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, skillCandidates } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

interface CandidateListBody {
  items: Array<{ id: string; status: string; workflow_id: string | null; reviewable?: boolean }>;
  total: number;
  reviewable_total: number;
}

const WORKFLOW_ID = "00000000-0000-4000-8000-0000000000c1";
const OTHER_WORKFLOW_ID = "00000000-0000-4000-8000-0000000000c2";

let srv: HttpTestServer;
let readKey = "";
let writeKey = "";
let contextId = "";
let proposalId = "";

async function mintKey(scopes: string[]): Promise<string> {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
  const plaintext = `wf_live_${rand}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: srv.userId,
    prefix: plaintext.slice(0, 12),
    token_sha256: createHash("sha256").update(plaintext).digest("hex"),
    scopes,
  });
  return plaintext;
}

async function seed(
  label: string,
  values: Partial<typeof skillCandidates.$inferInsert>,
): Promise<string> {
  const [row] = await srv.db
    .insert(skillCandidates)
    .values({
      tenant_id: srv.tenantId,
      scope: "workflow",
      workflow_id: WORKFLOW_ID,
      pattern_kind: "authoring_capability",
      title: `note ${label}`,
      body: `body ${label}`,
      evidence: {},
      confidence: "high",
      status: "context",
      fingerprint: `fp-context-route-${label}`,
      ...values,
    })
    .returning();
  if (!row) throw new Error("seed candidate failed");
  return row.id;
}

beforeAll(async () => {
  srv = await createHttpTestServer("skill-cand-context");
  readKey = await mintKey(["skill:read"]);
  writeKey = await mintKey(["skill:read", "skill:write"]);
  contextId = await seed("here", {});
  await seed("elsewhere", { workflow_id: OTHER_WORKFLOW_ID });
  proposalId = await seed("proposal", { pattern_kind: "success_pattern", status: "proposed" });
});

afterAll(async () => {
  await srv?.cleanup();
});

describe("drafting context notes over HTTP", () => {
  test("status=context&workflow_id lists only that workflow's notes", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/skill-candidates?status=context&workflow_id=${WORKFLOW_ID}`,
      { headers: { authorization: `Bearer ${readKey}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CandidateListBody;
    expect(body.items.map((item) => item.id)).toEqual([contextId]);
    expect(body.items[0]).toMatchObject({ status: "context", reviewable: false });
    expect(body.total).toBe(1);
    expect(body.reviewable_total).toBe(0);
  });

  test("status=proposed counts only real proposals", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates?status=proposed`, {
      headers: { authorization: `Bearer ${readKey}` },
    });
    const body = (await res.json()) as CandidateListBody;
    expect(body.items.map((item) => item.id)).toEqual([proposalId]);
    expect(body.reviewable_total).toBe(1);
  });

  test("the reviewable query parameter is gone", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/skill-candidates?reviewable=true`, {
      headers: { authorization: `Bearer ${readKey}` },
    });
    const body = (await res.json()) as CandidateListBody;
    expect(body.total).toBe(3);
  });

  test("approving or rejecting a context note answers 404", async () => {
    for (const action of ["approve", "reject"]) {
      const res = await fetch(`${srv.baseUrl}/v1/skill-candidates/${contextId}/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${writeKey}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(404);
    }
  });
});
