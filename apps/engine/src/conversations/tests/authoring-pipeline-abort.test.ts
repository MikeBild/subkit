import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../config/loader.ts";
import * as discoveryModule from "../../connectors/discovery/index.ts";
import { runDiscoveryCached } from "../../connectors/discovery/service.ts";
import type { DiscoveryResult } from "../../connectors/discovery/types.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { LlmGenerationAborted } from "../../llm/errors.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { recordSuccessShape } from "../../schema-versions/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import { runAuthoringPipeline } from "../authoring-pipeline.ts";
import { _withConnectorPreflightForTests } from "../authoring-preflight.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import { authorWorkflowTool } from "../tools/author-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

const nextUuid = createDeterministicUuidFactory(0xab_047);

let ctx: TestDb;
let tenant_id: string;
let fetchCalls = 0;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "subkit-cfg-authoring-abort-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/authoring-abort",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

const tripwire = ((..._args: unknown[]) => {
  fetchCalls += 1;
  throw new Error("live HTTP is forbidden inside the authoring pipeline");
}) as unknown as typeof fetch;

function tw(name: string, body: () => Promise<void>) {
  test(name, () =>
    withSelfHostedDriverFetchForTests(tripwire, () =>
      _withConnectorPreflightForTests(async () => null, body),
    ),
  );
}

beforeAll(async () => {
  await ensureConfigLoaded();
  ctx = await createTestDb("authoring_pipeline_abort");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-author-abort", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
  fetchCalls = 0;
});

function makeCtx(): ToolContext & { _draft: { value: DraftDocument | null } } {
  const ref: { value: DraftDocument | null } = { value: null };
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: nextUuid(),
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ref.value ?? createEmptyDraftDocument(),
    setDraft: async (d) => {
      ref.value = d;
    },
    _draft: ref,
  };
}

const VALID_DEF = {
  name: "Archive digest",
  slug: "archive-digest",
  steps: [
    {
      id: "fetch_items",
      kind: "request",
      method: "GET",
      url: "https://jsonplaceholder.typicode.com/posts",
    },
    {
      id: "shape_items",
      kind: "transform",
      language: "javascript",
      expression: "return input.scope.fetch_items.data.map(r => ({ id: r.id }));",
    },
  ],
};

const MAIL_BASE_URL = "https://mail.regrounding.test/api";
const MAIL_SEND_ROUTE = "/v1/users/{userId}/messages/send";

function mailIndex(): DiscoveryResult {
  const filler = Array.from({ length: 60 }, (_, i) => ({
    method: "GET" as const,
    path: `/v1/archive/${i}`,
    summary: `Archive listing ${i}`,
    description: null,
    operation_id: null,
    scopes: [],
    params: [],
    request_body_schema: null,
    request_content_type: null,
    response_schemas: {},
    pagination_hint: null,
    deprecated: false,
  }));
  return {
    source_url: MAIL_BASE_URL,
    fetched_at: "2026-01-01T00:00:00.000Z",
    strategy: "openapi-direct",
    spec_version: "openapi-3",
    title: "Mail",
    servers: [MAIL_BASE_URL],
    auth_schemes: [],
    endpoints: [
      ...filler,
      {
        method: "POST",
        path: MAIL_SEND_ROUTE,
        summary: "Send a message",
        description: null,
        operation_id: "sendMessage",
        scopes: [],
        params: [{ name: "userId", in: "path", required: true, type: "string" }],
        request_body_schema: { type: "object", properties: { raw: { type: "string" } } },
        request_content_type: "application/json",
        response_schemas: { "200": { type: "object", properties: { id: { type: "string" } } } },
        pagination_hint: null,
        deprecated: false,
      },
    ],
    warnings: [],
  } as DiscoveryResult;
}

function generateCalls() {
  return getMockProvider().calls.filter((c) => c.flow === "generate");
}

