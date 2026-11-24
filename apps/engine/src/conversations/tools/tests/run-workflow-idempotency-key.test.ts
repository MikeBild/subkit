import { describe, expect, test } from "bun:test";
import { runWorkflowTool } from "../engine-api/writes/run-workflow.ts";

const acceptsKey = (idempotencyKey: string) =>
  runWorkflowTool.inputSchema.safeParse({
    workflow: "orders-sync",
    idempotency_key: idempotencyKey,
  }).success;

describe("run_workflow idempotency_key length", () => {
  test("accepts the same 200 character keys as the HTTP run route", () => {
    expect(acceptsKey(`${"k".repeat(199)}🚚`)).toBe(true);
    expect(acceptsKey(`${"k".repeat(199)}é`)).toBe(true);
    expect(acceptsKey("k".repeat(200))).toBe(true);
  });

  test("rejects a key above 200 characters and an empty key", () => {
    expect(acceptsKey(`${"k".repeat(200)}🚚`)).toBe(false);
    expect(acceptsKey("")).toBe(false);
  });
});
