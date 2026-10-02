import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { automationQueryKeys, invalidateWorkflowAutomation } from "@/lib/automation-queries";

const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000009";

describe("the reads a workflow's automation state rests on", () => {
  test("every read the panel decides by is named", () => {
    const keys = automationQueryKeys(WORKFLOW).map((key) => JSON.stringify(key));
    for (const key of [
      ["workflow-authorities", WORKFLOW],
      ["workflow-automation-status", WORKFLOW],
      ["workflow-diagnosis", WORKFLOW],
      ["workflow", WORKFLOW, "schedules"],
      ["workflow-invocation", WORKFLOW],
      ["catalog-detail", "workflows", WORKFLOW],
    ])
      expect(keys).toContain(JSON.stringify(key));
  });

  test("an approval, a revocation or a run makes them all stale — and nothing else", async () => {
    const client = new QueryClient();
    const seed = (key: readonly unknown[]) => client.setQueryData(key, { seeded: true });
    // The diagnosis is read per environment, the approvals per page: both sit
    // under the workflow's prefix and must go with it.
    const own = [
      ["workflow-diagnosis", WORKFLOW, "prod"],
      ["workflow-authorities", WORKFLOW, "newest"],
      ["workflow-automation-status", WORKFLOW],
      ["workflow", WORKFLOW, "schedules"],
      ["catalog-detail", "workflows", WORKFLOW],
    ];
    const foreign = [
      ["workflow-diagnosis", OTHER, "prod"],
      ["workflow-authorities", OTHER],
      ["catalog-detail", "connectors", WORKFLOW],
    ];
    for (const key of [...own, ...foreign]) seed(key);
    await invalidateWorkflowAutomation(client, WORKFLOW);
    for (const key of own) expect(client.getQueryState(key)?.isInvalidated, String(key)).toBe(true);
    for (const key of foreign)
      expect(client.getQueryState(key)?.isInvalidated, String(key)).toBe(false);
  });
});
