import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { discoveryArtifacts } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import { cannotHelpTool } from "../tools/cannot-help.ts";
import type { ToolContext } from "../tools/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const nextUuid = createDeterministicUuidFactory(0xca7_10);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("cannot_help_claim");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(palette?: ReadonlySet<string>): ToolContext {
  const draft = createEmptyDraftDocument();
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: nextUuid(),
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id: ctx.tenant_id, actor_id: null, db: ctx.testDb.db }),
    getDraft: () => draft,
    setDraft: async () => {},
    ...(palette ? { availableToolNames: palette } : {}),
  };
}

async function gapRowCount(): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ id: discoveryArtifacts.id })
    .from(discoveryArtifacts)
    .where(
      and(
        eq(discoveryArtifacts.tenant_id, ctx.tenant_id),
        eq(discoveryArtifacts.kind, "capability_gap"),
      ),
    );
  return rows.length;
}

describe("cannot_help — the capability claim is checked, not believed", () => {
  test("abstaining over a tool that IS in the palette is refused and files no gap", async () => {
    const before = await gapRowCount();
    const result = await cannotHelpTool.execute(
      makeCtx(new Set(["author_workflow", "dry_run_workflow"])),
      {
        reason: "the author_workflow tool is not available in this MCP surface",
        missing_capability: "tool.author_workflow",
      },
    );

    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string; message?: string };
    expect(data.error_code).toBe("capability_claim_false");
    expect(data.message).toContain("author_workflow");
    expect(await gapRowCount()).toBe(before);
  });

  test("a genuinely absent tool still abstains AND files the gap", async () => {
    const before = await gapRowCount();
    const result = await cannotHelpTool.execute(makeCtx(new Set(["dry_run_workflow"])), {
      reason: "I have no tool that can send a carrier pigeon.",
      missing_capability: "tool.send_carrier_pigeon",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { abstained?: boolean }).abstained).toBe(true);
    expect(await gapRowCount()).toBeGreaterThan(before);
  });

  test("no palette threaded → the abstention is allowed through", async () => {
    const result = await cannotHelpTool.execute(makeCtx(), {
      reason: "the author_workflow tool is not available here",
      missing_capability: "tool.author_workflow",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { abstained?: boolean }).abstained).toBe(true);
  });

  test("a non-tool slug is never matched against the palette", async () => {
    const result = await cannotHelpTool.execute(makeCtx(new Set(["author_workflow"])), {
      reason: "no verified Codex recipe exists in this engine yet",
      missing_capability: "vendor_recipe.author_workflow",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { abstained?: boolean }).abstained).toBe(true);
  });
});
