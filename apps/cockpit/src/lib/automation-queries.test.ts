import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  activateDraftWithCarryOver,
  automationQueryKeys,
  invalidateWorkflowAutomation,
} from "@/lib/automation-queries";

const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000009";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

describe("activateDraftWithCarryOver", () => {
  test("uses the typed activate-draft endpoint and preserves the optimistic-concurrency body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ activated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await activateDraftWithCarryOver({
      workflowId: "workflow / id",
      versionId: "version-id",
      expectedCurrentVersionId: null,
      expectedManifestDigest: "digest",
      environment: "prod",
      conversationId: "conversation-id",
    });

    expect(calls[0]?.url.endsWith("/v1/workflows/workflow%20%2F%20id/activate-draft")).toBe(true);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({
        conversation_id: "conversation-id",
        workflow_version_id: "version-id",
        expected_current_version_id: null,
        expected_manifest_digest: "digest",
        execution_environment: "prod",
      }),
    );
  });
});
