import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { scrubString } from "../../apps/engine/src/logging/scrub-secrets.ts";
import {
  boot,
  cli,
  type E2EEnv,
  providerFromEnv,
  realProviderConfigured,
  shutdown,
} from "./setup.ts";

const SHOULD_RUN = realProviderConfigured();

test("a named provider is never silently skipped", () => {
  const named = providerFromEnv();
  const namesReal =
    (named !== undefined && named !== "mock") ||
    Boolean(process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_MODEL);
  if (!namesReal) return;
  expect(SHOULD_RUN).toBe(true);
});

let env: E2EEnv;
beforeAll(async () => {
  if (!SHOULD_RUN) return;
  env = await boot("tier1-real");
  const { applySkillSeedsForAllTenants, loadEmbeddedSkillSeeds } = await import(
    "../../apps/engine/src/skills/seed.ts"
  );
  const embeddedSkills = loadEmbeddedSkillSeeds();
  if (embeddedSkills.errors.length > 0) {
    throw new Error(
      `embedded skill seeds could not load: ${embeddedSkills.errors.map((error) => error.code).join(", ")}`,
    );
  }
  const seedOutcomes = await applySkillSeedsForAllTenants(embeddedSkills.skills, env.db);
  if (!seedOutcomes.some((outcome) => outcome.tenant_id === env.tenantId)) {
    throw new Error("embedded skill seed did not complete for the Tier 1 tenant");
  }
  const { detectConfiguredProvider } = await import(
    "../../apps/engine/src/llm/runtime/model-init.ts"
  );
  const resolved = detectConfiguredProvider();
  if (resolved === "mock" || resolved === "unconfigured") {
    throw new Error(
      `tier1 real-LLM suite booted with provider "${resolved}" — the engine config did not pick up the real provider; check boot()'s llm.provider write in tests/e2e/setup.ts`,
    );
  }
}, 90_000);
afterAll(async () => {
  if (!SHOULD_RUN) return;
  await shutdown(env);
}, 30_000);

function adminAuth() {
  return {
    Authorization: `Bearer ${env.personas.admin.apiKey}`,
    "Content-Type": "application/json",
  } as const;
}

interface CreateOutcome {
  conversation: { id: string; status: string; target_workflow_id: string | null };
  events: Array<{
    type: string;
    output?: unknown;
    tool?: string;
    tool_name?: string;
    elicitation_id?: string;
  }>;
  pending_elicitation_id?: string;
}

