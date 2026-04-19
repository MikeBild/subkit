// Skill auto-load rule tests — pure, no DB, no LLM.

import { describe, expect, test } from "bun:test";
import {
  BASELINE_SKILLS,
  baselineSkillsToLoad,
  shouldAutoloadSkillsForTool,
} from "../skill-autoload.ts";

describe("BASELINE_SKILLS", () => {
  test("contains the core-concepts + error-recovery slugs", () => {
    expect(BASELINE_SKILLS).toContain("subkit-concepts");
    expect(BASELINE_SKILLS).toContain("error-recovery");
  });

  test("baselineSkillsToLoad filters out already-loaded slugs", () => {
    expect(baselineSkillsToLoad([]).sort()).toEqual([...BASELINE_SKILLS].sort());
    expect(baselineSkillsToLoad(["subkit-concepts"])).toEqual(["error-recovery"]);
    expect(baselineSkillsToLoad([...BASELINE_SKILLS])).toEqual([]);
  });
});

describe("shouldAutoloadSkillsForTool — tool-name-only rules", () => {
  test("probe_connector → http-connectors", () => {
    const s = shouldAutoloadSkillsForTool("probe_connector", {}, []);
    expect(s).toContain("http-connectors");
  });

  test("approve_patch_candidate → self-healing", () => {
    const s = shouldAutoloadSkillsForTool("approve_patch_candidate", {}, []);
    expect(s).toEqual(["self-healing"]);
  });

  test("test_rbac_expression → rbac-and-scopes", () => {
    const s = shouldAutoloadSkillsForTool("test_rbac_expression", {}, []);
    expect(s).toEqual(["rbac-and-scopes"]);
  });

  test("unknown tool → no auto-load", () => {
    expect(shouldAutoloadSkillsForTool("list_workflows", {}, [])).toEqual([]);
  });
});

describe("shouldAutoloadSkillsForTool — input-predicate rules", () => {
  test("propose_step with request kind → http-connectors", () => {
    const s = shouldAutoloadSkillsForTool(
      "propose_step",
      { step: { id: "x", kind: "request", method: "GET", path: "/x" } },
      [],
    );
    expect(s).toContain("http-connectors");
  });

  test("propose_step with transform kind → data-handling", () => {
    const s = shouldAutoloadSkillsForTool(
      "propose_step",
      { step: { id: "x", kind: "transform", expression: "data" } },
      [],
    );
    expect(s).toContain("data-handling");
  });

  test("propose_step with postgres driver → postgres-connectors", () => {
    const s = shouldAutoloadSkillsForTool(
      "propose_step",
      { step: { id: "x", kind: "request", config: { driver: "postgres", query: "select" } } },
      [],
    );
    expect(s).toContain("postgres-connectors");
  });

  test("build_workflow always loads workflow-authoring", () => {
    const s = shouldAutoloadSkillsForTool(
      "build_workflow",
      { name: "x", slug: "x", steps: [{ id: "a", kind: "wait", duration_ms: 10 }] },
      [],
    );
    expect(s).toContain("workflow-authoring");
  });

  test("build_workflow with s3 driver step → s3-connectors", () => {
    const s = shouldAutoloadSkillsForTool(
      "build_workflow",
      {
        steps: [
          {
            id: "a",
            kind: "request",
            config: { driver: "s3", bucket: "b" },
          },
        ],
      },
      [],
    );
    expect(s).toContain("s3-connectors");
  });

  test("build_workflow with graphql driver step → graphql-connectors", () => {
    const s = shouldAutoloadSkillsForTool(
      "build_workflow",
      {
        steps: [
          {
            id: "a",
            kind: "request",
            config: { driver: "graphql", query: "{ ok }" },
          },
        ],
      },
      [],
    );
    expect(s).toContain("graphql-connectors");
  });
});

describe("shouldAutoloadSkillsForTool — dedup", () => {
  test("skill already loaded → not returned again", () => {
    const s = shouldAutoloadSkillsForTool("probe_connector", {}, ["http-connectors"]);
    expect(s).toEqual([]);
  });

  test("two rules fire at once → each skill appears once", () => {
    const s = shouldAutoloadSkillsForTool(
      "build_workflow",
      {
        steps: [
          { id: "a", kind: "request", config: { driver: "postgres" } },
          { id: "b", kind: "transform", expression: "x" },
        ],
      },
      [],
    );
    // workflow-authoring + postgres-connectors for sure.
    expect(s).toContain("workflow-authoring");
    expect(s).toContain("postgres-connectors");
    // Dedup — no duplicates.
    expect(new Set(s).size).toBe(s.length);
  });
});
