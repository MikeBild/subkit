import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedConnector, seedTenant } from "../../test-helpers/seed.ts";
import { resolveDryRunEnvironment } from "../service.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("resolve_dry_run_keyless");
});

afterAll(async () => {
  await ctx.cleanup?.();
});

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
    const tenant_id = (await seedTenant(ctx.db)).id;
    const keyless = (await seedConnector(ctx.db, { tenant_id, auth_type: "none" })).id;
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
    const tenant_id = (await seedTenant(ctx.db)).id;
    const bearer = (await seedConnector(ctx.db, { tenant_id, auth_type: "bearer" })).id;
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
    const tenant_id = (await seedTenant(ctx.db)).id;
    const keyless = (await seedConnector(ctx.db, { tenant_id, auth_type: "none" })).id;
    const bearer = (await seedConnector(ctx.db, { tenant_id, auth_type: "bearer" })).id;
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
