import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { workflows, workflowVersions } from "../../../db/schema/index.ts";
import { listWorkflowToolSlugs } from "../../../workflows/catalog.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../tests/setup.ts";
import { splitPromptIntoBlocks, toSystemMessages } from "../cache-blocks.ts";
import { assembleEnhancedPrompt, type ConversationSurface } from "../context-assembler.ts";

const SURFACES: ConversationSurface[] = ["web", "sk_interactive", "sk_headless", "mcp", "chat"];
const AUTOMATION_CONTEXT = "AUTOMATIC OPERATION: wire-order sentinel for the automation block";
const AUTHORING_CONTEXT = "# Authoring context\nwire-order sentinel for the authoring block";
const USER_MEMORY = "wire-order sentinel for the user memory block";

let ctx: LlmTestCtx;
let principal: ResolvedPrincipal;

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeAll(async () => {
  ctx = await createLlmTestCtx("wire-order");
  principal = {
    provider: "test",
    kind: "user",
    id: "u-wire-order",
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
  };
  const [tool] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "wire-order-tool",
      name: "Wire Order Tool",
      lifecycle: "active",
      is_tool: true,
    })
    .returning();
  const [version] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: tool!.id,
      version: 1,
      dag: { name: "Wire Order Tool", slug: "wire-order-tool", steps: [] },
    })
    .returning();
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: version!.id })
    .where(eq(workflows.id, tool!.id));
  await ctx.testDb.db.insert(workflows).values({
    tenant_id: ctx.tenant_id,
    slug: "wire-order-draft",
    name: "Wire Order Draft",
    lifecycle: "draft",
    is_tool: false,
  });
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe("converse prompt on the wire", () => {
  for (const surface of SURFACES) {
    test(`${surface}: no section text twice, snapshot volatile, automation context once`, async () => {
      const prompt = await assembleEnhancedPrompt(
        {
          tenant_id: ctx.tenant_id,
          flow: "converse",
          surface,
          principal,
          connector_id: ctx.connector_id,
          user_turns: [{ role: "user", content: "what workflows do I have?" }],
          max_tokens: 50_000,
          model: "claude-sonnet-4-6",
          user_memory: USER_MEMORY,
          authoring_context: AUTHORING_CONTEXT,
          automation_context: AUTOMATION_CONTEXT,
          runtime_context: { surface, tenant_slug: "wire-order" },
        },
        ctx.testDb.db,
      );

      const sections = (prompt.system_sections ?? []).map((s) => s.text);
      expect(sections.length).toBeGreaterThan(0);
      expect(new Set(sections).size).toBe(sections.length);

      const messages = toSystemMessages(splitPromptIntoBlocks(prompt, "converse"), {
        enabled: true,
        ttl: "1h",
      });
      expect(messages).toHaveLength(2);
      const [stable, volatile] = messages;
      const wire = messages.map((m) => m.content).join("\n\n");
      for (const section of sections) {
        expect(occurrences(wire, section), section.slice(0, 60)).toBe(1);
      }

      expect(occurrences(wire, "=== TENANT SNAPSHOT")).toBe(1);
      expect(volatile!.content).toContain("=== TENANT SNAPSHOT");
      expect(stable!.content).not.toContain("=== TENANT SNAPSHOT");
      expect(stable!.providerOptions?.anthropic.cacheControl.ttl).toBe("1h");

      expect(occurrences(wire, AUTOMATION_CONTEXT)).toBe(1);
      expect(volatile!.content).toContain(AUTOMATION_CONTEXT);
      expect(occurrences(wire, AUTHORING_CONTEXT)).toBe(1);
      expect(occurrences(wire, USER_MEMORY)).toBe(1);
    });
  }

  test("every workflow the snapshot marks as a tool is a wf_ tool for the same principal", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        surface: "web",
        principal,
        user_turns: [{ role: "user", content: "list workflows" }],
        max_tokens: 50_000,
        model: "claude-sonnet-4-6",
      },
      ctx.testDb.db,
    );
    const toolSlugs = await listWorkflowToolSlugs({ db: ctx.testDb.db, principal });
    const marked = [...prompt.system.matchAll(/\[tool: wf_([a-z0-9-]+)\]/g)].map((m) => m[1]);
    expect(marked).toEqual(["wire-order-tool"]);
    for (const slug of marked) expect(toolSlugs.has(slug!)).toBe(true);
    expect(prompt.system).toContain("wire-order-draft (draft) [authoring-only]");
    expect(prompt.system).not.toContain("[tool: wf_wire-order-draft]");
  });

  test("without a principal the snapshot is withheld on every surface", async () => {
    for (const surface of SURFACES) {
      const prompt = await assembleEnhancedPrompt(
        {
          tenant_id: ctx.tenant_id,
          flow: "converse",
          surface,
          user_turns: [{ role: "user", content: "list workflows" }],
          max_tokens: 50_000,
          model: "claude-sonnet-4-6",
        },
        ctx.testDb.db,
      );
      expect(prompt.system, surface).not.toContain("=== TENANT SNAPSHOT");
    }
  });
});
