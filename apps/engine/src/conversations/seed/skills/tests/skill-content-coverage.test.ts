// Skill-content coverage. Pins that key authoring affordances are
// actually documented — a complementary lint to example-blocks.
// Whenever a new schema-level field lands, add a presence check here
// so the doc isn't silently behind the schema.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS = join(import.meta.dir, "..");

function read(name: string): string {
  return readFileSync(join(SKILLS, name), "utf-8");
}

describe("s3-connectors.md · field coverage", () => {
  const body = read("s3-connectors.md");
  test('documents `parse_as: "bytes"` mode', () => {
    expect(body).toContain('"bytes"');
    expect(body).toContain("Buffer");
  });
  test("documents expected_statuses on s3 steps", () => {
    expect(body).toContain("expected_statuses");
  });
  test("mentions presigned URLs", () => {
    expect(body.toLowerCase()).toContain("presign");
  });
  test("mentions multipart threshold", () => {
    expect(body).toContain("multipart");
  });
});

describe("postgres-connectors.md · field coverage", () => {
  const body = read("postgres-connectors.md");
  test("documents expected_row_count tuple form", () => {
    expect(body).toContain("[1, 1]");
  });
  test("documents expected_row_count object form (min/max)", () => {
    expect(body).toMatch(/"min":\s*1.*"max":\s*1/s);
  });
  test("documents sql.also[i].expected_row_count form", () => {
    expect(body).toContain("expected_row_count");
    expect(body).toContain("also");
  });
  test("documents sql.cursor for streaming", () => {
    expect(body).toContain("sql.cursor");
    expect(body).toContain("fetch_size");
  });
  test("documents sql.also for transactional follow-ups", () => {
    expect(body).toContain("sql.also");
  });
});

describe("workflow-authoring.md · field coverage", () => {
  const body = read("workflow-authoring.md");
  test("mentions probe_connector before build_workflow recipe", () => {
    expect(body).toMatch(/probe_connector.*build_workflow/s);
  });
  test("documents output_transform_function (JS) alongside output_transform", () => {
    expect(body).toContain("output_transform_function");
  });
  test("references propose_schema_migration in the repair flow", () => {
    expect(body).toContain("propose_schema_migration");
  });
  test("documents the loop.over and branch.when JSONata bindings (`$scope`/`$input`)", () => {
    expect(body).toMatch(/loop\.over.*\$scope|branch\.when.*\$scope/s);
    expect(body).toContain("$input");
  });
  test("documents the inspect-before-loop authoring gate", () => {
    expect(body).toContain("loop_authoring_requires_inspect");
  });
  test("documents the inspect-before-transform authoring gate", () => {
    expect(body).toContain("transform_authoring_requires_inspect");
  });
  test("documents that validation is auto-surfaced (validate_draft is rarely needed)", () => {
    expect(body).toMatch(/Validation\s+is\s+auto-surfaced|validate_draft.*rarely/i);
  });
  test("documents suggest_jsonata_paths as the path discovery tool", () => {
    expect(body).toContain("suggest_jsonata_paths");
  });
  test("documents bare-path validation for step references", () => {
    expect(body).toMatch(/Bare-path|bare-path|`<X>\.data`|fetch_users\.data/);
    expect(body).toContain("workflow_unresolved_step_reference");
  });
  test("documents output_transform reference validation", () => {
    expect(body).toContain("output_transform");
  });
  test("documents authoring_scope_changed warning", () => {
    expect(body).toContain("authoring_scope_changed");
  });
  test("documents find_* discovery tools", () => {
    expect(body).toContain("find_workflow");
    expect(body).toContain("find_connector");
    expect(body).toContain("find_skill");
  });
  test("documents build_workflow persistence contract", () => {
    expect(body).toContain('persistence: "draft_only"');
  });
  test("documents persisted scope_index survival", () => {
    expect(body).toContain("scope_index");
  });
  test("documents fingerprint-keyed gate evidence and the recorded_eval findings block", () => {
    expect(body).toContain("preview_stale_for_referenced_step");
    expect(body).toContain("recorded_eval");
    expect(body).toMatch(/fingerprint-keyed/i);
    // The recovery recipe: one dry-run refreshes evidence; unchanged steps keep theirs.
    expect(body).toMatch(/unchanged steps keep their evidence/i);
  });
  test("documents the inside-a-loop-body addressing table ($item-only)", () => {
    expect(body).toContain("Inside a loop body — addressing table");
    // $item in JSONata vs ${item.…} in request strings — item_var is retired
    expect(body).toContain("${item.name}");
    expect(body).toContain("$item.name");
    expect(body).toMatch(/`item_var` is retired/);
    expect(body).not.toMatch(/"item_var":/);
    // $item and $loop_index always bound
    expect(body).toMatch(/\$item.*always bound|ALWAYS bound/is);
    expect(body).toContain("$loop_index");
    // sibling body step results + downstream loop output addressing
    expect(body).toContain("$scope.<body_step_id>.data");
    expect(body).toContain("$scope.<loop_id>.data.<body_step_id>.data");
    // the compact worked example: request + transform in one body
    expect(body).toContain("${item.full_name}");
    expect(body).toContain("$scope.fetch_languages.data");
  });
  test("documents author_workflow as the canonical one-shot authoring entry", () => {
    expect(body).toContain("`author_workflow`");
    expect(body).toMatch(/default to `author_workflow`/);
    expect(body).toContain("authoring_stage_violation");
    expect(body).toMatch(/REPAIR-STAGE tools/);
  });
  test("documents the verbatim JS-first transform contract", () => {
    expect(body).toMatch(/Transforms — JavaScript first/);
    expect(body).toContain("FUNCTION BODY");
    expect(body).toContain("input.scope.<step_id>.data");
    expect(body).toContain("input.input");
    expect(body).toMatch(/must `return` its result/);
    expect(body).toMatch(/QuickJS/);
    // JSONata demoted to legacy/compat with $item-only addressing
    expect(body).toMatch(/JSONata is legacy\/compat/);
    expect(body).toMatch(/\*\*`\$item` ONLY\*\*/);
  });
  test("documents the bulk-endpoint design rule", () => {
    expect(body).toMatch(/prefer one bulk list endpoint over a nested per-item loop/i);
  });
  test("documents that dry-runs hold writes (sends never fire in a preview)", () => {
    expect(body).toMatch(/Dry-runs hold writes — sends never fire in a preview/);
    expect(body).toMatch(/held request artifacts?/);
    expect(body).toMatch(
      /full-live preview.*explicit confirmation|explicit confirmation machinery/is,
    );
  });
  test("documents that loop.body is an ARRAY of step ids", () => {
    expect(body).toMatch(/`body` is an ARRAY of step ids/);
    expect(body).toContain("expected array, received string");
  });
  test("documents the JSONata flavour rules (:= blocks, dynamic keys, & concatenation)", () => {
    expect(body).toContain("JSONata flavour rules");
    // := binding needs a parenthesized block, not a bare object-constructor value
    expect(body).toContain("( $t := $sum(items.price);");
    // dynamic-key recipe via $merge($map(...))
    expect(body).toContain("$merge($map(");
    // & is binary string concatenation, never unary
    expect(body).toMatch(/`&` is BINARY string concatenation/);
  });
});

