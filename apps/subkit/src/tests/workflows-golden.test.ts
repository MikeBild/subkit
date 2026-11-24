import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const GOLDEN_PATH = new URL("./fixtures/workflows.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, unknown>;
const actual: Record<string, unknown> = {};

async function record(name: string, args: string[]): Promise<void> {
  actual[name] = await subkit(args);
  expect(actual[name]).toEqual(golden[name]);
}

const WORKFLOW_ID = "5eed0002-0000-4000-8000-000000000001";
const OTHER_ID = "5eed0002-0000-4000-8000-000000000002";
const TENANT_ID = "5eed0001-0000-4000-8000-000000000001";

const item = (id: string, slug: string, name: string, category: string) => ({
  id,
  slug,
  name,
  description: `${name} keeps the ${category} catalog block in shape for the golden test.`,
  category,
  lifecycle: "active",
  connectors: ["notion"],
  trigger: null,
  schedule: null,
  webhooks_active: 0,
  effective_trigger: { kind: "manual" },
  updated_at: "2023-11-14T22:13:21.000Z",
});

const LIST = {
  items: [
    item(WORKFLOW_ID, "notion-sync", "Notion sync", "notion"),
    item(OTHER_ID, "daily-mail", "Daily mail", "communication"),
  ],
  total: 3,
  categories: [
    { category: "communication", count: 1 },
    { category: "notion", count: 1 },
  ],
};

const DETAIL = {
  ...item(WORKFLOW_ID, "notion-sync", "Notion sync", "notion"),
  definition: { name: "Notion sync", steps: [{ id: "noop", kind: "transform" }] },
};

let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? "" : await request.text();
      requests.push(`${request.method} ${url.pathname}${url.search} ${body}`.trim());
      if (url.pathname === "/v1/workflows") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return Response.json({ ...LIST, items: LIST.items.slice(offset) });
      }
      if (url.pathname === `/v1/workflows/${WORKFLOW_ID}`) return Response.json(DETAIL);
      if (url.pathname === `/v1/workflows/${WORKFLOW_ID}/metadata`)
        return Response.json({ ...DETAIL, ...JSON.parse(body) });
      return Response.json({ code: "not_found", message: "workflow not found" }, { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

async function subkit(args: string[]) {
  requests = [];
  const commandPath = new URL("../commands/workflows.ts", import.meta.url).pathname;
  const script = `import { runCommand } from "citty"; import { workflowsCommand } from ${JSON.stringify(commandPath)}; await runCommand(workflowsCommand, { rawArgs: ${JSON.stringify(args)} });`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      SUBKIT_ENGINE_URL: `http://127.0.0.1:${server.port}`,
      SUBKIT_API_KEY: "synthetic-cli-key",
      SUBKIT_TENANT: TENANT_ID,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      COLUMNS: "160",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const uncaught = stderr.search(/^\d+ \| /m);
  return { exitCode, requests, stdout, stderr: uncaught < 0 ? stderr : stderr.slice(0, uncaught) };
}

test("subkit workflows list prints grouped catalog blocks", async () => {
  await record("list", ["list"]);
});

test("subkit workflows list --flat --limit 2 --category notion prints one table", async () => {
  await record("list.flat", ["list", "--flat", "--limit", "2", "--category", "notion"]);
});

test("subkit workflows list --json prints the raw items", async () => {
  await record("list.json", ["list", "--json", "--connector", "notion"]);
});

test("subkit workflows get prints the workflow and its trigger", async () => {
  await record("get", ["get", WORKFLOW_ID]);
});

test("subkit workflows get reports a missing workflow", async () => {
  await record("get.missing", ["get", "5eed0002-0000-4000-8000-0000000000ff"]);
});

test("subkit workflows patch resolves a slug and patches metadata", async () => {
  await record("patch", [
    "patch",
    "notion-sync",
    "--name",
    "Notion mirror",
    "--category",
    "notion",
  ]);
});

test("subkit workflows patch without a field refuses before calling the engine", async () => {
  await record("patch.empty", ["patch", "notion-sync", "--json"]);
});

test("the golden file has no stale entries", () => {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
});
