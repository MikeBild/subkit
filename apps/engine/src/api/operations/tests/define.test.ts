import { describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { defineOperation, isRejection, reject } from "../index.ts";
import { toConversationTool } from "../tool.ts";

const base = {
  id: "things.get",
  summary: "Fetch a thing",
  permission: "thing:read",
  effect: "read" as const,
  handler: async () => reject.notFound("thing"),
};

const http = {
  method: "get" as const,
  path: "/v1/things/{id}",
  tags: ["things"],
  response: z.object({}),
  toInput: () => ({}),
  toBody: () => ({}),
};

const tool = {
  name: "get_thing",
  description: "Fetch a thing",
  input: z.object({ id: z.string() }),
  gate: "enforced" as const,
  toInput: (args: unknown) => args,
  toResult: () => ({ ok: true as const, data: null }),
};

describe("defineOperation", () => {
  test("refuses a tenant_id in any input surface", () => {
    expect(() =>
      defineOperation({ ...base, http: { ...http, query: z.object({ tenant_id: z.string() }) } }),
    ).toThrow(/takes tenant_id as input/);
    expect(() =>
      defineOperation({ ...base, tool: { ...tool, input: z.object({ tenant_id: z.string() }) } }),
    ).toThrow(/takes tenant_id as input/);
  });

  test("refuses a resource param the path does not carry", () => {
    expect(() =>
      defineOperation({ ...base, resource: { type: "thing", param: "thing_id" }, http }),
    ).toThrow(/names resource param thing_id not in its path/);
  });

  test("refuses a permission scope on an operation without a permission", () => {
    expect(() =>
      defineOperation({
        ...base,
        permission: null,
        resource: { type: "thing", param: "id" },
        http,
      }),
    ).toThrow(/has no permission but declares a permission scope/);
  });

  test("checks every extra permission resource against the path", () => {
    expect(() =>
      defineOperation({
        ...base,
        requiredPermissions: [
          { permission: "other:read", resource: { type: "other", param: "other_id" } },
        ],
        http,
      }),
    ).toThrow(/names resource param other_id not in its path/);
    expect(() =>
      defineOperation({
        ...base,
        resource: { type: "thing", param: "id" },
        http: { ...http, path: "/v1/things/:id/test" },
      }),
    ).not.toThrow();
  });

  test("allows a target tenant in the body only when the binding says so", () => {
    const body = z.object({ tenant_id: z.string() });
    expect(() => defineOperation({ ...base, http: { ...http, body } })).toThrow(
      /takes tenant_id as input/,
    );
    expect(() =>
      defineOperation({ ...base, http: { ...http, body, targetTenant: "body" } }),
    ).not.toThrow();
    expect(() =>
      defineOperation({
        ...base,
        http: { ...http, query: body, targetTenant: "body" },
      }),
    ).toThrow(/takes tenant_id as input/);
  });

  test("returns a frozen operation", () => {
    const op = defineOperation({ ...base, resource: { type: "thing", param: "id" }, http });
    expect(Object.isFrozen(op)).toBe(true);
  });
});

describe("rejections", () => {
  test("carry the HTTP status and error envelope fields", () => {
    expect(JSON.parse(JSON.stringify(reject.notFound("thing")))).toEqual({
      rejected: true,
      status: 404,
      code: "not_found",
      message: "thing not found",
    });
    expect(JSON.parse(JSON.stringify(reject.badRequest("bad", { errors: ["x"] })))).toEqual({
      rejected: true,
      status: 400,
      code: "bad_request",
      message: "bad",
      details: { errors: ["x"] },
    });
    expect(reject.conflict("taken", undefined, "lifecycle_blocked").code).toBe("lifecycle_blocked");
    expect(reject.unauthorized().status).toBe(401);
    expect(reject.forbidden("no").status).toBe(403);
    expect(reject.payloadTooLarge("big").code).toBe("payload_too_large");
    expect(reject.unprocessable("bad").code).toBe("unprocessable");
    expect(reject.status(409, "busy", "busy", undefined, "retry later").hint).toBe("retry later");
    expect(JSON.parse(JSON.stringify(reject.status(409, "taken", "taken", { id: "x" })))).toEqual({
      rejected: true,
      status: 409,
      code: "taken",
      message: "taken",
      details: { id: "x" },
    });
  });

  test("are told apart from results", () => {
    expect(isRejection(reject.notFound("thing"))).toBe(true);
    expect(isRejection({ rejected: false })).toBe(false);
    expect(isRejection({ rejected: true, status: 404, code: "x", message: "x" })).toBe(false);
    expect(isRejection(null)).toBe(false);
    expect(isRejection("rejected")).toBe(false);
  });
});

describe("toConversationTool", () => {
  test("derives category and permission from the operation", () => {
    const op = defineOperation({ ...base, resource: { type: "thing", param: "id" }, tool });
    const derived = toConversationTool(op);
    expect(derived.category).toBe("tenant_read");
    expect(derived.permission).toEqual({
      action: "thing:read",
      resourceType: "thing",
      resourceIdArg: "id",
    });
  });

  test("a deferred gate leaves the tool ungated and a write is tenant_write", () => {
    const op = defineOperation({
      ...base,
      effect: "write",
      audit: "workflow.updated",
      tool: { ...tool, gate: "deferred" },
    });
    const derived = toConversationTool(op);
    expect(derived.category).toBe("tenant_write");
    expect(derived.permission).toBeUndefined();
  });

  test("a tool permission override wins over the operation resource", () => {
    const op = defineOperation({
      ...base,
      resource: { type: "thing", param: "id" },
      tool: {
        ...tool,
        permission: { resourceType: "knowledge", resourceIdArg: "id" },
        strict: false,
      },
    });
    const derived = toConversationTool(op);
    expect(derived.permission).toEqual({
      action: "thing:read",
      resourceType: "knowledge",
      resourceIdArg: "id",
    });
    expect(derived.strict).toBe(false);
  });

  test("toResult sees the tool context and onError turns a throw into a result", async () => {
    const ctx = {
      db: {},
      tenant_id: "t",
      conversation_id: "c-1",
      engineClient: { context: { tenant_id: "t", actor_id: null } },
    } as never;
    const seen = defineOperation({
      ...base,
      tool: {
        ...tool,
        toResult: async (
          _outcome: unknown,
          _input: unknown,
          context: { conversation_id: string },
        ) => ({
          ok: true as const,
          data: context.conversation_id,
        }),
      },
    });
    expect(await toConversationTool(seen).execute(ctx, { id: "x" })).toEqual({
      ok: true,
      data: "c-1",
    });
    const failing = defineOperation({
      ...base,
      handler: async () => {
        throw new Error("boom");
      },
      tool: {
        ...tool,
        onError: (error: unknown) => ({
          ok: false as const,
          error_code: String((error as Error).message),
        }),
      },
    });
    expect(await toConversationTool(failing).execute(ctx, { id: "x" })).toEqual({
      ok: false,
      error_code: "boom",
    });
    const unguarded = defineOperation({ ...failing, tool });
    await expect(toConversationTool(unguarded).execute(ctx, { id: "x" })).rejects.toThrow("boom");
  });

  test("without a principal the scope takes the engine client actor and prepare feeds toResult", async () => {
    const ctx = {
      db: {},
      tenant_id: "t",
      conversation_id: "c-1",
      engineClient: { context: { tenant_id: "t", actor_id: null, actor_type: "system" } },
    } as never;
    const op = defineOperation({
      ...base,
      handler: async (scope: { actor: unknown }) => scope.actor as never,
      tool: {
        ...tool,
        prepare: async () => "before",
        toResult: (outcome: unknown, _input: unknown, _ctx: unknown, prepared: unknown) => ({
          ok: true as const,
          data: { outcome, prepared },
        }),
      },
    });
    expect(await toConversationTool(op).execute(ctx, { id: "x" })).toEqual({
      ok: true,
      data: { outcome: { id: null, type: "system" }, prepared: "before" },
    });
  });

  test("toInput sees the context, a guard can stop the handler, draft flags pass through", async () => {
    const ctx = {
      db: {},
      tenant_id: "t",
      conversation_id: "c-9",
      engineClient: { context: { tenant_id: "t", actor_id: null } },
    } as never;
    let handled = 0;
    const precheck = async () => ({ ok: true }) as never;
    const op = defineOperation({
      ...base,
      handler: async (_scope: unknown, input: { id: string; conversation: string }) => {
        handled += 1;
        return input as never;
      },
      tool: {
        ...tool,
        requires_draft: true,
        precheck,
        toInput: async (args: unknown, context: { conversation_id: string }) => ({
          id: (args as { id: string }).id,
          conversation: context.conversation_id,
        }),
        guard: async (input: { id: string }) =>
          input.id === "blocked" ? { ok: false as const, error_code: "blocked" } : null,
        toResult: (outcome: unknown) => ({ ok: true as const, data: outcome }),
      },
    });
    const derived = toConversationTool(op);
    expect(derived.requires_draft).toBe(true);
    expect(derived.precheck).toBe(precheck);
    expect(await derived.execute(ctx, { id: "blocked" })).toEqual({
      ok: false,
      error_code: "blocked",
    });
    expect(handled).toBe(0);
    expect(await derived.execute(ctx, { id: "x" })).toEqual({
      ok: true,
      data: { id: "x", conversation: "c-9" },
    });
    expect(handled).toBe(1);
  });

  test("refuses an operation without a tool binding", () => {
    expect(() => toConversationTool(defineOperation(base))).toThrow(/has no tool binding/);
  });
});
