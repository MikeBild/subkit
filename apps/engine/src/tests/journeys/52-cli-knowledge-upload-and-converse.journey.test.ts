import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { knowledgeSourcesCommand } from "../../../../sk/src/commands/knowledge-sources.ts";
import { connectors } from "../../db/schema/index.ts";
import { getDocsSearchCacheStats, invalidateDocsCache } from "../../docs-ingestion/service.ts";
import { getKnowledgeSearchCacheStats, invalidateKnowledgeCache } from "../../knowledge/service.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: JourneyCtx;
let tmpFile: string;
let connectorId = "";

const MARKDOWN_FIXTURE = [
  "# Acme Charges API",
  "",
  "Acme is a payments API used to demonstrate the documentation pipeline.",
  "",
  "## Authentication",
  "",
  "Use a Bearer token in the `Authorization` header.",
  "Tokens are issued via OAuth2 client credentials flow.",
  "",
  "## Endpoints",
  "",
  "### POST /v1/charges",
  "Create a charge against a customer.",
  "",
  "### GET /v1/charges/{id}",
  "Retrieve a charge by id.",
].join("\n");

interface Captured {
  stdout: string;
  stderr: string;
}

function patchStd(): Captured & { restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return {
    get stdout() {
      return out.join("");
    },
    get stderr() {
      return err.join("");
    },
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

function isLogLine(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.ts === "string" && typeof o.level === "string" && typeof o.module === "string";
}

function extractLastJson(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!(line.startsWith("{") || line.startsWith("["))) continue;
    try {
      const parsed = JSON.parse(line);
      if (isLogLine(parsed)) continue;
      return line;
    } catch {}
  }
  let depth = 0;
  let end = -1;
  for (let i = stdout.length - 1; i >= 0; i--) {
    const c = stdout[i];
    if (c === "}" || c === "]") {
      if (end === -1) end = i;
      depth++;
    } else if (c === "{" || c === "[") {
      depth--;
      if (depth === 0 && end !== -1) {
        const candidate = stdout.slice(i, end + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (!isLogLine(parsed)) return candidate;
        } catch {}
        end = -1;
      }
    }
  }
  return stdout.trim();
}

function withEnv(url: string, apiKey: string, fn: () => Promise<void>): Promise<void> {
  const prevUrl = process.env.SUBKIT_ENGINE_URL;
  const prevKey = process.env.SUBKIT_API_KEY;
  process.env.SUBKIT_ENGINE_URL = url;
  process.env.SUBKIT_API_KEY = apiKey;
  return fn().finally(() => {
    if (prevUrl === undefined) delete process.env.SUBKIT_ENGINE_URL;
    else process.env.SUBKIT_ENGINE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUBKIT_API_KEY;
    else process.env.SUBKIT_API_KEY = prevKey;
  });
}

function withNoExit(fn: () => Promise<void>): Promise<void> {
  const origExit = process.exit.bind(process);
  (process as { exit: unknown }).exit = (code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  };
  return fn().finally(() => {
    process.exit = origExit;
  });
}

