import { describe, expect, test } from "bun:test";
import {
  validateStepReferences,
  validateUnsupportedPlaceholders,
} from "../workflows/reference-validator.ts";
import { compileRequestBoundary } from "../workflows/request-boundary.ts";
import { type RequestStep, WorkflowDefSchema } from "../workflows/types.ts";
import { validateWorkflowDef } from "../workflows/validator.ts";
import { bindRecipe } from "./recipe-binding.ts";
import {
  builtFromRecipe,
  getSolutionRecipe,
  loadSolutionRecipes,
  recipeForOrigin,
} from "./solutions.ts";
import templateSkillsJson from "./template-skills.json" with { type: "json" };
import { ConnectorRecipeSchema, getBuiltinTemplate, loadBuiltinTemplates } from "./templates.ts";

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

  test("recent-rows orders the table rows instead of catalog columns (#571)", () => {
    const recentRowsRecipe = pg.recipes.find((recipe) => recipe.slug === "recent-rows")!;
    const [rowsStep] = recentRowsRecipe.workflow.steps as Array<{
      sql: { query: string; params: string[] };
    }>;
    expect(rowsStep!.sql.query).not.toContain("information_schema");
    expect(rowsStep!.sql.query).toContain("FROM %I.%I");
    expect(rowsStep!.sql.query).toContain("ORDER BY t.%I DESC");
    expect(rowsStep!.sql.params).toEqual([
      "${input.schema_name}",
      "${input.table_name}",
      "${input.order_column}",
      "${input.limit}",
    ]);
    const inputProperties = recentRowsRecipe.workflow.input_schema?.properties as Record<
      string,
      { default?: unknown }
    >;
    expect(inputProperties.order_column?.default).toBe("created_at");
  });

  test("each recipe ships a sql block (not an http url)", () => {
    for (const r of pg.recipes) {
      for (const step of r.workflow.steps as Array<{ sql?: { query?: string }; url?: string }>) {
        expect(step.sql?.query?.length ?? 0).toBeGreaterThan(0);
        expect(step.url).toBeUndefined();
      }
    }
  });

  test("row-count counts the table rows instead of catalog entries (#569)", () => {
    const rowCountRecipe = pg.recipes.find((recipe) => recipe.slug === "row-count")!;
    const [countStep] = rowCountRecipe.workflow.steps as Array<{
      sql: { query: string; params: string[] };
    }>;
    expect(countStep!.sql.query).not.toContain("information_schema");
    expect(countStep!.sql.query).toContain("FROM %I.%I");
    expect(countStep!.sql.params).toEqual(["${input.schema_name}", "${input.table_name}"]);
  });
});

