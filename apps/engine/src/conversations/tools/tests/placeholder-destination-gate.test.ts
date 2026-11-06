// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the parameterized recipient `${input.recipient}` is the correct design under test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversations, workflows } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../../authoring-state/index.ts";
import { commitWorkflowAtomic } from "../../persistence/commit-workflow.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import { dryRunWorkflowTool } from "../dry-run-workflow.ts";
import { editWorkflowPatchTool } from "../edit-workflow-patch.ts";
import type { ToolContext } from "../index.ts";
import { saveWorkflowDraftTool } from "../save-workflow-draft.ts";

const nextUuid = createDeterministicUuidFactory(0xd357_01);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("placeholder_gate");
});

afterAll(async () => {
  await ctx.cleanup();
});

let fetchCalls = 0;
const tripwire = ((..._args: unknown[]) => {
  fetchCalls += 1;
  throw new Error("live HTTP is forbidden behind the placeholder gate");
}) as unknown as typeof fetch;

function sendStep(to: string): Record<string, unknown> {
  return {
    id: "send",
    kind: "request",
    method: "POST",
    url: "https://api.acme.com/send",
    body: { to, subject: "Droplets" },
  };
}

function draftWith(steps: Array<Record<string, unknown>>): DraftDocument {
  const d = createEmptyDraftDocument("workflow_authoring");
  d.workflow = { name: "Droplet report", slug: "droplet-report", steps };
  return d;
}

function makeCtx(
  initial: DraftDocument,
  opts: { permission_mode?: ToolContext["permission_mode"]; conversation_id?: string } = {},
): ToolContext & { current: () => DraftDocument; writes: () => number } {
  let draft = initial;
  let writes = 0;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: opts.conversation_id ?? nextUuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    ...(opts.permission_mode ? { permission_mode: opts.permission_mode } : {}),
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      writes += 1;
      draft = next;
    },
    current: () => draft,
    writes: () => writes,
  };
}

type GateData = {
  error_code: string;
  requires_user_input: boolean;
  next_best_actions: string[];
  placeholder_destinations: Array<{ path: string; match: string; kind: string }>;
};

function expectPlaceholderGate(result: { ok: boolean; data?: unknown; error_code?: string }) {
  expect(result.ok).toBe(false);
  expect(result.error_code).toBe("workflow_placeholder_destination");
  const data = result.data as GateData;
  expect(data.error_code).toBe("workflow_placeholder_destination");
  expect(data.requires_user_input).toBe(true);
  expect(data.next_best_actions).toEqual(["ask_user_text", "ask_user_form", "author_workflow"]);
  return data;
}

describe("edit_workflow_patch · placeholder destinations", () => {
  test("a patch that fills body.to with a placeholder address is refused and the draft is untouched", async () => {
    const toolCtx = makeCtx(draftWith([sendStep("${input.recipient}")]));
    const before = JSON.stringify(toolCtx.current());
    const result = await editWorkflowPatchTool.execute(toolCtx, {
      step_patches: [
        { step_id: "send", op: "replace", path: "/body/to", value: "user@example.com" },
      ],
    });
    const data = expectPlaceholderGate(result);
    expect(data.placeholder_destinations).toEqual([
      expect.objectContaining({
        path: "steps.send.body.to",
        match: "user@example.com",
        kind: "placeholder_email",
      }),
    ]);
    expect(toolCtx.writes()).toBe(0);
    expect(JSON.stringify(toolCtx.current())).toBe(before);
  });

  test("a patch that adds a step on a placeholder host is refused the same way", async () => {
    const toolCtx = makeCtx(draftWith([sendStep("${input.recipient}")]));
    const result = await editWorkflowPatchTool.execute(toolCtx, {
      patches: [
        {
          op: "add",
          path: "/steps/-",
          value: { id: "fetch", kind: "request", method: "GET", url: "https://api.example.com/x" },
        },
      ],
    });
    const data = expectPlaceholderGate(result);
    expect(data.placeholder_destinations.map((v) => v.path)).toEqual(["steps.fetch.url"]);
    expect(toolCtx.writes()).toBe(0);
  });

  test("a parameterized recipient is the correct design and is accepted", async () => {
    const toolCtx = makeCtx(draftWith([sendStep("ops@acme.com")]));
    const result = await editWorkflowPatchTool.execute(toolCtx, {
      step_patches: [
        { step_id: "send", op: "replace", path: "/body/to", value: "${input.recipient}" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(toolCtx.current().workflow.steps[0]).toMatchObject({
      body: { to: "${input.recipient}" },
    });
  });
});

describe("dry_run_workflow · placeholder destinations", () => {
  test("the preview is refused before any execution, no draft mutation, zero egress", async () => {
    fetchCalls = 0;
    const toolCtx = makeCtx(draftWith([sendStep("user@example.com")]), { permission_mode: "auto" });
    const result = await withSelfHostedDriverFetchForTests(tripwire, () =>
      dryRunWorkflowTool.execute(toolCtx, { input: {} }),
    );
    const data = expectPlaceholderGate(result);
    expect(data.placeholder_destinations.map((v) => v.path)).toEqual(["steps.send.body.to"]);
    expect(toolCtx.writes()).toBe(0);
    expect(toolCtx.current().latest_preview ?? null).toBeNull();
    expect(fetchCalls).toBe(0);
    const persisted = await ctx.testDb.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    expect(persisted).toHaveLength(0);
  });
});

describe("commit gate · placeholder destinations are never persisted", () => {
  function readyDraft(steps: Array<Record<string, unknown>>): DraftDocument {
    let draft = draftWith(steps);
    draft = withWorkflowInspection(draft);
    draft = withWorkflowValidation(draft, true, "Workflow draft validated.");
    draft = withLatestPreview(draft, { ok: true, summary: "preview ok", warnings: [] });
    return draft;
  }

  async function seedConversation(): Promise<string> {
    const [row] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    if (!row) throw new Error("seed conversation failed");
    return row.id;
  }

  test("commitWorkflowAtomic refuses after the inspect/validate gate and persists nothing", async () => {
    const conversation_id = await seedConversation();
    const toolCtx = makeCtx(readyDraft([sendStep("recipient@example.com")]), {
      permission_mode: "auto",
      conversation_id,
    });
    const result = await commitWorkflowAtomic({ ctx: toolCtx, reason: "test" });
    const data = expectPlaceholderGate(result);
    expect(data.placeholder_destinations.map((v) => v.path)).toEqual(["steps.send.body.to"]);
    const persisted = await ctx.testDb.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    expect(persisted).toHaveLength(0);
  });

  test("save_workflow_draft reaches the same gate; the parameterized draft saves", async () => {
    const blockedCtx = makeCtx(readyDraft([sendStep("someone@acme.com")]), {
      permission_mode: "auto",
      conversation_id: await seedConversation(),
    });
    const blocked = await saveWorkflowDraftTool.execute(blockedCtx, {});
    expectPlaceholderGate(blocked);

    const okCtx = makeCtx(readyDraft([sendStep("${input.recipient}")]), {
      permission_mode: "auto",
      conversation_id: await seedConversation(),
    });
    const saved = await saveWorkflowDraftTool.execute(okCtx, {});
    expect(saved.ok).toBe(true);
    const persisted = await ctx.testDb.db
      .select({ slug: workflows.slug })
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    expect(persisted.map((w) => w.slug)).toEqual(["droplet-report"]);
  });
});
