// Cross-write-path Postgres-error translation coverage. Pre-fix the
// translator existed in `auto-persist.ts` but only the auto-persist
// dispatcher used it — every direct tool path (save_connector_draft,
// update_connector, update_workflow, delete_connector, delete_workflow)
// surfaced raw SQL strings to the LLM (session 975a64b0 16:37:21:
// 23505 unique-violation rendered as "Failed query: insert into
// \"connectors\" ..." → 3m09s of opaque "summarising 5 tool results"
// while the LLM tried to recover).
//
// Post-fix every write path runs the same translator, producing
// typed `error_code` + `next_best_actions` so the LLM converges in
// 1 turn instead of looping. This test pins the contract.

import { describe, expect, test } from "bun:test";
import { translateAutoPersistError } from "./auto-persist.ts";

function pgError(code: string, message: string, detail?: string): Error {
  const e = new Error(message);
  // biome-ignore lint/suspicious/noExplicitAny: pg errors carry .code/.detail
  (e as any).code = code;
  if (detail) {
    // biome-ignore lint/suspicious/noExplicitAny: pg errors carry .detail
    (e as any).detail = detail;
  }
  return e;
}

describe("translateAutoPersistError · 23505 unique-violation", () => {
  for (const ctx of [
    "save_connector_draft",
    "update_connector",
    "save_workflow_draft",
    "update_workflow",
    "delete_connector",
    "delete_workflow",
  ] as const) {
    test(`${ctx} → slug_already_in_use with resource-aware recovery`, () => {
      const t = translateAutoPersistError(
        pgError(
          "23505",
          'duplicate key value violates unique constraint "connectors_tenant_slug_env_key"',
        ),
        ctx,
      );
      expect(t.error_code).toBe("slug_already_in_use");
      expect(t.message).toMatch(/already exists/i);
      // Resource-aware next-best-actions
      const isConnector =
        ctx === "save_connector_draft" || ctx === "update_connector" || ctx === "delete_connector";
      const isWorkflow =
        ctx === "save_workflow_draft" || ctx === "update_workflow" || ctx === "delete_workflow";
      if (isConnector) {
        expect(t.next_best_actions).toContain("list_connectors");
      } else if (isWorkflow) {
        expect(t.next_best_actions).toContain("list_workflows");
      }
    });
  }
});

describe("translateAutoPersistError · 23503 fk-violation", () => {
  test("returns in_use_by_dependent_rows with executions/connectors hint", () => {
    const t = translateAutoPersistError(
      pgError("23503", 'update or delete on table "connectors" violates foreign key constraint'),
      "delete_connector",
    );
    expect(t.error_code).toBe("in_use_by_dependent_rows");
    expect(t.next_best_actions).toContain("list_executions");
  });
});

describe("translateAutoPersistError · 23502 not-null-violation", () => {
  test("returns missing_required_field with inspect hint", () => {
    const t = translateAutoPersistError(
      pgError("23502", 'null value in column "slug" violates not-null constraint'),
      "save_connector_draft",
    );
    expect(t.error_code).toBe("missing_required_field");
    expect(t.next_best_actions).toEqual(expect.arrayContaining(["inspect_connector_draft"]));
  });
});

describe("translateAutoPersistError · 22P02 invalid_input_format", () => {
  test("returns invalid_input_format on invalid uuid syntax", () => {
    const t = translateAutoPersistError(
      pgError("22P02", 'invalid input syntax for type uuid: "not-a-uuid"'),
      "update_workflow",
    );
    expect(t.error_code).toBe("invalid_input_format");
  });
});

describe("translateAutoPersistError · regex fallback (no .code)", () => {
  test("23505 message text without code still triggers slug_already_in_use", () => {
    // Some upstream wrappers re-throw with just the message text.
    const e = new Error('duplicate key value violates unique constraint "x"');
    const t = translateAutoPersistError(e, "save_connector_draft");
    expect(t.error_code).toBe("slug_already_in_use");
  });
});

describe("translateAutoPersistError · unknown error", () => {
  test("returns auto_persist_failed with verbatim message", () => {
    const e = new Error("connection refused");
    const t = translateAutoPersistError(e, "save_connector_draft");
    expect(t.error_code).toBe("auto_persist_failed");
    expect(t.message).toContain("connection refused");
  });
});