describe("runAuthoringPipeline — structured abort", () => {
  tw(
    "an abort naming a missing route re-grounds that route and its recorded shape for the second pass",
    async () => {
      const [mail] = await ctx.db
        .insert(connectors)
        .values({
          tenant_id,
          slug: "mail-regrounding",
          display_name: "Mail",
          driver: "http",
          base_url: MAIL_BASE_URL,
          auth_type: "none",
        })
        .returning();
      const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
        mailIndex(),
      );
      try {
        await runDiscoveryCached(
          { db: ctx.db, tenant_id, actor_id: null },
          { base_url: MAIL_BASE_URL },
        );
      } finally {
        spy.mockRestore();
      }
      await recordSuccessShape(
        {
          tenant_id,
          connector_id: mail!.id,
          endpoint_key: "POST /api/v1/users/me/messages/send",
          value: { id: "m-1", threadId: "t-1" },
        },
        ctx.db,
      );
      let calls = 0;
      getMockProvider().generateOverrides.generate = () => {
        calls += 1;
        if (calls === 1) {
          throw new LlmGenerationAborted({
            reason: "the send operation contract is not in the excerpt",
            needs: [
              {
                kind: "endpoint_contract",
                connector_slug: "mail-regrounding",
                method: "POST",
                path: "/v1/users/me/messages/send",
                question: null,
              },
            ],
          });
        }
        return VALID_DEF;
      };
      const result = await runAuthoringPipeline({
        ctx: makeCtx(),
        goal: "Daily archive digest",
        connector_ids: ["mail-regrounding"],
      });
      expect(result.ok).toBe(true);
      const prompts = generateCalls().map((c) => c.last_user);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).not.toContain(`POST ${MAIL_SEND_ROUTE}`);
      expect(prompts[1]).toContain("Evidence fetched for the previous abort");
      expect(prompts[1]).toContain(`\`mail-regrounding\` POST ${MAIL_SEND_ROUTE}`);
      expect(prompts[1]).toContain("userId (path, required, string)");
      expect(prompts[1]).toContain(
        "recorded response `mail-regrounding` POST /api/v1/users/me/messages/send",
      );
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "an abort the engine cannot re-ground returns the needs instead of an identical retry",
    async () => {
      getMockProvider().generateOverrides.generate = () => {
        throw new LlmGenerationAborted({
          reason: "no route for the export",
          needs: [
            {
              kind: "response_shape",
              connector_slug: null,
              method: "GET",
              path: "/v9/export",
              question: null,
            },
          ],
        });
      };
      const toolCtx = makeCtx();
      const result = await authorWorkflowTool.execute(toolCtx, { goal: "Export everything" });
      expect(result.ok).toBe(false);
      const data = result.data as {
        error_code: string;
        needs: Array<{ kind: string; path: string }>;
        next_best_actions: string[];
      };
      expect(data.error_code).toBe("authoring_generation_failed");
      expect(data.needs).toEqual([
        expect.objectContaining({ kind: "response_shape", path: "/v9/export" }),
      ]);
      expect(data.next_best_actions).toEqual(["probe_connector", "author_workflow"]);
      expect(generateCalls()).toHaveLength(1);
      expect(toolCtx._draft.value).toBeNull();
    },
  );

  tw("a connector choice asks the user with the production connector preselected", async () => {
    await ctx.db.insert(connectors).values([
      {
        tenant_id,
        slug: "notify-sandbox",
        display_name: "Notify sandbox",
        driver: "http",
        base_url: "https://notify.choice.test",
        auth_type: "none",
        environment: "dev",
      },
      {
        tenant_id,
        slug: "notify-live",
        display_name: "Notify live",
        driver: "http",
        base_url: "https://notify.choice.test",
        auth_type: "none",
        environment: "prod",
      },
    ]);
    getMockProvider().generateOverrides.generate = () => {
      throw new LlmGenerationAborted({
        reason: "two notify connectors could send this",
        needs: [
          {
            kind: "connector_choice",
            connector_slug: null,
            method: null,
            path: null,
            question: "Which notify connector should send the alert?",
          },
        ],
      });
    };
    const toolCtx = makeCtx();
    const result = await authorWorkflowTool.execute(toolCtx, {
      goal: "Send an alert",
      connector_slugs: ["notify-sandbox", "notify-live"],
    });
    expect(result.ok).toBe(false);
    const data = result.data as {
      requires_user_input: boolean;
      next_best_actions: string[];
      user_prompt: {
        tool: string;
        args: { question: string; default?: string; options: Array<{ value: string }> };
      };
    };
    expect(data.requires_user_input).toBe(true);
    expect(data.next_best_actions[0]).toBe("ask_user_choice");
    expect(data.user_prompt.tool).toBe("ask_user_choice");
    expect(data.user_prompt.args.question).toBe("Which notify connector should send the alert?");
    expect(data.user_prompt.args.default).toBe("notify-live");
    expect(data.user_prompt.args.options.map((o) => o.value)).toEqual([
      "notify-live",
      "notify-sandbox",
    ]);
    expect(generateCalls()).toHaveLength(1);
    expect(toolCtx._draft.value).toBeNull();
  });
});
