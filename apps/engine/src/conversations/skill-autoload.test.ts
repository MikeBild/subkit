// Pure-matcher unit tests for the data-driven autoload.
//
// Parity-matrix design: instead of importing `loadActivationCatalog`
// (which needs a DB), we hand-roll a tiny ActivationRecord catalog that
// mirrors the shipped seed-skill `activates_when` rules. Every (tool,
// input) tuple covered by the legacy `RULES` table has its own assertion
// here so the rewrite cannot regress against the historical contract.

import { describe, expect, test } from "bun:test";
import {
  type ActivationRecord,
  autoloadForToolCall,
  autoloadForUserTurn,
  listBaselineSlugs,
  reaffirmLoadedForTurn,
} from "./skill-autoload.ts";

const CATALOG: ActivationRecord[] = [
  {
    slug: "subkit-concepts",
    activates_when: [{ kind: "baseline" }],
    maturity: "stable",
    side_effects: "read",
    tags: ["foundations"],
  },
  {
    slug: "error-recovery",
    activates_when: [{ kind: "baseline" }, { kind: "intent_keyword", word: "error" }],
    maturity: "stable",
    side_effects: "read",
    tags: ["authoring", "errors"],
  },
  {
    slug: "http-connectors",
    activates_when: [
      { kind: "tool", tool: "probe_connector" },
      { kind: "tool_arg", tool: "propose_step", path: "step.kind", equals: "request" },
      { kind: "connector_driver", driver: "http" },
    ],
    maturity: "stable",
    side_effects: "read",
    tags: ["driver", "http"],
  },
  {
    slug: "postgres-connectors",
    activates_when: [{ kind: "connector_driver", driver: "postgres" }],
    maturity: "stable",
    side_effects: "write",
    tags: ["driver", "postgres"],
  },
  {
    slug: "graphql-connectors",
    activates_when: [{ kind: "connector_driver", driver: "graphql" }],
    maturity: "stable",
    side_effects: "read",
    tags: ["driver"],
  },
  {
    slug: "s3-connectors",
    activates_when: [{ kind: "connector_driver", driver: "s3" }],
    maturity: "stable",
    side_effects: "write",
    tags: ["driver"],
  },
  {
    slug: "data-handling",
    activates_when: [
      { kind: "tool_arg", tool: "propose_step", path: "step.kind", equals: "transform" },
    ],
    maturity: "stable",
    side_effects: "read",
    tags: [],
  },
  {
    slug: "workflow-authoring",
    activates_when: [
      { kind: "tool", tool: "build_workflow" },
      { kind: "tool", tool: "approve_discovery_artifact" },
      { kind: "tool", tool: "preview_attachment" },
    ],
    maturity: "stable",
    side_effects: "read",
    tags: [],
  },
  {
    slug: "self-healing",
    activates_when: [
      { kind: "tool", tool: "approve_patch_candidate" },
      { kind: "tool", tool: "approve_skill_candidate" },
    ],
    maturity: "stable",
    side_effects: "read",
    tags: [],
  },
  {
    slug: "rbac-and-scopes",
    activates_when: [{ kind: "tool", tool: "test_rbac_expression" }],
    maturity: "stable",
    side_effects: "read",
    tags: [],
  },
  {
    slug: "experimental-thing",
    activates_when: [{ kind: "tool", tool: "probe_connector" }],
    maturity: "experimental",
    side_effects: "read",
    tags: [],
  },
];

