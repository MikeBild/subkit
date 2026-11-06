import { describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as discoveryModule from "../../connectors/discovery/index.ts";
import { runDiscoveryCached } from "../../connectors/discovery/service.ts";
import type { DiscoveredEndpoint, DiscoveryResult } from "../../connectors/discovery/types.ts";
import { connectors, knowledgeChunks, tenants } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createKnowledgeSource } from "../../knowledge/service.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { listLatestShapes } from "../../schema-versions/service.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { runAuthoringPipeline } from "../authoring-pipeline.ts";
import { _withConnectorPreflightForTests, preflightConnector } from "../authoring-preflight.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import { authorWorkflowTool } from "../tools/author-workflow.ts";
import {
  ctx,
  fetchCalls,
  makeCtx,
  tenant_id,
  tw,
  useAuthoringPipelineSetup,
  VALID_DEF,
} from "./authoring-pipeline-fixtures.ts";

useAuthoringPipelineSetup();

describe("runAuthoringPipeline — ask-first: placeholder destinations are refused, not regenerated", () => {
  const PLACEHOLDER_BODY_DEF = {
    name: "Droplet report",
    slug: "droplet-report",
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: "https://api.acme.com/send",
        body: { to: "user@example.com", subject: "Droplets" },
      },
    ],
  };
  const PLACEHOLDER_TRANSFORM_DEF = {
    name: "Droplet report",
    slug: "droplet-report",
    steps: [
      {
        id: "compose",
        kind: "transform",
        language: "javascript",
        expression: 'return { to: "recipient@example.com", body: "report" };',
      },
    ],
  };
  const PARAMETERIZED_DEF = {
    name: "Droplet report",
    slug: "droplet-report",
    input_schema: {
      type: "object",
      properties: { recipient: { type: "string" } },
      required: ["recipient"],
    },
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: "https://api.acme.com/send",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the parameterized recipient is the correct design under test
        body: { to: "${input.recipient}", subject: "Droplets" },
      },
    ],
  };

  for (const [label, def, path] of [
    ["request body.to", PLACEHOLDER_BODY_DEF, "steps.send.body.to"],
    ["JS transform expression", PLACEHOLDER_TRANSFORM_DEF, "steps.compose.expression"],
  ] as const) {
    tw(
      `${label}: ONE pass, authoring_definition_invalid + requires_user_input, field named, nothing stashed, zero egress`,
      async () => {
        let calls = 0;
        getMockProvider().generateOverrides.generate = () => {
          calls += 1;
          return def;
        };
        const toolCtx = makeCtx();
        const result = await runAuthoringPipeline({
          ctx: toolCtx,
          goal: "Send me a daily report of my DigitalOcean droplets by email.",
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error_code).toBe("authoring_definition_invalid");
        expect(result.requires_user_input).toBe(true);
        expect(result.attempts).toBe(1);
        expect(calls).toBe(1);
        expect(result.placeholder_destinations?.map((v) => v.path)).toEqual([path]);
        expect(result.errors.map((e) => e.path)).toEqual([path]);
        expect(result.message).toContain(`${path}: placeholder destination`);
        expect(result.message).toContain(
          "ask the user for the real value with ask_user_text or ask_user_form",
        );
        expect(toolCtx._draft.value).toBeNull();
        expect(fetchCalls).toBe(0);
      },
    );
  }

  tw(
    "a parameterized destination (a runtime input placeholder) is the correct design and passes",
    async () => {
      getMockProvider().generateOverrides.generate = () => PARAMETERIZED_DEF;
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "email the droplet report" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.attempts).toBe(1);
      expect(result.validation.ok).toBe(true);
      expect(toolCtx._draft.value?.workflow.slug).toBe("droplet-report");
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "author_workflow envelope: requires_user_input, ask-first next_best_actions, placeholder_destinations, previous draft kept",
    async () => {
      getMockProvider().generateOverrides.generate = () => PLACEHOLDER_BODY_DEF;
      const toolCtx = makeCtx();
      const before = createEmptyDraftDocument();
      before.workflow = {
        name: "Kept",
        slug: "kept",
        steps: [{ id: "a", kind: "transform", language: "javascript", expression: "return 1;" }],
      };
      toolCtx._draft.value = before;
      const result = await authorWorkflowTool.execute(toolCtx, {
        goal: "Send me a daily report of my DigitalOcean droplets by email.",
      });
      expect(result.ok).toBe(false);
      const data = result.data as {
        error_code: string;
        requires_user_input: boolean;
        next_best_actions: string[];
        placeholder_destinations: Array<{ path: string; match: string }>;
        attempts: number;
      };
      expect(data.error_code).toBe("authoring_definition_invalid");
      expect(data.requires_user_input).toBe(true);
      expect(data.next_best_actions).toEqual(["ask_user_text", "ask_user_form", "author_workflow"]);
      expect(data.placeholder_destinations).toEqual([
        expect.objectContaining({ path: "steps.send.body.to", match: "user@example.com" }),
      ]);
      expect(data.attempts).toBe(1);
      expect(toolCtx._draft.value?.workflow.slug).toBe("kept");
      expect(fetchCalls).toBe(0);
    },
  );
});

