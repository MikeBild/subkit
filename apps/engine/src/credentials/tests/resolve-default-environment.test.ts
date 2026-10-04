import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  resolveDefaultEnvironmentForConnector,
  resolveDryRunEnvironment,
  upsertCredential,
} from "../service.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("resolve_default_env");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" }) // allow-random: test fixture
    .returning();
  return t!.id;
}

async function seedConnector(tenant_id: string): Promise<string> {
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: `c-${Math.random().toString(36).slice(2, 8)}`, // allow-random: test fixture
      display_name: "C",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://example.test",
    })
    .returning();
  return c!.id;
}

describe("resolveDefaultEnvironmentForConnector", () => {
  test("returns null when the connector has no credential in any environment", async () => {
    const tenant_id = await seedTenant();
    const connector_id = await seedConnector(tenant_id);
    const env = await resolveDefaultEnvironmentForConnector(tenant_id, connector_id, ctx.db);
    expect(env).toBeNull();
  });

  test("returns dev when a dev credential exists", async () => {
    const tenant_id = await seedTenant();
    const connector_id = await seedConnector(tenant_id);
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "dev-token" },
        actor_id: null,
      },
      ctx.db,
    );
    const env = await resolveDefaultEnvironmentForConnector(tenant_id, connector_id, ctx.db);
    expect(env).toBe("dev");
  });

  test("returns prod when only a prod credential exists", async () => {
    const tenant_id = await seedTenant();
    const connector_id = await seedConnector(tenant_id);
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "prod",
        mode: "bearer",
        value: { mode: "bearer", token: "prod-token" },
        actor_id: null,
      },
      ctx.db,
    );
    const env = await resolveDefaultEnvironmentForConnector(tenant_id, connector_id, ctx.db);
    expect(env).toBe("prod");
  });

  test("prefers dev when both dev and prod credentials exist", async () => {
    const tenant_id = await seedTenant();
    const connector_id = await seedConnector(tenant_id);
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "prod",
        mode: "bearer",
        value: { mode: "bearer", token: "prod-token" },
        actor_id: null,
      },
      ctx.db,
    );
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "dev-token" },
        actor_id: null,
      },
      ctx.db,
    );
    const env = await resolveDefaultEnvironmentForConnector(tenant_id, connector_id, ctx.db);
    expect(env).toBe("dev");
  });

  test("draft (non-UUID) connector id short-circuits to null", async () => {
    const tenant_id = await seedTenant();
    const env = await resolveDefaultEnvironmentForConnector(tenant_id, "draft-abc", ctx.db);
    expect(env).toBeNull();
  });
});

describe("resolveDryRunEnvironment — with a real credential present", () => {
  test("resolves prod silently (no warning) when the connector only has a prod grant", async () => {
    const tenant_id = await seedTenant();
    const connector_id = await seedConnector(tenant_id);
    await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "prod",
        mode: "bearer",
        value: { mode: "bearer", token: "prod-token" },
        actor_id: null,
      },
      ctx.db,
    );
    const warns: string[] = [];
    const env = await resolveDryRunEnvironment({
      tenant_id,
      steps: [{ connector_id }],
      exec: ctx.db,
      onLog: (level, message) => {
        if (level === "warn") warns.push(message);
      },
    });
    expect(env).toBe("prod");
    expect(warns.join("\n")).not.toContain("no credential found");
  });

  test("requested environment is authoritative regardless of stored credentials", async () => {
    const tenant_id = await seedTenant();
    const connector_id = await seedConnector(tenant_id);
    const env = await resolveDryRunEnvironment({
      tenant_id,
      steps: [{ connector_id }],
      requested: "prod",
      exec: ctx.db,
    });
    expect(env).toBe("prod");
  });
});
