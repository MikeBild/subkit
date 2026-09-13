// The connectors command's help text must describe the drivers the engine
// actually ships.
//
// `--category` filters connectors by catalog block, and a connector's block IS
// its driver. Naming four of five in the help text is worse than naming none:
// an operator reads the list as exhaustive and concludes the fifth driver is
// not filterable. The engine's driver enum is the authority, read out of the
// committed OpenAPI surface rather than restated here — a hand-written list
// would need to be remembered the next time the enum changes, and forgetting
// costs nothing visible.
//
// `connectors.ts` reads nothing at import time — it defines citty commands and
// resolves the profile only inside `run`. It is nevertheless loaded lazily,
// inside `sub()`: importing it at module scope pulls the real
// `engine-client.ts` into the registry during this file's LOAD phase, which is
// before the sibling command tests install their `mock.module` stub for it.
// Those tests then reach the network instead of the stub. The ones that break
// are `connectors-driver-verbs.test.ts` and `create-json-contract.test.ts` —
// written on one line each because the reference checker matches a file by its
// basename, and a name wrapped across two lines reads as a file that does not
// exist.

import openapi from "@cli-core/engine-api/openapi.json" with { type: "json" };
import { describe, expect, test } from "bun:test";

/** The engine's driver list, as published in the generated OpenAPI surface. */
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

describe("sk connectors --category help text", () => {
  test("the driver enum resolves — otherwise the assertions below pass vacuously", () => {
    expect(DRIVER_ENUM.length).toBeGreaterThan(1);
    expect(DRIVER_ENUM).toContain("mcp");
  });

  test("names every driver the engine ships", async () => {
    const description = (await sub("list")).args?.category?.description ?? "";
    const missing = DRIVER_ENUM.filter((d) => !description.includes(d));
    expect(missing).toEqual([]);
  });
});

describe("the mcp driver's own verbs are discoverable from help alone", () => {
  // These two are the only driver-specific verbs on the connectors command.
  // A coding agent picks a subcommand off the help listing, so the help has
  // to say which driver they belong to — pointing `mcp-inspect` at an http
  // connector produces an engine refusal, and the CLI should not have been
  // the reason someone tried.
  test.each(["mcp-inspect", "mcp-authorize"])("%s says it is the mcp driver's", async (name) => {
    expect((await sub(name)).meta?.description ?? "").toContain("mcp driver");
  });

  test("enable and disable claim no driver — they are the switch for every one", async () => {
    for (const name of ["enable", "disable"]) {
      expect((await sub(name)).meta?.description ?? "").not.toContain("mcp");
    }
  });
});
