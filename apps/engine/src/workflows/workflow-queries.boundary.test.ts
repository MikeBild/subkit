import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowDir = resolve(import.meta.dir);

describe("workflow query boundary", () => {
  test("keeps workflow reads in the query module while preserving service compatibility", () => {
    const service = readFileSync(resolve(workflowDir, "service.ts"), "utf8");
    const queries = readFileSync(resolve(workflowDir, "workflow-queries.ts"), "utf8");
    const readModel = readFileSync(resolve(workflowDir, "read-model.ts"), "utf8");

    expect(queries).toContain("export async function listWorkflows");
    expect(queries).toContain("export async function getWorkflowBySlug");
    expect(queries).not.toContain('from "./service.ts"');
    expect(service).toContain('from "./workflow-queries.ts"');
    expect(service).not.toContain("export async function listWorkflows(");
    expect(readModel).toContain('from "./workflow-queries.ts"');
    expect(readModel).not.toContain('from "./service.ts"');
  });
});
