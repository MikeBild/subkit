import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowDir = resolve(import.meta.dir);

describe("workflow read-model boundary", () => {
  test("keeps database-to-view projection out of the command service", () => {
    const service = readFileSync(resolve(workflowDir, "service.ts"), "utf8");
    const projection = readFileSync(resolve(workflowDir, "read-projections.ts"), "utf8");
    expect(service).toContain('from "./read-projections.ts"');
    expect(service).not.toContain("function workflowViewsFromRows");
    expect(projection).toContain("export async function workflowViewsFromRows");
    expect(projection).toContain("export async function loadWorkflowView");
  });

  test("keeps Zod validation at the workflow transport boundary, not in pure vocabulary", () => {
    const domain = readFileSync(resolve(workflowDir, "domain-types.ts"), "utf8");
    expect(domain).not.toContain("z.");
    expect(domain).not.toContain("@hono/zod-openapi");
  });

  test("keeps graph and pure rule functions independent of transport schemas", () => {
    for (const filename of [
      "dag.ts",
      "runtime-annotation.ts",
      "jsonata-sites.ts",
      "input-schema-synth.ts",
      "reference-validator.ts",
      "destination-placeholders.ts",
    ]) {
      const source = readFileSync(resolve(workflowDir, filename), "utf8");
      expect(source).not.toContain('from "./types.ts"');
      expect(source).not.toContain("@hono/zod-openapi");
    }
    const definition = readFileSync(resolve(workflowDir, "core/definition.ts"), "utf8");
    expect(definition).not.toContain("as never");
  });

  test("keeps persisted-spec parsing outside the functional core", () => {
    const coreSpec = readFileSync(resolve(workflowDir, "core/spec.ts"), "utf8");
    const storedSpec = readFileSync(resolve(workflowDir, "stored-spec.ts"), "utf8");
    expect(coreSpec).not.toContain("WorkflowSpecSchema");
    expect(storedSpec).toContain("WorkflowSpecSchema.safeParse");
  });
});
