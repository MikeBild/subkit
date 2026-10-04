import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EngineError } from "@cli-core/errors";
import { renderInvokeSnippet } from "@shared/invoke-snippet.ts";
import { runCommand } from "citty";
import { createHttpTestServer, type HttpTestServer } from "../../../engine/src/http/tests/setup.ts";
import { withConfigKey } from "../../../engine/src/test-helpers/config-override.ts";
import { resolveInvokeSnippet } from "../lib/invoke-snippet-source.ts";
import { workflowsCommand } from "./workflows.ts";

const PUBLIC_URL = "https://engine.example.com";
const UNKNOWN_WORKFLOW = "3fb5fc90-1c2d-4e5f-8a6b-7c8d9e0f1a2b";

interface Emitted {
  snippet: string;
  engine_url: string;
  environment: string;
  source: "engine" | "local";
  local_reason?: string;
}

let ctx: HttpTestServer;
let workflowId: string;
let written: string[];
let restore: () => void;

beforeAll(async () => {
  ctx = await createHttpTestServer("sk_invoke_snippet");
  const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: "invoke-snippet-required-input",
      steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
      input_schema: {
        type: "object",
        properties: { recipient_email: { type: "string" }, limit: { type: "integer", default: 5 } },
        required: ["recipient_email", "limit"],
      },
    }),
  });
  if (!res.ok) throw new Error(`workflow create failed: ${res.status} ${await res.text()}`);
  workflowId = ((await res.json()) as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

beforeEach(() => {
  const names = ["SUBKIT_ENGINE_URL", "SUBKIT_API_KEY", "SUBKIT_TENANT"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]] as const));
  written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  restore = () => {
    process.stdout.write = original;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
});

afterEach(() => restore());

function profile(engineUrl: string, apiKey: string, tenant?: string): void {
  process.env.SUBKIT_ENGINE_URL = engineUrl;
  process.env.SUBKIT_API_KEY = apiKey;
  if (tenant === undefined) delete process.env.SUBKIT_TENANT;
  else process.env.SUBKIT_TENANT = tenant;
}

function commandOutput(): string {
  return written.filter((chunk) => !chunk.startsWith('{"ts":')).join("");
}

async function emit(id: string, ...args: string[]): Promise<Emitted> {
  await runCommand(workflowsCommand, { rawArgs: ["invoke-snippet", id, "--json", ...args] });
  return JSON.parse(commandOutput()) as Emitted;
}

async function engineInvocation(): Promise<{
  base_url: string | null;
  http: { snippets: Record<"dev" | "prod", Record<string, string>> | null };
}> {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows/${workflowId}/invocation`, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
  });
  return (await res.json()) as Awaited<ReturnType<typeof engineInvocation>>;
}

describe("sk workflows invoke-snippet — against the engine", () => {
  test.each([
    ["curl", "prod"],
    ["node", "prod"],
    ["python", "dev"],
  ] as const)("%s/%s is the engine's snippet, byte for byte", async (lang, environment) => {
    profile(ctx.baseUrl, ctx.apiKey);
    const [out, engine] = await withConfigKey("server.public_base_url", PUBLIC_URL, async () => [
      await emit(workflowId, "--lang", lang, "--environment", environment),
      await engineInvocation(),
    ]);
    expect(out.source).toBe("engine");
    expect(out.snippet).toBe(engine.http.snippets?.[environment][lang] ?? "no engine snippet");
    expect(out.snippet).toContain("recipient_email");
    expect(out.snippet).toContain("<recipient_email>");
    expect(out.engine_url).toBe(PUBLIC_URL);
    expect(out.snippet).toContain(`${PUBLIC_URL}/v1/executions`);
    expect(out.snippet).not.toContain(ctx.baseUrl);
  });

  test("production is the default and is stated", async () => {
    profile(ctx.baseUrl, ctx.apiKey);
    const out = await withConfigKey("server.public_base_url", PUBLIC_URL, () => emit(workflowId));
    expect(out.environment).toBe("prod");
    expect(out.snippet).toContain("x-subkit-environment: prod");
  });

  test("the key is never printed", async () => {
    profile(ctx.baseUrl, ctx.apiKey);
    await withConfigKey("server.public_base_url", PUBLIC_URL, () => emit(workflowId));
    expect(commandOutput()).not.toContain(ctx.apiKey);
  });
});

describe("sk workflows invoke-snippet — when the engine cannot answer", () => {
  const local = (id: string, engineUrl: string) =>
    renderInvokeSnippet({ lang: "curl", engineUrl, workflowId: id, environment: "prod" });

  test("an engine without a public address: rendered here, and said so", async () => {
    profile(ctx.baseUrl, ctx.apiKey);
    const out = await withConfigKey("server.public_base_url", "", () => emit(workflowId));
    expect(out).toMatchObject({
      source: "local",
      local_reason: "no_public_address",
      engine_url: ctx.baseUrl,
    });
    expect(out.snippet).toBe(local(workflowId, ctx.baseUrl));
  });

  test("a workflow the engine does not know", async () => {
    profile(ctx.baseUrl, ctx.apiKey);
    const out = await emit(UNKNOWN_WORKFLOW);
    expect(out).toMatchObject({ source: "local", local_reason: "workflow_unknown" });
    expect(out.snippet).toBe(local(UNKNOWN_WORKFLOW, ctx.baseUrl));
  });

  test("an unreachable engine", async () => {
    profile("http://127.0.0.1:9", "wf_live_never_printed", "tenant-never-printed");
    const out = await emit(UNKNOWN_WORKFLOW, "--environment", "dev");
    expect(out).toMatchObject({ source: "local", local_reason: "engine_unreachable" });
    expect(out.environment).toBe("dev");
    expect(out.snippet).toContain("x-subkit-environment: dev");
    const all = commandOutput();
    expect(all).not.toContain("x-subkit-tenant");
    expect(all).not.toContain("tenant-never-printed");
    expect(all).not.toContain("wf_live_never_printed");
  });

  test("an id that is not a workflow id is not asked for at all", async () => {
    let asked = 0;
    const out = await resolveInvokeSnippet({
      client: {
        getWorkflowInvocation: async () => {
          asked += 1;
          throw new Error("must not be called");
        },
      },
      profileEngineUrl: PUBLIC_URL,
      workflowId: "wf_abc123",
      lang: "curl",
      environment: "prod",
    });
    expect(asked).toBe(0);
    expect(out).toMatchObject({ source: "local", local_reason: "workflow_unknown" });
    expect(out.snippet).toBe(local("wf_abc123", PUBLIC_URL));
  });

  test.each([401, 403, 500])(
    "a %i is an error, not a reason to print another call",
    async (status) => {
      await expect(
        resolveInvokeSnippet({
          client: {
            getWorkflowInvocation: async () => {
              throw new EngineError(status, { code: "refused", message: "refused" });
            },
          },
          profileEngineUrl: PUBLIC_URL,
          workflowId: UNKNOWN_WORKFLOW,
          lang: "curl",
          environment: "prod",
        }),
      ).rejects.toBeInstanceOf(EngineError);
    },
  );
});
