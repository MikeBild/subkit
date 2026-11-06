import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "citty";
import type { PermissionListResponse } from "../engine-client/rbac.ts";
import { rbacCommand } from "./rbac.ts";

const TENANT = "10000000-0000-4000-8000-000000000001";

const catalog: PermissionListResponse = {
  items: [
    {
      name: "workflows.read",
      description: "Read workflows",
      resource_type: "workflow",
      operator: false,
    },
    {
      name: "engine.admin",
      description: "Administer the engine",
      resource_type: "engine",
      operator: true,
    },
  ],
};

let previousFetch: typeof globalThis.fetch;
let previousWrite: typeof process.stdout.write;
let output: string[];
let paths: string[];

beforeEach(() => {
  previousFetch = globalThis.fetch;
  previousWrite = process.stdout.write.bind(process.stdout);
  output = [];
  paths = [];
  process.env.SUBKIT_ENGINE_URL = "https://engine.test/gateway";
  process.env.SUBKIT_API_KEY = "test-key";
  process.env.SUBKIT_TENANT = TENANT;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    paths.push(url.pathname);
    if (url.pathname === "/gateway/v1/rbac/permissions") {
      return new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as typeof globalThis.fetch;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  process.stdout.write = previousWrite;
  delete process.env.SUBKIT_ENGINE_URL;
  delete process.env.SUBKIT_API_KEY;
  delete process.env.SUBKIT_TENANT;
});

describe("sk rbac permissions list", () => {
  test("renders one row per catalog entry with name, resource type, operator flag and description", async () => {
    await runCommand(rbacCommand, { rawArgs: ["permissions", "list"] });
    expect(output.join("")).toBe(
      [
        "name\tresource_type\toperator\tdescription",
        "workflows.read\tworkflow\tfalse\tRead workflows",
        "engine.admin\tengine\ttrue\tAdminister the engine",
        "",
      ].join("\n"),
    );
    expect(output.join("")).not.toContain("[object Object]");
    expect(paths).toEqual(["/gateway/v1/rbac/permissions"]);
  });

  test("passes the engine catalog entries through unchanged with --json", async () => {
    await runCommand(rbacCommand, { rawArgs: ["permissions", "list", "--json"] });
    expect(JSON.parse(output.join(""))).toEqual(catalog.items);
  });
});
