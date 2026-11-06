import { graphqlOverHttpRequest } from "@shared/index.ts";

export const GRAPHQL_OVER_HTTP_REPAIR =
  'The supported repair keeps the graphql block with its cursor_pagination on the existing http connector and sets path "/graphql" (for GitHub the connector base_url is https://api.github.com, so the request goes to https://api.github.com/graphql with that connector\'s credential). Do not set url. A graphql connector whose base_url is the GraphQL endpoint, or a step against the REST endpoint, also works.';

export const GRAPHQL_OVER_HTTP_LOSS =
  "a POST /graphql request with a body on an http connector has no cursor_pagination, so only the first page is read, and a mutation or an unparseable or runtime-assembled document is reviewed as a write";

export const GRAPHQL_OVER_HTTP_WARNING = `Do not convert it to a POST /graphql body on an http connector: ${GRAPHQL_OVER_HTTP_LOSS}. Keep the graphql block and set path "/graphql" instead.`;

export type ConnectorBaseUrls = ReadonlyMap<string, ReadonlyArray<string>>;

interface StepsHolder {
  steps?: ReadonlyArray<unknown> | null | undefined;
}

type StepRecord = Record<string, unknown>;

const NO_BASE_URLS: ConnectorBaseUrls = new Map();

function stepRecords(definition: StepsHolder): StepRecord[] {
  return (definition.steps ?? []).filter(
    (step): step is StepRecord =>
      step !== null && typeof step === "object" && typeof (step as StepRecord).id === "string",
  );
}

function isGraphqlOverHttpStep(
  step: StepRecord,
  baseUrls: ConnectorBaseUrls = NO_BASE_URLS,
): boolean {
  if (step.kind !== "request" || step.graphql || step.sql || step.mcp || step.s3) return false;
  const target =
    typeof step.url === "string" ? step.url : typeof step.path === "string" ? step.path : null;
  const method = typeof step.method === "string" ? step.method : null;
  const connectorBaseUrls =
    typeof step.connector_id === "string" ? (baseUrls.get(step.connector_id) ?? []) : [];
  return [null, ...connectorBaseUrls].some(
    (baseUrl) => graphqlOverHttpRequest({ method, target, body: step.body, baseUrl }) !== null,
  );
}

export function introducedGraphqlOverHttpSteps(
  before: StepsHolder,
  after: StepsHolder,
  baseUrls: ConnectorBaseUrls = NO_BASE_URLS,
): string[] {
  const existing = new Set(
    stepRecords(before)
      .filter((step) => isGraphqlOverHttpStep(step, baseUrls))
      .map((step) => step.id as string),
  );
  return stepRecords(after)
    .filter((step) => !existing.has(step.id as string) && isGraphqlOverHttpStep(step, baseUrls))
    .map((step) => step.id as string);
}

export function replacedGraphqlSteps(before: StepsHolder, after: StepsHolder): string[] {
  const afterById = new Map(stepRecords(after).map((step) => [step.id as string, step]));
  return stepRecords(before)
    .filter((step) => step.kind === "request" && step.graphql)
    .filter((step) => !afterById.get(step.id as string)?.graphql)
    .map((step) => step.id as string);
}

export function lossyGraphqlConversions(
  before: StepsHolder,
  after: StepsHolder,
  baseUrls: ConnectorBaseUrls = NO_BASE_URLS,
): string[] {
  if (replacedGraphqlSteps(before, after).length === 0) return [];
  return introducedGraphqlOverHttpSteps(before, after, baseUrls);
}
