import { resolveGraphqlStepEndpoint } from "../../../connectors/drivers/graphql-endpoint.ts";
import { GRAPHQL_OVER_HTTP_REPAIR } from "../../../workflows/graphql-conversion.ts";
import type { RequestStep } from "../../../workflows/types.ts";
import type { StepErrorDetail } from "../../types.ts";

interface GraphqlDispatchConnector {
  slug: string;
  driver: string;
  base_url?: string | null;
  auth_type?: string | null;
  config?: unknown;
}

type GraphqlDispatchTarget =
  | { ok: true; endpoint: string | null; pass_endpoint: boolean }
  | { ok: false; error: StepErrorDetail };

export function resolveGraphqlDispatchTarget(
  connector: GraphqlDispatchConnector,
  step: Pick<RequestStep, "path" | "url">,
): GraphqlDispatchTarget {
  if (connector.driver === "graphql") {
    const cfg = (connector.config ?? {}) as { endpoint?: unknown };
    return {
      ok: true,
      endpoint:
        typeof cfg.endpoint === "string" && cfg.endpoint.length > 0
          ? cfg.endpoint
          : (connector.base_url ?? null),
      pass_endpoint: false,
    };
  }
  const resolved = resolveGraphqlStepEndpoint({
    driver: connector.driver,
    base_url: connector.base_url,
    auth_type: connector.auth_type,
    path: step.path,
    url: step.url,
  });
  if (resolved.ok) return { ok: true, endpoint: resolved.url, pass_endpoint: true };
  return {
    ok: false,
    error: {
      code: resolved.code,
      message:
        resolved.code === "connector_driver_mismatch"
          ? `request step carries a \`graphql\` block but connector '${connector.slug}' is driver '${connector.driver}'. ${GRAPHQL_OVER_HTTP_REPAIR}`
          : resolved.message,
    },
  };
}
