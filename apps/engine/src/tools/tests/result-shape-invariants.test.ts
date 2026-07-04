// Result envelope shape invariants.
//
// The unified `ToolEnvelope` discriminated union is the dispatcher's
// public contract. This file uses a Zod schema to validate that every
// shape the dispatcher emits parses cleanly — guards against drift
// where a future change accidentally returns the legacy `ok:boolean`
// or omits a required field.

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { dispatchTool } from "../dispatcher.ts";
import { buildRegistry, type ToolProvider } from "../registry.ts";
import type { ToolDescriptor, ToolEnvelope } from "../types.ts";

// Authoritative Zod mirror of the ToolEnvelope union. Updating this
// without updating types.ts (or vice versa) is the regression we want
// the test to catch.
const ToolEnvelopeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    data: z.unknown(),
    pause: z.unknown().optional(),
    committed_workflow_id: z.string().optional(),
  }),
  z.object({
    status: z.literal("error"),
    error_code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    next_best_actions: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal("needs_confirm"),
    confirm: z.object({
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
      policy_mode: z.literal("confirm_before_execution"),
      reason: z.string(),
      tool_call_id: z.string(),
      resume: z.string(),
    }),
  }),
  z.object({
    status: z.literal("paused"),
    pause: z.unknown(),
  }),
  z.object({
    status: z.literal("not_available_on_surface"),
    reason: z.string(),
  }),
]);

const PRINCIPAL: ResolvedPrincipal = {
  kind: "user",
  id: "00000000-0000-0000-0000-000000000001",
  tenant_id: "00000000-0000-0000-0000-000000000002",
  authoring_role_id: null,
  scopes: new Set(),
  permission_grants: [],
  role_ids: [],
  api_key_id: null,
  // biome-ignore lint/suspicious/noExplicitAny: test stub
} as any;

// biome-ignore lint/suspicious/noExplicitAny: test stub
const DB_STUB: any = {
  transaction: async (fn: (db: unknown) => unknown) => fn(DB_STUB),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
};

function descriptorWithExecute(
  name: string,
  category: "tenant_read" | "tenant_write" | "draft_write",
  exec: () => Promise<unknown>,
): ToolProvider {
  const descriptor: ToolDescriptor = {
    name,
    description: `${name} stub`,
    category,
    inputSchema: { type: "object" },
  };
  return {
    name: `_stub_${name}`,
    list: () => [descriptor],
    resolve: (n) =>
      n === name
        ? {
            descriptor,
            executor: {
              kind: "conversation",
              tool: undefined as never,
              execute: async () => exec(),
            },
          }
        : undefined,
  };
}

describe("tools/result-shape — envelope union invariants", () => {
  test("ok envelope conforms", async () => {
    const reg = buildRegistry([
      descriptorWithExecute("_ok", "tenant_read", async () => ({
        ok: true,
        data: { x: 1 },
      })),
    ]);
    const envelope: ToolEnvelope = await dispatchTool(
      { registry: reg, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "chat", name: "_ok", args: {} },
    );
    expect(ToolEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.status).toBe("ok");
  });

  test("error envelope from legacy ok:false conforms (with structured error_code)", async () => {
    const reg = buildRegistry([
      descriptorWithExecute("_err", "tenant_read", async () => ({
        ok: false,
        error_code: "thing_missing",
        message: "no thing",
        next_best_actions: ["create_thing"],
      })),
    ]);
    const envelope = await dispatchTool(
      { registry: reg, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "chat", name: "_err", args: {} },
    );
    expect(ToolEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  test("error envelope from legacy ok:false with bare data preserves payload as details", async () => {
    const reg = buildRegistry([
      descriptorWithExecute("_errlegacy", "tenant_read", async () => ({
        ok: false,
        data: { error: "old-shape" },
      })),
    ]);
    const envelope = await dispatchTool(
      { registry: reg, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "chat", name: "_errlegacy", args: {} },
    );
    expect(ToolEnvelopeSchema.safeParse(envelope).success).toBe(true);
    if (envelope.status === "error") {
      expect(envelope.details).toEqual({ error: "old-shape" });
    }
  });

  test("needs_confirm envelope conforms", async () => {
    const reg = buildRegistry([
      descriptorWithExecute("_writes", "tenant_write", async () => ({
        ok: true,
        data: {},
      })),
    ]);
    // tenant_write without sk_confirm → needs_confirm
    const envelope = await dispatchTool(
      { registry: reg, db: DB_STUB, principal: PRINCIPAL },
      { surface: "mcp", name: "_writes", args: {} },
    );
    expect(ToolEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.status).toBe("needs_confirm");
  });

  test("not_available_on_surface envelope from draft_write on MCP conforms", async () => {
    const reg = buildRegistry([
      descriptorWithExecute("_draftw", "draft_write", async () => ({ ok: true, data: {} })),
    ]);
    const envelope = await dispatchTool(
      { registry: reg, db: DB_STUB, principal: PRINCIPAL, mcpMode: "authoring" },
      { surface: "mcp", name: "_draftw", args: {} },
    );
    expect(ToolEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.status).toBe("not_available_on_surface");
  });

  test("tool_not_found envelope conforms", async () => {
    const reg = buildRegistry([
      descriptorWithExecute("_unused", "tenant_read", async () => ({ ok: true, data: {} })),
    ]);
    const envelope = await dispatchTool(
      { registry: reg, db: DB_STUB, principal: PRINCIPAL },
      { surface: "chat", name: "definitely_does_not_exist", args: {} },
    );
    expect(ToolEnvelopeSchema.safeParse(envelope).success).toBe(true);
    if (envelope.status === "error") {
      expect(envelope.error_code).toBe("tool_not_found");
    }
  });

  test("executor throw is normalized to error envelope, not leaked", async () => {
    const reg = buildRegistry([
      descriptorWithExecute("_throws", "tenant_read", async () => {
        throw new Error("boom");
      }),
    ]);
    const envelope = await dispatchTool(
      { registry: reg, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "chat", name: "_throws", args: {} },
    );
    expect(ToolEnvelopeSchema.safeParse(envelope).success).toBe(true);
    if (envelope.status === "error") {
      expect(envelope.error_code).toBe("tool_execute_failed");
    }
  });

  test("status discriminator is exhaustive over the union", () => {
    const expected = new Set([
      "ok",
      "error",
      "needs_confirm",
      "paused",
      "not_available_on_surface",
    ]);
    // Force a complete match — adding a new status without updating the
    // schema and this set will break the discriminator narrowing.
    const seen = new Set<string>();
    for (const option of (ToolEnvelopeSchema as unknown as { options: Array<unknown> }).options) {
      const shape = (option as { shape?: { status?: { value?: string } } }).shape;
      const lit = shape?.status?.value;
      if (typeof lit === "string") seen.add(lit);
    }
    expect(seen).toEqual(expected);
  });
});
