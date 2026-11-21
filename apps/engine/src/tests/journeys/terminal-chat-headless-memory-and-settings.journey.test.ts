import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { ResolvedProfile } from "../../../../sk/src/config.ts";
import { runHeadless } from "../../../../sk/src/headless.ts";
import { loadMemory } from "../../../../sk/src/memory.ts";
import { loadSettings } from "../../../../sk/src/settings.ts";
import { auditLog, conversations } from "../../db/schema/index.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

describe("the sk terminal chat runs headless, remembers and layers settings", () => {
  describe("the headless output contract", () => {
    let ctx: JourneyCtx;

    interface WriterBuffer {
      write: (s: string) => void;
      lines(): string[];
      toString(): string;
    }

    function makeBuffer(): WriterBuffer {
      const chunks: string[] = [];
      return {
        write: (s: string) => {
          chunks.push(s);
        },
        lines: () =>
          chunks
            .join("")
            .split("\n")
            .filter((l) => l.length > 0),
        toString: () => chunks.join(""),
      };
    }

    function profileFor(tenantId: string, apiKey: string): ResolvedProfile {
      return {
        name: "journey",
        engine_url: ctx.baseUrl,
        api_key: apiKey,
        active_tenant_id: tenantId,
      };
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("sk-cli-08-headless");
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: --output text prints one line of assistant text and exits 0", async () => {
      const stdout = makeBuffer();
      const stderr = makeBuffer();
      const result = await runHeadless({
        profile: profileFor(ctx.tenantId, ctx.apiKey),
        prompt: "list the active workflows",
        output: "text",
        noMemory: true,
        stdout,
        stderr,
      });
      expect(result.exitCode).toBe(0);
      expect(result.conversation_id).not.toBeNull();
      expect(stderr.toString()).not.toContain("sk:");
    });

    test("AC2: --output json emits a parseable envelope with all documented fields", async () => {
      const stdout = makeBuffer();
      const stderr = makeBuffer();
      const result = await runHeadless({
        profile: profileFor(ctx.tenantId, ctx.apiKey),
        prompt: "create a sample workflow",
        output: "json",
        noMemory: true,
        stdout,
        stderr,
      });
      expect(result.exitCode).toBe(0);
      const raw = stdout.toString().trim();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.session_id).toBeDefined();
      expect(typeof parsed.status).toBe("string");
      expect(Array.isArray(parsed.messages)).toBe(true);
      expect(Array.isArray(parsed.tool_calls)).toBe(true);
      expect(Array.isArray(parsed.validation_errors)).toBe(true);
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(Array.isArray(parsed.memory_sources)).toBe(true);
      expect(typeof parsed.assistant_text).toBe("string");
    });

    test("AC3: --output stream-json emits NDJSON ending with a `completed` frame", async () => {
      const stdout = makeBuffer();
      const stderr = makeBuffer();
      const result = await runHeadless({
        profile: profileFor(ctx.tenantId, ctx.apiKey),
        prompt: "stream a turn",
        output: "stream-json",
        noMemory: true,
        stdout,
        stderr,
      });
      expect(result.exitCode).toBe(0);
      const lines = stdout.lines();
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { type?: string };
      expect(last.type).toBe("completed");
    });

    test("AC4: --no-memory skips injection — no CONVERSATION_MEMORY_INJECTED audit row", async () => {
      const result = await runHeadless({
        profile: profileFor(ctx.tenantId, ctx.apiKey),
        prompt: "no memory here",
        output: "text",
        noMemory: true,
        stdout: makeBuffer(),
        stderr: makeBuffer(),
      });
      expect(result.exitCode).toBe(0);
      const rows = await ctx.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "conversation.memory_injected"),
            eq(auditLog.resource_id, result.conversation_id as string),
          ),
        );
      expect(rows.length).toBe(0);
    });

    test("AC5: a broken profile (invalid API key) exits with code 2", async () => {
      const stdout = makeBuffer();
      const stderr = makeBuffer();
      const result = await runHeadless({
        profile: {
          name: "bad",
          engine_url: ctx.baseUrl,
          api_key: "wf_live_not-a-real-key-aaaaaaaaaaaaaaaaaaaaaa",
          active_tenant_id: ctx.tenantId,
        },
        prompt: "will fail",
        output: "text",
        noMemory: true,
        stdout,
        stderr,
      });
      expect(result.exitCode).toBe(2);
      expect(stderr.toString()).toContain("sk:");
    });
  });

  describe("the memory pipeline", () => {
    let ctx: JourneyCtx;

    let tmpWorkspace: string;

    const makeBuf = () => {
      const chunks: string[] = [];
      return {
        write: (s: string) => chunks.push(s),
        toString: () => chunks.join(""),
      };
    };

    function profile(): ResolvedProfile {
      return {
        name: "journey",
        engine_url: ctx.baseUrl,
        api_key: ctx.apiKey,
        active_tenant_id: ctx.tenantId,
      };
    }

    async function memoryAuditCount(conversationId: string): Promise<number> {
      const rows = await ctx.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "conversation.memory_injected"),
            eq(auditLog.resource_id, conversationId),
          ),
        );
      return rows.length;
    }

    async function conversationMemory(id: string): Promise<string | null> {
      const [row] = await ctx.db
        .select({ memory: conversations.memory })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      return row?.memory ?? null;
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("sk-cli-10-memory");
      tmpWorkspace = mkdtempSync(join(tmpdir(), "sk-memory-ws-"));
      writeFileSync(
        join(tmpWorkspace, "SK.md"),
        "# Project memory\n- prefer JSON response shapes\n- avoid pagination for list endpoints under 100 rows\n",
        "utf8",
      );
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      rmSync(tmpWorkspace, { recursive: true, force: true });
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: SK.md is forwarded, stored, and audited on first turn", async () => {
      const result = await runHeadless({
        profile: profile(),
        prompt: "create a sample workflow",
        output: "text",
        cwd: tmpWorkspace,
        stdout: makeBuf(),
        stderr: makeBuf(),
      });
      expect(result.exitCode).toBe(0);
      const id = result.conversation_id as string;
      expect(id).toBeDefined();
      const persisted = await conversationMemory(id);
      expect(persisted).toContain("prefer JSON response shapes");
      const count = await memoryAuditCount(id);
      expect(count).toBe(1);
    });

    test("AC2: a follow-up turn without memory reuses the persisted row", async () => {
      const created = await runHeadless({
        profile: profile(),
        prompt: "turn 1",
        output: "json",
        cwd: tmpWorkspace,
        stdout: makeBuf(),
        stderr: makeBuf(),
      });
      const id = created.conversation_id as string;
      const initialCount = await memoryAuditCount(id);
      const res = await journeyFetch(ctx, `/v1/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "turn 2" }),
      });
      expect(res.status).toBe(200);
      const finalCount = await memoryAuditCount(id);
      expect(finalCount).toBe(initialCount);
      expect(await conversationMemory(id)).toContain("prefer JSON response shapes");
    });

    test("AC3: explicitly resending memory writes a new row", async () => {
      const created = await runHeadless({
        profile: profile(),
        prompt: "initial",
        output: "text",
        cwd: tmpWorkspace,
        stdout: makeBuf(),
        stderr: makeBuf(),
      });
      const id = created.conversation_id as string;
      const initialCount = await memoryAuditCount(id);
      const res = await journeyFetch(ctx, `/v1/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          message: "with updated memory",
          memory: "# Updated memory\n- switched to RFC 7807 errors",
        }),
      });
      expect(res.status).toBe(200);
      expect(await memoryAuditCount(id)).toBe(initialCount + 1);
      const persisted = await conversationMemory(id);
      expect(persisted).toContain("RFC 7807");
    });

    test("AC4: --no-memory skips injection even when SK.md exists", async () => {
      const result = await runHeadless({
        profile: profile(),
        prompt: "no memory please",
        output: "text",
        noMemory: true,
        cwd: tmpWorkspace,
        stdout: makeBuf(),
        stderr: makeBuf(),
      });
      const id = result.conversation_id as string;
      expect(await memoryAuditCount(id)).toBe(0);
      expect(await conversationMemory(id)).toBeNull();
    });

    test("AC5: memory loader walks upward from a nested cwd", () => {
      const nested = join(tmpWorkspace, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      const result = loadMemory({ cwd: nested });
      expect(result.content).toContain("prefer JSON response shapes");
      expect(result.sources[0]).toContain("SK.md");
    });
  });

  describe("settings layering", () => {
    let ctx: JourneyCtx;

    let tmpWorkspace: string;

    let prevSkHome: string | undefined;

    let userHome: string;

    const makeBuf = () => ({
      write: (_s: string) => {},
    });

    function profile(): ResolvedProfile {
      return {
        name: "journey",
        engine_url: ctx.baseUrl,
        api_key: ctx.apiKey,
        active_tenant_id: ctx.tenantId,
      };
    }

    async function loadConversationModel(id: string): Promise<string | null> {
      const [row] = await ctx.db
        .select({ model: conversations.model })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      return row?.model ?? null;
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("sk-cli-15-settings");
      userHome = mkdtempSync(join(tmpdir(), "sk-set-home-"));
      tmpWorkspace = mkdtempSync(join(tmpdir(), "sk-set-ws-"));
      prevSkHome = testEnv.SK_HOME;
      testEnv.SK_HOME = userHome;
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (prevSkHome !== undefined) testEnv.SK_HOME = prevSkHome;
      else delete testEnv.SK_HOME;
      rmSync(userHome, { recursive: true, force: true });
      rmSync(tmpWorkspace, { recursive: true, force: true });
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    function writeProject(obj: unknown): void {
      mkdirSync(join(tmpWorkspace, ".sk"), { recursive: true });
      writeFileSync(join(tmpWorkspace, ".sk", "settings.json"), JSON.stringify(obj), "utf8");
    }

    function writeLocal(obj: unknown): void {
      mkdirSync(join(tmpWorkspace, ".sk"), { recursive: true });
      writeFileSync(join(tmpWorkspace, ".sk", "settings.local.json"), JSON.stringify(obj), "utf8");
    }

    function clearLayers(): void {
      try {
        rmSync(join(tmpWorkspace, ".sk"), { recursive: true, force: true });
      } catch {}
    }

    test("AC1: project settings override defaults — loader observes it", () => {
      clearLayers();
      writeProject({ model: "project-model", defaultTenant: "project-tenant" });
      const r = loadSettings(tmpWorkspace);
      expect(r.merged.model).toBe("project-model");
      expect(r.merged.defaultTenant).toBe("project-tenant");
      expect(r.sources.some((s) => s.endsWith("settings.json"))).toBe(true);
    });

    test("AC2: local settings override project settings for the same key", () => {
      clearLayers();
      writeProject({ model: "from-project" });
      writeLocal({ model: "from-local" });
      const r = loadSettings(tmpWorkspace);
      expect(r.merged.model).toBe("from-local");
    });

    test("AC3: additionalDirectories — later layer replaces earlier array", () => {
      clearLayers();
      writeProject({ additionalDirectories: ["docs", "scripts"] });
      writeLocal({ additionalDirectories: ["local-only"] });
      const r = loadSettings(tmpWorkspace);
      expect(r.merged.additionalDirectories).toEqual(["local-only"]);
    });

    test("AC4: includeMemoryFile: false suppresses SUBKIT.md injection", async () => {
      clearLayers();
      writeFileSync(join(tmpWorkspace, "SUBKIT.md"), "# memory you shouldn't see", "utf8");
      writeProject({ includeMemoryFile: false });
      const result = await runHeadless({
        profile: profile(),
        prompt: "check memory suppression",
        output: "text",
        cwd: tmpWorkspace,
        stdout: makeBuf(),
        stderr: makeBuf(),
      });
      const id = result.conversation_id as string;
      const [row] = await ctx.db
        .select({ memory: conversations.memory })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      expect(row?.memory ?? null).toBeNull();
    });

    test("AC5: settings.model attaches to new conversations", async () => {
      clearLayers();
      writeProject({ model: "anthropic:claude-opus-4-6" });
      const result = await runHeadless({
        profile: profile(),
        prompt: "pick my model",
        output: "text",
        noMemory: true,
        cwd: tmpWorkspace,
        stdout: makeBuf(),
        stderr: makeBuf(),
      });
      const id = result.conversation_id as string;
      expect(await loadConversationModel(id)).toBe("anthropic:claude-opus-4-6");
    });

    test("AC6: missing files are tolerated", () => {
      clearLayers();
      const r = loadSettings(tmpWorkspace);
      expect(r.merged.includeMemoryFile).toBe(true);
      expect(r.merged.statusLine?.showTokens).toBe(true);
    });
  });
});
