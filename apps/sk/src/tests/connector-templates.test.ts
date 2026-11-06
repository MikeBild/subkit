import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadTemplateBodyFromArgs } from "../commands/connector-templates.ts";
import type { ConnectorTemplateCreateBody } from "../engine-client/connectors.ts";

const TENANT_ID = "5eed0001-0000-4000-8000-000000000001";

const shortFormBody = {
  version: 1,
  slug: "acme",
  name: "Acme",
  driver: "http",
  base_url: "https://acme.example.com",
  auth_type: "none",
  oauth: null,
  default_skill: null,
  ingestion_source: "unsupported",
  ingestion_url: null,
  icon: "",
  description: "Connector template for Acme.",
  category: "custom",
  tags: [],
  aliases: [],
  setup_instructions: "Provide credentials to connect to Acme.",
  auth_options: [
    {
      auth_type: "none",
      label: "No Auth",
      description: "No authentication required.",
      oauth: null,
    },
  ],
  url_pattern: "^https?://",
  keywords: [],
  inline_schema: null,
  probe_endpoint: null,
  read_operations: [],
  resource_url_parser: null,
  credential_hints: [],
  base_url_options: [],
  pagination_defaults: null,
  capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  example_paths: [],
  recipes: [],
  aws_service: null,
  aws_region: null,
  verified_at: null,
  respects_robots: false,
} satisfies ConnectorTemplateCreateBody;

describe("connector-templates create builds the contract body", () => {
  test("the short form sends every field ConnectorTemplateCreateBody requires", async () => {
    expect(await loadTemplateBodyFromArgs({ slug: "acme", name: "Acme", driver: "http" })).toEqual(
      shortFormBody,
    );
  });

  test("the short form rejects a driver the contract does not know", async () => {
    await expect(
      loadTemplateBodyFromArgs({ slug: "acme", name: "Acme", driver: "soap" }),
    ).rejects.toThrow("--driver must be one of: http | postgres | s3 | graphql | mcp");
  });
});

interface Seen {
  method: string;
  path: string;
  query: string;
}

let server: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ method: request.method, path: url.pathname, query: url.search });
      if (url.pathname === "/v1/recipe-packs/finance")
        return Response.json({ vertical: "finance", outcome: "Close the books", recipes: [] });
      return Response.json({ code: "not_found", message: "no route" }, { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

async function sk(args: string[]) {
  seen = [];
  const commandPath = new URL("../commands/connector-templates.ts", import.meta.url).pathname;
  const script = `import { runCommand } from "citty"; import { connectorTemplatesCommand } from ${JSON.stringify(commandPath)}; await runCommand(connectorTemplatesCommand, { rawArgs: ${JSON.stringify(args)} });`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      SUBKIT_ENGINE_URL: `http://127.0.0.1:${server.port}`,
      SUBKIT_API_KEY: "synthetic-cli-key",
      SUBKIT_TENANT: TENANT_ID,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, seen };
}

describe("sk connector-templates recipe-pack follows the vertical enum", () => {
  test("a known vertical reaches the engine", async () => {
    const run = await sk(["recipe-pack", "finance", "--json"]);
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([{ method: "GET", path: "/v1/recipe-packs/finance", query: "" }]);
  });

  test("an unknown vertical stops before any request", async () => {
    const run = await sk(["recipe-pack", "legal"]);
    expect(run.exitCode).toBe(2);
    expect(run.seen).toEqual([]);
    expect(run.stderr).toContain("recipe-pack: unknown vertical 'legal'");
  });
});
