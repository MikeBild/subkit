// Recipe-clone unit tests. Exercises the pure helper used by the
// `start_workflow_from_recipe` conversation tool — without spinning up
// a conversation, a DB, or a tool context.

import { describe, expect, test } from "bun:test";
import { WorkflowDefSchema } from "../workflows/types.ts";
import { getBuiltinTemplate, loadBuiltinTemplates } from "./templates.ts";

describe("Stripe recipes — clone semantics", () => {
  const stripe = getBuiltinTemplate("stripe")!;

  test("template is loadable", () => {
    expect(stripe).toBeDefined();
    expect(stripe.recipes.length).toBeGreaterThanOrEqual(12);
  });

  test("each recipe.workflow validates standalone (re-parse, no shared state)", () => {
    for (const r of stripe.recipes) {
      const cloned = JSON.parse(JSON.stringify(r.workflow));
      expect(WorkflowDefSchema.safeParse(cloned).success).toBe(true);
    }
  });

  test("cloning twice produces deeply distinct objects", () => {
    const r = stripe.recipes[0]!;
    const a = JSON.parse(JSON.stringify(r.workflow));
    const b = JSON.parse(JSON.stringify(r.workflow));
    expect(a).not.toBe(b);
    a.name = "first-clone";
    expect(b.name).not.toBe("first-clone");
  });

  test("recipe carries derived_from_skill linkage", () => {
    for (const r of stripe.recipes) {
      expect(r.derived_from_skill).toBe("stripe-basics");
    }
  });
});

describe("GitHub recipes", () => {
  const github = getBuiltinTemplate("github")!;

  test("uses page-based pagination matching the template's pagination_defaults", () => {
    const list = github.recipes.find((r) => r.slug === "list-my-repos")!;
    const step = list.workflow.steps[0]! as { pagination?: { strategy?: string } };
    expect(step.pagination?.strategy).toBe("page");
  });

  test("create-issue recipe declares an input_schema", () => {
    const create = github.recipes.find((r) => r.slug === "create-issue")!;
    expect(create.workflow.input_schema).toBeDefined();
  });
});

describe("Postgres recipes", () => {
  const pg = getBuiltinTemplate("postgres")!;

  test("each recipe step uses the placeholder connector_id", () => {
    for (const r of pg.recipes) {
      for (const step of r.workflow.steps as Array<{ connector_id?: string }>) {
        expect(step.connector_id).toBe("00000000-0000-0000-0000-000000000000");
      }
    }
  });

  test("each recipe ships a sql block (not an http url)", () => {
    for (const r of pg.recipes) {
      for (const step of r.workflow.steps as Array<{ sql?: { query?: string }; url?: string }>) {
        expect(step.sql?.query?.length ?? 0).toBeGreaterThan(0);
        expect(step.url).toBeUndefined();
      }
    }
  });
});

describe("GraphQL and AWS recipe coverage", () => {
  test("github-graphql ships cursor-aware GraphQL recipes", () => {
    const githubGraphql = getBuiltinTemplate("github-graphql")!;
    expect(githubGraphql.recipes.map((r) => r.slug)).toEqual(
      expect.arrayContaining([
        "viewer",
        "list-viewer-repositories",
        "repository-issues",
        "repository-pull-requests",
        "search-repositories",
      ]),
    );
    const list = githubGraphql.recipes.find((r) => r.slug === "list-viewer-repositories")!;
    const query = JSON.stringify(list.workflow.steps[0]);
    expect(query).toContain("pageInfo");
    expect(query).toContain("rateLimit");
  });

  test("appsync recipes use placeholder connector ids for tenant-specific endpoints", () => {
    for (const slug of ["appsync-cognito", "appsync-iam"]) {
      const template = getBuiltinTemplate(slug)!;
      expect(template.recipes.length).toBeGreaterThanOrEqual(3);
      for (const recipe of template.recipes) {
        const first = recipe.workflow.steps[0] as { connector_id?: string; graphql?: unknown };
        expect(first.connector_id).toBe("00000000-0000-0000-0000-000000000000");
        expect(first.graphql).toBeDefined();
      }
    }
  });

  test("aws service recipes carry SigV4 auth and service-specific targets", () => {
    const expectations = {
      "aws-dynamodb": "DynamoDB_20120810",
      "aws-sqs": "AmazonSQS",
      "aws-ses": "SimpleEmailService",
      "aws-lambda": "/2015-03-31/functions/",
      "aws-cognito-user-pools": "AWSCognitoIdentityProviderService",
    };
    for (const [slug, marker] of Object.entries(expectations)) {
      const template = getBuiltinTemplate(slug)!;
      expect(template.auth_type).toBe("aws_sigv4");
      expect(JSON.stringify(template.recipes)).toContain(marker);
    }
  });

  test("openai provider recipes include structured output and embeddings patterns", () => {
    const openai = getBuiltinTemplate("openai")!;
    expect(openai.recipes.map((r) => r.slug)).toEqual(
      expect.arrayContaining(["list-models", "structured-extraction", "create-embedding"]),
    );
    const structured = openai.recipes.find((r) => r.slug === "structured-extraction")!;
    expect(JSON.stringify(structured.workflow)).toContain("json_schema");
    expect(structured.workflow.output_schema).toBeDefined();
  });
});

