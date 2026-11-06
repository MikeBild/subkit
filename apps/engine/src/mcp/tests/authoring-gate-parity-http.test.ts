// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the parameterized recipient `${input.recipient}` is the correct design under test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq } from "drizzle-orm";
import { MCP_ADMIN_SCOPE } from "../../auth/scopes.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { createEmptyDraftDocument } from "../../conversations/authoring-state/index.ts";
import { freshSignals } from "../../conversations/tests/turn-signals.ts";
import { getTool, type ToolContext } from "../../conversations/tools/index.ts";
import { wrapOne } from "../../conversations/tools/sdk-wrap/invoke.ts";
import type { DraftDocument, TurnEvent } from "../../conversations/types.ts";
import { conversations, conversationToolCalls, users } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { makeToolCtx, seedTenant } from "../../test-helpers/seed.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

type Surface = NonNullable<ToolContext["surface"]>;
const LOOP_SURFACES: Surface[] = ["web", "sk_headless", "sk_interactive", "chat", "mcp"];

const REPLACE_ME_SENTENCE =
  'placeholder destination "REPLACE_ME" — a reserved example or placeholder that cannot be delivered, even when the user typed it; ask the user for the real value with ask_user_text or ask_user_form and never fill it with a placeholder.';

const PLACEHOLDER_PATCH = {
  step_patches: [{ step_id: "send", op: "replace", path: "/body/to", value: "REPLACE_ME" }],
};
const UNKNOWN_FUNCTION_PATCH = {
  patches: [
    {
      op: "add",
      path: "/output_transform",
      value: "$indexOf(send.items, 'x')",
    },
  ],
};

let suite: McpTestSuite;
let adminClient: Client;
let principal: ResolvedPrincipal;
const previousLlmProvider = process.env.LLM_PROVIDER;

function seedDraft(): DraftDocument {
  const draft = createEmptyDraftDocument("workflow_authoring");
  draft.workflow = {
    name: "Gate parity",
    slug: "gate-parity",
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: "https://api.acme.com/send",
        body: { to: "${input.recipient}", subject: "Report" },
      },
    ],
  };
  return draft;
}

async function newConversation(draft: DraftDocument | null): Promise<string> {
  const [row] = await suite.http.db
    .insert(conversations)
    .values({
      tenant_id: suite.http.tenantId,
      owner_id: suite.http.userId,
      status: "active",
      ...(draft ? { draft } : {}),
    })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation seed failed");
  return row.id;
}

function toolCtx(conversation_id: string, surface: Surface, draft: DraftDocument): ToolContext {
  return makeToolCtx({
    db: suite.http.db,
    tenant_id: suite.http.tenantId,
    conversation_id,
    actor_id: suite.http.userId,
    principal,
    getDraft: () => draft,
    setDraft: async () => {},
    surface,
  });
}

async function runWrappedTool(
  surface: Surface,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const draft = seedDraft();
  const conversationId = await newConversation(draft);
  const inner = getTool(tool);
  if (!inner) throw new Error(`${tool} is not registered`);
  const events: TurnEvent[] = [];
  const wrapped = wrapOne(
    inner,
    toolCtx(conversationId, surface, draft),
    freshSignals(),
    events,
    suite.http.db,
    {},
    "auto",
    [],
  );
  return wrapped.execute!(args, {
    toolCallId: `authoring-gate-${surface}-${tool}`,
    messages: [],
    context: {},
  });
}

async function recordedOutput(conversationId: string, tool: string): Promise<unknown> {
  const row = await waitFor(
    async () => {
      const rows = await suite.http.db
        .select({ output: conversationToolCalls.output })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, suite.http.tenantId),
            eq(conversationToolCalls.conversation_id, conversationId),
            eq(conversationToolCalls.tool, tool),
          ),
        );
      const done = rows.find((r) => r.output !== null);
      return done ?? null;
    },
    { tries: 500, sleepMs: 10, label: `${tool} output recorded` },
  );
  return row.output;
}

