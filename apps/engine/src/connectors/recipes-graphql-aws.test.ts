import { describe, expect, test } from "bun:test";
import { Kind, parse, print } from "graphql";
import { getBuiltinTemplate, loadBuiltinTemplates } from "./templates.ts";

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

  test("every GraphQL recipe step binds a placeholder connector of its own template", () => {
    const placeholder = "00000000-0000-0000-0000-000000000000";
    const offenders: string[] = [];
    for (const template of loadBuiltinTemplates()) {
      for (const recipe of template.recipes) {
        const graphqlSteps = (
          recipe.workflow.steps as Array<{
            connector_id?: string;
            url?: string;
            graphql?: { query?: string };
          }>
        ).filter((step) => step.graphql);
        if (graphqlSteps.length === 0) continue;
        const label = `${template.slug}/${recipe.slug}`;
        const required = recipe.required_connectors.find((r) => r.placeholder === placeholder);
        if (required?.template !== template.slug) offenders.push(`${label}: required_connectors`);
        for (const step of graphqlSteps) {
          if (step.connector_id !== placeholder) offenders.push(`${label}: connector_id`);
          if (step.url !== undefined) offenders.push(`${label}: url`);
          try {
            parse(step.graphql?.query ?? "");
          } catch {
            offenders.push(`${label}: query`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("linear team queries declare the team id as String!", () => {
    const linear = getBuiltinTemplate("linear")!;
    for (const slug of ["list-issues", "list-cycles"]) {
      const recipe = linear.recipes.find((r) => r.slug === slug)!;
      const step = recipe.workflow.steps[0] as { graphql?: { query?: string } };
      const document = parse(step.graphql?.query ?? "");
      const operation = document.definitions[0];
      if (operation?.kind !== Kind.OPERATION_DEFINITION)
        throw new Error(`${slug} has no operation`);
      const teamVariable = operation.variableDefinitions?.find(
        (v) => v.variable.name.value === "t",
      );
      expect({ slug, type: teamVariable ? print(teamVariable.type) : null }).toEqual({
        slug,
        type: "String!",
      });
    }
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
    expect(structured.workflow.steps[0]).toMatchObject({ kind: "model", id: "extract" });
    expect(JSON.stringify(structured.workflow.steps[0])).toContain("output_schema");
    expect(structured.workflow.output_schema).toBeDefined();
  });
});
