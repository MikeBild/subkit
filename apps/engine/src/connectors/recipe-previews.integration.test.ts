import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../execution/engine.ts";
import { createEngineCtx, type EngineTestCtx } from "../execution/tests/setup.ts";
import { withSelfHostedDriverFetchForTests } from "../test-helpers/driver-fetch.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import { bindRecipe, listTemplateConnectors, rebindConnectorIds } from "./recipe-binding.ts";
import { createConnector } from "./service.ts";
import { getSolutionRecipe } from "./solutions.ts";
import { type ConnectorRecipe, getBuiltinTemplate, loadBuiltinTemplates } from "./templates.ts";

const skip = process.env.REQUIRES_PG === "0";

interface Call {
  method: string;
  url: URL;
  body: string;
}

type Reply = (call: Call) => unknown;

let ctx: EngineTestCtx;
const ownApis: Record<string, string> = {};

const TEMPLATE_CONNECTORS = [
  "google-gmail",
  "google-drive",
  "google-analytics",
  "stripe",
  "slack",
  "anthropic",
];

async function connector(slug: string, template: string, base_url?: string): Promise<string> {
  const created = await createConnector(
    {
      tenant_id: ctx.tenantId,
      input: {
        name: slug,
        slug,
        driver: "http",
        environment: "dev",
        auth_type: "none",
        template_slug: template,
        ...(base_url ? { base_url } : {}),
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );
  return created.id;
}

beforeAll(async () => {
  if (skip) return;
  ctx = await createEngineCtx("recipe-previews");
  for (const slug of TEMPLATE_CONNECTORS) await connector(slug, slug);
  ownApis.access = await connector("access-api", "http", "https://access.example.com");
  ownApis.subkit = await connector("subkit-api", "http", "https://subkit.example.com");
}, 60_000);

afterAll(async () => {
  if (!skip) await ctx?.cleanup();
}, 30_000);

async function preview(
  recipe: ConnectorRecipe,
  reply: Reply,
  ownApi?: string,
): Promise<{ output: unknown; calls: Call[] }> {
  const needed = recipe.required_connectors.map((r) => r.template);
  const available = await listTemplateConnectors(ctx.tenantId, needed, ctx.testDb.db);
  const templates = new Map(
    loadBuiltinTemplates().map((t) => [t.slug, { name: t.name, base_url: t.base_url }]),
  );
  const bound = bindRecipe(recipe, available, templates);
  const unbound = bound.connectors.filter((c) => c.connector_id === null);
  expect(unbound.map((c) => c.template)).toEqual(ownApi ? ["http"] : []);
  const definition = ownApi
    ? rebindConnectorIds(
        bound.workflow,
        Object.fromEntries(unbound.map((c) => [c.placeholder, ownApi])),
      )
    : bound.workflow;
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
  const run = (hold_writes: boolean) =>
    withSelfHostedDriverFetchForTests(fake, () =>
      runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "draft", definition: definition as WorkflowDef },
        input: recipe.sample_input,
        options: { hold_writes },
      }),
    );
  const held = await run(true);
  expect({ held: held.status, error: held.error }).toEqual({ held: "succeeded", error: null });
  calls.length = 0;
  const result = await run(false);
  expect({ status: result.status, error: result.error }).toEqual({
    status: "succeeded",
    error: null,
  });
  expect(result.output).toEqual(recipe.expected_output_preview);
  return { output: result.output, calls };
}

function solution(slug: string): ConnectorRecipe {
  const recipe = getSolutionRecipe(slug);
  if (!recipe) throw new Error(`solution ${slug} missing`);
  return recipe;
}

