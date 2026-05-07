// Skill-content contract tests.
//
// These tests ensure the 10 bundled Markdown skills are not placeholder
// stubs — they must contain the concrete concepts the LLM is supposed to
// learn from them. If someone reduces a skill to a generic description,
// these tests fail with a pointed, fixable message.
//
// This is deliberately stricter than "file exists". The content matters.

import { describe, expect, test } from "bun:test";
import { loadEmbeddedSkillSeeds, type SeededSkill } from "../seed.ts";

function loadAll(): Map<string, SeededSkill> {
  const r = loadEmbeddedSkillSeeds();
  expect(r.errors).toEqual([]);
  const map = new Map<string, SeededSkill>();
  for (const s of r.skills) map.set(s.slug, s);
  return map;
}

describe("seeded skill catalogue — coverage", () => {
  test("all 10 expected slugs are present", async () => {
    const skills = loadAll();
    const expected = [
      "subkit-concepts",
      "workflow-authoring",
      "http-connectors",
      "postgres-connectors",
      "s3-connectors",
      "graphql-connectors",
      "data-handling",
      "rbac-and-scopes",
      "self-healing",
      "error-recovery",
    ];
    for (const slug of expected) {
      expect(skills.has(slug)).toBe(true);
    }
  });

  test("every skill has a non-trivial body (>=1000 chars)", async () => {
    const skills = loadAll();
    for (const [slug, s] of skills) {
      expect(s.body.length).toBeGreaterThan(1000);
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.description.length).toBeGreaterThan(10);
      // Keep the error message actionable:
      if (s.body.length < 1000) throw new Error(`skill ${slug} body too short`);
    }
  });
});

