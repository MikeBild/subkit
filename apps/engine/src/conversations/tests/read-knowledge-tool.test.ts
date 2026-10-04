import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertKnowledgeBundle } from "../../knowledge/bundle-service.ts";
import { readKnowledgeTool } from "../tools/engine-api/knowledge-sources.ts";
import type { ToolContext } from "../tools/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
let sourceId = "";
let bigSourceId = "";

function toolCtx(): ToolContext {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub matching ToolContext for in-process service calls
  const engineClientStub: any = {
    context: { actor_id: ctx.user_id, actor_type: "user" },
    knowledgeSources: {
      // biome-ignore lint/suspicious/noExplicitAny: in-process service forwarding
      chunks: async (id: string, opts: any) => {
        const { listKnowledgeChunks } = await import("../../knowledge/bundle-service.ts");
        return listKnowledgeChunks(
          { tenant_id: ctx.tenant_id, knowledge_source_id: id, ...opts },
          ctx.testDb.db,
        );
      },
    },
  };
  return { engineClient: engineClientStub } as unknown as ToolContext;
}

beforeAll(async () => {
  ctx = await createConversationTestCtx("read_knowledge_tool");

  const wiki = await upsertKnowledgeBundle(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      input: { name: "Read Wiki", slug: "read-wiki" },
      files: [
        {
          path: "runbooks/deploy.md",
          content: "---\ntype: Runbook\n---\n# Deploy\n\nRun the smoke test.",
        },
        { path: "notes.md", content: "A plain note." },
      ],
    },
    ctx.testDb.db,
  );
  sourceId = wiki.knowledge_source.id;

  const big = Array.from(
    { length: 2_000 },
    (_, i) => `unique paragraph ${i}: the quick brown fox jumps over lazy dog number ${i}.`,
  ).join("\n\n");
  const bigWiki = await upsertKnowledgeBundle(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      input: { name: "Big Read Wiki", slug: "big-read-wiki" },
      files: [{ path: "big.md", content: big }],
    },
    ctx.testDb.db,
  );
  bigSourceId = bigWiki.knowledge_source.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 60_000);