describe("runAuthoringPipeline — goal-grounded retrieval", () => {
  tw("the generation call retrieves domain knowledge that matches the goal words", async () => {
    const [scoped] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-author-pipeline-retrieval", display_name: "T" })
      .returning();
    const scopedTenant = scoped!.id;
    const source = await createKnowledgeSource(
      {
        tenant_id: scopedTenant,
        input: { name: "Dunning Rules", scope: "global", tags: ["domain:invoicing"] },
        upload: {
          buffer: Buffer.from(
            "# Dunning Rules\n\nEscalate to the second letter after thirty days.\nNever contact customers on public holidays.",
          ),
          filename: "dunning.md",
          mime: "text/markdown",
        },
        actor: null,
      },
      ctx.db,
    );
    getMockProvider().generateOverrides.generate = () => VALID_DEF;
    const toolCtx = {
      ...makeCtx(),
      tenant_id: scopedTenant,
      engineClient: new EngineClient({ tenant_id: scopedTenant, actor_id: null, db: ctx.db }),
    };
    const result = await runAuthoringPipeline({
      ctx: toolCtx,
      goal: "Send overdue invoice reminders every Monday",
    });
    expect(result.ok).toBe(true);

    const generateCall = getMockProvider().calls.find((c) => c.flow === "generate");
    expect(generateCall).toBeDefined();
    const chunkRows = await ctx.db
      .select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.tenant_id, scopedTenant),
          eq(knowledgeChunks.knowledge_source_id, source.id),
        ),
      );
    expect(chunkRows.length).toBeGreaterThan(0);
    const included = new Set(generateCall!.included_knowledge_chunk_ids);
    expect(chunkRows.some((r) => included.has(r.id))).toBe(true);
  });

  tw("a connector category narrows knowledge retrieval to its domain tag", async () => {
    const [scoped] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-author-pipeline-domains", display_name: "T" })
      .returning();
    const scopedTenant = scoped!.id;
    const ingest = (name: string, tag: string) =>
      createKnowledgeSource(
        {
          tenant_id: scopedTenant,
          input: { name, scope: "global", tags: [tag] },
          upload: {
            buffer: Buffer.from(`# ${name}\n\nOverdue invoice reminders go out every Monday.`),
            filename: `${tag.replace(":", "-")}.md`,
            mime: "text/markdown",
          },
          actor: null,
        },
        ctx.db,
      );
    const billing = await ingest("Billing reminders", "domain:billing");
    const support = await ingest("Support reminders", "domain:support");
    await ctx.db.insert(connectors).values({
      tenant_id: scopedTenant,
      slug: "domain-billing-api",
      display_name: "Billing API",
      driver: "http",
      base_url: "https://billing.domains.test",
      auth_type: "none",
      category: "billing",
    });
    getMockProvider().generateOverrides.generate = () => VALID_DEF;
    const toolCtx = {
      ...makeCtx(),
      tenant_id: scopedTenant,
      engineClient: new EngineClient({ tenant_id: scopedTenant, actor_id: null, db: ctx.db }),
    };
    const result = await runAuthoringPipeline({
      ctx: toolCtx,
      goal: "Send overdue invoice reminders every Monday",
      connector_ids: ["domain-billing-api"],
    });
    expect(result.ok).toBe(true);
    const generateCall = getMockProvider().calls.find((c) => c.flow === "generate");
    if (!generateCall) throw new Error("generate call missing");
    const chunksOf = async (knowledge_source_id: string) =>
      (
        await ctx.db
          .select({ id: knowledgeChunks.id })
          .from(knowledgeChunks)
          .where(
            and(
              eq(knowledgeChunks.tenant_id, scopedTenant),
              eq(knowledgeChunks.knowledge_source_id, knowledge_source_id),
            ),
          )
      ).map((r) => r.id);
    const included = new Set(generateCall.included_knowledge_chunk_ids);
    expect((await chunksOf(billing.id)).some((id) => included.has(id))).toBe(true);
    expect((await chunksOf(support.id)).some((id) => included.has(id))).toBe(false);
  });
});