async function runThroughHttpConversation(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const conversationId = await newConversation(seedDraft());
  getMockProvider().setConversePlan(conversationId, [{ tool, args }]);
  const res = await fetch(`${suite.http.baseUrl}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${suite.http.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: "Adjust the workflow." }),
  });
  expect([200, 202]).toContain(res.status);
  return recordedOutput(conversationId, tool);
}

async function runThroughMcpConversation(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const conversationId = await newConversation(seedDraft());
  getMockProvider().setConversePlan(conversationId, [{ tool, args }]);
  const result = await adminClient.callTool({
    name: "conversation_append",
    arguments: { conversation_id: conversationId, message: "Adjust the workflow." },
    _meta: { sk_permission_mode: "auto" },
  });
  expect(result.isError).toBe(false);
  return recordedOutput(conversationId, tool);
}

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  suite = await startMcpTestSuite("authoring-gate-parity-http", { withQueue: true });
  principal = {
    provider: "test",
    kind: "user",
    id: suite.http.userId,
    tenant_id: suite.http.tenantId,
    roles: ["admin"],
  };
  const admin = await suite.issueApiKey([MCP_ADMIN_SCOPE]);
  adminClient = await suite.connectWithApiKey(admin.plaintext);
}, 60_000);

afterAll(async () => {
  if (previousLlmProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousLlmProvider;
  await suite?.cleanup();
}, 30_000);

interface Gate {
  code: string;
  errors: string[];
  placeholders: Array<{ path: string; match: string; kind: string }>;
  requires_user_input: boolean;
  next_best_actions: string[];
}

function projectGate(output: unknown): Gate {
  const root = (output ?? {}) as Record<string, unknown>;
  const data = (
    root.data && typeof root.data === "object" ? { ...root, ...(root.data as object) } : root
  ) as Record<string, unknown>;
  const code = (data.error_code ?? data.error) as string;
  const errors = Array.isArray(data.errors)
    ? (data.errors as Array<{ path: string; message: string }>).map(
        (e) => `${e.path}: ${e.message}`,
      )
    : [];
  return {
    code,
    errors,
    placeholders: (data.placeholder_destinations ?? []) as Gate["placeholders"],
    requires_user_input: data.requires_user_input === true,
    next_best_actions: (data.next_best_actions ?? []) as string[],
  };
}

async function postWorkflow(path: string, def: Record<string, unknown>) {
  const res = await fetch(`${suite.http.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${suite.http.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(def),
  });
  const body = (await res.json()) as {
    ok?: boolean;
    errors?: unknown;
    details?: { errors?: string[] };
  };
  return { status: res.status, body };
}

function definition(slug: string, extra: Record<string, unknown>, to = "ops@acme.com") {
  return {
    name: slug,
    slug,
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: "https://api.acme.com/send",
        body: { to },
      },
    ],
    ...extra,
  };
}

function httpErrorStrings(body: { errors?: unknown; details?: { errors?: string[] } }): string[] {
  const raw = body.details?.errors ?? body.errors ?? [];
  return (raw as unknown[]).map((e) =>
    typeof e === "string"
      ? e
      : `${(e as { path: string }).path}: ${(e as { message: string }).message}`,
  );
}

describe("placeholder destination gate answers identically on every authoring surface", () => {
  test("edit_workflow_patch refuses the same placeholder with the same payload on all five loop surfaces", async () => {
    const gates: Gate[] = [];
    for (const surface of LOOP_SURFACES) {
      gates.push(
        projectGate(await runWrappedTool(surface, "edit_workflow_patch", PLACEHOLDER_PATCH)),
      );
    }
    const first = gates[0]!;
    expect(first.code).toBe("workflow_placeholder_destination");
    expect(first.requires_user_input).toBe(true);
    expect(first.next_best_actions).toEqual(["ask_user_text", "ask_user_form", "author_workflow"]);
    expect(first.placeholders).toEqual([
      expect.objectContaining({
        path: "steps.send.body.to",
        match: "REPLACE_ME",
        kind: expect.any(String),
      }),
    ]);
    for (const gate of gates) expect(gate).toEqual(first);
  }, 60_000);

  test("the real loop over HTTP (web) and over /mcp conversation_append answer like the direct tool", async () => {
    const direct = projectGate(
      await runWrappedTool("web", "edit_workflow_patch", PLACEHOLDER_PATCH),
    );
    const overHttp = projectGate(
      await runThroughHttpConversation("edit_workflow_patch", PLACEHOLDER_PATCH),
    );
    const overMcp = projectGate(
      await runThroughMcpConversation("edit_workflow_patch", PLACEHOLDER_PATCH),
    );
    expect(overHttp).toEqual(direct);
    expect(overMcp).toEqual(direct);
  }, 60_000);

  test("POST /v1/workflows and /validate state the same sentence the loop tools state", async () => {
    const direct = projectGate(
      await runWrappedTool("sk_headless", "edit_workflow_patch", PLACEHOLDER_PATCH),
    );
    const sentence = `steps.send.body.to: ${REPLACE_ME_SENTENCE}`;
    expect(direct.placeholders[0]?.path).toBe("steps.send.body.to");

    const created = await postWorkflow(
      "/v1/workflows",
      definition("gate-parity-create", {}, "REPLACE_ME"),
    );
    expect(created.status).toBe(400);
    expect(httpErrorStrings(created.body)).toContain(sentence);

    const validated = await postWorkflow(
      "/v1/workflows/validate",
      definition("gate-parity-validate", {}, "REPLACE_ME"),
    );
    expect(validated.status).toBe(200);
    expect(validated.body.ok).toBe(false);
    expect(httpErrorStrings(validated.body)).toContain(sentence);
  }, 60_000);

  test("a placeholder gate refusal never persists a workflow on any surface", async () => {
    const created = await postWorkflow(
      "/v1/workflows",
      definition("gate-parity-nothing", {}, "REPLACE_ME"),
    );
    expect(created.status).toBe(400);
    const list = await fetch(`${suite.http.baseUrl}/v1/workflows`, {
      headers: { authorization: `Bearer ${suite.http.apiKey}` },
    });
    const text = await list.text();
    expect(text).not.toContain("gate-parity-nothing");
  }, 30_000);
});

