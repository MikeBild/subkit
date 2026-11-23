import { workflowJsonDigest } from "../../canonical-json.ts";
import { requestDigest } from "../../core/request-protocol.ts";
import type { ResolvedEffectBinding } from "../../effect-manifest.ts";
import { WorkflowDefSchema } from "../../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";

const PROJECT_ITEMS_QUERY =
  "query ProjectItems($after: String, $owner: String!, $number: Int!) { user(login: $owner) { projectV2(number: $number) { items(first: 50, after: $after) { totalCount nodes { id } pageInfo { hasNextPage endCursor } } } } }";

const projectItemsGraphql = {
  operation: "query",
  query: PROJECT_ITEMS_QUERY,
  variables: { after: null, owner: "MikeBild", number: 4 },
  cursor_pagination: {
    connection_path: "user.projectV2.items",
    items_field: "nodes",
    cursor_variable: "after",
    max_pages: 40,
    max_items: 2000,
  },
};

function manifestInput(step: Record<string, unknown>, binding: Partial<ResolvedEffectBinding>) {
  const definition = WorkflowDefSchema.parse(
    JSON.parse(JSON.stringify({ name: "GitHub briefing", steps: [{ ...step, id: "items" }] })),
  );
  const resolved: ResolvedEffectBinding = {
    tenant_id: tenant,
    step_id: "items",
    connector_id: connector,
    driver: "http",
    environment: "prod",
    request_digest: requestDigest(definition.steps[0]),
    target: "https://api.github.com/graphql",
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    ...binding,
  };
  return {
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "prod" as const,
    execution_options_digest: "c".repeat(64),
    definition,
    bindings: [resolved],
  };
}

export const graphqlDriverProjectItems = () =>
  manifestInput(
    {
      kind: "request",
      protocol: "graphql",
      connector_id: connector,
      method: "POST",
      graphql: projectItemsGraphql,
    },
    { driver: "graphql" },
  );

export const httpProjectItems = (step: Record<string, unknown> = {}) =>
  manifestInput(
    {
      kind: "request",
      protocol: "graphql",
      connector_id: connector,
      method: "POST",
      path: "/graphql",
      side_effects: "read",
      graphql: projectItemsGraphql,
      ...step,
    },
    {},
  );

export const plainHttpGet = () =>
  manifestInput(
    {
      kind: "request",
      connector_id: connector,
      method: "GET",
      path: "/repos/MikeBild/subkit/milestones",
      query: { state: "all", per_page: 100 },
    },
    { target: "https://api.github.com/repos/MikeBild/subkit/milestones" },
  );