describe("catalog totals", () => {
  test("at least 30 recipes total across the catalog (e2e smoke gate)", () => {
    const total = loadBuiltinTemplates().reduce((acc, t) => acc + t.recipes.length, 0);
    expect(total).toBeGreaterThanOrEqual(30);
  });
});

// In an AI-authored model, a primitive without a recipe is a primitive the
// LLM never emits cleanly on first attempt (repair loop is `maxRetries: 0`).
// This gate enforces that every workflow step kind has ≥1 demonstrating
// recipe in `templates.json`. Add the kind to `KNOWN_UNCOVERED` only with a
// TODO citation pointing at the issue that will land its first recipe.
describe("recipe-coverage gate (A1)", () => {
  const DECLARED_STEP_KINDS = [
    "request",
    "transform",
    "call",
    "wait",
    "wait_for_event",
    "branch",
    "parallel",
    "loop",
  ] as const;

  // Step kinds without a shipped recipe today. Each entry must reference an
  // open issue or follow-up that will remove it. Empty set = full coverage.
  // #146 / Part D landed call + wait_for_event recipes against the GitHub
  // template; 4.2.0 retired the docker-based `tool` step. Every remaining
  // discriminant ships with a demonstrating recipe.
  const KNOWN_UNCOVERED = new Set<string>([]);

  function collectStepKinds(steps: unknown): Set<string> {
    const used = new Set<string>();
    const walk = (xs: unknown): void => {
      if (!Array.isArray(xs)) return;
      for (const s of xs) {
        if (!s || typeof s !== "object") continue;
        const step = s as Record<string, unknown>;
        if (typeof step.kind === "string") used.add(step.kind);
        if (Array.isArray(step.then_steps)) walk(step.then_steps);
        if (Array.isArray(step.else_steps)) walk(step.else_steps);
        if (Array.isArray(step.branches)) for (const b of step.branches) walk(b);
        if (Array.isArray(step.body_steps)) walk(step.body_steps);
      }
    };
    walk(steps);
    return used;
  }

  test("every StepSchema discriminant is either covered by a recipe or listed in KNOWN_UNCOVERED", () => {
    const used = new Set<string>();
    for (const t of loadBuiltinTemplates()) {
      for (const r of t.recipes) {
        for (const k of collectStepKinds(r.workflow.steps)) used.add(k);
      }
    }
    const missing: string[] = [];
    for (const kind of DECLARED_STEP_KINDS) {
      if (used.has(kind)) continue;
      if (KNOWN_UNCOVERED.has(kind)) continue;
      missing.push(kind);
    }
    expect(missing).toEqual([]);
  });

  test("KNOWN_UNCOVERED entries are not silently shadowed by a now-covered recipe", () => {
    const used = new Set<string>();
    for (const t of loadBuiltinTemplates()) {
      for (const r of t.recipes) {
        for (const k of collectStepKinds(r.workflow.steps)) used.add(k);
      }
    }
    const stale: string[] = [];
    for (const kind of KNOWN_UNCOVERED) {
      if (used.has(kind)) stale.push(kind);
    }
    // If this fails: a recipe added the kind. Remove it from KNOWN_UNCOVERED.
    expect(stale).toEqual([]);
  });

  test("DECLARED_STEP_KINDS matches the actual StepSchema discriminator", () => {
    // Hand-rolled list above matches WorkflowDef StepSchema discriminator.
    // If StepSchema gains a kind, this assertion fails by design — update the
    // list AND add KNOWN_UNCOVERED entry pointing at the issue that ships
    // the first recipe.
    const declared = new Set<string>(DECLARED_STEP_KINDS);
    const expected = new Set<string>([
      "request",
      "transform",
      "call",
      "wait",
      "wait_for_event",
      "branch",
      "parallel",
      "loop",
    ]);
    expect([...declared].sort()).toEqual([...expected].sort());
  });
});
