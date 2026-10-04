import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSlash, type SlashHandlerContext } from "../repl/slash/handler.ts";
import { dispatchKnowledgeSlash } from "../repl/slash/handlers/knowledge.ts";

const dirs: string[] = [];

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-knowledge-slash-"));
  dirs.push(dir);
  mkdirSync(join(dir, "runbooks"));
  writeFileSync(join(dir, "index.md"), "# Slash Wiki");
  writeFileSync(join(dir, "runbooks", "deploy.md"), "---\ntype: Runbook\n---\nbody");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface StubCalls {
  importBodies: Record<string, unknown>[];
  panes: unknown[];
  listed: number;
}

function makeCtx(overrides?: { withPane?: boolean; importError?: Error }): {
  ctx: SlashHandlerContext;
  calls: StubCalls;
} {
  const calls: StubCalls = { importBodies: [], panes: [], listed: 0 };
  const client = {
    importKnowledgeBundle: async (body: Record<string, unknown>) => {
      if (overrides?.importError) throw overrides.importError;
      calls.importBodies.push(body);
      return {
        outcome: "created",
        ingested_count: 1,
        skipped_count: 1,
        knowledge_source: { name: body.name, slug: "slash-wiki" },
      };
    },
    listKnowledgeSources: async () => {
      calls.listed++;
      return { items: [{ id: "ks_1", name: "Existing Source", kind: "bundle" }] };
    },
  };
  const ctx = {
    client,
    ...(overrides?.withPane
      ? {
          openPane: (spec: unknown) => {
            calls.panes.push(spec);
          },
        }
      : {}),
  } as unknown as SlashHandlerContext;
  return { ctx, calls };
}

describe("/knowledge slash handler", () => {
  test("bare /knowledge delegates to the inspect behavior (Settings pane on Ink hosts)", async () => {
    const { ctx, calls } = makeCtx({ withPane: true });
    const banner = await dispatchKnowledgeSlash([], ctx);
    expect(banner).toBeNull();
    expect(calls.panes).toHaveLength(1);
    expect((calls.panes[0] as { kind: string }).kind).toBe("settings");
  });

  test("bare /knowledge lists sources on readline hosts (no pane)", async () => {
    const { ctx, calls } = makeCtx();
    const banner = await dispatchKnowledgeSlash([], ctx);
    expect(calls.listed).toBe(1);
    expect(String(banner)).toContain("Existing Source");
  });

  test("import walks the directory, skips reserved files client-agnostically, posts the bundle", async () => {
    const dir = makeVault();
    const { ctx, calls } = makeCtx();
    const banner = await dispatchKnowledgeSlash(["import", dir], ctx);
    expect(calls.importBodies).toHaveLength(1);
    const body = calls.importBodies[0] as { name: string; files: { path: string }[] };
    expect(body.name).toBe("Slash Wiki");
    expect(body.files.map((f) => f.path)).toEqual(["/index.md", "/runbooks/deploy.md"]);
    expect(String(banner)).toContain("created");
    expect(String(banner)).toContain("1 chunks ingested");
  });

  test("unknown action and missing dir return usage, never throw", async () => {
    const { ctx } = makeCtx();
    expect(String(await dispatchKnowledgeSlash(["export"], ctx))).toContain("usage:");
    expect(String(await dispatchKnowledgeSlash(["import"], ctx))).toContain("usage:");
  });

  test("engine failure surfaces as a banner, not a crash", async () => {
    const dir = makeVault();
    const { ctx } = makeCtx({ importError: new Error("engine is down") });
    const banner = await dispatchKnowledgeSlash(["import", dir], ctx);
    expect(String(banner)).toContain("import failed: engine is down");
  });

  test("unreadable directory surfaces as a banner, not a crash", async () => {
    const { ctx } = makeCtx();
    const banner = await dispatchKnowledgeSlash(["import", "/definitely/not/a/dir"], ctx);
    expect(String(banner)).toContain("couldn't read bundle:");
  });

  test("handleSlash wires /knowledge import to the IMPORT handler, not the inspect pane", async () => {
    const dir = makeVault();
    const { ctx, calls } = makeCtx({ withPane: true });
    const banner = await handleSlash("knowledge", ["import", dir], ctx);
    expect(calls.importBodies).toHaveLength(1);
    expect(calls.panes).toHaveLength(0);
    expect(String(banner)).toContain("created");
  });
});
