import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertPageSize,
  canConsumeBytes,
  consumeBytes,
  createBudgetState,
  PageTooLargeError,
  PER_PAGE_BYTES,
  TOTAL_BUDGET_BYTES,
} from "../budgets.ts";
import { ingestDocs } from "../service.ts";
import { createDocsTestCtx, type DocsTestCtx } from "./setup.ts";

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("budget");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("docs-ingestion/budget", () => {
  test("assertPageSize throws PageTooLargeError over 3 MB", () => {
    expect(() => assertPageSize(PER_PAGE_BYTES + 1)).toThrow(PageTooLargeError);
    expect(() => assertPageSize(1024)).not.toThrow();
  });

  test("total budget caps the run at 10 MB", () => {
    const state = createBudgetState();
    expect(canConsumeBytes(state, TOTAL_BUDGET_BYTES - 1)).toBe(true);
    consumeBytes(state, TOTAL_BUDGET_BYTES - 1);
    expect(canConsumeBytes(state, 2)).toBe(false);
    consumeBytes(state, 2);
    expect(state.budget_exceeded).toBe(true);
  });

  test("PageTooLargeError on an oversized markdown content string", async () => {
    const oversized = "a b c d e ".repeat(Math.ceil(PER_PAGE_BYTES / 10) + 1000);
    await expect(
      ingestDocs(
        {
          tenant_id: ctx.tenantId,
          connector_id: ctx.connectorId,
          input: { source_type: "markdown", content: oversized },
        },
        ctx.testDb.db,
      ),
    ).rejects.toThrow(/per-page budget/);
  });
});
