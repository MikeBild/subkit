import { describe, expect, test } from "bun:test";
import { skillAudienceForAuthoringMode } from "../skills/types.ts";
import {
  type ActivationRecord,
  autoloadForToolCall,
  autoloadForUserTurn,
  reaffirmLoadedForTurn,
} from "./skill-autoload.ts";

describe("autoloadForToolCall — step_kind activation rule (A5)", () => {
  const STEP_KIND_CATALOG: ActivationRecord[] = [
    {
      slug: "wait-step-skill",
      activates_when: [{ kind: "step_kind", step_kinds: ["wait"] }],
      maturity: "stable",
      side_effects: "read",
      tags: [],
    },
    {
      slug: "branch-and-loop-skill",
      activates_when: [{ kind: "step_kind", step_kinds: ["branch", "loop"] }],
      maturity: "stable",
      side_effects: "read",
      tags: [],
    },
  ];

  test("edit_workflow_patch adds a wait step → activates wait-step-skill", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            patches: [{ op: "add", path: "/steps/-", value: { kind: "wait", duration_ms: 5000 } }],
          },
        },
        STEP_KIND_CATALOG,
        [],
      ),
    ).toContain("wait-step-skill");
  });

  test("edit_workflow_patch adds a request step → does NOT activate wait-step-skill", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: { patches: [{ op: "add", path: "/steps/-", value: { kind: "request" } }] },
        },
        STEP_KIND_CATALOG,
        [],
      ),
    ).not.toContain("wait-step-skill");
  });

  test("edit_workflow_patch adding a wait step among others → activates wait-step-skill", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            patches: [
              { op: "add", path: "/steps/-", value: { kind: "request", id: "a" } },
              { op: "add", path: "/steps/-", value: { kind: "wait", id: "b", duration_ms: 1000 } },
            ],
          },
        },
        STEP_KIND_CATALOG,
        [],
      ),
    ).toContain("wait-step-skill");
  });

  test("edit_workflow_patch with branch.then_steps[] carrying for_each → activates branch-and-loop-skill", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            patches: [
              {
                op: "add",
                path: "/steps/-",
                value: {
                  kind: "branch",
                  id: "b1",
                  then_steps: [{ kind: "request", id: "l1", for_each: "() => []" }],
                  else_steps: [],
                },
              },
            ],
          },
        },
        STEP_KIND_CATALOG,
        [],
      ),
    ).toContain("branch-and-loop-skill");
  });

  test("a step with for_each counts as a loop structure", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            patches: [
              {
                op: "add",
                path: "/steps/-",
                value: { kind: "request", id: "send", for_each: { items: "${steps.list}" } },
              },
            ],
          },
        },
        STEP_KIND_CATALOG,
        [],
      ),
    ).toContain("branch-and-loop-skill");
  });

  test("setting for_each on an existing step counts as a loop structure", () => {
    for (const input of [
      { step_patches: [{ step_id: "send", op: "add", path: "/for_each", value: { items: "x" } }] },
      { patches: [{ op: "add", path: "/steps/2/for_each", value: { items: "x" } }] },
    ]) {
      expect(
        autoloadForToolCall({ tool: "edit_workflow_patch", input }, STEP_KIND_CATALOG, []),
      ).toContain("branch-and-loop-skill");
    }
  });

  test("step_patches values are inspected for nested step kinds", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            step_patches: [
              { step_id: "outer", op: "add", path: "/then_steps/-", value: { kind: "wait" } },
            ],
          },
        },
        STEP_KIND_CATALOG,
        [],
      ),
    ).toContain("wait-step-skill");
  });

  test("a step_patch on another field does not count as a loop", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            step_patches: [{ step_id: "send", op: "replace", path: "/headers/Accept", value: "x" }],
          },
        },
        STEP_KIND_CATALOG,
        [],
      ),
    ).not.toContain("branch-and-loop-skill");
  });

  test("user-turn signals do NOT trigger step_kind rules", () => {
    expect(
      autoloadForUserTurn({ user_text: "wait for something" }, STEP_KIND_CATALOG, []),
    ).not.toContain("wait-step-skill");
  });
});

describe("applies_to — chat skills stay out of drafting, drafting skills out of chat", () => {
  const AUDIENCE_CATALOG: ActivationRecord[] = [
    {
      slug: "chat-only",
      activates_when: [{ kind: "baseline" }, { kind: "intent_keyword", word: "report" }],
      maturity: "stable",
      side_effects: "read",
      tags: [],
      applies_to: "chat",
    },
    {
      slug: "drafting-only",
      activates_when: [
        { kind: "intent_keyword", word: "report" },
        { kind: "tool", tool: "author_workflow" },
      ],
      maturity: "stable",
      side_effects: "read",
      tags: [],
      applies_to: "authoring",
    },
    {
      slug: "everywhere",
      activates_when: [{ kind: "intent_keyword", word: "report" }],
      maturity: "stable",
      side_effects: "read",
      tags: [],
    },
  ];

  test("a chat turn never autoloads a drafting-only skill", () => {
    const out = autoloadForUserTurn(
      { user_text: "a report please", audience: "chat" },
      AUDIENCE_CATALOG,
      [],
    );
    expect(out).toContain("chat-only");
    expect(out).toContain("everywhere");
    expect(out).not.toContain("drafting-only");
  });

  test("a drafting turn never autoloads or re-affirms a chat-only skill", () => {
    const out = autoloadForUserTurn(
      { user_text: "a report please", audience: "authoring" },
      AUDIENCE_CATALOG,
      [],
    );
    expect(out).toContain("drafting-only");
    expect(out).not.toContain("chat-only");
    expect(
      autoloadForToolCall(
        { tool: "author_workflow", input: {}, audience: "authoring" },
        AUDIENCE_CATALOG,
        [],
      ),
    ).toEqual(["drafting-only"]);
    expect(
      reaffirmLoadedForTurn(
        { mode: "user_turn", user_text: "a report", audience: "authoring" },
        AUDIENCE_CATALOG,
        ["chat-only"],
      ),
    ).toEqual([]);
  });

  test("the draft's authoring mode decides the audience", () => {
    expect(skillAudienceForAuthoringMode("workflow")).toBe("authoring");
    expect(skillAudienceForAuthoringMode("execution")).toBe("chat");
    expect(skillAudienceForAuthoringMode(undefined)).toBe("chat");
  });
});
