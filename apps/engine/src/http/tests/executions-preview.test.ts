import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, roles, users, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { grantResource } from "../../rbac/grants.ts";
import { waitForJson } from "../../test-helpers/determinism/wait.ts";
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

function get(path: string) {
  return fetch(`${ctx.baseUrl}${path}`, { headers: { authorization: `Bearer ${ctx.apiKey}` } });
}

async function started(response: Response): Promise<string> {
  expect(response.status).toBe(202);
  const body = RunResponseSchema.parse(await response.json());
  expect(body.status).toBe("running");
  expect(body.output).toBeUndefined();
  return body.execution_id;
}

function finished(execution_id: string) {
  return waitForJson<{ status: string }>(
    () => get(`/v1/executions/${execution_id}`),
    (body) => !["queued", "running"].includes(body.status),
    { label: "single-step run finished" },
  );
}

async function stepRows(execution_id: string) {
  const response = await get(`/v1/executions/${execution_id}/steps`);
  const body = (await response.json()) as {
    items: Array<{ step_key: string; held: boolean; output_preview?: unknown }>;
  };
  return body.items;
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

  test("draft preview holds POST without touching the upstream", async () => {
    const step = {
      id: "send",
      kind: "request",
      method: "POST",
      url: `${upstream.baseUrl}/draft`,
      body: { message: "preview only" },
    };
    const response = await post({
      source: "draft",
      hold_writes: true,
      definition: { name: "Preview", steps: [step] },
    });
    expect(response.status).toBe(200);
    const result = RunResponseSchema.parse(await response.json());
    expect(result.status).toBe("succeeded");
    expect(result.steps?.find((entry) => entry.step_key === "send")?.held).toBe(true);
    expect(hits).not.toContain("/draft");
  });

  test("step preview holds POST without touching the upstream", async () => {
    const execution_id = await started(
      await post({
        source: "step",
        hold_writes: true,
        step: {
          id: "send",
          kind: "request",
          method: "POST",
          url: `${upstream.baseUrl}/step`,
          body: { message: "preview only" },
        },
      }),
    );
    expect((await finished(execution_id)).status).toBe("succeeded");
    expect((await stepRows(execution_id)).find((entry) => entry.step_key === "send")?.held).toBe(
      true,
    );
    expect(hits).not.toContain("/step");
  });

  test("a single step answers before it has finished and can be stopped", async () => {
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      upstream.setHandler((req, res) => {
        hits.push(req.url ?? "");
        if (req.url !== "/slow") return jsonResponse(res, 200, { ok: true });
        resolve();
        return new Promise<void>((done) => {
          release = () => {
            jsonResponse(res, 200, { ok: true });
            done();
          };
        });
      });
    });
    const execution_id = await started(
      await post({
        source: "step",
        hold_writes: true,
        step: { id: "read", kind: "request", method: "GET", url: `${upstream.baseUrl}/slow` },
      }),
    );
    await reached;
    const running = (await (await get(`/v1/executions/${execution_id}`)).json()) as {
      status: string;
    };
    expect(running.status).toBe("running");
    const cancel = await fetch(`${ctx.baseUrl}/v1/executions/${execution_id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(cancel.status).toBe(202);
    expect((await finished(execution_id)).status).toBe("aborted");
    release();
  });

  test("a single step sees the scope it was given and keeps to its time limit", async () => {
    const withScope = await started(
      await post({
        source: "step",
        hold_writes: true,
        scope: { earlier: { data: { n: 41 } } },
        step: {
          id: "next",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.earlier.data.n + 1;",
        },
      }),
    );
    expect((await finished(withScope)).status).toBe("succeeded");
    expect((await stepRows(withScope))[0]?.output_preview).toBe(42);

    let release: () => void = () => undefined;
    upstream.setHandler((req, res) => {
      hits.push(req.url ?? "");
      if (req.url !== "/late") return jsonResponse(res, 200, { ok: true });
      return new Promise<void>((done) => {
        release = () => {
          jsonResponse(res, 200, { ok: true });
          done();
        };
      });
    });
    const limited = await started(
      await post({
        source: "step",
        hold_writes: true,
        timeout_ms: 200,
        step: { id: "read", kind: "request", method: "GET", url: `${upstream.baseUrl}/late` },
      }),
    );
    expect(["timed_out", "aborted"]).toContain((await finished(limited)).status);
    release();
  });

  test("preview permits a read against the real upstream", async () => {
    const execution_id = await started(
      await post({
        source: "step",
        hold_writes: true,
        step: { id: "read", kind: "request", method: "GET", url: `${upstream.baseUrl}/read` },
      }),
    );
    expect((await finished(execution_id)).status).toBe("succeeded");
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
      if (source === "step") {
        const execution_id = await started(response);
        expect((await finished(execution_id)).status).toBe("succeeded");
        expect(
          (await stepRows(execution_id)).find((entry) => entry.step_key === "send")?.held,
        ).toBe(true);
        continue;
      }
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
