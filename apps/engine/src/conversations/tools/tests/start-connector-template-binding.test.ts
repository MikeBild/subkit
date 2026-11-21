import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectorTemplates } from "../../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../../authoring-state/index.ts";
import { createConversation } from "../../service/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import { askUserFormTool } from "../ask-user/form.ts";
import type { ToolContext } from "../index.ts";
import { startConnectorFromDescriptionTool } from "../start-connector-from-description.ts";

let ctx: ConversationTestCtx;

const CANONICAL_SETUP =
  "Create an API key under Zephyr Settings → API Keys, then exchange it for a token.";

beforeAll(async () => {
  ctx = await createConversationTestCtx("start_connector_template_binding");
  await ctx.testDb.db.insert(connectorTemplates).values([
    {
      tenant_id: ctx.tenant_id,
      slug: "zephyr-board",
      name: "Zephyr Board",
      driver: "graphql",
      base_url: "https://zephyr.example.test/api/v2/graphql",
      auth_type: "bearer",
      ingestion_source: "graphql",
      url_pattern: "^https://zephyr\\.example\\.test",
      setup_instructions: CANONICAL_SETUP,
      credential_hints: [
        {
          field: "token",
          label: "Zephyr API token",
          placeholder: "",
          doc_url: null,
          secret: true,
        },
      ],
    },
    {
      tenant_id: ctx.tenant_id,
      slug: "zephyr-selfhosted",
      name: "Zephyr Self-Hosted",
      driver: "graphql",
      base_url: "https://your-instance.zephyrwild.example/api",
      auth_type: "bearer",
      ingestion_source: "graphql",
      url_pattern: "^https://[a-z0-9-]+\\.zephyrwild\\.example",
      setup_instructions: "Self-hosted instances mint tokens under Admin → Tokens.",
      credential_hints: [
        {
          field: "token",
          label: "Instance token",
          placeholder: "",
          doc_url: null,
          secret: true,
        },
      ],
    },
    {
      tenant_id: ctx.tenant_id,
      slug: "editorial-http-publisher",
      name: "Editorial HTTP Publisher",
      driver: "http",
      base_url: "https://editorial.example.test",
      auth_type: "bearer",
      ingestion_source: "openapi",
      url_pattern: "^https://editorial\\.example\\.test(/|$)",
    },
  ]);
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createToolCtx(): Promise<{ base: ToolContext }> {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "template-binding-test",
    },
    ctx.testDb.db,
  );
  let draft: DraftDocument = createEmptyDraftDocument();
  return {
    base: {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: created.conversation.id,
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      engineClient: {} as never,
      getDraft: () => draft,
      setDraft: async (next: DraftDocument) => {
        draft = next;
      },
    },
  };
}

interface BindingPayload {
  connector: { template_slug: string | null; auth_type: string };
  matched_template: {
    slug: string;
    setup_instructions?: string;
    credential_hints?: Array<{ field: string; secret: boolean }>;
    template_base_url?: string | null;
  } | null;
  base_url_conflict?: {
    supplied_base_url: string;
    template_base_url: string;
    bound_base_url: string;
    overridden: boolean;
    note: string;
  };
}

describe("start_connector_from_description — template binding", () => {
  test("does not bind a URL-matched template owned by another driver", async () => {
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Editorial MCP",
      driver: "mcp",
      environment: "prod",
      base_url: "https://editorial.example.test/mcp",
      auth_type: "bearer",
      force_new: true,
    });
    expect(started.ok).toBe(true);
    const connector = toolCtx.base.getDraft().connector;
    expect(connector?.template_slug).toBeNull();
    expect(connector?.driver).toBe("mcp");
    expect(connector?.base_url).toBe("https://editorial.example.test/mcp");
    expect(connector?.config).toEqual({
      mcp: { transport: "http", auth: { kind: "bearer" } },
    });
    expect(connector?.validation?.ok).toBe(true);
  });

  test("same-host guess is overridden by the template's canonical base_url and the result says so", async () => {
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Zephyr Cloud",
      driver: "graphql",
      environment: "dev",
      base_url: "https://zephyr.example.test/graphql",
      auth_type: "bearer",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("expected ok result");
    const data = started.data as BindingPayload;
    expect(data.connector.template_slug).toBe("zephyr-board");
    expect(data.connector.auth_type).toBe("bearer");

    expect(toolCtx.base.getDraft().connector?.base_url).toBe(
      "https://zephyr.example.test/api/v2/graphql",
    );

    expect(data.matched_template?.slug).toBe("zephyr-board");
    expect(data.matched_template?.setup_instructions).toBe(CANONICAL_SETUP);
    expect(data.matched_template?.credential_hints?.[0]?.field).toBe("token");

    expect(data.base_url_conflict).toBeDefined();
    expect(data.base_url_conflict?.overridden).toBe(true);
    expect(data.base_url_conflict?.supplied_base_url).toBe("https://zephyr.example.test/graphql");
    expect(data.base_url_conflict?.bound_base_url).toBe(
      "https://zephyr.example.test/api/v2/graphql",
    );
    expect(data.base_url_conflict?.note.length).toBeGreaterThan(0);
  });

  test("different-host guess (wildcard template) keeps the operator URL but still surfaces hints + disagreement", async () => {
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Zephyr at Acme",
      driver: "graphql",
      environment: "dev",
      base_url: "https://acme.zephyrwild.example/api",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("expected ok result");
    const data = started.data as BindingPayload;
    expect(data.connector.template_slug).toBe("zephyr-selfhosted");
    expect(toolCtx.base.getDraft().connector?.base_url).toBe("https://acme.zephyrwild.example/api");
    expect(data.matched_template?.setup_instructions).toContain("Admin → Tokens");
    expect(data.base_url_conflict).toBeDefined();
    expect(data.base_url_conflict?.overridden).toBe(false);
    expect(data.base_url_conflict?.bound_base_url).toBe("https://acme.zephyrwild.example/api");
  });

  test("guess identical to the template base_url → no conflict note", async () => {
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Zephyr Exact",
      driver: "graphql",
      environment: "dev",
      base_url: "https://zephyr.example.test/api/v2/graphql",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("expected ok result");
    const data = started.data as BindingPayload;
    expect(data.connector.template_slug).toBe("zephyr-board");
    expect(data.base_url_conflict).toBeUndefined();
    expect(data.matched_template?.setup_instructions).toBe(CANONICAL_SETUP);
  });

  test("credential_form_mismatch on a template-bound draft carries the template setup_instructions", async () => {
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Zephyr Form",
      driver: "graphql",
      environment: "dev",
      base_url: "https://zephyr.example.test/graphql",
      auth_type: "bearer",
    });
    expect(started.ok).toBe(true);

    const result = await askUserFormTool.execute(toolCtx.base, {
      question: "Enter your Zephyr API key",
      fields: [
        { name: "api_key", label: "API key", type: "password" },
        { name: "access_key", label: "Access key", type: "password" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected mismatch");
    expect(result.error_code).toBe("credential_form_mismatch");
    const data = result.data as {
      expected_fields?: string[];
      missing?: string[];
      setup_instructions?: string;
      message?: string;
    };
    expect(data.expected_fields).toEqual(["token"]);
    expect(data.missing).toEqual(["token"]);
    expect(data.setup_instructions).toBe(CANONICAL_SETUP);
    expect(typeof data.message).toBe("string");
  });
});
