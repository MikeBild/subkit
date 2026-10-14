import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, llmUsage } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
const nextKeyHex = createDeterministicHexFactory(0x51a11);
let systemAccountKey = "";

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("ai");
  systemAccountKey = `wf_live_${nextKeyHex(24)}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: srv.systemAccountId,
    prefix: systemAccountKey.slice(0, 12),
    token_sha256: createHash("sha256").update(systemAccountKey).digest("hex"),
    scopes: ["*"],
  });
});

afterAll(async () => {
  await srv.cleanup();
});

describe("http /v1/skills + /v1/ai/generate", () => {
  test("skill creation audit preserves the authenticated system-account principal", async () => {
    const response = await fetch(`${srv.baseUrl}/v1/skills`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${systemAccountKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope: "global", title: "system-skill", body: "test" }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const [entry] = await srv.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "skill.created"),
          eq(auditLog.resource_id, created.id),
        ),
      );
    expect(entry).toEqual({ actor_type: "system_account", actor_id: srv.systemAccountId });
  });

  test("create skill then generate draft workflow and record usage", async () => {
    const skillRes = await fetch(`${srv.baseUrl}/v1/skills`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: "global",
        title: "prefer-list-endpoints",
        body: "Prefer listing endpoints over single-item fetches when possible.",
      }),
    });
    expect(skillRes.status).toBe(201);
    const skill = (await skillRes.json()) as { id: string; scope: string };
    expect(skill.id).toBeTruthy();
    expect(skill.scope).toBe("global");

    const genRes = await fetch(`${srv.baseUrl}/v1/ai/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "list the first two users from the api",
      }),
    });
    expect(genRes.status).toBe(200);
    const body = (await genRes.json()) as {
      draft_workflow: { steps?: Array<{ kind?: string }> };
      included_skills: string[];
      tokens: Record<string, number>;
      model_used: string;
    };
    expect(body.draft_workflow).toBeTruthy();
    expect(Array.isArray(body.draft_workflow.steps)).toBe(true);
    expect(body.draft_workflow.steps?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(body.included_skills.length).toBeGreaterThanOrEqual(1);
    expect(body.tokens.total).toBeGreaterThan(0);
    expect(body.model_used).toBeTruthy();

    const rows = await srv.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, srv.tenantId), eq(llmUsage.result, "success")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.model).toBeTruthy();
    expect(rows[0]?.total_tokens ?? 0).toBeGreaterThan(0);
  });

  test("summarize returns a compact summary and records usage", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/ai/summarize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt:
          "Summarize this incident: the connector probe passed, preview matched the expected output, and the workflow was committed after approval.",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: string;
      tokens: Record<string, number>;
      model_used: string;
      fell_back: boolean;
    };
    expect(body.summary).toContain("Summary:");
    expect(body.tokens.total).toBeGreaterThan(0);
    expect(body.model_used).toBeTruthy();
    expect(typeof body.fell_back).toBe("boolean");

    const rows = await srv.db
      .select()
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.tenant_id, srv.tenantId),
          eq(llmUsage.result, "success"),
          eq(llmUsage.flow, "summarize"),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
