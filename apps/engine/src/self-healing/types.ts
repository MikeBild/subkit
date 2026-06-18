// Shared types for the self-healing loop.
//
// `SchemaShape` is a tiny recursive JSON shape derived from an actual
// response body — NOT an OpenAPI schema. The self-healing loop only
// cares about the *shape* of the bytes the connector sent, so we
// normalise every value to one of: scalar, array-of-shape, or
// object-with-property-shapes. Anything we cannot classify widens
// to `"unknown"`.

export type SchemaShape =
  | { type: "string" | "number" | "boolean" | "null" | "unknown" }
  | { type: "array"; items: SchemaShape }
  | { type: "object"; properties: Record<string, SchemaShape> };

// A normalised capture of a failing `request`/`transform` step paired
// with the drifted response. The drift detector emits exactly one
// `DriftSignal` variant per failure — null when the failure doesn't
// match any recognised drift pattern.

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
      // sk-stdlib major-version drift. Emitted when a workflow or
      // request_hook was persisted against a recorded stdlib major
      // that differs from the engine's current major. Unlike the
      // other drift kinds, this one is not tied to a failing step —
      // it's a proactive scan surfaced by the self-healing service
      // so operators can review a migration before the next run.
      kind: "stdlib_version_drift";
      surface: "workflow" | "request_hook";
      resource_id: string;
      recorded_version: string;
      current_version: string;
      recorded_major: number;
      current_major: number;
    }
  | {
      // Workflow-level invariant violation. Emitted when the
      // `validation_expression` on a WorkflowDef evaluates to a
      // falsy result against the run's final output — the run
      // structurally succeeded, but a business invariant ("orders
      // must be non-empty", "every charge has a currency") didn't
      // hold. The repair flow gets the expression text + the
      // offending output so it can propose a fix that re-satisfies
      // the invariant.
      kind: "validation_failed";
      expression: string;
      actual_value: unknown;
    }
  | {
      // Vendor removed or announced removal of an endpoint a committed
      // workflow references. Emitted by the runtime request path (410 Gone /
      // Deprecation headers on a live response) and by the proactive
      // endpoint-contract scan — the months-early warning that converts
      // "discover the removal when an unattended run returns 0 results"
      // into "discover it inside the migration window". Always classified
      // never-auto: an endpoint path rewrite changes request semantics and
      // must go through a reviewed Patch Candidate, even when the vendor
      // announced a successor URI.
      kind: "endpoint_contract";
      severity: "removed" | "deprecated";
      request: {
        method?: string | undefined;
        url?: string | undefined;
        path?: string | undefined;
      };
      /** Vendor-announced removal date (Sunset header), when known. */
      sunset: string | null;
      /** Vendor-announced replacement URI, when known. */
      successor_uri: string | null;
    };

// The classifier output. A PatchDecision says whether the engine may
// auto-apply the candidate. `reasons` is used for audit metadata.

export interface PatchDecision {
  classification: "safe" | "unsafe";
  reasons: string[];
}

// What the queue job actually carries. The payload is small enough to
// fit under the pg-boss 8 KiB cap: every big object is fetched back out
// of postgres by id inside the handler.

export interface WorkflowRepairJob {
  tenant_id: string;
  workflow_id: string;
  execution_id: string | null;
  step_id: string | null;
  connector_id?: string | null;
  endpoint_key?: string | null;
}

// The minimum shape the fixture-runner needs from a step. Mirrors the
// small subset of RequestStep / TransformStep we care about for the
// dry-run gate. The runner does NOT hit the network — it replays the
// recorded response body against the patched step's selector.

export interface DryRunStep {
  id: string;
  kind: "request" | "transform";
  data_selector?: string | undefined;
  response_filters?: unknown;
  expression?: string | undefined;
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
