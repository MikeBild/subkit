import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { llmUsage } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("ai");
});

afterAll(async () => {
  await srv.cleanup();
});

describe("http /v1/skills + /v1/ai/generate", () => {
  test("create skill then generate draft workflow and record usage", async () => {
    // 1. create a global skill
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

    // 2. run generate
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

    // 3. assert the llm_usage row was written, bound to this tenant.
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
