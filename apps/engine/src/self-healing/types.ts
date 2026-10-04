import type { GateFixer } from "../workflows/gate-fix.ts";
import type { ReportDeliveryBoundary } from "../workflows/report-delivery-boundary.ts";

export type SchemaShape =
  | { type: "string" | "number" | "boolean" | "null" | "unknown" }
  | { type: "array"; items: SchemaShape }
  | { type: "object"; properties: Record<string, SchemaShape> };

export type DriftSignal =
  | {
      kind: "http_status_new_shape";
      status: number;
      request: {
        method?: string | undefined;
        url?: string | undefined;
        path?: string | undefined;
      };
      response_before: SchemaShape | null;
      response_after: SchemaShape;
    }
  | {
      kind: "jsonata_path_miss";
      expression: string;
      missing_path: string;
      prior_value: unknown;
    }
  | {
      kind: "schema_diff";
      before: SchemaShape;
      after: SchemaShape;
      added: string[];
      removed: string[];
      widened: string[];
    }
  | {
      kind: "stdlib_version_drift";
      surface: "workflow" | "request_hook";
      resource_id: string;
      recorded_version: string;
      current_version: string;
      recorded_major: number;
      current_major: number;
    }
  | {
      kind: "validation_failed";
      expression: string;
      actual_value: unknown;
    }
  | {
      kind: "endpoint_contract";
      severity: "removed" | "deprecated";
      request: {
        method?: string | undefined;
        url?: string | undefined;
        path?: string | undefined;
      };
      sunset: string | null;
      successor_uri: string | null;
    }
  | {
      kind: "gate_block";
      code: string;
      reason: string | null;
      fixer: GateFixer;
      step_id: string;
    };

export interface PatchDecision {
  classification: "safe" | "unsafe";
  reasons: string[];
}

export interface WorkflowRepairJob {
  tenant_id: string;
  workflow_id: string;
  execution_id: string | null;
  step_id: string | null;
  connector_id?: string | null;
  endpoint_key?: string | null;
  trigger?: "gate_block";
  version_id?: string;
  environment?: "dev" | "prod";
}

export interface DryRunStep {
  id: string;
  kind: "request" | "transform";
  data_selector?: string | undefined;
  response_filters?: unknown;
  expression?: string | undefined;
  report_delivery?: ReportDeliveryBoundary | undefined;
}

export interface DryRunFixture {
  request: unknown;
  response: unknown;
}

export interface DryRunResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}
