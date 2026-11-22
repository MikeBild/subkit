import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { knowledgeSourcesCommand } from "../../../../subkit/src/commands/knowledge-sources.ts";
import { connectors } from "../../db/schema/index.ts";
import { getDocsSearchCacheStats, invalidateDocsCache } from "../../docs-ingestion/service.ts";
import { getKnowledgeSearchCacheStats, invalidateKnowledgeCache } from "../../knowledge/service.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { type Captured, extractLastJson, patchStd, withEnv, withNoExit } from "./cli-capture.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

describe("an operator manages knowledge from the subkit CLI", () => {
  describe("subkit knowledge-sources", () => {
    let ctx: JourneyCtx;

    let tmpFile: string;

    async function run(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runPlain(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runExpectError(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<{ message: string; captured: Captured }> {
      const cli = patchStd();
      let message = "";
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      } finally {
        cli.restore();
      }
      return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
    }

    let createdId = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("cli-knowledge-sources");
      tmpFile = path.join(tmpdir(), `ks-test-${TEST_NOW_MS}.txt`);
      writeFileSync(
        tmpFile,
        "The quick brown fox jumps over the lazy dog. This is a test document for knowledge source ingestion.",
      );
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: knowledge-sources list returns an array (may be empty)", async () => {
      const { stdout } = await run(knowledgeSourcesCommand, ["list"]);
      const body = JSON.parse(extractLastJson(stdout));
      const items = (body as { items?: unknown[] }).items ?? body;
      expect(Array.isArray(items)).toBe(true);
    });

    test("AC2: knowledge-sources create uploads file and returns record with id and name", async () => {
      const { stdout } = await run(
        knowledgeSourcesCommand,
        ["create"],
        ["--file", tmpFile, "--name", "Test Doc"],
      );
      const body = JSON.parse(extractLastJson(stdout));
      expect(typeof body.id).toBe("string");
      expect(body.id.length).toBeGreaterThan(0);
      expect(body.name).toBe("Test Doc");
      createdId = body.id as string;
    });

    test("AC3: knowledge-sources list after create contains the new id", async () => {
      const { stdout } = await run(knowledgeSourcesCommand, ["list"]);
      const body = JSON.parse(extractLastJson(stdout));
      const items =
        (body as { items?: Array<{ id: string }> }).items ?? (body as Array<{ id: string }>);
      const ids = (items as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toContain(createdId);
    });

    test("AC4: knowledge-sources get returns the correct record", async () => {
      const { stdout } = await run(knowledgeSourcesCommand, ["get", createdId]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(body.id).toBe(createdId);
      expect(typeof body.name).toBe("string");
    });

    test("AC5: knowledge-sources patch updates the name", async () => {
      const { stdout } = await run(
        knowledgeSourcesCommand,
        ["patch", createdId],
        ["--name", "Updated Doc"],
      );
      const body = JSON.parse(extractLastJson(stdout));
      expect(body.id).toBe(createdId);
      expect(body.name).toBe("Updated Doc");
    });

    test("AC6: knowledge-sources delete outputs 'deleted'", async () => {
      const { stdout } = await runPlain(knowledgeSourcesCommand, ["delete", createdId]);
      expect(stdout).toContain("deleted");
    });

    test("AC7: knowledge-sources get after delete returns an error", async () => {
      const { message, captured } = await runExpectError(knowledgeSourcesCommand, [
        "get",
        createdId,
      ]);
      const combined = `${message}\n${captured.stderr}`.toLowerCase();
      expect(
        combined.includes("not_found") ||
          combined.includes("404") ||
          combined.includes("not found") ||
          combined.includes("process.exit"),
      ).toBe(true);
    });

    test("AC8: knowledge source is not accessible without a valid api key", async () => {
      const res = await fetch(`${ctx.baseUrl}/v1/knowledge-sources`, {
        headers: { authorization: "Bearer wf_live_boguskey" },
      });
      expect(res.status).toBe(401);
    });

    let bundleDir = "";
    let bundleSourceId = "";

    test("AC9: knowledge-sources import creates one source from a directory", async () => {
      bundleDir = path.join(tmpdir(), `ks-bundle-${TEST_NOW_MS}`);
      const { mkdirSync } = await import("node:fs");
      mkdirSync(path.join(bundleDir, "runbooks"), { recursive: true });
      writeFileSync(
        path.join(bundleDir, "index.md"),
        "# Journey Wiki\n\n* [Deploy](runbooks/deploy.md)",
      );
      writeFileSync(
        path.join(bundleDir, "runbooks", "deploy.md"),
        "---\ntype: Runbook\ntitle: Deploy\n---\n# Deploy\n\nAlways run the smoke test after deploying.",
      );
      writeFileSync(path.join(bundleDir, "notes.md"), "Plain note without frontmatter.");

      const { stdout } = await run(knowledgeSourcesCommand, ["import", bundleDir]);
      const body = JSON.parse(extractLastJson(stdout)) as {
        outcome: string;
        ingested_count: number;
        skipped_files: string[];
        knowledge_source: { id: string; name: string; slug: string; tags: string[] };
      };
      expect(body.outcome).toBe("created");
      expect(body.ingested_count).toBe(2);
      expect(body.skipped_files).toEqual(["/index.md"]);
      expect(body.knowledge_source.name).toBe("Journey Wiki");
      expect(body.knowledge_source.tags).toContain("type:runbook");
      bundleSourceId = body.knowledge_source.id;
    });

    test("AC10: imported bundle is searchable with the structural type tag", async () => {
      const res = await fetch(
        `${ctx.baseUrl}/v1/knowledge-sources/search?q=smoke%20test%20deploy&tags=type:runbook`,
        { headers: { authorization: `Bearer ${ctx.apiKey}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hits: { source_name: string }[] };
      expect(body.hits.length).toBeGreaterThan(0);
      expect(body.hits[0]!.source_name).toBe("Journey Wiki");
    });

    test("AC11: chunks endpoint returns the full file content by path", async () => {
      const res = await fetch(
        `${ctx.baseUrl}/v1/knowledge-sources/${bundleSourceId}/chunks?path=${encodeURIComponent("/runbooks/deploy.md")}`,
        { headers: { authorization: `Bearer ${ctx.apiKey}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { content: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.content).toContain("Always run the smoke test after deploying.");
      expect(body.items[0]!.content).toContain("type: Runbook");
    });

    test("AC12: re-import of unchanged directory is a no-op (outcome unchanged)", async () => {
      const { stdout } = await run(knowledgeSourcesCommand, ["import", bundleDir]);
      const body = JSON.parse(extractLastJson(stdout)) as {
        outcome: string;
        ingested_count: number;
        knowledge_source: { id: string };
      };
      expect(body.outcome).toBe("unchanged");
      expect(body.ingested_count).toBe(0);
      expect(body.knowledge_source.id).toBe(bundleSourceId);
    });

    test("AC13: changed file re-ingests in place (outcome updated, same id)", async () => {
      writeFileSync(
        path.join(bundleDir, "notes.md"),
        "---\ntype: Decision\n---\nNow a typed decision note.",
      );
      const { stdout } = await run(knowledgeSourcesCommand, ["import", bundleDir]);
      const body = JSON.parse(extractLastJson(stdout)) as {
        outcome: string;
        knowledge_source: { id: string; tags: string[] };
      };
      expect(body.outcome).toBe("updated");
      expect(body.knowledge_source.id).toBe(bundleSourceId);
      expect(body.knowledge_source.tags).toContain("type:decision");
      expect(body.knowledge_source.tags).toContain("type:runbook");
    });

    test("AC14: import option flags map through (--name/--slug/--description/--tags)", async () => {
      const { stdout } = await run(
        knowledgeSourcesCommand,
        ["import", bundleDir],
        [
          "--name",
          "Flagged Wiki",
          "--slug",
          "flagged-wiki",
          "--description",
          "flag mapping probe",
          "--tags",
          "domain:journeys, extra",
        ],
      );
      const body = JSON.parse(extractLastJson(stdout)) as {
        outcome: string;
        knowledge_source: {
          name: string;
          slug: string;
          description: string | null;
          tags: string[];
        };
      };
      expect(body.outcome).toBe("created");
      expect(body.knowledge_source.name).toBe("Flagged Wiki");
      expect(body.knowledge_source.slug).toBe("flagged-wiki");
      expect(body.knowledge_source.description).toBe("flag mapping probe");
      expect(body.knowledge_source.tags).toContain("domain:journeys");
      expect(body.knowledge_source.tags).toContain("extra");
    });

    test("AC15: --json error discipline — slug conflict surfaces as structured error, not a crash", async () => {
      const form = new FormData();
      form.append("file", new Blob(["# owned"], { type: "text/markdown" }), "owned.md");
      form.append("metadata", JSON.stringify({ name: "Owned doc", slug: "cli-owned-slug" }));
      const seeded = await fetch(`${ctx.baseUrl}/v1/knowledge-sources`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.apiKey}` },
        body: form,
      });
      expect(seeded.status).toBe(201);

      const { message, captured } = await runExpectError(
        knowledgeSourcesCommand,
        ["import", bundleDir],
        ["--slug", "cli-owned-slug"],
      );
      const combined = `${message}\n${captured.stderr}\n${captured.stdout}`.toLowerCase();
      expect(
        combined.includes("slug_conflict") ||
          combined.includes("409") ||
          combined.includes("already belongs"),
      ).toBe(true);
    });
  });

  describe("subkit knowledge upload, search and converse", () => {
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

    async function runCli(
      command: import("citty").CommandDef,
      rawArgs: string[],
    ): Promise<Captured> {
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
});
