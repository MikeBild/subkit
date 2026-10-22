import { graphqlOverHttpQuery } from "@shared/index.ts";

export const GRAPHQL_OVER_HTTP_REPAIR =
  "The supported repair is a graphql block on a graphql connector whose base_url is the GraphQL endpoint (for GitHub https://api.github.com/graphql), keeping cursor_pagination, or a step against the REST endpoint.";

export const GRAPHQL_OVER_HTTP_WARNING =
  "Do not convert it to POST /graphql on an http connector: that drops cursor_pagination, so only the first page is read, and the request is reviewed as a write.";

interface StepsHolder {
  steps?: ReadonlyArray<unknown> | null | undefined;
}

type StepRecord = Record<string, unknown>;

function stepRecords(definition: StepsHolder): StepRecord[] {
  return (definition.steps ?? []).filter(
    (step): step is StepRecord => step !== null && typeof step === "object",
  );
}

export function isGraphqlOverHttpStep(step: StepRecord): boolean {
  if (step.kind !== "request" || step.graphql || step.sql || step.mcp || step.s3) return false;
  const target =
    typeof step.url === "string" ? step.url : typeof step.path === "string" ? step.path : null;
  return (
    graphqlOverHttpQuery({
      method: typeof step.method === "string" ? step.method : null,
      target,
      body: step.body,
    }) !== null
  );
}

export function lossyGraphqlConversions(before: StepsHolder, after: StepsHolder): string[] {
  const graphqlStepIds = new Set(
    stepRecords(before)
      .filter((step) => step.kind === "request" && step.graphql && typeof step.id === "string")
      .map((step) => step.id as string),
  );
  return stepRecords(after)
    .filter(
      (step) =>
        typeof step.id === "string" && graphqlStepIds.has(step.id) && isGraphqlOverHttpStep(step),
    )
    .map((step) => step.id as string);
}

export function introducedGraphqlOverHttpSteps(before: StepsHolder, after: StepsHolder): string[] {
  const existing = new Set(
    stepRecords(before)
      .filter((step) => typeof step.id === "string" && isGraphqlOverHttpStep(step))
      .map((step) => step.id as string),
  );
  return stepRecords(after)
    .filter(
      (step) =>
        typeof step.id === "string" && !existing.has(step.id) && isGraphqlOverHttpStep(step),
    )
    .map((step) => step.id as string);
}
