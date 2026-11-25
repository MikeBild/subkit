import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { _resetConfigForTests, getConfig, loadConfig } from "../loader.ts";
import { ConfigSchema } from "../schema.ts";
import { dottedPath, listConfigLeaves } from "../walk.ts";

type SchemaDef = {
  type?: string;
  innerType?: z.ZodTypeAny;
  shape?: Record<string, z.ZodTypeAny>;
  valueType?: z.ZodTypeAny;
};

const WRAPPERS = new Set(["optional", "nullable", "default", "prefault"]);

const definitionOf = (schema: z.ZodTypeAny): SchemaDef => (schema as { def?: SchemaDef }).def ?? {};

const unwrapSchema = (schema: z.ZodTypeAny): z.ZodTypeAny => {
  const definition = definitionOf(schema);
  return WRAPPERS.has(definition.type ?? "") && definition.innerType
    ? unwrapSchema(definition.innerType)
    : schema;
};

const overlayLeafPaths = (schema: z.ZodTypeAny, prefix: string[] = []): string[] => {
  const definition = definitionOf(unwrapSchema(schema));
  return definition.type === "object" && definition.shape
    ? Object.entries(definition.shape).flatMap(([key, child]) =>
        overlayLeafPaths(child, [...prefix, key]),
      )
    : [prefix.join(".")];
};

const tenantsSchema = (ConfigSchema as unknown as { def: SchemaDef }).def.shape!.tenants!;
const tenantOverlaySchema = definitionOf(unwrapSchema(tenantsSchema)).valueType!;

describe("tenant overlay drift", () => {
  test("preserves result question checks alongside tenant reasoning overrides", () => {
    const parsed = ConfigSchema.parse({
      database: { url: "postgres://x" },
      tenants: {
        "tenant-r": { llm: { result_question_check: true, reasoning_effort: "high" } },
      },
    });
    expect(parsed.llm.result_question_check).toBe(false);
    expect(parsed.tenants["tenant-r"]?.llm).toEqual({
      result_question_check: true,
      reasoning_effort: "high",
    });
  });

  test("TenantOverlaySchema accepts exactly the tenant-scoped config leaves", () => {
    const tenantScopedLeaves = listConfigLeaves()
      .filter((leaf) => leaf.meta.scope === "tenant")
      .map(dottedPath)
      .sort();
    const acceptedLeaves = overlayLeafPaths(tenantOverlaySchema).sort();
    expect({
      missingFromOverlay: tenantScopedLeaves.filter((path) => !acceptedLeaves.includes(path)),
      notTenantScoped: acceptedLeaves.filter((path) => !tenantScopedLeaves.includes(path)),
    }).toEqual({ missingFromOverlay: [], notTenantScoped: [] });
  });

  test("a tenant override of llm.reasoning_effort survives overlay parsing", () => {
    const parsed = ConfigSchema.parse({
      database: { url: "postgres://x" },
      tenants: { "tenant-r": { llm: { reasoning_effort: "high" } } },
    });
    expect(parsed.tenants["tenant-r"]?.llm).toEqual({ reasoning_effort: "high" });
  });
});

describe("tenant override of llm.reasoning_effort", () => {
  let directory: string;
  let configPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "subkit-cfg-tenant-drift-"));
    configPath = join(directory, "subkit.config.json");
    _resetConfigForTests();
  });

  afterEach(() => {
    _resetConfigForTests();
    rmSync(directory, { recursive: true, force: true });
  });

  test("reaches the effective tenant config and leaves the instance default alone", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        database: { url: "postgres://x" },
        tenants: { "tenant-r": { llm: { reasoning_effort: "high" } } },
      }),
    );
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: configPath,
    });
    expect(getConfig("tenant-r").llm.reasoning_effort).toBe("high");
    expect(getConfig().llm.reasoning_effort).toBe("default");
  });
});
