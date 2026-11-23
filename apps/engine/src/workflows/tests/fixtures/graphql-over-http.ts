export const BRIEFING_CONNECTOR_ID = "11d24801-726b-4733-8d29-72bd922f08b0";
const RADAR_CONNECTOR_ID = "d7738a6f-0000-4000-8000-000000000001";

export const HARMONIQS_ITEMS_QUERY =
  "query HarmoniqsProjectItems($login: String!, $number: Int!, $after: String) { user(login: $login) { projectV2(number: $number) { url items(first: 100, after: $after) { totalCount nodes { id fieldValues(first: 100) { totalCount nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } } pageInfo { hasNextPage endCursor } } content { ... on Issue { id number title state stateReason url createdAt updatedAt closedAt labels(first: 100) { totalCount nodes { name } pageInfo { hasNextPage endCursor } } milestone { number title } } } } pageInfo { hasNextPage endCursor } } } }";

export const VALID_ITEMS_QUERY =
  "query ProjectItems($login: String!, $number: Int!, $after: String) { user(login: $login) { projectV2(number: $number) { items(first: 100, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } } } }";

export function graphqlProjectItemsStep(query: string = VALID_ITEMS_QUERY) {
  return {
    id: "project_items",
    kind: "request",
    protocol: "graphql",
    connector_id: BRIEFING_CONNECTOR_ID,
    method: "GET",
    headers: { accept: "application/vnd.github+json" },
    on_error: "continue",
    graphql: {
      operation: "query",
      query,
      variables: { after: null, login: "MikeBild", number: 3 },
      cursor_pagination: {
        max_items: 10000,
        max_pages: 100,
        items_field: "nodes",
        connection_path: "user.projectV2.items",
        cursor_variable: "after",
        required_connection_paths: ["fieldValues", "content.labels"],
      },
    },
  };
}

export function lossyConversionPatches(query: string = HARMONIQS_ITEMS_QUERY) {
  return [
    { op: "remove" as const, path: "/graphql", step_id: "project_items" },
    { op: "add" as const, path: "/path", value: "/graphql", step_id: "project_items" },
    { op: "replace" as const, path: "/method", value: "POST", step_id: "project_items" },
    {
      op: "add" as const,
      path: "/body",
      value: { query, variables: { after: null, login: "MikeBild", number: 3 } },
      step_id: "project_items",
    },
  ];
}

export function convertedProjectItemsStep(query: string = HARMONIQS_ITEMS_QUERY) {
  return {
    id: "project_items",
    kind: "request",
    connector_id: BRIEFING_CONNECTOR_ID,
    method: "POST",
    path: "/graphql",
    headers: { accept: "application/vnd.github+json" },
    on_error: "continue",
    body: { query, variables: { after: null, login: "MikeBild", number: 3 } },
  };
}

export const RADAR_SEARCH_STEP = {
  id: "search_repositories",
  kind: "request",
  connector_id: RADAR_CONNECTOR_ID,
  method: "POST",
  path: "/graphql",
  headers: { "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
  for_each: "(sourceData) => sourceData.window.data.queries",
  side_effects: "read",
  body: {
    query:
      "query RadarRepositories($query:String!,$first:Int!){search(query:$query,type:REPOSITORY,first:$first){repositoryCount nodes{... on Repository{nameWithOwner url description isFork isArchived isDisabled diskUsage stargazerCount forkCount pushedAt owner{__typename} primaryLanguage{name} licenseInfo{spdxId} repositoryTopics(first:30){nodes{topic{name}}} issues(states:OPEN){totalCount} defaultBranchRef{name target{... on Commit{oid}}}}}}}",
    variables: { first: 50, query: "${item.q}" },
  },
};

export const NOTION_SEARCH_STEP = {
  id: "search_page",
  kind: "request",
  connector_id: RADAR_CONNECTOR_ID,
  method: "POST",
  path: "/v1/search",
  side_effects: "read",
  body: { query: "SubKit Strategie" },
};

export const REST_ITEMS_STEP = {
  id: "project_items",
  kind: "request",
  connector_id: BRIEFING_CONNECTOR_ID,
  method: "GET",
  path: "/users/MikeBild/projectsV2/3/items",
  query: { per_page: "100" },
};