describe("GraphQL and AWS recipe coverage", () => {
  test("github-graphql ships cursor-aware GraphQL recipes", () => {
    const githubGraphql = getBuiltinTemplate("github-graphql")!;
    expect(githubGraphql.recipes.map((r) => r.slug)).toEqual(
      expect.arrayContaining([
        "viewer",
        "list-viewer-repositories",
        "user-project-items",
        "repository-issues",
        "repository-pull-requests",
        "search-repositories",
      ]),
    );
    const list = githubGraphql.recipes.find((r) => r.slug === "list-viewer-repositories")!;
    const query = JSON.stringify(list.workflow.steps[0]);
    expect(query).toContain("pageInfo");
    expect(query).toContain("rateLimit");
    const project = githubGraphql.recipes.find((r) => r.slug === "user-project-items")!;
    const projectStep = project.workflow.steps[0] as {
      graphql?: {
        query?: string;
        cursor_pagination?: {
          connection_path?: string;
          required_connection_paths?: string[];
        };
      };
    };
    expect(project.title).toBe(
      "List user Project items with bounded text and single-select values",
    );
    expect(project.description).toContain("up to 20 Text and SingleSelect field values per item");
    expect(project.description).toContain(
      "fails closed if a nested fieldValues connection has more pages",
    );
    expect(project.description).toContain("Other field-value types are not selected");
    expect(project.description).toContain("query each item's supported values separately");
    expect(projectStep.graphql?.query).toContain("projectV2(number: $number)");
    expect(projectStep.graphql?.query).toContain("fieldValues(first: 20)");
    expect(projectStep.graphql?.query).toContain("pageInfo { hasNextPage }");
    expect(projectStep.graphql?.cursor_pagination).toMatchObject({
      connection_path: "user.projectV2.items",
      required_connection_paths: ["fieldValues"],
    });
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

describe("Jira recipes (Fix #7)", () => {
  const jira = getBuiltinTemplate("jira")!;

  test("template is loadable and has the three new recipe slugs", () => {
    const slugs = jira.recipes.map((r) => r.slug);
    expect(slugs).toContain("list-open-issues");
    expect(slugs).toContain("list-my-issues");
    expect(slugs).toContain("search-issues-by-jql");
  });

  test("all three Jira recipes declare derived_from_skill === 'jira-basics'", () => {
    for (const slug of ["list-open-issues", "list-my-issues", "search-issues-by-jql"]) {
      const r = jira.recipes.find((x) => x.slug === slug)!;
      expect(r).toBeDefined();
      expect(r.derived_from_skill).toBe("jira-basics");
    }
  });

  test("list-open-issues JQL uses statusCategory != 'Done' (locale-invariant filter)", () => {
    const r = jira.recipes.find((x) => x.slug === "list-open-issues")!;
    const step = r.workflow.steps[0]! as { query?: { jql?: string } };
    expect(step.query?.jql).toContain('statusCategory != "Done"');
  });

  test("list-open-issues JQL is scoped to assignee = currentUser()", () => {
    const r = jira.recipes.find((x) => x.slug === "list-open-issues")!;
    const step = r.workflow.steps[0]! as { query?: { jql?: string } };
    expect(step.query?.jql).toContain("assignee = currentUser()");
  });

  test("search-issues-by-jql input_schema.required includes 'jql'", () => {
    const r = jira.recipes.find((x) => x.slug === "search-issues-by-jql")!;
    expect(r.workflow.input_schema).toBeDefined();
    const required = (r.workflow.input_schema as { required?: string[] }).required ?? [];
    expect(required).toContain("jql");
  });

  test("every Jira recipe parses standalone through ConnectorRecipeSchema", () => {
    for (const r of jira.recipes) {
      const cloned = JSON.parse(JSON.stringify(r));
      expect(ConnectorRecipeSchema.safeParse(cloned).success).toBe(true);
    }
  });

  test("jira-basics skill body contains statusCategory guidance", () => {
    const skills = templateSkillsJson as Record<string, unknown>;
    const jiraSkill = skills["jira-basics"];
    expect(jiraSkill).toBeDefined();
    expect(JSON.stringify(jiraSkill)).toContain("statusCategory");
  });
});

describe("catalog totals", () => {
  test("at least 30 recipes total across the catalog (e2e smoke gate)", () => {
    const total = loadBuiltinTemplates().reduce((acc, t) => acc + t.recipes.length, 0);
    expect(total).toBeGreaterThanOrEqual(30);
  });
});

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

  test("every StepSchema discriminant is covered by a recipe", () => {
    const used = new Set<string>();
    for (const t of loadBuiltinTemplates()) {
      for (const r of t.recipes) {
        for (const k of collectStepKinds(r.workflow.steps)) used.add(k);
      }
    }
    const missing: string[] = [];
    for (const kind of DECLARED_STEP_KINDS) {
      if (!used.has(kind)) missing.push(kind);
    }
    expect(missing).toEqual([]);
  });

  test("DECLARED_STEP_KINDS matches the actual StepSchema discriminator", () => {
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

describe("all builtin recipes — placeholder resolvability (regression for the LinkedIn create-post bug)", () => {
  test("every recipe.workflow has zero unsupported placeholders and zero bad step refs", () => {
    const offenders: string[] = [];
    for (const t of loadBuiltinTemplates()) {
      for (const r of t.recipes) {
        const parsed = WorkflowDefSchema.safeParse(JSON.parse(JSON.stringify(r.workflow)));
        if (!parsed.success) {
          offenders.push(`${t.slug}/${r.slug}: WorkflowDefSchema parse failed`);
          continue;
        }
        for (const e of validateUnsupportedPlaceholders(parsed.data)) {
          offenders.push(`${t.slug}/${r.slug}: unsupported_placeholder ${JSON.stringify(e)}`);
        }
        for (const e of validateStepReferences(parsed.data)) {
          offenders.push(`${t.slug}/${r.slug}: bad_step_ref ${JSON.stringify(e)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("solution recipes — several connectors per recipe", () => {
  const solutions = loadSolutionRecipes();

  const connectorIdsOf = (workflow: unknown): string[] =>
    (JSON.stringify(workflow).match(/"connector_id":"[^"]+"/g) ?? []).map((m) =>
      m.slice('"connector_id":"'.length, -1),
    );

  test("ships the built-in solutions", () => {
    expect(solutions.map((r) => r.slug)).toEqual([
      "invoice-attachments-to-drive",
      "daily-analytics-report",
      "payment-grants-access",
      "webhook-to-slack",
      "weekly-run-digest",
    ]);
  });

  test("every solution validates the way the validate endpoint does", () => {
    for (const recipe of solutions) {
      const result = validateWorkflowDef(JSON.parse(JSON.stringify(recipe.workflow)));
      expect({ slug: recipe.slug, errors: result.errors }).toEqual({
        slug: recipe.slug,
        errors: [],
      });
    }
  });

  test("every solution has resolvable placeholders and step references", () => {
    const offenders: string[] = [];
    for (const recipe of solutions) {
      const parsed = WorkflowDefSchema.parse(JSON.parse(JSON.stringify(recipe.workflow)));
      for (const e of validateUnsupportedPlaceholders(parsed)) {
        offenders.push(`${recipe.slug}: ${JSON.stringify(e)}`);
      }
      for (const e of validateStepReferences(parsed)) {
        offenders.push(`${recipe.slug}: ${JSON.stringify(e)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every solution previews: sample input, expected output and at least one real template", () => {
    const templates = new Set(loadBuiltinTemplates().map((t) => t.slug));
    for (const recipe of solutions) {
      expect(recipe.sample_input).not.toBeNull();
      expect(recipe.expected_output_preview).not.toBeNull();
      expect(recipe.required_connectors.length).toBeGreaterThan(0);
      for (const required of recipe.required_connectors) {
        expect(templates.has(required.template)).toBe(true);
      }
    }
  });

  test("every declared placeholder is used and no step uses an undeclared one", () => {
    for (const recipe of solutions) {
      const declared = recipe.required_connectors.map((r) => r.placeholder).sort();
      const used = [...new Set(connectorIdsOf(recipe.workflow))].sort();
      expect({ slug: recipe.slug, used }).toEqual({ slug: recipe.slug, used: declared });
    }
  });

  const connectorRow = (
    id: string,
    template_slug: string,
    enabled = true,
  ): {
    id: string;
    slug: string;
    display_name: string;
    template_slug: string;
    enabled: boolean;
  } => ({
    id,
    slug: `${template_slug}-${id.slice(0, 4)}`,
    display_name: `${template_slug} ${id.slice(0, 4)}`,
    template_slug,
    enabled,
  });
  const reportTemplates = new Map([
    ["google-analytics", { name: "Google Analytics 4", base_url: "https://analyticsdata.example" }],
    ["google-gmail", { name: "Gmail", base_url: "https://gmail.example" }],
  ]);
  const ANALYTICS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  test("binding takes the one enabled connector of a template and names the missing ones", () => {
    const recipe = getSolutionRecipe("daily-analytics-report");
    if (!recipe) throw new Error("daily-analytics-report missing");
    const bound = bindRecipe(
      recipe,
      [
        connectorRow(ANALYTICS, "google-analytics"),
        connectorRow(SECOND, "google-analytics", false),
      ],
      reportTemplates,
    );
    expect(bound.connectors.map((c) => [c.template, c.connector_id, c.template_name])).toEqual([
      ["google-analytics", ANALYTICS, "Google Analytics 4"],
      ["google-gmail", null, "Gmail"],
    ]);
    expect(bound.connectors[0]?.candidates.map((c) => c.id)).toEqual([ANALYTICS]);
    const ids = connectorIdsOf(bound.workflow);
    expect(ids).toContain(ANALYTICS);
    expect(ids).toContain(recipe.required_connectors[1]?.placeholder ?? "missing");
    expect(connectorIdsOf(recipe.workflow)).not.toContain(ANALYTICS);
  });

  test("two enabled connectors of one template are never bound; both are offered", () => {
    const recipe = getSolutionRecipe("daily-analytics-report");
    if (!recipe) throw new Error("daily-analytics-report missing");
    const bound = bindRecipe(
      recipe,
      [connectorRow(ANALYTICS, "google-analytics"), connectorRow(SECOND, "google-analytics")],
      reportTemplates,
    );
    expect(bound.connectors[0]?.connector_id).toBeNull();
    expect(bound.connectors[0]?.candidates.map((c) => c.id)).toEqual([ANALYTICS, SECOND]);
    expect(connectorIdsOf(bound.workflow)).not.toContain(ANALYTICS);
  });

  test("a placeholder whose template has no fixed address is offered, never bound", () => {
    const recipe = getSolutionRecipe("payment-grants-access");
    if (!recipe) throw new Error("payment-grants-access missing");
    const templates = new Map([
      ["stripe", { name: "Stripe", base_url: "https://api.stripe.com/v1" }],
      ["http", { name: "HTTP", base_url: null }],
      ["google-gmail", { name: "Gmail", base_url: "https://gmail.googleapis.com/gmail/v1" }],
    ]);
    const stripe = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const api = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const bound = bindRecipe(
      recipe,
      [connectorRow(stripe, "stripe"), connectorRow(api, "http")],
      templates,
    );
    expect(bound.connectors.map((c) => [c.template, c.connector_id])).toEqual([
      ["stripe", stripe],
      ["http", null],
      ["google-gmail", null],
    ]);
    expect(bound.connectors[1]?.candidates.map((c) => c.id)).toEqual([api]);
  });

  test("no recipe reads input.scope in its output_transform_function, where only the last output arrives", () => {
    const offenders: string[] = [];
    for (const t of loadBuiltinTemplates()) {
      for (const r of t.recipes) {
        if (r.workflow.output_transform_function?.includes("input.scope")) {
          offenders.push(`${t.slug}/${r.slug}`);
        }
      }
    }
    for (const r of solutions) {
      if (r.workflow.output_transform_function?.includes("input.scope")) {
        offenders.push(`solutions/${r.slug}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no solution takes webhooks without a signature check", () => {
    for (const recipe of solutions) {
      const trigger = recipe.workflow.trigger;
      if (trigger?.kind !== "webhook") continue;
      expect({ slug: recipe.slug, verify: trigger.verify }).not.toEqual({
        slug: recipe.slug,
        verify: "none",
      });
      expect(recipe.description).toMatch(/sign/i);
    }
  });

  test("the Drive solution keeps the drive.file scope and works in a folder it creates", () => {
    expect(getBuiltinTemplate("google-drive")?.oauth?.scopes).toBe(
      "https://www.googleapis.com/auth/drive.file",
    );
    const recipe = getSolutionRecipe("invoice-attachments-to-drive");
    const ids = (recipe?.workflow.steps ?? []).map((step) => step.id);
    expect(ids.indexOf("create_folder")).toBeGreaterThan(ids.indexOf("find_folder"));
    expect(ids.indexOf("upload_file")).toBeGreaterThan(ids.indexOf("folder"));
    expect(recipe?.workflow.input_schema?.required).toEqual(["query", "folder_name"]);
  });

  test("a recipe origin resolves only inside its own pack", () => {
    const finance = { categories: ["payments"], tags: ["finance"] };
    expect(recipeForOrigin({ vertical: "solutions", slug: "weekly-run-digest" }, null)?.slug).toBe(
      "weekly-run-digest",
    );
    expect(recipeForOrigin({ vertical: "solutions", slug: "made-up" }, null)).toBeNull();
    expect(recipeForOrigin({ vertical: "finance", slug: "list-customers" }, finance)?.slug).toBe(
      "list-customers",
    );
    expect(recipeForOrigin({ vertical: "finance", slug: "list-customers" }, null)).toBeNull();
    expect(
      recipeForOrigin({ vertical: "hr", slug: "list-customers" }, { categories: [], tags: [] }),
    ).toBeNull();
  });

  test("a definition counts as built from a recipe only with the recipe's steps in order", () => {
    const recipe = getSolutionRecipe("webhook-to-slack");
    if (!recipe) throw new Error("webhook-to-slack missing");
    const copy = JSON.parse(JSON.stringify(recipe.workflow));
    expect(builtFromRecipe(copy, recipe)).toBe(true);
    expect(builtFromRecipe({ ...copy, steps: copy.steps.slice(1) }, recipe)).toBe(false);
    expect(builtFromRecipe({ ...copy, steps: [...copy.steps].reverse() }, recipe)).toBe(false);
    expect(builtFromRecipe({ name: "x" }, recipe)).toBe(false);
  });
});

describe("template recipe urls (#521)", () => {
  test("every recipe url built on a connector base_url passes the draft-save url check", () => {
    const urlErrors = loadBuiltinTemplates().flatMap((template) =>
      template.recipes.flatMap((recipe) => {
        const baseUrlStepPaths = (recipe.workflow.steps as Array<{ id: string; url?: string }>)
          .filter((step) => step.url?.startsWith("${connector."))
          .map((step) => `steps.${step.id}.url`);
        return validateWorkflowDef(JSON.parse(JSON.stringify(recipe.workflow)))
          .errors.filter((error) => baseUrlStepPaths.includes(error.path))
          .map((error) => `${template.slug}/${recipe.slug}: ${error.path}`);
      }),
    );
    expect(urlErrors).toEqual([]);
  });
});

describe("square write recipes (#564)", () => {
  test("every square write step binds the square connector and compiles a request boundary", () => {
    const placeholder = "00000000-0000-0000-0000-000000000000";
    const square = getBuiltinTemplate("square")!;
    const outcomes = square.recipes.flatMap((recipe) =>
      (recipe.workflow.steps as RequestStep[])
        .filter((step) => (step.method ?? "GET").toUpperCase() !== "GET")
        .map((step) => ({
          step: `${recipe.slug}/${step.id}`,
          connector_id: step.connector_id,
          required: recipe.required_connectors.find((r) => r.placeholder === placeholder)?.template,
          refusal: compileRequestBoundary(step, square.base_url).refusal ?? null,
        })),
    );
    expect(outcomes.map((outcome) => outcome.step).sort()).toEqual([
      "create-customer/create",
      "inventory-counts/counts",
      "list-orders/search",
      "list-team-members/search",
      "refund-payment/refund",
    ]);
    expect(outcomes).toEqual(
      outcomes.map((outcome) => ({
        ...outcome,
        connector_id: placeholder,
        required: "square",
        refusal: null,
      })),
    );
  });
});
