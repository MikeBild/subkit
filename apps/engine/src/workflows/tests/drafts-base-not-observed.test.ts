import { expect, test } from "bun:test";
import type { Executor } from "../../db/client.ts";
import { saveWorkflowDraft } from "../drafts.ts";

test("updating a draft without an observed version is draft_base_not_observed", async () => {
  const exec = new Proxy({} as Executor, {
    get() {
      throw new Error("an unobserved base must be refused before any database access");
    },
  });
  const result = await saveWorkflowDraft(
    {
      tenant_id: "00000000-0000-4000-8000-000000000001",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      def: { name: "wf", steps: [] },
      actor_id: null,
      request_source: "api",
    },
    exec,
  );
  expect(result.code).toBe("draft_base_not_observed");
  expect(result.draft).toBeUndefined();
});
