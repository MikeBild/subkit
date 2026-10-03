import { describe, expect, test } from "bun:test";
import {
  type AuthorityPages,
  withAuthorityRevoked,
  withProvisionalAuthority,
} from "./optimistic-authorities";
import type { WorkflowAuthority, WorkflowAuthorityPreview } from "./workflow-authorities";

const authority = (id: string): WorkflowAuthority =>
  ({ id, state: "approved", revoked_at: null, ready_for_new_run: true }) as WorkflowAuthority;

const pages = (...ids: string[]): AuthorityPages => ({
  pages: [{ items: ids.map(authority), next_cursor: null }],
  pageParams: [null],
});

describe("optimistic approvals", () => {
  test("a revoked approval reads as revoked at once, the others untouched", () => {
    const next = withAuthorityRevoked(pages("a", "b"), "b", "2026-10-03T10:00:00.000Z");
    const [a, b] = next?.pages[0]?.items ?? [];
    expect(a).toMatchObject({ id: "a", state: "approved", revoked_at: null });
    expect(b).toMatchObject({
      id: "b",
      state: "revoked",
      revoked_at: "2026-10-03T10:00:00.000Z",
      ready_for_new_run: false,
    });
  });

  test("a granted approval stands newest until the engine answers", () => {
    const review = {
      manifest: { workflow_id: "w", workflow_version_id: "v9" },
    } as unknown as WorkflowAuthorityPreview;
    const input = {
      workflow_version_id: "v9",
      execution_environment: "prod" as const,
      expected_manifest_digest: "sha",
      valid_from: "2026-10-03T10:00:00.000Z",
      valid_until: null,
      max_runs: null,
    };
    const next = withProvisionalAuthority(pages("old"), review, input, "2026-10-03T10:00:00.000Z");
    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual(["provisional:sha", "old"]);
    expect(next?.pages[0]?.items[0]).toMatchObject({
      state: "approved",
      open_ended: true,
      execution_environment: "prod",
    });
    // Nothing read yet: the provisional approval is the whole list.
    expect(withProvisionalAuthority(undefined, review, input, "x")?.pages[0]?.items).toHaveLength(
      1,
    );
  });
});
