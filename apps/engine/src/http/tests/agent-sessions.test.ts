// Integration tests for POST /v1/agent/sessions — the coding-agent
// session capture surface. The analyze job is stubbed via the scaffold's
// appOptions so no pg-boss (and no LLM) is needed; what's exercised is
// auth + RBAC + Zod validation + the enqueue payload + the audit entry.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import type { AgentSessionAnalyzeJob } from "../../queue/handlers/agent-session-analyze.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
const enqueued: AgentSessionAnalyzeJob[] = [];

const PATH = "/v1/agent/sessions";

async function post(body: unknown, key?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${PATH}`, {
    method: "POST",
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("agent-sessions", {
    appOptions: {
      agentSessionEnqueue: async (job) => {
        enqueued.push(job);
      },
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /v1/agent/sessions — auth + validation", () => {
  test("no bearer → 401", async () => {
    const res = await post({ agent: "claude-code", transcript: "hi" });
    expect(res.status).toBe(401);
  });

  test("missing transcript → 422", async () => {
    const res = await post({ agent: "claude-code" }, ctx.apiKey);
    expect([400, 422]).toContain(res.status);
    expect(enqueued).toHaveLength(0);
  });

  test("malformed domain slug → 422", async () => {
    const res = await post(
      { agent: "claude-code", transcript: "x", domains: ["Blog DE!"] },
      ctx.apiKey,
    );
    expect([400, 422]).toContain(res.status);
    expect(enqueued).toHaveLength(0);
  });
});

describe("POST /v1/agent/sessions — happy path", () => {
  test("202, enqueues the analyze job, writes the audit entry", async () => {
    const res = await post(
      {
        agent: "claude-code",
        session_id: "sess-1",
        repo: "/home/me/blog",
        domains: ["blog-de"],
        transcript: 'user: bitte merken — nie " - " als Gedankenstrich\nassistant: verstanden',
      },
      ctx.apiKey,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { queued: boolean; transcript_chars: number };
    expect(body.queued).toBe(true);
    expect(body.transcript_chars).toBeGreaterThan(0);

    expect(enqueued).toHaveLength(1);
    const job = enqueued[0];
    expect(job?.tenant_id).toBe(ctx.tenantId);
    expect(job?.agent).toBe("claude-code");
    expect(job?.session_id).toBe("sess-1");
    expect(job?.domains).toEqual(["blog-de"]);
    expect(job?.transcript).toContain("Gedankenstrich");

    // The route audits fire-and-forget (repo convention for enqueue
    // endpoints), so the entry can land AFTER the 202 — poll briefly
    // instead of racing the async write.
    const captured = await waitFor(
      async () => {
        const entries = await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.tenant_id, ctx.tenantId))
          .orderBy(desc(auditLog.ts))
          .limit(10);
        return entries.find((e) => e.action === "agent_session.captured");
      },
      { label: "agent_session.captured audit entry", sleepMs: 25 },
    );
    expect((captured.metadata as { agent?: string })?.agent).toBe("claude-code");
  });

  test("the candidate list accepts the session_learning filter (curation path)", async () => {
    // Regression: the list route once pinned a hand-copied pattern_kind
    // subset and 400'd `session_learning` — breaking `sk learnings list`.
    const res = await fetch(
      `${ctx.baseUrl}/v1/skill-candidates?status=proposed&pattern_kind=session_learning`,
      { headers: { authorization: `Bearer ${ctx.apiKey}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });
});
