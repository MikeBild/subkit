import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executions, workflows, workflowVersions } from "../../db/schema/index.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let workflowId: string;

beforeAll(async () => {
  suite = await startMcpTestSuite("sensitive-direct-run");
  const [workflow] = await suite.http.db
    .insert(workflows)
    .values({
      tenant_id: suite.http.tenantId,
      slug: "private-snapshot",
      name: "Private Snapshot",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow seed failed");
  workflowId = workflow.id;
  const [version] = await suite.http.db
    .insert(workflowVersions)
    .values({
      tenant_id: suite.http.tenantId,
      workflow_id: workflowId,
      version: 1,
      dag: {
        name: "Private Snapshot",
        slug: "private-snapshot",
        execution_privacy: "sensitive",
        steps: [
          {
            id: "snapshot",
            kind: "transform",
            language: "javascript",
            expression: "return { count: 1 };",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("version seed failed");
  await suite.http.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflowId));
});

afterAll(async () => {
  await suite.cleanup();
});

test("MCP client receives an authorized sensitive final snapshot", async () => {
  const client = await suite.connect();
  const result = await client.callTool({
    name: "run_workflow",
    arguments: { workflow: workflowId, environment: "dev" },
  });
  expect(result.isError).toBe(false);
  const content = result.content as Array<{ type: string; text?: string }>;
  const body = JSON.parse(content.find((part) => part.type === "text")?.text ?? "null");
  expect(body).toMatchObject({ status: "succeeded", output: { count: 1 } });
  const runs = await suite.http.db
    .select({ request_source: executions.request_source })
    .from(executions)
    .where(eq(executions.workflow_id, workflowId));
  expect(runs.some((run) => run.request_source === "mcp")).toBe(true);
});