async function createConversation(initial_message: string): Promise<CreateOutcome> {
  const r = await fetch(`${env.baseUrl}/v1/conversations`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify({ initial_message }),
  });
  if (r.status !== 201) {
    throw new Error(`POST /v1/conversations failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as CreateOutcome;
}

async function appendMessage(id: string, message: string): Promise<CreateOutcome> {
  const r = await fetch(`${env.baseUrl}/v1/conversations/${id}/messages`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify({ message }),
  });
  if (r.status !== 200) {
    throw new Error(`POST .../messages failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as CreateOutcome;
}

async function respondElicitation(
  conv: string,
  elicit: string,
  output: unknown,
  reason?: string,
): Promise<CreateOutcome> {
  const r = await fetch(`${env.baseUrl}/v1/conversations/${conv}/elicitations/${elicit}/respond`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify(reason ? { output, reason } : { output }),
  });
  if (r.status !== 200) {
    throw new Error(`POST .../elicitations/.../respond failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as CreateOutcome;
}

async function getConversation(id: string): Promise<{
  conversation: { id: string; status: string; target_workflow_id: string | null };
  messages: Array<{ role: string; parts: unknown[] }>;
  tool_calls: Array<{ tool: string; outcome: string | null; output: unknown }>;
  draft: unknown;
}> {
  const r = await fetch(`${env.baseUrl}/v1/conversations/${id}`, { headers: adminAuth() });
  if (r.status !== 200) throw new Error(`GET conversation: ${r.status} ${await r.text()}`);
  return (await r.json()) as {
    conversation: { id: string; status: string; target_workflow_id: string | null };
    messages: Array<{ role: string; parts: unknown[] }>;
    tool_calls: Array<{ tool: string; outcome: string | null; output: unknown }>;
    draft: unknown;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function diagnosticText(text: string, maxLength = 1_000): string {
  const scrubbed = scrubString(text);
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
}

function conversationToolSummary(detail: Awaited<ReturnType<typeof getConversation>>): string {
  const workflow = record(record(detail.draft)?.workflow);
  const finalAssistant = [...detail.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const assistant_text = (finalAssistant?.parts ?? [])
    .flatMap((part) => {
      const fields = record(part);
      return fields?.type === "text" && typeof fields.text === "string" ? [fields.text] : [];
    })
    .map((text) => diagnosticText(text));
  const tool_errors = detail.tool_calls.flatMap((call) => {
    const output = record(call.output);
    return typeof output?.error === "string"
      ? [{ tool: call.tool, outcome: call.outcome, error: diagnosticText(output.error, 240) }]
      : [];
  });
  return JSON.stringify({
    conversation_id: detail.conversation.id,
    status: detail.conversation.status,
    target_workflow_id: detail.conversation.target_workflow_id,
    tool_names: detail.tool_calls.map((call) => call.tool),
    message_count: detail.messages.length,
    message_roles: detail.messages.map((message) => message.role),
    final_assistant_text: assistant_text,
    workflow_shape: workflow
      ? {
          execution_privacy: workflow.execution_privacy === "sensitive" ? "sensitive" : "standard",
          has_validation_expression: Boolean(workflow.validation_expression),
          has_validation_function: Boolean(workflow.validation_function),
          has_input_schema: Boolean(workflow.input_schema),
          has_output_schema: Boolean(workflow.output_schema),
          step_kinds: Array.isArray(workflow.steps)
            ? workflow.steps.map((step) => {
                const kind = record(step)?.kind;
                return typeof kind === "string" ? diagnosticText(kind, 40) : null;
              })
            : [],
        }
      : null,
    tool_errors,
  });
}

const MAX_AUTHORING_CONTINUATIONS = 2;
const AUTHORING_CONTINUATION_MESSAGE =
  "Continue the original requested authoring work through all remaining authorized preparation, inspection, validation, preview or probe, and save steps. Do not invent missing input; pause through the normal question or confirmation flow whenever actual user input is required.";

function pendingConfirmationId(outcome: CreateOutcome): string | null {
  if (!outcome.pending_elicitation_id) return null;
  return outcome.events.some(
    (event) =>
      event.type === "elicit_request" &&
      event.elicitation_id === outcome.pending_elicitation_id &&
      event.tool_name === "ask_user_confirm",
  )
    ? outcome.pending_elicitation_id
    : null;
}

function canContinueAuthoring(outcome: CreateOutcome, continuations: number): boolean {
  return (
    outcome.conversation.status === "active" &&
    outcome.conversation.target_workflow_id === null &&
    !outcome.pending_elicitation_id &&
    continuations < MAX_AUTHORING_CONTINUATIONS
  );
}

async function runAuthoringWithApprovals(
  initial_message: string,
  isComplete: (outcome: CreateOutcome) => boolean | Promise<boolean>,
  maxApprovals = 6,
): Promise<{ conversation_id: string; final: CreateOutcome }> {
  let outcome = await createConversation(initial_message);
  const id = outcome.conversation.id;
  let approvals = 0;
  let continuations = 0;

  while (true) {
    if (await isComplete(outcome)) break;
    const confirmationId = pendingConfirmationId(outcome);
    if (confirmationId) {
      if (approvals >= maxApprovals) break;
      outcome = await respondElicitation(id, confirmationId, { confirmed: true });
      approvals += 1;
      continue;
    }
    if (!canContinueAuthoring(outcome, continuations)) break;
    outcome = await appendMessage(id, AUTHORING_CONTINUATION_MESSAGE);
    continuations += 1;
  }
  return { conversation_id: id, final: outcome };
}

test("authoring continuation only advances active non-pending turns within its budget", () => {
  const active: CreateOutcome = {
    conversation: { id: "workflow-continuation", status: "active", target_workflow_id: null },
    events: [],
  };
  expect(canContinueAuthoring(active, 0)).toBe(true);
  expect(canContinueAuthoring(active, MAX_AUTHORING_CONTINUATIONS)).toBe(false);
  expect(canContinueAuthoring({ ...active, pending_elicitation_id: "confirmation" }, 0)).toBe(
    false,
  );
  expect(
    canContinueAuthoring(
      { ...active, conversation: { ...active.conversation, status: "committed" } },
      0,
    ),
  ).toBe(false);
  expect(
    canContinueAuthoring(
      { ...active, conversation: { ...active.conversation, target_workflow_id: "workflow-id" } },
      0,
    ),
  ).toBe(false);
  expect(
    pendingConfirmationId({
      ...active,
      pending_elicitation_id: "confirmation",
      events: [
        {
          type: "elicit_request",
          elicitation_id: "confirmation",
          tool_name: "ask_user_confirm",
        },
      ],
    }),
  ).toBe("confirmation");
  expect(
    pendingConfirmationId({
      ...active,
      pending_elicitation_id: "form",
      events: [{ type: "elicit_request", elicitation_id: "form", tool_name: "ask_user_form" }],
    }),
  ).toBeNull();
  expect(
    pendingConfirmationId({
      ...active,
      pending_elicitation_id: "form",
      events: [
        {
          type: "elicit_request",
          elicitation_id: "previous-confirmation",
          tool_name: "ask_user_confirm",
        },
        { type: "elicit_request", elicitation_id: "form", tool_name: "ask_user_form" },
      ],
    }),
  ).toBeNull();
});

describe.skipIf(!SHOULD_RUN)("Tier 1.1 — simple conversation (real LLM)", () => {
  test("POST /v1/conversations with `hello` returns 201 + a completed turn", async () => {
    const out = await createConversation("hello, who are you?");
    expect(out.conversation.id).toBeTruthy();
    const types = out.events.map((e) => e.type);
    expect(types).toContain("completed");
    expect(types).toContain("message");
  }, 90_000);
});

describe.skipIf(!SHOULD_RUN)("Tier 1.2 — multi-turn (real LLM)", () => {
  test("appendMessage grows the message list and preserves conversation_id", async () => {
    const first = await createConversation("hi, my favourite number is 42");
    const id = first.conversation.id;
    await appendMessage(id, "what number did i mention?");
    const detail = await getConversation(id);
    expect(detail.conversation.id).toBe(id);
    const userMsgs = detail.messages.filter((m) => m.role === "user");
    const asstMsgs = detail.messages.filter((m) => m.role === "assistant");
    expect(userMsgs.length).toBeGreaterThanOrEqual(2);
    expect(asstMsgs.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

describe.skipIf(!SHOULD_RUN)(
  "Tier 1.3 — connector authoring engages the real tool palette (real LLM)",
  () => {
    test("a chat that asks for a connector triggers start_connector_from_description and reaches confirm/commit", async () => {
      const before = await fetch(`${env.baseUrl}/v1/connectors?limit=200`, {
        headers: adminAuth(),
      }).then((r) => r.json() as Promise<{ items: Array<{ slug: string }> }>);
      const beforeSlugs = new Set(before.items.map((c) => c.slug));
      const expectedConnectorSlug = "open-meteo";
      const expectedConnectorPersisted = async (): Promise<boolean> => {
        const current = await fetch(`${env.baseUrl}/v1/connectors?limit=200`, {
          headers: adminAuth(),
        }).then((r) => r.json() as Promise<{ items: Array<{ slug: string }> }>);
        return current.items.some(
          (connector) =>
            connector.slug === expectedConnectorSlug && !beforeSlugs.has(connector.slug),
        );
      };

      const { conversation_id } = await runAuthoringWithApprovals(
        "Create a connector using start_connector_from_description " +
          "(name 'open-meteo', driver 'http', auth_type 'none', base_url " +
          "'https://api.open-meteo.com'). Then continue through the normal " +
          "probe/save path before building the workflow. When probing, use " +
          "path '/v1/forecast' with query latitude=52.52, longitude=13.41, " +
          "current_weather=true — the API root returns 400 by design.",
        expectedConnectorPersisted,
      );

      const detail = await getConversation(conversation_id);
      const tools = detail.tool_calls.map((t) => t.tool);
      const CONNECTOR_ENTRY_TOOLS = [
        "start_connector_from_description",
        "start_connector_from_template",
      ] as const;
      const usedEntry = CONNECTOR_ENTRY_TOOLS.find((t) => tools.includes(t));
      const after = await fetch(`${env.baseUrl}/v1/connectors?limit=200`, {
        headers: adminAuth(),
      }).then((r) => r.json() as Promise<{ items: Array<{ slug: string; name: string }> }>);
      const newOnes = after.items.filter((c) => !beforeSlugs.has(c.slug));
      try {
        expect(usedEntry).toBeDefined();
        if (usedEntry) {
          expect(newOnes.length).toBeGreaterThanOrEqual(1);
          expect(newOnes.some((connector) => connector.slug === expectedConnectorSlug)).toBe(true);
        }
      } catch (error) {
        const original = error instanceof Error ? error.message : String(error);
        throw new Error(
          `connector authoring contract failed: ${diagnosticText(original, 600)}; ${conversationToolSummary(detail)}; ${JSON.stringify({ expected_connector_slug: expectedConnectorSlug, new_connector_slugs: newOnes.map((connector) => connector.slug) })}`,
        );
      }
    }, 180_000);
  },
);

describe.skipIf(!SHOULD_RUN)(
  "Tier 1.4 — workflow authoring engages the real tool palette (real LLM)",
  () => {
    test("the model authors and previews a workflow through the supported tools", async () => {
      const { conversation_id } = await runAuthoringWithApprovals(
        "Create a workflow that fetches https://jsonplaceholder.typicode.com/users with one GET request and returns its response. " +
          "Use author_workflow, then inspect and preview the draft through dry_run_workflow. " +
          "Prepare and probe a connector first if required. Follow the normal approval and save path.",
        (outcome) => outcome.conversation.target_workflow_id !== null,
      );

      const detail = await getConversation(conversation_id);
      const tools = detail.tool_calls.map((t) => t.tool);

      try {
        const STEP_AUTHORING_TOOLS = ["author_workflow"] as const;
        expect(STEP_AUTHORING_TOOLS.some((t) => tools.includes(t))).toBe(true);
        expect(tools).toContain("dry_run_workflow");

        const workflowId = detail.conversation.target_workflow_id;
        expect(workflowId).toBeTruthy();
        const wfRes = await fetch(`${env.baseUrl}/v1/workflows?limit=200`, {
          headers: adminAuth(),
        });
        const wfBody = (await wfRes.json()) as { items: Array<{ id: string }> };
        expect(wfBody.items.some((workflow) => workflow.id === workflowId)).toBe(true);

        const audit = await fetch(`${env.baseUrl}/v1/audit-log?action=workflow.created&limit=20`, {
          headers: adminAuth(),
        }).then((r) => r.json() as Promise<{ items: Array<{ resource_id: string }> }>);
        expect(audit.items.some((entry) => entry.resource_id === workflowId)).toBe(true);
      } catch (error) {
        const original = error instanceof Error ? error.message : String(error);
        throw new Error(
          `workflow authoring contract failed: ${diagnosticText(original, 600)}; ${conversationToolSummary(detail)}`,
        );
      }
    }, 240_000);
  },
);

describe.skipIf(!SHOULD_RUN)("Tier 1.5 — resume (real LLM)", () => {
  test("subkit -r <id> appends a turn to a pre-existing conversation", async () => {
    const seed = await createConversation("first message: my code word is alpha-foxtrot");
    const id = seed.conversation.id;
    const r = await cli(["--p", "what was my code word?", "-r", id, "--output", "json"], {
      env,
      persona: "admin",
      timeout: 120_000,
    });
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as { session_id: string; status: string };
    expect(body.session_id).toBe(id);
    expect(body.status).toBe("completed");

    const detail = await getConversation(id);
    const userTexts = detail.messages
      .filter((m) => m.role === "user")
      .flatMap((m) =>
        (m.parts as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string),
      );
    expect(userTexts.some((t) => t.includes("first message"))).toBe(true);
    expect(userTexts.some((t) => t.includes("what was my code word"))).toBe(true);
  }, 180_000);
});

describe.skipIf(!SHOULD_RUN)("Tier 1.6 — elicitation reject (real LLM)", () => {
  test("declining ask_user_confirm leaves the conversation un-committed", async () => {
    const out = await createConversation(
      "Create a workflow with a GET request to https://jsonplaceholder.typicode.com/users. " +
        "Before authoring or saving anything, use ask_user_confirm to ask whether I want to proceed. " +
        "If I decline, do not create or save the workflow.",
    );
    const id = out.conversation.id;

    expect(out.pending_elicitation_id).toBeTruthy();
    if (out.pending_elicitation_id) {
      await respondElicitation(
        id,
        out.pending_elicitation_id,
        { confirmed: false },
        "user changed their mind",
      );
    }

    const detail = await getConversation(id);
    expect(detail.conversation.status).not.toBe("committed");
    expect(detail.conversation.target_workflow_id).toBeNull();
  }, 180_000);
});
