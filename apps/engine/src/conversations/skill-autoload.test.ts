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
      {
        kind: "tool_arg",
        tool: "edit_workflow_patch",
        path: "patches[*].value.kind",
        equals: "request",
      },
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
      {
        kind: "tool_arg",
        tool: "edit_workflow_patch",
        path: "patches[*].value.kind",
        equals: "transform",
      },
    ],
    maturity: "stable",
    side_effects: "read",
    tags: [],
  },
  {
    slug: "workflow-authoring",
    activates_when: [
      { kind: "tool", tool: "edit_workflow_patch" },
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

  test("edit_workflow_patch adds a request step → http-connectors", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: { patches: [{ op: "add", path: "/steps/-", value: { kind: "request" } }] },
        },
        CATALOG,
        [],
      ),
    ).toContain("http-connectors");
  });

  test("edit_workflow_patch config.driver=postgres → postgres-connectors (via inferred driver)", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            patches: [{ op: "add", path: "/steps/-", value: { config: { driver: "postgres" } } }],
          },
        },
        CATALOG,
        [],
      ),
    ).toContain("postgres-connectors");
  });

  test("edit_workflow_patch config.driver=graphql → graphql-connectors", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            patches: [{ op: "add", path: "/steps/-", value: { config: { driver: "graphql" } } }],
          },
        },
        CATALOG,
        [],
      ),
    ).toContain("graphql-connectors");
  });

  test("edit_workflow_patch adds a transform step → data-handling", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: { patches: [{ op: "add", path: "/steps/-", value: { kind: "transform" } }] },
        },
        CATALOG,
        [],
      ),
    ).toContain("data-handling");
  });

  test("edit_workflow_patch → workflow-authoring", () => {
    expect(
      autoloadForToolCall({ tool: "edit_workflow_patch", input: { patches: [] } }, CATALOG, []),
    ).toContain("workflow-authoring");
  });

  test("edit_workflow_patch with postgres step → adds postgres-connectors", () => {
    const out = autoloadForToolCall(
      {
        tool: "edit_workflow_patch",
        input: {
          patches: [{ op: "add", path: "/steps/-", value: { config: { driver: "postgres" } } }],
        },
      },
      CATALOG,
      [],
    );
    expect(out).toContain("postgres-connectors");
    expect(out).toContain("workflow-authoring");
  });

  test("a repair-shaped step_patches call carries no driver of its own", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            step_patches: [
              {
                step_id: "delete_expired",
                op: "add",
                path: "/s3/scope",
                value: { key_prefix: "reports/a/", max_bytes: 1000, max_deletes: 50 },
              },
            ],
          },
        },
        CATALOG,
        [],
      ),
    ).not.toContain("s3-connectors");
  });

  test("edit_workflow_patch with s3 step → adds s3-connectors", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            patches: [{ op: "add", path: "/steps/-", value: { config: { driver: "s3" } } }],
          },
        },
        CATALOG,
        [],
      ),
    ).toContain("s3-connectors");
  });

  test("edit_workflow_patch with graphql step → adds graphql-connectors", () => {
    expect(
      autoloadForToolCall(
        {
          tool: "edit_workflow_patch",
          input: {
            patches: [
              { op: "add", path: "/steps/-", value: { graphql: { query: "{__typename}" } } },
            ],
          },
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
    expect(
      autoloadForToolCall({ tool: "edit_workflow_patch", input: {} }, CATALOG, []),
    ).not.toContain("data-handling");
  });

  test("ranking is deterministic by tag count then slug", () => {
    const out = autoloadForToolCall(
      {
        tool: "edit_workflow_patch",
        input: {
          patches: [
            { op: "add", path: "/steps/-", value: { config: { driver: "postgres" } } },
            { op: "add", path: "/steps/-", value: { config: { driver: "s3" } } },
          ],
        },
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

  test("authoring-only skill is suppressed on the read-only chat surface", () => {
    const catalog: ActivationRecord[] = [
      {
        slug: "domain-setup-onboarding",
        activates_when: [{ kind: "intent_keyword", word: "music theory" }],
        maturity: "stable",
        side_effects: "read",
        tags: ["onboarding", "authoring-only"],
      },
    ];
    expect(
      autoloadForUserTurn({ user_text: "help with music theory", surface: "mcp" }, catalog, []),
    ).toContain("domain-setup-onboarding");
    expect(autoloadForUserTurn({ user_text: "help with music theory" }, catalog, [])).toContain(
      "domain-setup-onboarding",
    );
    expect(
      autoloadForUserTurn({ user_text: "help with music theory", surface: "chat" }, catalog, []),
    ).not.toContain("domain-setup-onboarding");
  });
});

describe("listBaselineSlugs", () => {
  test("returns every skill with kind:baseline, sorted lexicographically", () => {
    expect(listBaselineSlugs(CATALOG)).toEqual(["error-recovery", "subkit-concepts"]);
  });
});
