// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal runtime placeholder is the workflow contract.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await createHttpTestServer("automation-readiness");
});

afterAll(async () => {
  await server.cleanup();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${server.apiKey}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

interface Readiness {
  state: string;
  environment: string;
  issues: Array<{ step_id: string; code: string }>;
  repair_guidance: Array<{ step_id: string; code: string; instruction: string }>;
}

async function createWorkflow(slug: string, body: Record<string, unknown>) {
  const response = await api("/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: slug,
      slug,
      steps: [
        { id: "send", kind: "request", method: "POST", url: "https://example.test/messages", body },
      ],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; automation_readiness?: Readiness };
}

test("saving a workflow whose request depends on data reports that no approval can unblock it", async () => {
  const created = await createWorkflow("readiness-dynamic", { recipient: "${input.to}" });
  expect(created.automation_readiness?.state).toBe("repair_required");
  expect(created.automation_readiness?.issues).toContainEqual({
    step_id: "send",
    code: "dynamic_request",
  });

  const scheduled = await api("/v1/schedules", {
    method: "POST",
    body: JSON.stringify({
      workflow_id: created.id,
      cron: "0 9 * * *",
      execution_mode: "prod",
      input: { to: "someone@example.test" },
    }),
  });
  expect(scheduled.status).toBe(201);
  const schedule = (await scheduled.json()) as { id: string; automation_readiness?: Readiness };
  expect(schedule.automation_readiness?.state).toBe("repair_required");
  expect(schedule.automation_readiness?.environment).toBe("prod");

  const paused = await api(`/v1/schedules/${schedule.id}`, {
    method: "PUT",
    body: JSON.stringify({ paused: true }),
  });
  expect(paused.status).toBe(200);
  expect(((await paused.json()) as { automation_readiness?: Readiness }).automation_readiness).toBe(
    undefined,
  );
});

test("a fixed request reports that recurring runs can be approved", async () => {
  const created = await createWorkflow("readiness-fixed", { recipient: "reviewed@example.test" });
  expect(created.automation_readiness?.state).toBe("eligible");
  expect(created.automation_readiness?.issues).toEqual([]);
});
