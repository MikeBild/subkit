import { inferGraphqlOperation } from "@shared/index.ts";
import type { query as graphqlQuery } from "../../../../connectors/drivers/graphql.ts";
import { HttpRequestInvalidError } from "../../../../connectors/drivers/http.ts";
import {
  resolvePlaceholdersTypePreserving,
  resolveStringPlaceholders,
} from "../../../../llm/substitution/resolver.ts";
import { buildStepErrorDetail } from "../../error-detail.ts";
import { evidenceFromThrow, graphqlEvidence } from "../circuit-evidence.ts";
import { runGraphqlCursorPages } from "../graphql-pagination.ts";
import { runGraphqlWithRetry } from "../graphql-retry.ts";
import { resolveGraphqlDispatchTarget } from "../graphql-target.ts";
import { sleep } from "../http-attempt.ts";
import { rateLimitSleepOverride } from "../rate-limit.ts";
import { backoffMs, resolveRetryPolicy } from "../retry.ts";
import { classifyRequestStepSideEffects, heldStepResult } from "../side-effects.ts";
import {
  egressScope,
  failedStep,
  type RequestDispatch,
  type RequestStepDriver,
  recordDriverOutcome,
  requireConnector,
} from "./context.ts";

async function executeGraphql(d: RequestDispatch) {
  const { p } = d;
  const connector = requireConnector(d);
  const graphqlTarget = resolveGraphqlDispatchTarget(connector, p.step);
  if (!graphqlTarget.ok) return failedStep(d, graphqlTarget.error);
  if (!p.step.graphql) {
    return failedStep(d, {
      code: "missing_graphql",
      message: "request step against a graphql connector requires a `graphql` config",
    });
  }
  try {
    const queryRes = await resolveStringPlaceholders(p.step.graphql.query, d.resolver);
    const variablesRes =
      p.step.graphql.variables !== undefined
        ? await resolvePlaceholdersTypePreserving(p.step.graphql.variables, d.resolver)
        : null;
    const allUnresolved = [...queryRes.unresolved, ...(variablesRes?.unresolved ?? [])];
    if (allUnresolved.length > 0) {
      const tokens = allUnresolved.map((u) => u.token).join(", ");
      return failedStep(
        d,
        {
          code: "placeholder_unresolved",
          message: `unresolved placeholder(s) in graphql query/variables: ${tokens}`,
          details: { unresolved: allUnresolved },
        },
        {
          request_meta: {
            driver: "error",
            method: "POST",
            url: connector.base_url ?? null,
            unresolved_placeholders: allUnresolved.map((u) => u.token),
          },
        },
      );
    }
    const args: Parameters<typeof graphqlQuery>[0] = {
      before_dispatch: d.before_dispatch,
      db: p.ctx.db,
      tenant_id: p.ctx.tenant_id,
      connector,
      query: queryRes.value,
    };
    if (variablesRes !== null) {
      args.variables = variablesRes.value as Record<string, unknown>;
    }
    if (p.step.graphql.operation !== undefined) {
      args.operation = p.step.graphql.operation;
    }
    if (graphqlTarget.pass_endpoint && graphqlTarget.endpoint !== null) {
      args.endpoint = graphqlTarget.endpoint;
    }
    if (Object.keys(d.parts.step_headers).length > 0) {
      args.extra_headers = d.parts.step_headers;
    }
    const graphqlConfig = p.step.graphql;
    const graphqlConnectorResolution = d.connector_resolution;
    const cursorPagination = graphqlConfig.cursor_pagination;
    if (cursorPagination && inferGraphqlOperation(queryRes.value) !== "query") {
      return failedStep(d, {
        code: "graphql_pagination_not_read_only",
        message: "Cursor pagination requires a valid GraphQL query document without mutations.",
      });
    }
    const endpointUrl = graphqlTarget.endpoint;
    if (d.state.holdThisStep) {
      return heldStepResult({
        start: d.start,
        clock: d.clock,
        method: "POST",
        url: endpointUrl,
        headers: d.parts.step_headers,
        body: {
          query: queryRes.value,
          ...(variablesRes !== null
            ? { variables: variablesRes.value as Record<string, unknown> }
            : {}),
        },
      });
    }
    const executeGraphqlPage = (variables: Record<string, unknown>) =>
      runGraphqlWithRetry({
        queryArgs: { ...args, variables },
        egressInput: {
          ...egressScope(d),
          connector_id: connector.id,
          connector_slug: connector.slug,
          driver: "graphql",
          operation: graphqlConfig.operation ?? "query",
          url: endpointUrl,
        },
        step: p.step,
        signal: d.signal,
        start: d.start,
        clock: d.clock,
        ...d.rate_limit,
        connectorResolution: graphqlConnectorResolution as NonNullable<
          typeof graphqlConnectorResolution
        >,
      });
    const graphqlResult = cursorPagination
      ? await runGraphqlCursorPages({
          spec: cursorPagination,
          variables: args.variables ?? {},
          execute: executeGraphqlPage,
          clock: d.clock,
          wait: () =>
            (rateLimitSleepOverride() ?? sleep)(
              backoffMs(0, resolveRetryPolicy(p.step).backoff_base_ms),
              d.signal,
            ),
        })
      : await executeGraphqlPage(args.variables ?? {});
    await recordDriverOutcome(p.ctx.db, connector, graphqlEvidence(graphqlResult));
    return graphqlResult;
  } catch (err) {
    await recordDriverOutcome(p.ctx.db, connector, evidenceFromThrow(err));
    if (err instanceof HttpRequestInvalidError) {
      return failedStep(d, buildStepErrorDetail({ code: "request_invalid", err }));
    }
    return failedStep(d, buildStepErrorDetail({ code: "graphql_error", err }));
  }
}

export const graphqlRequestDriver: RequestStepDriver & { readonly kind: "graphql" } = {
  kind: "graphql",
  capabilities: {
    retry: "graphql_errors",
    pagination: "graphql_cursor",
    response_filters: "none",
    circuit_close: "outcome",
    step_timer: false,
    owns_setup_errors: false,
    failure_code: "graphql_error",
  },
  retryPolicy: resolveRetryPolicy,
  classifySideEffects: (step, method, baseUrl) =>
    classifyRequestStepSideEffects(step, "graphql", method, baseUrl),
  execute: executeGraphql,
};
