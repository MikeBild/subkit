import { describe, expect, test } from "bun:test";

import {
  executionMentionCandidates,
  loadMentionCandidates,
  workflowMentionCandidates,
} from "../repl/mention-candidates.ts";

describe("mention catalog candidates", () => {
  test("normalizes workflows and executions into namespaced insert values", () => {
    expect(
      workflowMentionCandidates([
        { id: "workflow-1", slug: "customer-sync", name: "Customer sync" },
        { id: "workflow-2" },
        { slug: "missing-id" },
      ]),
    ).toEqual([
      { value: "workflow:customer-sync", label: "Customer sync", kind: "workflow" },
      { value: "workflow:workflow-2", label: "workflow-2", kind: "workflow" },
    ]);
    expect(
      executionMentionCandidates([
        { id: "execution-1", workflow_name: "Customer sync" },
        { id: "execution-2" },
      ]),
    ).toEqual([
      { value: "execution:execution-1", label: "Customer sync", kind: "execution" },
      { value: "execution:execution-2", label: "execution-2", kind: "execution" },
    ]);
  });

  test("keeps permitted results when the other catalog is unavailable", async () => {
    const candidates = await loadMentionCandidates(
      {
        listWorkflows: async () => ({
          items: [{ id: "workflow-1", slug: "customer-sync" }],
        }),
        listExecutions: async () => {
          throw new Error("offline");
        },
      },
      new Set(["workflow:read", "execution:read"]),
    );

    expect(candidates).toEqual([
      { value: "workflow:customer-sync", label: "customer-sync", kind: "workflow" },
    ]);
  });

  test("does not request a catalog without its read permission", async () => {
    let executionRequests = 0;
    await loadMentionCandidates(
      {
        listWorkflows: async () => ({ items: [] }),
        listExecutions: async () => {
          executionRequests += 1;
          return { items: [] };
        },
      },
      new Set(["workflow:read"]),
    );
    expect(executionRequests).toBe(0);
  });
});
