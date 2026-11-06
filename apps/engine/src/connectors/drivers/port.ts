import type { SideEffect } from "@shared/index.ts";
import type { DriverName } from "../types.ts";

export type DriverRetry = "graphql_errors" | "mcp_availability" | "http_status" | "none";

export type DriverPagination = "graphql_cursor" | "http_strategy" | "s3_list" | "none";

export type DriverResponseFilters = "result" | "page" | "none";

export type DriverCircuitClose = "outcome" | "success";

export interface DriverCapabilities {
  readonly retry: DriverRetry;
  readonly pagination: DriverPagination;
  readonly response_filters: DriverResponseFilters;
  readonly circuit_close: DriverCircuitClose;
  readonly step_timer: boolean;
  readonly owns_setup_errors: boolean;
  readonly failure_code: string;
}

export interface DriverRetryPolicy {
  backoff_base_ms: number;
  additional_retry_statuses: ReadonlySet<number>;
}

export interface Driver<Request, Result, Step> {
  readonly kind: DriverName;
  readonly capabilities: DriverCapabilities;
  retryPolicy(step: Step): DriverRetryPolicy | null;
  classifySideEffects(step: Step, method?: string, baseUrl?: string | null): SideEffect;
  execute(request: Request): Promise<Result>;
  paginate?(request: Request): Promise<Result>;
}

export type DriverRegistry<Request, Result, Step> = {
  readonly [K in DriverName]: Driver<Request, Result, Step> & { readonly kind: K };
};

export function requestDriverKind(
  driver: string,
  declared: { graphql?: unknown; mcp?: unknown },
): string {
  if (driver === "graphql" || declared.graphql) return "graphql";
  if (driver === "mcp" || declared.mcp) return "mcp";
  return driver;
}

export function lookupDriver<Request, Result, Step>(
  registry: DriverRegistry<Request, Result, Step>,
  kind: string,
): Driver<Request, Result, Step> | null {
  return Object.hasOwn(registry, kind) ? registry[kind as DriverName] : null;
}
