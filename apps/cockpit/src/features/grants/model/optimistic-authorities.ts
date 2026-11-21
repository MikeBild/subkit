import type { InfiniteData } from "@tanstack/react-query";
import type {
  authorityGrantInput,
  WorkflowAuthority,
  WorkflowAuthorityList,
  WorkflowAuthorityPreview,
} from "@/features/grants/model/workflow-authorities";

export type AuthorityPages = InfiniteData<WorkflowAuthorityList, string | null>;

type GrantInput = NonNullable<ReturnType<typeof authorityGrantInput>>;

export function withAuthorityRevoked(
  data: AuthorityPages | undefined,
  id: string,
  at: string,
): AuthorityPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((authority) =>
        authority.id === id
          ? {
              ...authority,
              revoked_at: at,
              state: "revoked" as const,
              ready_for_new_run: false,
            }
          : authority,
      ),
    })),
  };
}

export function withAuthorityUntilRevoked(
  data: AuthorityPages | undefined,
  id: string,
): AuthorityPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((authority) =>
        authority.id === id
          ? {
              ...authority,
              valid_until: null,
              max_runs: null,
              remaining_runs: null,
              open_ended: true,
            }
          : authority,
      ),
    })),
  };
}

export function withProvisionalAuthority(
  data: AuthorityPages | undefined,
  review: WorkflowAuthorityPreview,
  input: GrantInput,
  now: string,
): AuthorityPages | undefined {
  const provisional: WorkflowAuthority = {
    id: `provisional:${input.expected_manifest_digest}`,
    workflow_id: review.manifest.workflow_id,
    workflow_version_id: input.workflow_version_id,
    effect_manifest_digest: input.expected_manifest_digest,
    effect_manifest: review.manifest,
    execution_environment: input.execution_environment,
    target_constraints: { targets: [] },
    valid_from: input.valid_from,
    valid_until: input.valid_until,
    max_runs: input.max_runs,
    reserved_runs: 0,
    remaining_runs: input.max_runs,
    open_ended: input.valid_until === null && input.max_runs === null,
    created_by: "",
    created_at: now,
    revoked_at: null,
    revoked_by: null,
    inherited_from: null,
    superseded_by: null,
    active_version: true,
    ready_for_new_run: true,
    state: "approved",
  };
  if (!data) return { pages: [{ items: [provisional], next_cursor: null }], pageParams: [null] };
  const [first, ...rest] = data.pages;
  return {
    ...data,
    pages: [
      { ...(first ?? { next_cursor: null }), items: [provisional, ...(first?.items ?? [])] },
      ...rest,
    ],
  };
}