function templateRecipe(template: string, slug: string): ConnectorRecipe {
  const recipe = getBuiltinTemplate(template)?.recipes.find((r) => r.slug === slug);
  if (!recipe) throw new Error(`recipe ${template}/${slug} missing`);
  return recipe;
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

const unexpected = (call: Call): never => {
  throw new Error(`unexpected ${call.method} ${call.url}`);
};

describe.skipIf(skip)("solution recipes preview against their expected output", () => {
  const invoiceReply =
    (folders: Array<{ id: string; name: string }>) =>
    (call: Call): unknown => {
      const { method, url } = call;
      if (url.pathname.endsWith("/users/me/messages")) return { messages: [{ id: "m1" }] };
      if (url.pathname.endsWith("/users/me/messages/m1")) return gmailMessage;
      if (url.pathname.endsWith("/attachments/att1")) return { size: 9, data: "JVBERi0xLjQK" };
      if (method === "GET" && url.pathname === "/drive/v3/files") return { files: folders };
      if (method === "POST" && url.pathname === "/drive/v3/files") {
        return { id: "folder-1", name: "Invoices" };
      }
      if (method === "POST" && url.pathname === "/upload/drive/v3/files") {
        return { id: "file-1", name: "2026-09-30_example.com_invoice-1042.pdf" };
      }
      return unexpected(call);
    };

  test("the first run creates its own Drive folder and files the invoice in it", async () => {
    const { calls } = await preview(solution("invoice-attachments-to-drive"), invoiceReply([]));
    const find = calls.find((c) => c.method === "GET" && c.url.pathname === "/drive/v3/files");
    expect(find?.url.searchParams.get("q")).toBe(
      "mimeType='application/vnd.google-apps.folder' and name='Invoices' and trashed=false",
    );
    const create = calls.find((c) => c.method === "POST" && c.url.pathname === "/drive/v3/files");
    expect(JSON.parse(create?.body ?? "{}")).toEqual({
      name: "Invoices",
      mimeType: "application/vnd.google-apps.folder",
    });
    const upload = calls.find((c) => c.url.pathname === "/upload/drive/v3/files");
    expect(upload?.url.hostname).toBe("www.googleapis.com");
    expect(upload?.body).toContain('"parents":["folder-1"]');
    expect(upload?.body).toContain("JVBERi0xLjQK");
  });

  test("later runs find the folder they created and do not create another", async () => {
    const { calls } = await preview(
      solution("invoice-attachments-to-drive"),
      invoiceReply([{ id: "folder-1", name: "Invoices" }]),
    );
    expect(calls.some((c) => c.method === "POST" && c.url.pathname === "/drive/v3/files")).toBe(
      false,
    );
    expect(calls.find((c) => c.url.pathname === "/upload/drive/v3/files")?.body).toContain(
      '"parents":["folder-1"]',
    );
  });

  test("the daily analytics report reads two reports and mails one summary", async () => {
    const { calls } = await preview(solution("daily-analytics-report"), (call) => {
      const { method, url, body } = call;
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
      return unexpected(call);
    });
    const mail = calls.find((c) => c.url.pathname.endsWith("/messages/send"));
    expect(JSON.parse(mail?.body ?? "{}").raw).toEqual(expect.any(String));
  });

  test("a paid checkout grants access in the bound own system and welcomes the buyer", async () => {
    const { calls } = await preview(
      solution("payment-grants-access"),
      (call) => {
        const { method, url } = call;
        if (url.pathname === "/v1/checkout/sessions/cs_example_0001") {
          return { id: "cs_example_0001", payment_status: "paid" };
        }
        if (method === "POST" && url.pathname === "/access/grants") return { granted: true };
        if (method === "POST" && url.pathname.endsWith("/users/me/messages/send")) {
          return sent("msg-0003");
        }
        return unexpected(call);
      },
      ownApis.access,
    );
    const grant = calls.find((c) => c.url.pathname === "/access/grants");
    expect(grant?.url.hostname).toBe("access.example.com");
    expect(JSON.parse(grant?.body ?? "{}")).toEqual({
      email: "buyer@example.com",
      group: "members",
      reference: "cs_example_0001",
    });
  });

  test("an important event becomes one Slack message in the configured channel", async () => {
    const { calls } = await preview(solution("webhook-to-slack"), (call) => {
      if (call.method === "POST" && call.url.pathname === "/api/chat.postMessage") {
        return { ok: true, ts: "1790755200.000100" };
      }
      return unexpected(call);
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      channel: "#alerts",
      text: "[ERROR] Payment provider unreachable — 3 retries failed for order 1042",
    });
  });

  test("the weekly digest reads the bound SubKit API, not another HTTP connector", async () => {
    const { calls } = await preview(
      solution("weekly-run-digest"),
      (call) => {
        const { method, url } = call;
        if (url.pathname === "/v1/stats/executions") {
          return {
            totals: {
              executions: { count: 120, by_status: { succeeded: 117, failed: 2, timed_out: 1 } },
            },
          };
        }
        if (url.pathname === "/v1/executions") {
          return { items: [{ workflow_name: "nightly-sync", error_code: "upstream_timeout" }] };
        }
        if (method === "POST" && url.pathname.endsWith("/users/me/messages/send")) {
          return sent("msg-0005");
        }
        return unexpected(call);
      },
      ownApis.subkit,
    );
    const reads = calls.filter((c) => c.url.pathname.startsWith("/v1/"));
    expect(reads.map((c) => c.url.hostname)).toEqual(["subkit.example.com", "subkit.example.com"]);
    expect(reads[1]?.url.searchParams.get("status")).toBe("failed,timed_out");
  });
});

const claudeAnswer = (text: string) => ({
  id: "msg_example",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 40, output_tokens: 12 },
});

