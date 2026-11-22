import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { uniqueSuffix } from "./_helpers/factories.ts";
import { apiClient } from "./_helpers/http.ts";
import { boot, cli, type E2EEnv, expectSuccess, shutdown } from "./setup.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const secret = ["ghp", "_", "E".repeat(36)].join("");

let env: E2EEnv;
beforeAll(async () => {
  process.env.SUBKIT_MCP_MODE = "admin";
  env = await boot("catalog-metadata", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
  delete process.env.SUBKIT_MCP_MODE;
}, 30_000);

class Mcp {
  private sessionId: string | null = null;
  private seq = 0;

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.personas.admin.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
      headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    }
    this.seq += 1;
    const res = await fetch(`${env.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: `${method}-${this.seq}`, method, params }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid && !this.sessionId) this.sessionId = sid;
    const text = (await res.text()).trim();
    const data =
      text.startsWith("event:") || text.startsWith("data:")
        ? (text.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5)
        : text;
    return JSON.parse(data) as Record<string, unknown>;
  }

  async open(): Promise<string> {
    const init = await this.call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "catalog-e2e", version: "0.0.0" },
    });
    return String((init.result as { instructions?: string }).instructions ?? "");
  }

  async tools(): Promise<Array<{ name: string; description?: string }>> {
    const res = await this.call("tools/list", {});
    return (res.result as { tools: Array<{ name: string; description?: string }> }).tools;
  }

  async tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.call("tools/call", { name, arguments: args });
    const content =
      (res.result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const text = content.find((c) => c.type === "text")?.text ?? "{}";
    return JSON.parse(text) as Record<string, unknown>;
  }

  async resources(): Promise<Array<{ uri: string; description?: string }>> {
    const res = await this.call("resources/list", {});
    return (res.result as { resources: Array<{ uri: string; description?: string }> }).resources;
  }
}

interface Workflow {
  id: string;
  slug: string;
  description: string | null;
  description_source: string;
  category: string;
  category_source: string;
}

async function seedWorkflow(slug: string): Promise<Workflow> {
  const res = await apiClient(env).post<Workflow>("/v1/workflows", {
    name: `Invoice digest ${slug}`,
    slug,
    steps: [
      { id: "fetch", kind: "request", method: "GET", url: "https://invoices.example.test/x" },
    ],
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("one description and category, the same on every surface", () => {
  test("a person sets it through subkit and HTTP, MCP and the tool catalog all read it back", async () => {
    const slug = uniqueSuffix("invoice-digest");
    const created = await seedWorkflow(slug);
    expect(created.category).toBe("other");

    const patched = await cli(
      [
        "workflows",
        "patch",
        slug,
        "--description",
        "Mails the monthly invoice digest to finance.",
        "--category",
        "billing",
        "--json",
      ],
      { env, persona: "admin" },
    );
    expectSuccess(patched, "subkit workflows patch");

    const got = await apiClient(env).get<Workflow>(`/v1/workflows/${created.id}`);
    expect(got.body.description).toBe("Mails the monthly invoice digest to finance.");
    expect(got.body.description_source).toBe("human");
    expect(got.body.category).toBe("billing");
    expect(got.body.slug).toBe(slug);

    const mcp = new Mcp();
    const instructions = await mcp.open();
    expect(instructions).toContain("billing (1)");
    const tool = (await mcp.tools()).find((t) => t.name === `wf_${slug}`);
    expect(tool?.description).toStartWith("[billing] Run the saved workflow");
    expect(tool?.description).toContain("Mails the monthly invoice digest to finance.");

    const listed = await mcp.tool("list_workflows", { category: "billing" });
    const items =
      (listed.data as { items: Workflow[] } | undefined)?.items ?? (listed.items as Workflow[]);
    expect(items.map((w) => w.slug)).toEqual([slug]);
    expect(items[0]?.description).toBe("Mails the monthly invoice digest to finance.");

    const found = await mcp.tool("find_workflow", { query: "monthly invoice digest finance" });
    const matches =
      (found.data as { matches?: Array<{ slug: string; reasons?: string[] }> })?.matches ??
      (found.matches as Array<{ slug: string; reasons?: string[] }>) ??
      [];
    expect(matches[0]?.slug).toBe(slug);
    expect(matches[0]?.reasons?.length ?? 0).toBeGreaterThan(0);
  }, 90_000);

  test("every kind takes its description and category from the CLI", async () => {
    const api = apiClient(env);
    const connector = await api.post<{ id: string }>("/v1/connectors", {
      name: "Billing API",
      slug: uniqueSuffix("billing-api"),
      driver: "http",
      base_url: "https://billing.example.test",
    });
    const source = await api.post<{ id: string }>("/v1/knowledge-sources/inline", {
      name: "Billing handbook",
      content: "# Billing\n\nInvoices close on the fifth.",
    });
    const skill = await api.post<{ id: string }>("/v1/skills", {
      scope: "global",
      title: "Invoice rules",
      body: "Never resend a paid invoice.",
    });
    const file = await api.post<{ id: string }>("/v1/files/inline", {
      filename: "invoices.csv",
      content_type: "text/csv",
      content_base64: Buffer.from("id,amount\n1,10\n").toString("base64"),
    });
    for (const [kind, id] of [
      ["connectors", connector.body.id],
      ["knowledge-sources", source.body.id],
      ["skills", skill.body.id],
      ["files", file.body.id],
    ] as const) {
      const res = await cli(
        [kind, "patch", id, "--category", "billing", "--description", `${kind} for billing`],
        {
          env,
          persona: "admin",
        },
      );
      expectSuccess(res, `subkit ${kind} patch`);
    }
    const vocabulary = await cli(["categories", "list", "--json"], { env, persona: "admin" });
    expectSuccess(vocabulary, "subkit categories list");
    const rows = JSON.parse(vocabulary.stdout) as Array<Record<string, unknown>>;
    const billing = rows.find((r) => r.category === "billing");
    expect(billing).toMatchObject({ connector: 1, knowledge_source: 1, skill: 1, file: 1 });
  }, 90_000);

  test("renaming a category moves every kind and leaves the wf_ tool name alone", async () => {
    const renamed = await cli(["categories", "rename", "billing", "finance", "--json"], {
      env,
      persona: "admin",
    });
    expectSuccess(renamed, "subkit categories rename");
    const result = JSON.parse(renamed.stdout) as { total: number; moved: Record<string, number> };
    expect(result.moved.workflow).toBe(1);
    expect(result.total).toBe(5);
    const mcp = new Mcp();
    await mcp.open();
    const tool = (await mcp.tools()).find((t) => t.description?.startsWith("[finance]"));
    expect(tool?.name).toStartWith("wf_invoice-digest");
  }, 90_000);

  test("a secret typed into a description is stored and served redacted everywhere", async () => {
    const slug = uniqueSuffix("leaky-digest");
    const created = await seedWorkflow(slug);
    const res = await apiClient(env).patch<Workflow>(`/v1/workflows/${created.id}/metadata`, {
      description: `Reads repos with ${secret} every night.`,
    });
    expect(res.status).toBe(200);
    expect(res.body.description).not.toContain(secret);
    const mcp = new Mcp();
    await mcp.open();
    expect(JSON.stringify(await mcp.tools())).not.toContain(secret);
    expect(JSON.stringify(await mcp.resources())).not.toContain(secret);
    expect(JSON.stringify(await mcp.tool("list_workflows", {}))).not.toContain(secret);
  }, 90_000);
});

describe("who may change the catalog", () => {
  test("an end user can neither describe a workflow nor rename a category", async () => {
    const created = await seedWorkflow(uniqueSuffix("guarded-digest"));
    const api = apiClient(env);
    const patch = await api.patch(
      `/v1/workflows/${created.id}/metadata`,
      { category: "stolen" },
      { persona: "enduser" },
    );
    expect([401, 403]).toContain(patch.status);
    const rename = await api.post(
      "/v1/categories/other/rename",
      { to: "stolen" },
      { persona: "enduser" },
    );
    expect([401, 403]).toContain(rename.status);
    const stillOther = await api.get<Workflow>(`/v1/workflows/${created.id}`);
    expect(stillOther.body.category).toBe("other");
    const reserved = await api.post("/v1/categories/other/rename", { to: "anything" });
    expect(reserved.status).toBe(400);
    const takeover = await api.patch(`/v1/workflows/${created.id}/metadata`, {
      category: "platform",
    });
    expect(takeover.status).toBe(400);
  }, 60_000);
});
