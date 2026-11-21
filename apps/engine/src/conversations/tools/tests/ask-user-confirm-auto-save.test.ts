import { describe, expect, test } from "bun:test";
import { autoPreparationProceeds, decideToolMode } from "../../tool-policies.ts";
import type { ModelCommitIntent } from "../ask-user/commit-intent.ts";
import { type AutoSaveDeps, saveDraftWithoutPause } from "../ask-user/confirm.ts";

function ctx(
  over: { ask_before_writing?: boolean; surface?: string; workflow?: Record<string, unknown> } = {},
) {
  return {
    ...(over.ask_before_writing ? { ask_before_writing: true } : {}),
    ...(over.surface ? { surface: over.surface } : {}),
    tenant_id: "t",
    conversation_id: "c",
    actor_id: null,
    db: {},
    getDraft: () => ({ summary: null, ...(over.workflow ? { workflow: over.workflow } : {}) }),
    setDraft: async () => undefined,
  } as never;
}

function saveIntent(payload: Record<string, unknown> = {}): ModelCommitIntent {
  return { kind: "save_workflow_draft", payload, description: "Save the draft" };
}

function deps(over: Partial<AutoSaveDeps> = {}) {
  const calls = { commit: 0, readiness: 0 };
  const value: AutoSaveDeps = {
    loadPolicies: async () => ({}),
    checkReadiness: (async () => {
      calls.readiness += 1;
      return { ok: true, verification: {} };
    }) as unknown as AutoSaveDeps["checkReadiness"],
    commit: (async () => {
      calls.commit += 1;
      return { ok: true, data: { workflow_id: "w", version_changed: true } };
    }) as unknown as AutoSaveDeps["commit"],
    ...over,
  };
  return { value, calls };
}

describe("a save the gate would release anyway does not pause", () => {
  test("the direct tool and the commit-intent path agree for an ordinary save", () => {
    expect(
      decideToolMode({
        tool: "save_workflow_draft",
        category: "draft_write",
        input: {},
        overrides: {},
      }).mode,
    ).toBe("no_confirm");
    expect(autoPreparationProceeds({ tool: "save_workflow_draft", input: {}, overrides: {} })).toBe(
      true,
    );
    expect(
      autoPreparationProceeds({
        tool: "save_workflow_draft",
        input: { force_commit: true },
        overrides: {},
      }),
    ).toBe(false);
    expect(autoPreparationProceeds({ tool: "delete_workflow", input: {}, overrides: {} })).toBe(
      false,
    );
  });

  test("an ordinary save intent is saved without creating a confirmation", async () => {
    const d = deps();
    const result = await saveDraftWithoutPause(ctx(), saveIntent(), false, d.value);
    expect(result?.ok).toBe(true);
    expect(d.calls).toEqual({ commit: 1, readiness: 1 });
    expect(result?.data).toMatchObject({
      confirmed: true,
      auto_resolved: true,
      performed: "save_workflow_draft",
      workflow_id: "w",
    });
  });

  test("a failed readiness check is returned and nothing is committed", async () => {
    const refusal = { ok: false, error_code: "workflow_not_ready", data: {} };
    const d = deps({
      checkReadiness: (async () => ({
        ok: false,
        result: refusal,
      })) as unknown as AutoSaveDeps["checkReadiness"],
    });
    const result = await saveDraftWithoutPause(ctx(), saveIntent(), false, d.value);
    expect(result).toEqual(refusal as never);
    expect(d.calls.commit).toBe(0);
  });

  const keepsPause: Array<[string, () => [never, ModelCommitIntent, boolean]]> = [
    ["force_commit", () => [ctx(), saveIntent({ force_commit: true }), false]],
    ["a pinned replacement", () => [ctx(), saveIntent({ target_workflow_id: "x" }), false]],
    ["destructive", () => [ctx(), saveIntent(), true]],
    ["asking before writing", () => [ctx({ ask_before_writing: true }), saveIntent(), false]],
    ["the MCP surface", () => [ctx({ surface: "mcp" }), saveIntent(), false]],
    [
      "a draft derived from a skill",
      () => [ctx({ workflow: { derived_from_skill_id: "risky-skill" } }), saveIntent(), false],
    ],
    [
      "a delete intent",
      () => [
        ctx(),
        { kind: "delete_workflow", payload: { id: "x" }, description: "Delete" },
        false,
      ],
    ],
    [
      "a run intent",
      () => [
        ctx(),
        { kind: "run_workflow", payload: { workflow_id: "x" }, description: "Run" },
        false,
      ],
    ],
    [
      "a connector save with a credential",
      () => [
        ctx(),
        {
          kind: "save_connector_draft",
          payload: { credential: { mode: "api_key" } },
          description: "Save connector",
        },
        false,
      ],
    ],
  ];
  for (const [label, args] of keepsPause) {
    test(`${label} keeps the human confirmation`, async () => {
      const d = deps();
      const [c, intent, destructive] = args();
      expect(await saveDraftWithoutPause(c, intent, destructive, d.value)).toBeNull();
      expect(d.calls.commit).toBe(0);
    });
  }

  test("a conversation override that asks first keeps the confirmation", async () => {
    const d = deps({
      loadPolicies: async () => ({ save_workflow_draft: "confirm_before_execution" }),
    });
    expect(await saveDraftWithoutPause(ctx(), saveIntent(), false, d.value)).toBeNull();
    expect(d.calls.commit).toBe(0);
  });

  test("an unreadable policy store fails closed", async () => {
    const d = deps({
      loadPolicies: async () => {
        throw new Error("db down");
      },
    });
    expect(await saveDraftWithoutPause(ctx(), saveIntent(), false, d.value)).toBeNull();
    expect(d.calls.commit).toBe(0);
  });
});
