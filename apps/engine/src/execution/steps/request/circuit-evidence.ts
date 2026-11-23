import {
  isAvailabilityFailure,
  isAvailabilityFailureFromError,
} from "../../../connectors/availability.ts";
import type { StepResult } from "../../types.ts";
import { RequestError } from "./errors.ts";

export type ConnectorEvidence = "answered" | "unavailable" | "none";

export function evidenceFromStatus(status: number): ConnectorEvidence {
  return isAvailabilityFailure({ status }) ? "unavailable" : "answered";
}

export function evidenceFromThrow(err: unknown): ConnectorEvidence {
  return isAvailabilityFailureFromError(err) ? "unavailable" : "none";
}

export function requestFailureEvidence(err: unknown, step_timed_out: boolean): ConnectorEvidence {
  if (!(err instanceof RequestError)) return evidenceFromThrow(err);
  if (typeof err.status === "number") return evidenceFromStatus(err.status);
  switch (err.cause_kind) {
    case "http_5xx":
    case "http_429":
    case "connection":
    case "timeout":
      return "unavailable";
    case "http_4xx":
    case "filter_fail":
      return "answered";
    case "abort":
      return step_timed_out ? "unavailable" : "none";
    case "upstream_rate_limited":
      return "answered";
    case "authority_invalid":
    case "request_invalid":
    case "pagination_limit_reached":
    case "pagination_link_foreign":
    case "pagination_link_unsupported":
    case "pagination_link_loop":
    case "pagination_short_page":
    case "pagination_cursor_repeated":
    case "pagination_stop_when_failed":
      return "none";
  }
}

export function graphqlEvidence(
  result: Pick<StepResult, "status" | "request_meta" | "error">,
): ConnectorEvidence {
  if (result.status === "succeeded") return "answered";
  const meta = result.request_meta;
  if (meta && meta.driver === "graphql") return evidenceFromStatus(meta.status);
  return evidenceFromThrow(result.error);
}

export function mcpEvidence(result: Pick<StepResult, "status" | "error">): ConnectorEvidence {
  if (result.status === "succeeded") return "answered";
  const code = result.error?.code;
  if (code === "mcp_unavailable") return "unavailable";
  if (code === "mcp_remote_error") return "answered";
  return "none";
}