describe("read_knowledge tool", () => {
  test("full read returns every chunk with raw content", async () => {
    const result = await readKnowledgeTool.execute(toolCtx(), {
      knowledge_source_id: sourceId,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      source: { slug: string; chunk_count: number };
      chunks: { path: string | null; content: string }[];
      next_offset?: number;
    };
    expect(data.source.slug).toBe("read-wiki");
    expect(data.chunks).toHaveLength(2);
    const deploy = data.chunks.find((c) => c.path === "/runbooks/deploy.md");
    expect(deploy?.content).toContain("type: Runbook");
    expect(deploy?.content).toContain("Run the smoke test.");
    expect(data.next_offset).toBeUndefined();
  });

  test("path narrows to one file; unknown path yields a typed error", async () => {
    const hit = await readKnowledgeTool.execute(toolCtx(), {
      knowledge_source_id: sourceId,
      path: "/notes.md",
    });
    expect(hit.ok).toBe(true);
    expect((hit.data as { chunks: unknown[] }).chunks).toHaveLength(1);

    const miss = await readKnowledgeTool.execute(toolCtx(), {
      knowledge_source_id: sourceId,
      path: "/does-not-exist.md",
    });
    expect(miss.ok).toBe(false);
    expect((miss.data as { error: string }).error).toBe("path_not_found");
  });

  test("large source pages via next_offset and pages compose to the full content", async () => {
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let rounds = 0;
    while (offset !== undefined) {
      rounds++;
      if (rounds > 20) throw new Error("pagination did not terminate");
      const page = await readKnowledgeTool.execute(toolCtx(), {
        knowledge_source_id: bigSourceId,
        offset,
      });
      expect(page.ok).toBe(true);
      const data = page.data as {
        chunks: { ordinal: number; content: string }[];
        next_offset?: number;
      };
      seen.push(...data.chunks.map((c) => c.content));
      offset = data.next_offset;
    }
    expect(rounds).toBeGreaterThan(1);
    const combined = seen.join("");
    expect(combined).toContain("unique paragraph 0:");
    expect(combined).toContain("unique paragraph 1999:");
  });

  test("path + offset pages through ONE large split file completely", async () => {
    const big = Array.from(
      { length: 2_500 },
      (_, i) => `single-file paragraph ${i}: sphinx of black quartz judge my vow ${i}.`,
    ).join("\n\n");
    const wiki = await upsertKnowledgeBundle(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        input: { name: "Split File Wiki", slug: "split-file-wiki" },
        files: [
          { path: "big/one.md", content: big },
          { path: "small.md", content: "unrelated" },
        ],
      },
      ctx.testDb.db,
    );

    const seen: string[] = [];
    let offset: number | undefined = 0;
    let rounds = 0;
    while (offset !== undefined) {
      rounds++;
      if (rounds > 20) throw new Error("pagination did not terminate");
      const page = await readKnowledgeTool.execute(toolCtx(), {
        knowledge_source_id: wiki.knowledge_source.id,
        path: "/big/one.md",
        offset,
      });
      expect(page.ok).toBe(true);
      const data = page.data as {
        chunks: { path: string | null; content: string }[];
        next_offset?: number;
      };
      for (const c of data.chunks) expect(c.path).toBe("/big/one.md");
      seen.push(...data.chunks.map((c) => c.content));
      offset = data.next_offset;
    }
    expect(rounds).toBeGreaterThan(1);
    const combined = seen.join("");
    expect(combined).toContain("single-file paragraph 0:");
    expect(combined).toContain("single-file paragraph 2499:");
    expect(combined).not.toContain("unrelated");
  });

  test("row-count pagination: 60 tiny files page at the 50-row boundary, none lost", async () => {
    const files = Array.from({ length: 60 }, (_, i) => ({
      path: `tiny/t${String(i).padStart(2, "0")}.md`,
      content: `tiny note ${i}`,
    }));
    const wiki = await upsertKnowledgeBundle(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        input: { name: "Tiny Files Wiki", slug: "tiny-files-wiki" },
        files,
      },
      ctx.testDb.db,
    );

    const first = await readKnowledgeTool.execute(toolCtx(), {
      knowledge_source_id: wiki.knowledge_source.id,
    });
    expect(first.ok).toBe(true);
    const page1 = first.data as { chunks: unknown[]; next_offset?: number };
    expect(page1.chunks).toHaveLength(50);
    expect(page1.next_offset).toBe(50);

    const second = await readKnowledgeTool.execute(toolCtx(), {
      knowledge_source_id: wiki.knowledge_source.id,
      offset: page1.next_offset,
    });
    const page2 = second.data as { chunks: { content: string }[]; next_offset?: number };
    expect(page2.chunks).toHaveLength(10);
    expect(page2.next_offset).toBeUndefined();
    expect(page2.chunks.at(-1)!.content).toBe("tiny note 59");
  });

  test("cross-tenant isolation: another tenant's id reads as not found", async () => {
    const result = await readKnowledgeTool.execute(
      {
        engineClient: {
          knowledgeSources: {
            chunks: async (id: string, opts: Record<string, unknown>) => {
              const { listKnowledgeChunks } = await import("../../knowledge/bundle-service.ts");
              return listKnowledgeChunks(
                {
                  tenant_id: "00000000-0000-4000-8000-00000000beef",
                  knowledge_source_id: id,
                  ...opts,
                },
                ctx.testDb.db,
              );
            },
          },
        },
      } as unknown as ToolContext,
      { knowledge_source_id: sourceId },
    );
    expect(result.ok).toBe(false);
    expect((result.data as { error: string }).error).toBe("knowledge_source_not_found");
  });

  test("unknown source id → knowledge_source_not_found", async () => {
    const result = await readKnowledgeTool.execute(toolCtx(), {
      knowledge_source_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error: string }).error).toBe("knowledge_source_not_found");
  });
});
