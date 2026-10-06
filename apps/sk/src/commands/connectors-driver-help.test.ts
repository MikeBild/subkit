import { describe, expect, test } from "bun:test";
import openapi from "@cli-core/engine-api/openapi.json" with { type: "json" };

const DRIVER_ENUM: string[] =
  (
    openapi as {
      components: {
        schemas: Record<string, { properties?: { driver?: { enum?: string[] } } }>;
      };
    }
  ).components.schemas.CreateConnectorBody?.properties?.driver?.enum ?? [];

type CittyArg = { description?: string };
type CittySub = { meta?: { description?: string }; args?: Record<string, CittyArg> };

async function sub(name: string): Promise<CittySub> {
  const { connectorsCommand } = await import("./connectors.ts");
  const subs = (connectorsCommand as { subCommands?: Record<string, CittySub> }).subCommands;
  const found = subs?.[name];
  if (!found) throw new Error(`expected subCommands.${name} on the connectors command`);
  return found;
}

describe("sk connectors list --driver help text", () => {
  test("the driver enum resolves — otherwise the assertions below pass vacuously", () => {
    expect(DRIVER_ENUM.length).toBeGreaterThan(1);
    expect(DRIVER_ENUM).toContain("mcp");
  });

  test("names every driver the engine ships", async () => {
    const description = (await sub("list")).args?.driver?.description ?? "";
    const missing = DRIVER_ENUM.filter((d) => !description.includes(d));
    expect(missing).toEqual([]);
  });
});

describe("the mcp driver's own verbs are discoverable from help alone", () => {
  test.each(["mcp-inspect", "mcp-authorize"])("%s says it is the mcp driver's", async (name) => {
    expect((await sub(name)).meta?.description ?? "").toContain("mcp driver");
  });

  test("enable and disable claim no driver — they are the switch for every one", async () => {
    for (const name of ["enable", "disable"]) {
      expect((await sub(name)).meta?.description ?? "").not.toContain("mcp");
    }
  });
});