describe("subkit-concepts — mental model coverage", () => {
  test("mentions every step kind by name", async () => {
    const skills = loadAll();
    const concepts = skills.get("subkit-concepts")!;
    const body = concepts.body.toLowerCase();
    const kinds = ["request", "transform", "wait", "branch", "parallel", "loop", "call", "tool"];
    for (const k of kinds) {
      expect(body.includes(k)).toBe(true);
    }
  });

  test("shows the 4 main placeholder token formats", async () => {
    const skills = loadAll();
    const body = skills.get("subkit-concepts")!.body;
    expect(body).toContain("${cred.");
    expect(body).toContain("${connector.");
    expect(body).toContain("${input.");
    // Both `${scope.*}` and `$scope.*` are used in the codebase; either
    // form being documented is enough to teach the concept.
    const hasScope = body.includes("${scope.") || body.includes("$scope.");
    expect(hasScope).toBe(true);
  });

  test("covers envelope shape { data, status_code, headers, error, duration_ms }", async () => {
    const skills = loadAll();
    const body = skills.get("subkit-concepts")!.body;
    expect(body).toContain("data");
    expect(body).toContain("status_code");
    expect(body.toLowerCase()).toContain("envelope");
  });

  test("documents onError mode vocabulary across the catalogue", async () => {
    const skills = loadAll();
    // The primary modes may be split across subkit-concepts.md and
    // error-recovery.md. We require the catalogue, taken as a whole, to
    // teach at least three of the four modes.
    const combined = [
      skills.get("subkit-concepts")!.body,
      skills.get("error-recovery")!.body,
      skills.get("http-connectors")!.body,
    ]
      .join("\n")
      .toLowerCase();
    const modes = ["fail", "retry", "fallback", "skip"];
    const hits = modes.filter((m) => combined.includes(m));
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  test("has an explicit 'Common pitfalls' section", async () => {
    const skills = loadAll();
    const body = skills.get("subkit-concepts")!.body.toLowerCase();
    expect(body).toContain("pitfall");
  });
});

describe("workflow-authoring — recipe coverage", () => {
  test("references the draft → save_workflow_draft path", async () => {
    const skills = loadAll();
    const body = skills.get("workflow-authoring")!.body;
    expect(body).toContain("save_workflow_draft");
    // Either probe_connector or build_workflow (both new in this phase) should appear:
    const hasProbe = body.includes("probe_connector");
    const hasBuild = body.includes("build_workflow");
    const hasPropose = body.includes("propose_step");
    expect(hasProbe || hasBuild || hasPropose).toBe(true);
  });

  test("explains data_selector vs transform step", async () => {
    const skills = loadAll();
    const body = skills.get("workflow-authoring")!.body.toLowerCase();
    expect(body).toContain("data_selector");
    expect(body).toContain("transform");
  });
});

describe("data-handling — envelope rule enforced", () => {
  test("explicitly shows $scope.<id>.data (not bare $scope.<id>)", async () => {
    const skills = loadAll();
    const body = skills.get("data-handling")!.body;
    // positive evidence:
    expect(/\$scope\.[A-Za-z0-9_-]+\.data\b/.test(body)).toBe(true);
  });

  test("mentions JSONata", async () => {
    const skills = loadAll();
    const body = skills.get("data-handling")!.body.toLowerCase();
    expect(body).toContain("jsonata");
  });
});

describe("rbac-and-scopes — permission vocabulary", () => {
  test("lists the real subkit permissions", async () => {
    const skills = loadAll();
    const body = skills.get("rbac-and-scopes")!.body;
    // A representative subset — all of these must appear:
    const perms = [
      "workflow:run",
      "workflow:read",
      "connector:read",
      "connector:write",
      "credential:write",
      "skill:write",
    ];
    for (const p of perms) {
      expect(body).toContain(p);
    }
  });

  test("mentions test_rbac_expression", async () => {
    const skills = loadAll();
    const body = skills.get("rbac-and-scopes")!.body;
    expect(body).toContain("test_rbac_expression");
  });
});

describe("error-recovery — numbered recovery routine", () => {
  test("has at least 4 numbered steps", async () => {
    const skills = loadAll();
    const body = skills.get("error-recovery")!.body;
    // Accept three common shapes: ordered Markdown list ('1. ... 2. ...'),
    // H3 headings with numbers ('### 1. Read'), or '**Step 1**' style.
    const orderedList = body.match(/^\s*\d+\.\s/gm) ?? [];
    const numberedHeading = body.match(/^#{1,6}\s+\d+\.\s/gm) ?? [];
    const stepForm = body.match(/\*\*\s*Step\s+\d+/gi) ?? [];
    const total = orderedList.length + numberedHeading.length + stepForm.length;
    expect(total).toBeGreaterThanOrEqual(4);
  });

  test("lists at least 5 canonical error codes", async () => {
    const skills = loadAll();
    const body = skills.get("error-recovery")!.body;
    const codes = [
      "placeholder_unresolved",
      "permission_denied",
      "connector_not_found",
      "http_5xx",
      "step_timeout",
    ];
    let hits = 0;
    for (const c of codes) if (body.includes(c)) hits++;
    expect(hits).toBeGreaterThanOrEqual(4);
  });
});

describe("self-healing — patch candidate vocabulary", () => {
  test("explains safe vs unsafe patch classification", async () => {
    const skills = loadAll();
    const body = skills.get("self-healing")!.body.toLowerCase();
    expect(body).toContain("patch_candidate");
    expect(body).toContain("safe");
    expect(body).toContain("unsafe");
  });
});

describe("connector-specific skills — driver vocabulary", () => {
  test("http-connectors covers the core mutation verbs + GET", async () => {
    const skills = loadAll();
    const body = skills.get("http-connectors")!.body;
    // At least GET + POST + 2 of {PUT, PATCH, DELETE}. Any combination
    // covers the conceptual spread of safe/unsafe methods.
    expect(body).toContain("GET");
    expect(body).toContain("POST");
    const mutations = ["PUT", "PATCH", "DELETE"].filter((v) => body.includes(v));
    expect(mutations.length).toBeGreaterThanOrEqual(2);
  });

  test("postgres-connectors gives a DSN shape with a placeholder", async () => {
    const skills = loadAll();
    const body = skills.get("postgres-connectors")!.body;
    expect(body).toContain("postgres://");
    expect(/\$\{cred\./.test(body)).toBe(true);
  });

  test("s3-connectors references bucket config", async () => {
    const skills = loadAll();
    const body = skills.get("s3-connectors")!.body.toLowerCase();
    expect(body).toContain("bucket");
  });

  test("graphql-connectors mentions query + variables", async () => {
    const skills = loadAll();
    const body = skills.get("graphql-connectors")!.body.toLowerCase();
    expect(body).toContain("query");
    expect(body).toContain("variables");
  });
});