describe("reaffirmLoadedForTurn — recency re-affirmation (inverse of one-way add)", () => {
  test("always re-affirms baseline loaded slugs (user_turn)", () => {
    const out = reaffirmLoadedForTurn(
      { mode: "user_turn", user_text: "nothing relevant here" },
      CATALOG,
      ["subkit-concepts", "error-recovery"],
    );
    // Both carry a baseline rule → re-affirmed regardless of text.
    expect(out).toContain("subkit-concepts");
    expect(out).toContain("error-recovery");
  });

  test("re-affirms a loaded slug whose intent_keyword still matches", () => {
    const out = reaffirmLoadedForTurn({ mode: "user_turn", user_text: "I hit an error" }, CATALOG, [
      "error-recovery",
    ]);
    expect(out).toContain("error-recovery");
  });

  test("re-affirms a loaded slug whose connector_driver is still in scope", () => {
    const out = reaffirmLoadedForTurn(
      { mode: "user_turn", user_text: "no keyword", connector_drivers: ["postgres"] },
      CATALOG,
      ["postgres-connectors"],
    );
    expect(out).toContain("postgres-connectors");
  });

  test("returns [] for a loaded slug with no current match", () => {
    const out = reaffirmLoadedForTurn(
      { mode: "user_turn", user_text: "unrelated chatter" },
      CATALOG,
      ["postgres-connectors"],
    );
    expect(out).toEqual([]);
  });

  test("never returns a slug that is NOT in currently_loaded (re-affirm only, never add)", () => {
    const out = reaffirmLoadedForTurn(
      { mode: "user_turn", user_text: "I hit an error", connector_drivers: ["postgres"] },
      CATALOG,
      // error-recovery would match but it is NOT loaded → must not appear.
      ["subkit-concepts"],
    );
    expect(out).not.toContain("error-recovery");
    expect(out).not.toContain("postgres-connectors");
    expect(out).toContain("subkit-concepts");
  });

  test("drops experimental loaded slugs without throwing (re-load to re-promote)", () => {
    const out = reaffirmLoadedForTurn({ mode: "user_turn", user_text: "anything" }, CATALOG, [
      "experimental-thing",
    ]);
    expect(out).not.toContain("experimental-thing");
  });

  test("tool_call mode re-affirms a loaded slug whose tool rule matches", () => {
    const out = reaffirmLoadedForTurn(
      { mode: "tool_call", tool: "probe_connector", input: {} },
      CATALOG,
      ["http-connectors"],
    );
    expect(out).toContain("http-connectors");
  });
});

describe("autoloadForToolCall — RULES parity matrix", () => {
  test("probe_connector → http-connectors", () => {
    expect(autoloadForToolCall({ tool: "probe_connector", input: {} }, CATALOG, [])).toContain(
      "http-connectors",
    );
  });

  test("propose_step kind=request → http-connectors", () => {
    expect(
      autoloadForToolCall(
        { tool: "propose_step", input: { step: { kind: "request" } } },
        CATALOG,
        [],
      ),
    ).toContain("http-connectors");
  });

  test("propose_step config.driver=postgres → postgres-connectors (via inferred driver)", () => {
    expect(
      autoloadForToolCall(
        { tool: "propose_step", input: { step: { config: { driver: "postgres" } } } },
        CATALOG,
        [],
      ),
    ).toContain("postgres-connectors");
  });

  test("propose_step config.driver=graphql → graphql-connectors", () => {
    expect(
      autoloadForToolCall(
        { tool: "propose_step", input: { step: { config: { driver: "graphql" } } } },
        CATALOG,
        [],
      ),
    ).toContain("graphql-connectors");
  });

  test("propose_step kind=transform → data-handling", () => {
    expect(
      autoloadForToolCall(
        { tool: "propose_step", input: { step: { kind: "transform" } } },
        CATALOG,
        [],
      ),
    ).toContain("data-handling");
  });

  test("build_workflow → workflow-authoring", () => {
    expect(
      autoloadForToolCall({ tool: "build_workflow", input: { steps: [] } }, CATALOG, []),
    ).toContain("workflow-authoring");
  });

  test("build_workflow with postgres step → adds postgres-connectors", () => {
    const out = autoloadForToolCall(
      {
        tool: "build_workflow",
        input: { steps: [{ config: { driver: "postgres" } }] },
      },
      CATALOG,
      [],
    );
    expect(out).toContain("postgres-connectors");
    expect(out).toContain("workflow-authoring");
  });

  test("build_workflow with s3 step → adds s3-connectors", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "build_workflow",
          input: { steps: [{ config: { driver: "s3" } }] },
        },
        CATALOG,
        [],
      ),
    ).toContain("s3-connectors");
  });

  test("build_workflow with graphql step → adds graphql-connectors", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "build_workflow",
          input: { steps: [{ graphql: { query: "{__typename}" } }] },
        },
        CATALOG,
        [],
      ),
    ).toContain("graphql-connectors");
  });

  test("approve_patch_candidate / approve_skill_candidate → self-healing", () => {
    expect(
      autoloadForToolCall({ tool: "approve_patch_candidate", input: {} }, CATALOG, []),
    ).toContain("self-healing");
    expect(
      autoloadForToolCall({ tool: "approve_skill_candidate", input: {} }, CATALOG, []),
    ).toContain("self-healing");
  });

  test("test_rbac_expression → rbac-and-scopes", () => {
    expect(autoloadForToolCall({ tool: "test_rbac_expression", input: {} }, CATALOG, [])).toContain(
      "rbac-and-scopes",
    );
  });
});

