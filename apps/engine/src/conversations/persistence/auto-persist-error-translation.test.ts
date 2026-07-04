// Regression for session abeefb33: every auto-persist failure
// surfaced as the prose "database error" → cannot_help → conversation
// dead-ends with no question for the user. Postgres errors now
// translate into typed envelopes (`slug_already_in_use`,
// `in_use_by_dependent_rows`, `missing_required_field`,
// `invalid_input_format`, `auto_persist_failed`) with concrete
// `next_best_actions` so the LLM has a recovery path.
//
// Pure-function unit test against the translator — no DB needed.

import { describe, expect, test } from "bun:test";
import { translateAutoPersistError } from "./auto-persist.ts";

class PgError extends Error {
  code: string;
  detail?: string;
  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

describe("translateAutoPersistError", () => {
  test("23505 unique_violation on connector → slug_already_in_use", () => {
    const err = new PgError(
      "23505",
      'duplicate key value violates unique constraint "connectors_tenant_slug_env_key"',
      "Key (tenant_id, slug, environment)=(t1, digitalocean, dev) already exists.",
    );
    const out = translateAutoPersistError(err, "save_connector_draft");
    expect(out.error_code).toBe("slug_already_in_use");
    expect(out.message).toMatch(/connector/);
    expect(out.next_best_actions).toContain("list_connectors");
  });

  test("23505 unique_violation on workflow → slug_already_in_use", () => {
    const err = new PgError(
      "23505",
      'duplicate key value violates unique constraint "workflows_tenant_slug_active_key"',
    );
    const out = translateAutoPersistError(err, "save_workflow_draft");
    expect(out.error_code).toBe("slug_already_in_use");
    expect(out.message).toMatch(/workflow/);
    expect(out.next_best_actions).toContain("list_workflows");
  });

  test("23503 foreign_key_violation → in_use_by_dependent_rows", () => {
    const err = new PgError("23503", "update or delete on table violates foreign key constraint");
    const out = translateAutoPersistError(err, "delete_connector");
    expect(out.error_code).toBe("in_use_by_dependent_rows");
  });

  test("23502 not_null_violation → missing_required_field", () => {
    const err = new PgError(
      "23502",
      'null value in column "slug" of relation "connectors" violates not-null constraint',
    );
    const out = translateAutoPersistError(err, "save_connector_draft");
    expect(out.error_code).toBe("missing_required_field");
    expect(out.next_best_actions).toContain("inspect_connector_draft");
  });

  test("22P02 invalid_text_representation → invalid_input_format", () => {
    const err = new PgError("22P02", "invalid input syntax for type uuid");
    const out = translateAutoPersistError(err, "save_connector_draft");
    expect(out.error_code).toBe("invalid_input_format");
  });

  test("unknown error falls back to auto_persist_failed (with the verbatim message)", () => {
    const err = new Error("unexpected runtime explosion");
    const out = translateAutoPersistError(err, "save_connector_draft");
    expect(out.error_code).toBe("auto_persist_failed");
    expect(out.message).toContain("unexpected runtime explosion");
    // Critically, fallback STILL points at ask_user_text so the LLM
    // surfaces the failure to the user instead of cannot_help'ing.
    expect(out.next_best_actions).toContain("ask_user_text");
  });

  test("regex fallback when err has no .code (older pg / wrapped errors)", () => {
    const err = new Error('duplicate key value violates unique constraint "x"');
    const out = translateAutoPersistError(err, "save_connector_draft");
    expect(out.error_code).toBe("slug_already_in_use");
  });
});