describe("runAuthoringPipeline — real pre-flight", () => {
  function route(method: "GET" | "POST", path: string, summary: string): DiscoveredEndpoint {
    return {
      method,
      path,
      summary,
      description: null,
      operation_id: null,
      scopes: [],
      params: [],
      request_body_schema: null,
      request_content_type: null,
      response_schemas: {},
      pagination_hint: null,
      deprecated: false,
    };
  }

  async function seedIndex(base_url: string): Promise<void> {
    const index: DiscoveryResult = {
      source_url: base_url,
      fetched_at: "2026-01-01T00:00:00.000Z",
      strategy: "openapi-direct",
      spec_version: "openapi-3",
      title: "Gadgets",
      servers: [base_url],
      auth_schemes: [],
      endpoints: [
        route("GET", "/v1/gadgets", "List gadgets"),
        route("POST", "/v1/gadgets", "Create gadgets"),
      ],
      warnings: [],
    };
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(index);
    try {
      await runDiscoveryCached({ db: ctx.db, tenant_id, actor_id: null }, { base_url });
    } finally {
      spy.mockRestore();
    }
  }

  function recordingFetch(requests: Array<{ method: string; url: string }>): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      requests.push({ method: method.toUpperCase(), url });
      return new Response(JSON.stringify({ gadgets: [{ id: "g-1", label: "first" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  test("an open connector gets one read-only GET probe whose shape reaches the prompt", async () => {
    const base_url = "https://gadgets-open.preflight.test";
    const [connector] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id,
        slug: "gadgets-open",
        display_name: "Gadgets",
        driver: "http",
        base_url,
        auth_type: "none",
      })
      .returning();
    await seedIndex(base_url);
    const requests: Array<{ method: string; url: string }> = [];
    getMockProvider().generateOverrides.generate = () => VALID_DEF;
    const result = await withSelfHostedDriverFetchForTests(recordingFetch(requests), () =>
      _withConnectorPreflightForTests(preflightConnector, () =>
        runAuthoringPipeline({
          ctx: makeCtx(),
          goal: "Summarise all gadgets",
          connector_ids: ["gadgets-open"],
        }),
      ),
    );
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toContain("/v1/gadgets");
    const shapes = await listLatestShapes(
      { tenant_id, connector_id: connector!.id, max_endpoints: 10 },
      ctx.db,
    );
    expect(shapes.map((s) => s.endpoint_key)).toContain("GET /v1/gadgets");
    const prompt = getMockProvider().calls.find((c) => c.flow === "generate")?.last_user ?? "";
    expect(prompt).toContain("GET /v1/gadgets");
  });

  test("a connector without a saved credential is never probed and never asks", async () => {
    const base_url = "https://gadgets-locked.preflight.test";
    await ctx.db.insert(connectors).values({
      tenant_id,
      slug: "gadgets-locked",
      display_name: "Locked gadgets",
      driver: "http",
      base_url,
      auth_type: "bearer",
    });
    await seedIndex(base_url);
    const requests: Array<{ method: string; url: string }> = [];
    getMockProvider().generateOverrides.generate = () => VALID_DEF;
    const result = await withSelfHostedDriverFetchForTests(recordingFetch(requests), () =>
      _withConnectorPreflightForTests(preflightConnector, () =>
        runAuthoringPipeline({
          ctx: makeCtx(),
          goal: "Summarise all gadgets",
          connector_ids: ["gadgets-locked"],
        }),
      ),
    );
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(0);
    expect("requires_user_input" in result).toBe(false);
  });
});
