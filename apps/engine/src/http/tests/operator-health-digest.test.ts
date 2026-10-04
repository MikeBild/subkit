import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  apiKeys,
  executionSteps,
  executions,
  patchCandidates,
  users,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { reviewableDiff, seedPatchableWorkflow } from "../../test-helpers/patch-candidates.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function mintKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = "wf_live_neghttp_member_0001";
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("operator_digest");
  const [exec] = await srv.db
    .insert(executions)
    .values({
      tenant_id: srv.tenantId,
      status: "failed",
      source_kind: "saved",
      request_source: "scheduler",
      execution_mode: "dev",
    })
    .returning();
  await srv.db.insert(executionSteps).values({
    tenant_id: srv.tenantId,
    execution_id: exec!.id,
    step_key: "fetch",
    step_index: 0,
    kind: "request",
    status: "failed",
    error: { code: "http_4xx", message: "http 404", guidance: "The path is wrong." },
  });
  const wf = await seedPatchableWorkflow(srv.db, srv.tenantId, "sync", "Sync");
  await srv.db.insert(patchCandidates).values({
    tenant_id: srv.tenantId,
    workflow_id: wf.workflow_id,
    classification: "safe",
    status: "proposed",
    diff: reviewableDiff("Widen selector"),
  });
});

afterAll(async () => {
  await srv.cleanup();
});

describe("GET /v1/operator/health-digest", () => {
  test("401 unauthenticated", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/operator/health-digest`);
    expect(res.status).toBe(401);
  });

  test("200 with a grouped, origin-tagged digest", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/operator/health-digest`, {
      headers: { Authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      all_clear: boolean;
      failure_groups: Array<{ origin: string; error_code: string; guidance: string | null }>;
      headline: string;
      rendered: string;
    };
    expect(body.all_clear).toBe(false);
    const group = body.failure_groups.find((g) => g.error_code === "http_4xx");
    expect(group?.origin).toBe("scheduled");
    expect(group?.guidance).toBe("The path is wrong.");
    expect(body.headline).toBe("Needs attention: 1 item (1 to decide).");
    expect(body.rendered).toContain("[scheduled]");
  });

  test("patch items carry age_days and stuck through the HTTP body", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/operator/health-digest`, {
      headers: { Authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      patch_candidates: {
        open: number;
        items: Array<{ summary: string; age_days: number; stuck: boolean }>;
      };
    };
    expect(body.patch_candidates.open).toBe(1);
    const item = body.patch_candidates.items[0];
    expect(item?.summary).toBe("Widen selector");
    expect(typeof item?.age_days).toBe("number");
    expect(item?.age_days).toBeGreaterThanOrEqual(0);
    expect(typeof item?.stuck).toBe("boolean");
  });

  test("403 when the principal lacks stats:read (member role)", async () => {
    const [memberUser] = await srv.db
      .insert(users)
      .values({
        tenant_id: srv.tenantId,
        email: "member-digest@test.local",
        role_id: await builtinRoleId(srv.db, "member"),
      })
      .returning();
    if (!memberUser) throw new Error("seed member user failed");

    const memberKey = mintKey();
    await srv.db.insert(apiKeys).values({
      tenant_id: srv.tenantId,
      user_id: memberUser.id,
      prefix: memberKey.prefix,
      token_sha256: memberKey.hash,
      scopes: ["*"],
    });

    const res = await fetch(`${srv.baseUrl}/v1/operator/health-digest`, {
      headers: { Authorization: `Bearer ${memberKey.plaintext}` },
    });
    expect(res.status).toBe(403);
  });
});