async function runCli(command: import("citty").CommandDef, rawArgs: string[]): Promise<Captured> {
  const cli = patchStd();
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(command, { rawArgs });
      }),
    );
  } finally {
    cli.restore();
  }
  return { stdout: cli.stdout, stderr: cli.stderr };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("ks-upload-converse");
  tmpFile = path.join(tmpdir(), `ks-md-${TEST_NOW_MS}.md`);
  writeFileSync(tmpFile, MARKDOWN_FIXTURE);

  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "acme-charges",
      display_name: "Acme Charges",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.acme.example.com",
      config: {},
    })
    .returning();
  connectorId = row!.id;

  invalidateKnowledgeCache(ctx.tenantId);
  invalidateDocsCache(ctx.tenantId, connectorId);
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 52: sk CLI knowledge upload → search → converse", () => {
  test("AC1: knowledge-sources create indexes a Markdown file", async () => {
    const { stdout } = await runCli(knowledgeSourcesCommand, [
      "create",
      "--file",
      tmpFile,
      "--name",
      "Acme Charges API Docs",
      "--json",
    ]);
    const body = JSON.parse(extractLastJson(stdout)) as {
      id: string;
      name: string;
      chunk_count: number;
    };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.name).toBe("Acme Charges API Docs");
    expect(body.chunk_count).toBeGreaterThanOrEqual(2);
  });

  test("AC2: GET /v1/knowledge-sources/search returns hits with non-null fetched_at", async () => {
    const res = await journeyFetch(
      ctx,
      `/v1/knowledge-sources/search?q=${encodeURIComponent("authorization bearer token")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ id: string; fetched_at: string | null }>;
    };
    expect(body.hits.length).toBeGreaterThan(0);
    const top = body.hits[0]!;
    expect(top.fetched_at).toBeTruthy();
    expect(() => new Date(top.fetched_at as string).toISOString()).not.toThrow();
  });

  test("AC3: a repeat search hits the in-memory cache", async () => {
    const before = getKnowledgeSearchCacheStats();
    const res1 = await journeyFetch(
      ctx,
      `/v1/knowledge-sources/search?q=${encodeURIComponent("charges endpoint")}`,
    );
    expect(res1.status).toBe(200);
    const res2 = await journeyFetch(
      ctx,
      `/v1/knowledge-sources/search?q=${encodeURIComponent("charges endpoint")}`,
    );
    expect(res2.status).toBe(200);
    const after = getKnowledgeSearchCacheStats();
    expect(after.hits).toBeGreaterThan(before.hits);
  });

  test("AC4: a conversation that triggers search_knowledge gets hits with fetched_at", async () => {
    const createRes = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      conversation: { id: string };
      status: string;
    };
    const conversationId = created.conversation.id;

    getMockProvider().setConversePlan(conversationId, [
      { tool: "search_knowledge", args: { query: "authorization bearer", limit: 3 } },
    ]);

    const followRes = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "search the docs for auth info" }),
    });
    expect([200, 202].includes(followRes.status)).toBe(true);
    const after = (await followRes.json()) as {
      events: Array<{ type: string; tool?: string; output?: unknown }>;
      status?: string;
    };
    const toolResult = after.events.find(
      (e) => e.type === "tool_result" && e.tool === "search_knowledge",
    );
    expect(toolResult).toBeTruthy();
    const output = toolResult?.output as
      | { hits?: Array<{ fetched_at?: string | null }> }
      | undefined;
    const hits = output?.hits ?? [];
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.fetched_at).toBeTruthy();
  });

  test("AC5: POST /v1/connectors/{id}/docs/ingest with Markdown content, search returns fetched_at", async () => {
    const ingestRes = await journeyFetch(ctx, `/v1/connectors/${connectorId}/docs/ingest`, {
      method: "POST",
      body: JSON.stringify({
        source_type: "markdown",
        content: MARKDOWN_FIXTURE,
      }),
    });
    expect(ingestRes.status).toBe(200);
    const ingestBody = (await ingestRes.json()) as { ingested_count: number };
    expect(ingestBody.ingested_count).toBeGreaterThanOrEqual(1);

    const searchRes = await journeyFetch(
      ctx,
      `/v1/connectors/${connectorId}/docs/search?q=${encodeURIComponent("authentication")}`,
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as {
      items: Array<{ id: string; fetched_at: string | null; match_type: string }>;
    };
    expect(searchBody.items.length).toBeGreaterThan(0);
    const top = searchBody.items[0]!;
    expect(top.fetched_at).toBeTruthy();
    expect(typeof top.match_type).toBe("string");
  });

  test("AC6: docs cache stats are observable via the test hook", () => {
    const stats = getDocsSearchCacheStats();
    expect(typeof stats.hits).toBe("number");
    expect(typeof stats.misses).toBe("number");
    expect(typeof stats.size).toBe("number");
  });
});