const report = (dimension: string | null, metrics: string[], rows: string[][]) => ({
  ...(dimension ? { dimensionHeaders: [{ name: dimension }] } : {}),
  metricHeaders: metrics.map((name) => ({ name })),
  rows: rows.map((row) =>
    dimension
      ? {
          dimensionValues: [{ value: row[0] }],
          metricValues: row.slice(1).map((value) => ({ value })),
        }
      : { metricValues: row.map((value) => ({ value })) },
  ),
});

describe.skipIf(skip)("Anthropic and Google Analytics 4 recipes preview", () => {
  test("anthropic recipes send the version header and read the answer's text", async () => {
    const replies: Record<string, Reply> = {
      "list-models": (call) =>
        call.url.pathname === "/v1/models"
          ? { data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }
          : unexpected(call),
      "summarize-text": () =>
        claudeAnswer("The review covered hiring, billing and the office move."),
      "classify-text": () =>
        claudeAnswer(
          JSON.stringify({ category: "billing", reason: "The customer reports a double charge." }),
        ),
    };
    for (const [slug, reply] of Object.entries(replies)) {
      const { calls } = await preview(templateRecipe("anthropic", slug), reply);
      expect(calls[0]?.url.hostname).toBe("api.anthropic.com");
    }
  });

  test("google analytics recipes run their reports against the given property", async () => {
    const replies: Record<string, Reply> = {
      "run-report": () =>
        report(
          null,
          ["activeUsers", "sessions", "screenPageViews", "keyEvents"],
          [["42", "57", "133", "3"]],
        ),
      "top-pages": () =>
        report(
          "pagePath",
          ["screenPageViews"],
          [
            ["/pricing", "61"],
            ["/", "40"],
          ],
        ),
      "traffic-sources": () =>
        report(
          "sessionSource",
          ["sessions"],
          [
            ["google", "30"],
            ["(direct)", "12"],
          ],
        ),
      "realtime-active-users": () =>
        report(
          "country",
          ["activeUsers"],
          [
            ["Germany", "5"],
            ["Austria", "2"],
          ],
        ),
    };
    for (const [slug, reply] of Object.entries(replies)) {
      const { calls } = await preview(templateRecipe("google-analytics", slug), reply);
      expect(calls[0]?.url.pathname).toMatch(/^\/v1beta\/properties\/123456789:run/);
    }
  });
});
