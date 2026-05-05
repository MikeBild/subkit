// User story: As a platform operator I want my before-request hooks to
// express policy with the sk-Stdlib surface (sk.http.isMutating,
// sk.deny, sk.allow) instead of inline comparisons, so the policy code
// is uniform and the LLM-authoring layer can reliably propose it.
// Acceptance criteria:
//   - AC1: A hook that uses sk.* can be created via REST and is
//          accepted by the hook lint pass.
//   - AC2: A workflow whose step would POST is denied by the sk-based
//          hook and the execution surfaces `policy.denied`.
//   - AC3: A GET-only workflow still succeeds while the sk-based hook
//          is enabled — parity with the inline-hook baseline in
//          journey 12.
// Spec refs: docs/04-authoring.md (sk-Stdlib im Sandbox),
// docs/07-security-governance.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { requestHooks, workflows, workflowVersions } from "../../db/schema/index.ts";
import { STDLIB_VERSION } from "../../sandboxes/quickjs/stdlib/index.ts";
import { scanStdlibDrift } from "../../self-healing/stdlib-drift-scan.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let mock: Server;
let mockBase = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("stdlib-hook");

  mock = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, 60_000);

describe("journey: sk-stdlib before-request hook", () => {
  test("AC1: admin creates an sk-based deny-mutating hook", async () => {
    const hookCode = `
      return sk.http.isMutating(sk.get(input, 'request.method', ''))
        ? sk.deny('mutating_denied')
        : sk.allow();
    `;
    const res = await journeyFetch(ctx, "/v1/auth/request-hooks", {
      method: "POST",
      body: JSON.stringify({
        role: "admin",
        code: hookCode,
        description: "sk-stdlib deny mutating",
        enabled: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; enabled: boolean };
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.enabled).toBe(true);
  });

  test("AC2: an sk-based hook blocks a POST workflow", async () => {
    // Workflow that would POST the mock.
    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "sk-blocked-post",
        slug: "sk-blocked-post",
        steps: [
          {
            kind: "request",
            id: "post",
            method: "POST",
            url: `${mockBase}/widgets`,
            body: { hello: "world" },
          },
        ],
      }),
    });
    expect(wfRes.status).toBe(201);
    const wfBody = (await wfRes.json()) as { id: string };

    const run = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wfBody.id, input: {} }),
    });
    expect(run.status).toBe(200);
    const rb = (await run.json()) as {
      status: string;
      steps: Array<{ error: { code?: string } | null }>;
    };
    expect(rb.status).toBe("failed");
    const denied = rb.steps.find((s) => s.error && (s.error as { code?: string }).code);
    expect(denied).toBeDefined();
    expect((denied?.error as { code: string }).code).toBe("policy.denied");
  });

  test("AC3: the created hook persists STDLIB_VERSION for drift detection", async () => {
    const rows = await ctx.db
      .select()
      .from(requestHooks)
      .where(and(eq(requestHooks.tenant_id, ctx.tenantId), eq(requestHooks.role, "admin")));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.stdlib_version).toBe(STDLIB_VERSION);
    }
  });

  test("AC4: a JS-transform workflow persists runtime.stdlib_version on its DAG", async () => {
    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "sk-transform",
        slug: "sk-transform",
        steps: [
          {
            kind: "transform",
            id: "t",
            expression: "return sk.pick(input, ['a']);",
            language: "javascript",
          },
        ],
      }),
    });
    expect(wfRes.status).toBe(201);
    const wfBody = (await wfRes.json()) as { id: string };
    const [wf] = await ctx.db
      .select({ current_version_id: workflows.current_version_id })
      .from(workflows)
      .where(eq(workflows.id, wfBody.id));
    expect(wf?.current_version_id).toBeDefined();
    const [v] = await ctx.db
      .select({ dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, wf!.current_version_id!));
    const dag = v?.dag as { runtime?: { stdlib_version?: string } };
    expect(dag.runtime?.stdlib_version).toBe(STDLIB_VERSION);
  });

  test("AC5: current-version workflows and hooks produce zero drift signals", async () => {
    const signals = await scanStdlibDrift(ctx.tenantId, ctx.db);
    expect(signals).toEqual([]);
  });

  test("AC6: a GET-only workflow succeeds under the same sk-based hook", async () => {
    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "sk-allowed-get",
        slug: "sk-allowed-get",
        steps: [
          {
            kind: "request",
            id: "get",
            method: "GET",
            url: `${mockBase}/widgets`,
          },
        ],
      }),
    });
    const wfId = ((await wfRes.json()) as { id: string }).id;
    const run = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wfId, input: {} }),
    });
    const rb = (await run.json()) as { status: string };
    expect(rb.status).toBe("succeeded");
  });
});
