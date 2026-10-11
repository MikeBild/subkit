import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, roles, users, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { grantResource } from "../../rbac/grants.ts";
import { RunResponseSchema } from "../routes/executions/schemas.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let upstream: MockServer;
const hits: string[] = [];

beforeAll(async () => {
  ctx = await createHttpTestServer("execution-preview");
  upstream = await createMockServer((req, res) => {
    hits.push(req.url ?? "");
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await upstream.close();
  await ctx.cleanup();
});

async function post(body: Record<string, unknown>, authenticated = true) {
  return fetch(`${ctx.baseUrl}/v1/executions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("HTTP temporary execution previews", () => {
  test("an inline preview cannot borrow a saved workflow's resource grant", async () => {
    const [role] = await ctx.db
      .insert(roles)
      .values({ tenant_id: ctx.tenantId, name: "preview-none" })
      .returning();
    if (!role) throw new Error("role fixture missing");
    const [user] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "preview-scoped@test.local",
        role_id: role.id,
      })
      .returning();
    const [workflow] = await ctx.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenantId,
        slug: "scoped-preview",
        name: "Scoped fixture",
        lifecycle: "draft",
      })
      .returning();
    if (!user || !workflow) throw new Error("resource fixture missing");
    await grantResource(ctx.db, {
      tenant_id: ctx.tenantId,
      subject_type: "user",
      subject_id: user.id,
      resource_type: "workflow",
      resource_id: workflow.id,
      permission: "workflow:run",
    });
    const key = "wf_live_preview_scoped_fixture_only_000001";
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      prefix: key.slice(0, 12),
      token_sha256: createHash("sha256").update(key).digest("hex"),
      scopes: ["workflow:run"],
    });
    const step = {
      id: "shape",
      kind: "transform",
      language: "javascript",
      expression: "return 1;",
    };
    for (const source of ["draft", "step"] as const) {
      const response = await fetch(`${ctx.baseUrl}/v1/executions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          source,
          workflow_id: workflow.id,
          hold_writes: true,
          ...(source === "draft"
            ? { definition: { name: "Unrelated definition", steps: [step] } }
            : { step }),
        }),
      });
      expect(response.status).toBe(403);
    }
  });

  for (const source of ["draft", "step"] as const) {
    test(`${source} preview holds POST without touching the upstream`, async () => {
      const step = {
        id: "send",
        kind: "request",
        method: "POST",
        url: `${upstream.baseUrl}/${source}`,
        body: { message: "preview only" },
      };
      const response = await post({
        source,
        hold_writes: true,
        ...(source === "draft" ? { definition: { name: "Preview", steps: [step] } } : { step }),
      });
      expect(response.status).toBe(200);
      const result = RunResponseSchema.parse(await response.json());
      expect(result.status).toBe("succeeded");
      expect(result.steps?.find((entry) => entry.step_key === "send")?.held).toBe(true);
      expect(hits).not.toContain(`/${source}`);
    });
  }

  test("preview permits a read against the real upstream", async () => {
    const response = await post({
      source: "step",
      hold_writes: true,
      step: { id: "read", kind: "request", method: "GET", url: `${upstream.baseUrl}/read` },
    });
    expect(response.status).toBe(200);
    expect(RunResponseSchema.parse(await response.json()).status).toBe("succeeded");
    expect(hits.filter((path) => path === "/read")).toHaveLength(1);
  });

  test("a saved preview still rejects an unknown workflow", async () => {
    const response = await post({
      source: "saved",
      workflow_id: ctx.tenantId,
      hold_writes: true,
    });
    expect(response.status).toBe(404);
  });

  test("a saved workflow without authority is durably held, including explicit preview and rerun", async () => {
    const [workflow] = await ctx.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenantId,
        slug: "held-saved",
        name: "Held saved",
        lifecycle: "active",
      })
      .returning();
    if (!workflow) throw new Error("workflow fixture missing");
    const [version] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: workflow.id,
        version: 1,
        dag: {
          name: "Held saved",
          steps: [
            { id: "send", kind: "request", method: "POST", url: `${upstream.baseUrl}/saved-held` },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("version fixture missing");
    await ctx.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, workflow.id));
    for (const options of [{}, { hold_writes: true }]) {
      const response = await post({ source: "saved", workflow_id: workflow.id, ...options });
      expect(response.status).toBe(200);
      const result = RunResponseSchema.parse(await response.json());
      expect(result.steps?.find((step) => step.step_key === "send")?.held).toBe(true);
      const detail = await fetch(`${ctx.baseUrl}/v1/executions/${result.execution_id}`, {
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      });
      expect(await detail.json()).toMatchObject({
        hold_writes: true,
        execution_authority_id: null,
        workflow_version_id: version.id,
      });
      const rerun = await fetch(`${ctx.baseUrl}/v1/executions/${result.execution_id}/rerun`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ hold_writes: false }),
      });
      expect(rerun.status).toBe(200);
      const rerunResult = RunResponseSchema.parse(await rerun.json());
      expect(rerunResult.hold_writes).toBe(true);
      expect(rerunResult.steps?.find((step) => step.step_key === "send")?.held).toBe(true);
    }
    const live = await post({ source: "saved", workflow_id: workflow.id, hold_writes: false });
    expect(live.status).toBe(409);
    expect(hits).not.toContain("/saved-held");
  });

  test("omitting the preview flag on temporary definitions never enables writes", async () => {
    for (const source of ["step", "draft"] as const) {
      const step = {
        id: "send",
        kind: "request",
        method: "POST",
        url: `${upstream.baseUrl}/default-held`,
      };
      const response = await post({
        source,
        ...(source === "step" ? { step } : { definition: { name: "Default held", steps: [step] } }),
      });
      expect(response.status).toBe(200);
      expect(
        RunResponseSchema.parse(await response.json()).steps?.find(
          (entry) => entry.step_key === "send",
        )?.held,
      ).toBe(true);
    }
    expect(hits).not.toContain("/default-held");
  });

  test("preview cannot bypass authentication", async () => {
    const response = await post(
      {
        source: "step",
        hold_writes: true,
        step: { id: "send", kind: "request", method: "POST", url: `${upstream.baseUrl}/denied` },
      },
      false,
    );
    expect(response.status).toBe(401);
    expect(hits).not.toContain("/denied");
  });
});
