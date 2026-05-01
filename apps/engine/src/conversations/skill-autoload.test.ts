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
