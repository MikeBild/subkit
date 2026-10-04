import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resolveDryRunEnvironment } from "../service.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("resolve_dry_run_keyless");
});

afterAll(async () => {
  await ctx.cleanup?.();
});

async function seedTenant(): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" }) // allow-random: test fixture
    .returning();
  return t!.id;
}

async function seedConnector(tenant_id: string, auth_type: "none" | "bearer"): Promise<string> {
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: `c-${Math.random().toString(36).slice(2, 8)}`, // allow-random: test fixture
      display_name: "C",
      driver: "http",
      environment: "dev",
      auth_type,
      base_url: "https://example.test",
    })
    .returning();
  return c!.id;
}

function captureWarns() {
  const warns: string[] = [];
  return {
    warns,
    onLog: (level: "debug" | "info" | "warn" | "error", message: string) => {
      if (level === "warn") warns.push(message);
    },
  };
}

describe("resolveDryRunEnvironment — keyless connectors do not warn", () => {
  test("all-keyless workflow: returns dev, NO no-credential warning", async () => {
    const tenant_id = await seedTenant();
    const keyless = await seedConnector(tenant_id, "none");
    const { warns, onLog } = captureWarns();

    const env = await resolveDryRunEnvironment({
      tenant_id,
      steps: [{ connector_id: keyless }],
      exec: ctx.db,
      onLog,
    });

    expect(env).toBe("dev");
    expect(warns.join("\n")).not.toContain("no credential found");
  });

  test("auth-requiring connector with no credential: STILL warns", async () => {
    const tenant_id = await seedTenant();
    const bearer = await seedConnector(tenant_id, "bearer");
    const { warns, onLog } = captureWarns();

    const env = await resolveDryRunEnvironment({
      tenant_id,
      steps: [{ connector_id: bearer }],
      exec: ctx.db,
      onLog,
    });

    expect(env).toBe("dev");
    expect(warns.join("\n")).toContain("no credential found");
  });

  test("mixed: keyless + uncredentialed auth connector → warns only about the auth one", async () => {
    const tenant_id = await seedTenant();
    const keyless = await seedConnector(tenant_id, "none");
    const bearer = await seedConnector(tenant_id, "bearer");
    const { warns, onLog } = captureWarns();

    await resolveDryRunEnvironment({
      tenant_id,
      steps: [{ connector_id: keyless }, { connector_id: bearer }],
      exec: ctx.db,
      onLog,
    });

    const msg = warns.join("\n");
    expect(msg).toContain("no credential found");
    expect(msg).toContain(bearer);
    expect(msg).not.toContain(keyless);
  });
});
