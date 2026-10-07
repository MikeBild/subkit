import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../execution/engine.ts";
import { createEngineCtx, type EngineTestCtx } from "../execution/tests/setup.ts";
import { withDriverFetchForTests } from "../test-helpers/driver-fetch.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import { bindRecipe, listTemplateConnectors } from "./recipe-binding.ts";
import { createConnector } from "./service.ts";
import { getSolutionRecipe } from "./solutions.ts";
import { loadBuiltinTemplates } from "./templates.ts";

const skip = process.env.REQUIRES_PG === "0";

interface Call {
  method: string;
  url: URL;
  body: string;
}

type Reply = (call: Call) => unknown;

let ctx: EngineTestCtx;

const ADDRESSES: Record<string, string> = {
  http: "https://access.example.com",
};

beforeAll(async () => {
  if (skip) return;
  ctx = await createEngineCtx("solutions-preview");
  const templates = loadBuiltinTemplates();
  for (const slug of ["google-gmail", "google-drive", "google-analytics", "stripe", "slack"]) {
    const template = templates.find((t) => t.slug === slug);
    if (!template) throw new Error(`template ${slug} missing`);
    await createConnector(
      {
        tenant_id: ctx.tenantId,
        input: {
          name: template.name,
          slug,
          driver: "http",
          environment: "dev",
          auth_type: "none",
          template_slug: slug,
        },
        actor_id: null,
      },
      ctx.testDb.db,
    );
  }
  await createConnector(
    {
      tenant_id: ctx.tenantId,
      input: {
        name: "Own API",
        slug: "own-api",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: ADDRESSES.http,
        template_slug: "http",
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );
}, 60_000);

afterAll(async () => {
  if (!skip) await ctx?.cleanup();
}, 30_000);

async function preview(slug: string, reply: Reply): Promise<{ output: unknown; calls: Call[] }> {
  const recipe = getSolutionRecipe(slug);
  if (!recipe) throw new Error(`solution ${slug} missing`);
  const needed = recipe.required_connectors.map((r) => r.template);
  const available = await listTemplateConnectors(ctx.tenantId, needed, ctx.testDb.db);
  const bound = bindRecipe(recipe, available, new Map());
  expect(bound.connectors.every((c) => c.connector_id !== null)).toBe(true);
  const calls: Call[] = [];
  const fake = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const raw = init?.body ?? (request ? await request.text() : "");
    const call = { method, url, body: typeof raw === "string" ? raw : String(raw ?? "") };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const result = await withDriverFetchForTests(fake, () =>
    runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "draft", definition: bound.workflow as WorkflowDef },
      input: recipe.sample_input,
    }),
  );
  expect({ status: result.status, error: result.error }).toEqual({
    status: "succeeded",
    error: null,
  });
  expect(result.output).toEqual(recipe.expected_output_preview);
  return { output: result.output, calls };
}

const gmailMessage = {
  id: "m1",
  internalDate: "1790755200000",
  payload: {
    headers: [{ name: "From", value: "Billing <billing@example.com>" }],
    parts: [
      { filename: "", mimeType: "text/plain", body: { size: 10 } },
      {
        filename: "invoice-1042.pdf",
        mimeType: "application/pdf",
        body: { attachmentId: "att1", size: 9 },
      },
    ],
  },
};

const sent = (id: string) => ({ id, threadId: "thread-1", labelIds: ["SENT"] });

describe.skipIf(skip)("solution recipes preview against their expected output", () => {
  test("invoice attachments land in the Drive folder under a date and sender name", async () => {
    const { calls } = await preview("invoice-attachments-to-drive", ({ method, url }) => {
      if (url.pathname.endsWith("/users/me/messages")) return { messages: [{ id: "m1" }] };
      if (url.pathname.endsWith("/users/me/messages/m1")) return gmailMessage;
      if (url.pathname.endsWith("/attachments/att1")) return { size: 9, data: "JVBERi0xLjQK" };
      if (method === "POST" && url.pathname === "/upload/drive/v3/files") {
        return { id: "file-1", name: "2026-09-30_example.com_invoice-1042.pdf" };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const upload = calls.find((c) => c.url.pathname === "/upload/drive/v3/files");
    expect(upload?.url.hostname).toBe("www.googleapis.com");
    expect(upload?.body).toContain('"parents":["folder-accounting-inbox"]');
    expect(upload?.body).toContain("JVBERi0xLjQK");
  });

  test("the daily analytics report reads two reports and mails one summary", async () => {
    const { calls } = await preview("daily-analytics-report", ({ method, url, body }) => {
      if (url.pathname === "/v1beta/properties/123456789:runReport") {
        if (body.includes("pagePath")) {
          return {
            dimensionHeaders: [{ name: "pagePath" }],
            metricHeaders: [{ name: "screenPageViews" }],
            rows: [
              { dimensionValues: [{ value: "/pricing" }], metricValues: [{ value: "61" }] },
              { dimensionValues: [{ value: "/" }], metricValues: [{ value: "40" }] },
            ],
          };
        }
        return {
          metricHeaders: [
            { name: "activeUsers" },
            { name: "sessions" },
            { name: "screenPageViews" },
          ],
          rows: [{ metricValues: [{ value: "42" }, { value: "57" }, { value: "133" }] }],
        };
      }
      if (method === "POST" && url.pathname.endsWith("/users/me/messages/send")) {
        return sent("msg-0002");
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const mail = calls.find((c) => c.url.pathname.endsWith("/messages/send"));
    expect(JSON.parse(mail?.body ?? "{}").raw).toEqual(expect.any(String));
  });

  test("a paid checkout grants access and welcomes the buyer", async () => {
    const { calls } = await preview("payment-grants-access", ({ method, url }) => {
      if (url.pathname === "/v1/checkout/sessions/cs_example_0001") {
        return { id: "cs_example_0001", payment_status: "paid" };
      }
      if (method === "POST" && url.pathname === "/access/grants") return { granted: true };
      if (method === "POST" && url.pathname.endsWith("/users/me/messages/send")) {
        return sent("msg-0003");
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const grant = calls.find((c) => c.url.pathname === "/access/grants");
    expect(grant?.url.hostname).toBe("access.example.com");
    expect(JSON.parse(grant?.body ?? "{}")).toEqual({
      email: "buyer@example.com",
      group: "members",
      reference: "cs_example_0001",
    });
  });

  test("an important event becomes one Slack message in the configured channel", async () => {
    const { calls } = await preview("webhook-to-slack", ({ method, url }) => {
      if (method === "POST" && url.pathname === "/api/chat.postMessage") {
        return { ok: true, ts: "1790755200.000100" };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      channel: "#alerts",
      text: "[ERROR] Payment provider unreachable — 3 retries failed for order 1042",
    });
  });

  test("the weekly digest counts runs and failures of the last seven days", async () => {
    const { calls } = await preview("weekly-run-digest", ({ method, url }) => {
      if (url.pathname === "/v1/stats/executions") {
        return {
          totals: {
            executions: { count: 120, by_status: { succeeded: 117, failed: 2, timed_out: 1 } },
          },
        };
      }
      if (url.pathname === "/v1/executions") {
        return {
          items: [{ workflow_name: "nightly-sync", error_code: "upstream_timeout" }],
        };
      }
      if (method === "POST" && url.pathname.endsWith("/users/me/messages/send")) {
        return sent("msg-0005");
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const failed = calls.find((c) => c.url.pathname === "/v1/executions");
    expect(failed?.url.searchParams.get("status")).toBe("failed,timed_out");
  });
});
