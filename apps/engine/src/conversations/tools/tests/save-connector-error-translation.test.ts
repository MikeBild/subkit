// save_connector_draft direct path translates Postgres errors into
// typed error_codes. Pre-fix (session 975a64b0 16:37:21) the raw
// `Failed query: insert into "connectors" ...` SQL message was
// passed verbatim to the LLM, which then spent 3m09s of opaque
// "summarising 5 tool results" trying to recover from it. Post-fix
// the LLM gets `slug_already_in_use` + `next_best_actions:
// [list_connectors, get_connector, update_connector]` and recovers
// in a single turn.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const SRC = join(import.meta.dir, "..", "save-connector-draft.ts");

describe("save_connector_draft · error translation", () => {
  const body = readFileSync(SRC, "utf-8");

  test("imports translateAutoPersistError", () => {
    expect(body).toContain("translateAutoPersistError");
  });

  test("wraps saveConnectorAtomic in try/catch", () => {
    expect(body).toMatch(/try \{[\s\S]*?atomicResult = await saveConnectorAtomic/);
  });

  test("the catch dispatches through translateAutoPersistError", () => {
    expect(body).toMatch(/translateAutoPersistError\(err,\s*"save_connector_draft"\)/);
  });

  test("translated error returns a structured envelope (error_code + next_best_actions)", () => {
    expect(body).toMatch(/error_code:\s*translated\.error_code/);
    expect(body).toMatch(/next_best_actions:\s*translated\.next_best_actions/);
  });

  test("logs the threw event so an operator can grep the audit log", () => {
    expect(body).toContain('action: "save_connector_draft.atomic_threw"');
  });
});
