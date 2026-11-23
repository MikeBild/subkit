import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { now } from "../../utils/clock.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let graphqlConnectorId: string;
let pgConnectorId: string;
let gql500: MockServer;
let gqlErrors: MockServer;
let failingGqlConnectorId: string;
let answeringGqlConnectorId: string;

beforeAll(async () => {
  ctx = await createEngineCtx("circuit-non-http");

  const [g] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "circuit-graphql",
      display_name: "Circuit GraphQL",
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: "https://graphql.circuit-non-http.invalid/graphql",
      config: {},
      circuit_state: "open",
      circuit_opened_at: new Date(now()),
      circuit_failure_count: 5,
      circuit_threshold: 5,
      circuit_reset_ms: 300_000,
    })
    .returning();
  graphqlConnectorId = g!.id;

  const [p] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "circuit-postgres",
      display_name: "Circuit Postgres",
      driver: "postgres",
      environment: "dev",
      auth_type: "none",
      dsn: ctx.testDb.url,
      config: {},
      circuit_threshold: 5,
    })
    .returning();
  pgConnectorId = p!.id;

  gql500 = await createMockServer((_req, res) => {
    jsonResponse(res, 500, { error: "upstream exploded" });
  });
  gqlErrors = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { errors: [{ message: "Cannot query field 'nope'" }] });
  });

  const [f] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "circuit-graphql-500",
      display_name: "Circuit GraphQL 500",
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: gql500.baseUrl,
      config: { endpoint: gql500.baseUrl },
      circuit_threshold: 5,
    })
    .returning();
  failingGqlConnectorId = f!.id;

  const [a] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "circuit-graphql-errors",
      display_name: "Circuit GraphQL Errors",
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: gqlErrors.baseUrl,
      config: { endpoint: gqlErrors.baseUrl },
      circuit_failure_count: 3,
      circuit_threshold: 5,
    })
    .returning();
  answeringGqlConnectorId = a!.id;
});

afterAll(async () => {
  await gql500.close();
  await gqlErrors.close();
  await ctx.cleanup();
});

describe("circuit-breaker enforcement is driver-agnostic", () => {
  test("an open breaker blocks a graphql step", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "circuit-graphql-blocked",
      steps: [
        {
          kind: "request",
          protocol: "graphql",
          id: "gql",
          connector_id: graphqlConnectorId,
          graphql: { query: "query { viewer { id } }" },
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    const stepError = result.steps[0]?.error as { code?: string } | undefined;
    expect(stepError?.code).toBe("circuit_open");
  });
});

describe("only availability failures reach the breaker", () => {
  test("a SQL syntax error does not increment the connector's failure count", async () => {
    const before = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, pgConnectorId))
    )[0]!;
    expect(before.circuit_failure_count).toBe(0);

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "circuit-pg-syntax-error",
      steps: [
        {
          kind: "request",
          protocol: "sql",
          id: "sql",
          connector_id: pgConnectorId,
          sql: { query: "SELECT FROM WHERE" },
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");

    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, pgConnectorId))
    )[0]!;
    expect(after.circuit_failure_count).toBe(0);
    expect(after.circuit_state).toBe("closed");
  });
});

describe("one outcome recorder decides for every driver", () => {
  test("a graphql endpoint that 5xxs through its retries counts against the breaker", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "circuit-graphql-5xx",
      steps: [
        {
          kind: "request",
          protocol: "graphql",
          id: "gql",
          connector_id: failingGqlConnectorId,
          graphql: { query: "query { viewer { id } }" },
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");

    const after = (
      await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, failingGqlConnectorId))
    )[0]!;
    expect(after.circuit_failure_count).toBe(1);
  });

  test("a graphql errors array clears a partial count — the endpoint answered", async () => {
    const before = (
      await ctx.testDb.db
        .select()
        .from(connectors)
        .where(eq(connectors.id, answeringGqlConnectorId))
    )[0]!;
    expect(before.circuit_failure_count).toBe(3);

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "circuit-graphql-answered",
      steps: [
        {
          kind: "request",
          protocol: "graphql",
          id: "gql",
          connector_id: answeringGqlConnectorId,
          graphql: { query: "query { nope }" },
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect((result.steps[0]?.error as { code?: string } | undefined)?.code).toBe("graphql_error");

    const after = (
      await ctx.testDb.db
        .select()
        .from(connectors)
        .where(eq(connectors.id, answeringGqlConnectorId))
    )[0]!;
    expect(after.circuit_failure_count).toBe(0);
    expect(after.circuit_state).toBe("closed");
  });
});