describe("unknown JSONata function check answers identically on every authoring surface", () => {
  test("edit_workflow_patch reports the same finding on all five loop surfaces", async () => {
    const gates: Gate[] = [];
    for (const surface of LOOP_SURFACES) {
      gates.push(
        projectGate(await runWrappedTool(surface, "edit_workflow_patch", UNKNOWN_FUNCTION_PATCH)),
      );
    }
    const first = gates[0]!;
    expect(first.code).toBe("patch_invalid");
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toStartWith("output_transform: JSONata has no function `$indexOf`");
    for (const gate of gates) expect(gate).toEqual(first);
  }, 60_000);

  test("the real loop over HTTP (web) and over /mcp conversation_append answer like the direct tool", async () => {
    const direct = projectGate(
      await runWrappedTool("web", "edit_workflow_patch", UNKNOWN_FUNCTION_PATCH),
    );
    const overHttp = projectGate(
      await runThroughHttpConversation("edit_workflow_patch", UNKNOWN_FUNCTION_PATCH),
    );
    const overMcp = projectGate(
      await runThroughMcpConversation("edit_workflow_patch", UNKNOWN_FUNCTION_PATCH),
    );
    expect(overHttp).toEqual(direct);
    expect(overMcp).toEqual(direct);
  }, 60_000);

  test("POST /v1/workflows and /v1/workflows/drafts return the loop tool's message verbatim", async () => {
    const direct = projectGate(
      await runWrappedTool("web", "edit_workflow_patch", UNKNOWN_FUNCTION_PATCH),
    );
    const def = definition("gate-parity-jsonata", {
      output_transform: "$indexOf(send.items, 'x')",
    });

    const created = await postWorkflow("/v1/workflows", def);
    expect(created.status).toBe(400);
    expect(httpErrorStrings(created.body)).toEqual(direct.errors);

    const draft = await postWorkflow("/v1/workflows/drafts", { definition: def });
    expect(draft.status).toBe(400);
    expect(JSON.stringify(draft.body)).toContain(direct.errors[0] ?? "missing");
  }, 60_000);

  test("POST /v1/workflows/validate reports the same finding instead of ok:true", async () => {
    const direct = projectGate(
      await runWrappedTool("web", "edit_workflow_patch", UNKNOWN_FUNCTION_PATCH),
    );
    const def = definition("gate-parity-validate-jsonata", {
      output_transform: "$indexOf(send.items, 'x')",
    });
    const validated = await postWorkflow("/v1/workflows/validate", def);
    expect(validated.status).toBe(200);
    expect(validated.body.ok).toBe(false);
    expect(httpErrorStrings(validated.body)).toEqual(direct.errors);
  }, 60_000);

  test("a built-in function passes on the loop and on HTTP alike", async () => {
    const accepted = await runWrappedTool("web", "edit_workflow_patch", {
      patches: [{ op: "add", path: "/output_transform", value: "$count(send.items)" }],
    });
    expect((accepted as { ok?: boolean }).ok).toBe(true);
    const created = await postWorkflow(
      "/v1/workflows",
      definition("gate-parity-builtin", { output_transform: "$count(send.items)" }),
    );
    expect(created.status).toBe(201);
  }, 60_000);
});

describe("tenant isolation of the gate", () => {
  test("another tenant's admin cannot drive a conversation of this tenant and no output is recorded", async () => {
    const otherTenant = await seedTenant(suite.http.db, {
      slug: "gate-parity-other-tenant",
      display_name: "Gate parity other",
    });
    const [otherUser] = await suite.http.db
      .insert(users)
      .values({
        tenant_id: otherTenant.id,
        email: "other@gate-parity.test.local",
        role_id: await builtinRoleId(suite.http.db, "admin"),
      })
      .returning({ id: users.id });
    if (!otherUser) throw new Error("other user seed failed");
    const foreignKey = await suite.issueApiKeyForTenant(otherTenant.id, otherUser.id, [
      MCP_ADMIN_SCOPE,
    ]);
    const conversationId = await newConversation(seedDraft());
    getMockProvider().setConversePlan(conversationId, [
      { tool: "edit_workflow_patch", args: PLACEHOLDER_PATCH },
    ]);
    const foreign = await suite.connectWithApiKey(foreignKey.plaintext);
    const result = await foreign.callTool({
      name: "conversation_append",
      arguments: { conversation_id: conversationId, message: "Adjust the workflow." },
    });
    expect(result.isError).toBe(true);
    const recorded = await suite.http.db
      .select({ id: conversationToolCalls.id })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversationId));
    expect(recorded).toHaveLength(0);
  }, 30_000);
});
