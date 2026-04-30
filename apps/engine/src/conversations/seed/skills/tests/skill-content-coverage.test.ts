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
});

describe("postgres-connectors.md · cursor caveat", () => {
  const body = read("postgres-connectors.md");
  test("documents that cursor counts are fetch-count, not affected-count", () => {
    expect(body.toLowerCase()).toContain("fetch");
    expect(body).toMatch(/cursor.*expected_row_count|expected_row_count.*cursor/s);
  });
});
