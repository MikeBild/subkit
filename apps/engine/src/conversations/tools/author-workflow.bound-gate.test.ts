// Regenerating is not editing.
//
// `author_workflow` rebuilds the whole definition from a goal, so anything the
// goal does not restate is gone — and the goal-satisfaction judge cannot notice
// what is missing. On a conversation bound to a saved retention workflow that
// cost a real guard: the rewrite dropped the check that stops a listing from
// escaping its partition, validated clean, previewed green and was saved.
//
// The gate refuses a rewrite of the workflow a conversation is bound to
// — with no override. It runs before the pipeline, so a refusal costs no
// generation.

import { expect, test } from "bun:test";
import { bindPersistedWorkflow, createEmptyDraftDocument } from "../authoring-state.ts";
import type { DraftDocument } from "../types.ts";
import { authorWorkflowTool } from "./author-workflow.ts";
import type { ToolContext } from "./index.ts";

const WORKFLOW_ID = "00000000-0000-4000-8000-0000000000a1";
const VERSION_ID = "00000000-0000-4000-8000-0000000000a2";

function boundDraft(): DraftDocument {
  const base = createEmptyDraftDocument();
  return bindPersistedWorkflow(
    {
      ...base,
      workflow: {
        name: "Retention",
        slug: "reporting-retention",
        steps: [{ id: "guard", kind: "transform", expression: "return 1;" }],
      },
    },
    {
      kind: "workflow",
      id: WORKFLOW_ID,
      slug: "reporting-retention",
      name: "Retention",
      version_id: VERSION_ID,
      draft_version_id: null,
      current_version_id: VERSION_ID,
      persistence_kind: "active",
      version: 9,
      environment: null,
      saved_at: "2026-01-01T00:00:00.000Z",
    },
  );
}

/** Every database or engine touch is a generation the gate should have spared. */
function ctxFor(draft: DraftDocument): ToolContext {
  const forbidden = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`the gate let the call through: touched ${String(prop)}`);
      },
    },
  );
  return {
    // biome-ignore lint/suspicious/noExplicitAny: a refused call must never reach these
    db: forbidden as any,
    tenant_id: "00000000-0000-4000-8000-0000000000b1",
    conversation_id: "00000000-0000-4000-8000-0000000000b2",
    actor_id: "00000000-0000-4000-8000-0000000000b3",
    connector_id: null,
    workflow_id: WORKFLOW_ID,
    permission_mode: "auto",
    // biome-ignore lint/suspicious/noExplicitAny: a refused call must never reach these
    engineClient: forbidden as any,
    getDraft: () => draft,
    setDraft: async () => {},
  };
}

test("a rewrite of the bound workflow is refused and points at the patch tool", async () => {
  const result = await authorWorkflowTool.execute(ctxFor(boundDraft()), {
    goal: "give every report area its own delete boundary",
  });
  expect(result.ok).toBe(false);
  const data = result.data as { error_code?: string; message?: string };
  expect(data.error_code).toBe("rewrite_of_bound_workflow");
  expect(data.message).toContain("reporting-retention");
  expect(data.message).toContain("edit_workflow_patch");
  // No override is offered. The first version of this gate named a flag, and
  // the model set it on its very next call — a hatch the caller can open is
  // not a gate. Patches can express any redesign, so this is not a dead end.
  expect(data.message).not.toContain("replace_bound_workflow");
  expect(data.message).toContain("no override");
});

test("restating the bound slug does not get around it", async () => {
  const result = await authorWorkflowTool.execute(ctxFor(boundDraft()), {
    goal: "rebuild it",
    slug: "reporting-retention",
  });
  expect((result.data as { error_code?: string }).error_code).toBe("rewrite_of_bound_workflow");
});

test("an argument cannot open the gate", async () => {
  const result = await authorWorkflowTool.execute(ctxFor(boundDraft()), {
    goal: "deliberate redesign",
    replace_bound_workflow: true,
  });
  expect((result.data as { error_code?: string }).error_code).toBe("rewrite_of_bound_workflow");
});

test("a different slug or an unbound draft are not this gate's business", async () => {
  // Each of these must get PAST the gate. They then reach the forbidden context,
  // which is the proof: the gate itself touches nothing.
  const past = async (draft: DraftDocument, args: Record<string, unknown>) => {
    try {
      const result = await authorWorkflowTool.execute(ctxFor(draft), args);
      return (result.data as { error_code?: string }).error_code ?? "ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  for (const outcome of [
    await past(boundDraft(), { goal: "a new, separate workflow", slug: "something-else" }),
    await past(createEmptyDraftDocument(), { goal: "first workflow in this chat" }),
  ])
    expect(outcome).not.toBe("rewrite_of_bound_workflow");
});
