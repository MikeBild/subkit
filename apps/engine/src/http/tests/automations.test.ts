import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("automations");
});

afterAll(async () => {
  await ctx?.cleanup();
});

function authHeaders(): HeadersInit {
  return {
    authorization: `Bearer ${ctx.apiKey}`,
    "content-type": "application/json",
  };
}

describe("automations routes", () => {
  test("create, preview, diff, apply, and run an automation", async () => {
    const initialDefinition = {
      name: "Direct Automation",
      slug: "direct-automation",
      steps: [{ id: "wait-1", kind: "wait", duration_ms: 1 }],
    };

    const createRes = await fetch(`${ctx.baseUrl}/v1/automations`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(initialDefinition),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      slug: string;
      current_version: number;
      definition: { name: string; steps: Array<{ id: string }> };
    };
    expect(created.slug).toBe("direct-automation");
    expect(created.current_version).toBe(1);
    expect(created.definition.name).toBe("Direct Automation");

    const listRes = await fetch(`${ctx.baseUrl}/v1/automations`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(listBody.items.some((item) => item.id === created.id)).toBe(true);

    const previewRes = await fetch(`${ctx.baseUrl}/v1/automations/preview`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ definition: initialDefinition, input: null, request_source: "cli" }),
    });
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      execution: { status: string; steps: Array<{ status: string }> };
    };
    expect(preview.execution.status).toBe("succeeded");
    expect(preview.execution.steps[0]?.status).toBe("succeeded");

    const updatedDefinition = {
      ...initialDefinition,
      steps: [
        { id: "wait-1", kind: "wait", duration_ms: 2 },
        { id: "wait-2", kind: "wait", duration_ms: 1 },
      ],
    };

    const diffRes = await fetch(`${ctx.baseUrl}/v1/automations/${created.id}/changes/preview`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ definition: updatedDefinition, input: null, request_source: "cli" }),
    });
    expect(diffRes.status).toBe(200);
    const diff = (await diffRes.json()) as {
      changed: boolean;
      operations: Array<{ op: string; path: string }>;
      execution: { status: string };
    };
    expect(diff.changed).toBe(true);
    expect(diff.operations.length).toBeGreaterThan(0);
    expect(diff.execution.status).toBe("succeeded");

    const applyAndRunRes = await fetch(
      `${ctx.baseUrl}/v1/automations/${created.id}/changes/apply-and-run`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          definition: updatedDefinition,
          input: null,
          request_source: "cli",
        }),
      },
    );
    expect(applyAndRunRes.status).toBe(200);
    const applied = (await applyAndRunRes.json()) as {
      changed: boolean;
      automation: { current_version: number; definition: { steps: Array<{ id: string }> } };
      execution: { status: string; steps: Array<{ status: string }> };
    };
    expect(applied.changed).toBe(true);
    expect(applied.automation.current_version).toBe(2);
    expect(applied.automation.definition.steps).toHaveLength(2);
    expect(applied.execution.status).toBe("succeeded");
    expect(applied.execution.steps).toHaveLength(2);

    const runRes = await fetch(`${ctx.baseUrl}/v1/automations/${created.id}/run`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ input: null, request_source: "cli" }),
    });
    expect(runRes.status).toBe(200);
    const run = (await runRes.json()) as {
      status: string;
      steps: Array<{ status: string }>;
    };
    expect(run.status).toBe("succeeded");
    expect(run.steps).toHaveLength(2);

    const getRes = await fetch(`${ctx.baseUrl}/v1/automations/${created.id}`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as {
      current_version: number;
      definition: { steps: Array<{ id: string }> };
    };
    expect(fetched.current_version).toBe(2);
    expect(fetched.definition.steps).toHaveLength(2);
  });
});