describe("autoloadForToolCall — invariants", () => {
  test("currently-loaded slugs are filtered out", () => {
    expect(
      autoloadForToolCall({ tool: "probe_connector", input: {} }, CATALOG, ["http-connectors"]),
    ).not.toContain("http-connectors");
  });

  test("experimental skill is NEVER returned even when matched", () => {
    expect(autoloadForToolCall({ tool: "probe_connector", input: {} }, CATALOG, [])).not.toContain(
      "experimental-thing",
    );
  });

  test("tool_arg with missing path resolves to no-match (does not crash)", () => {
    expect(autoloadForToolCall({ tool: "propose_step", input: {} }, CATALOG, [])).not.toContain(
      "data-handling",
    );
  });

  test("ranking is deterministic by tag count then slug", () => {
    // postgres-connectors (2 tags) ranks before s3-connectors (1 tag)
    // when both match a build_workflow turn that mentions both drivers.
    const out = autoloadForToolCall(
      {
        tool: "build_workflow",
        input: { steps: [{ config: { driver: "postgres" } }, { config: { driver: "s3" } }] },
      },
      CATALOG,
      [],
    );
    const pIdx = out.indexOf("postgres-connectors");
    const sIdx = out.indexOf("s3-connectors");
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(pIdx).toBeLessThan(sIdx);
  });

  test("ScopeFacts.connector_drivers fires connector_driver rules", () => {
    expect(
      autoloadForToolCall(
        { tool: "list_workflows", input: {}, connector_drivers: ["postgres"] },
        CATALOG,
        [],
      ),
    ).toContain("postgres-connectors");
  });
});

describe("autoloadForUserTurn", () => {
  test("first-turn baseline returns subkit-concepts + error-recovery", () => {
    const out = autoloadForUserTurn({ user_text: "hi there", first_turn: true }, CATALOG, []);
    expect(out).toContain("subkit-concepts");
    expect(out).toContain("error-recovery");
  });

  test("intent_keyword match (case-insensitive)", () => {
    expect(autoloadForUserTurn({ user_text: "ERROR happened" }, CATALOG, [])).toContain(
      "error-recovery",
    );
  });

  test("non-first-turn does NOT load baseline-only skills", () => {
    expect(autoloadForUserTurn({ user_text: "hello" }, CATALOG, [])).not.toContain(
      "subkit-concepts",
    );
  });
});

describe("listBaselineSlugs", () => {
  test("returns every skill with kind:baseline, sorted lexicographically", () => {
    expect(listBaselineSlugs(CATALOG)).toEqual(["error-recovery", "subkit-concepts"]);
  });
});

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

  test("propose_step kind=wait → activates wait-step-skill", () => {
    expect(
      autoloadForToolCall(
        { tool: "propose_step", input: { step: { kind: "wait", duration_ms: 5000 } } },
        STEP_KIND_CATALOG,
        [],
      ),
    ).toContain("wait-step-skill");
  });

  test("propose_step kind=request → does NOT activate wait-step-skill", () => {
    expect(
      autoloadForToolCall(
        { tool: "propose_step", input: { step: { kind: "request" } } },
        STEP_KIND_CATALOG,
        [],
      ),
    ).not.toContain("wait-step-skill");
  });

  test("build_workflow with steps[].kind=wait → activates wait-step-skill", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "build_workflow",
          input: {
            steps: [
              { kind: "request", id: "a" },
              { kind: "wait", id: "b", duration_ms: 1000 },
            ],
          },
        },
        STEP_KIND_CATALOG,
        [],
      ),
    ).toContain("wait-step-skill");
  });

  test("build_workflow with branch.then_steps[].kind=loop → activates branch-and-loop-skill", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "build_workflow",
          input: {
            steps: [
              {
                kind: "branch",
                id: "b1",
                then_steps: [{ kind: "loop", id: "l1" }],
                else_steps: [],
              },
            ],
          },
        },
        STEP_KIND_CATALOG,
        [],
      ),
    ).toContain("branch-and-loop-skill");
  });

  test("user-turn signals do NOT trigger step_kind rules", () => {
    expect(
      autoloadForUserTurn({ user_text: "wait for something" }, STEP_KIND_CATALOG, []),
    ).not.toContain("wait-step-skill");
  });
});