describe("data-handling.md · $item-only loop contract + JS-first transforms", () => {
  const body = read("data-handling.md");
  test("documents the $item-only loop iteration contract (item_var retired)", () => {
    expect(body).toMatch(/`item_var` is RETIRED/);
    expect(body).not.toMatch(/"item_var":/);
    expect(body).toContain("${item.id}");
    expect(body).toContain("$item.name");
    expect(body).toContain("$loop_index");
  });
  test("documents the JS transform addressing (one `input` global, explicit return)", () => {
    expect(body).toContain("FUNCTION BODY");
    expect(body).toContain("input.scope.");
    expect(body).toContain("input.input");
    expect(body).toMatch(/language.*javascript/i);
  });
  test("documents output_transform_function (JS, preferred) vs output_transform (JSONata, legacy)", () => {
    expect(body).toContain("output_transform_function");
    expect(body).toContain("output_transform");
    expect(body).not.toContain("outputTransform");
  });
});

describe("subkit-concepts.md / multi-step-best-practices.md · item_var retired", () => {
  test("subkit-concepts loop example carries no item_var and names $item", () => {
    const body = read("subkit-concepts.md");
    expect(body).not.toMatch(/"item_var":/);
    expect(body).toContain("$item");
    expect(body).toContain("${item.");
  });
  test("multi-step-best-practices teaches $item / ${item.…} and rejects item_var", () => {
    const body = read("multi-step-best-practices.md");
    expect(body).not.toMatch(/"item_var":/);
    expect(body).toContain("$item");
    expect(body).toContain("$loop_index");
    expect(body).toMatch(/`item_var` is retired/);
  });
});

describe("postgres-connectors.md · cursor caveat", () => {
  const body = read("postgres-connectors.md");
  test("documents that cursor counts are fetch-count, not affected-count", () => {
    expect(body.toLowerCase()).toContain("fetch");
    expect(body).toMatch(/cursor.*expected_row_count|expected_row_count.*cursor/s);
  });
});
