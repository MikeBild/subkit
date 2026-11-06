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

  test("returns a frozen operation", () => {
    const op = defineOperation({ ...base, resource: { type: "thing", param: "id" }, http });
    expect(Object.isFrozen(op)).toBe(true);
  });
});

describe("rejections", () => {
  test("carry the HTTP status and error envelope fields", () => {
    expect(reject.notFound("thing")).toEqual({
      rejected: true,
      status: 404,
      code: "not_found",
      message: "thing not found",
    });
    expect(reject.badRequest("bad", { errors: ["x"] })).toEqual({
      rejected: true,
      status: 400,
      code: "bad_request",
      message: "bad",
      details: { errors: ["x"] },
    });
    expect(reject.conflict("taken", undefined, "lifecycle_blocked").code).toBe("lifecycle_blocked");
    expect(reject.unauthorized().status).toBe(401);
  });

  test("are told apart from results", () => {
    expect(isRejection(reject.notFound("thing"))).toBe(true);
    expect(isRejection({ rejected: false })).toBe(false);
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

  test("refuses an operation without a tool binding", () => {
    expect(() => toConversationTool(defineOperation(base))).toThrow(/has no tool binding/);
  });
});
