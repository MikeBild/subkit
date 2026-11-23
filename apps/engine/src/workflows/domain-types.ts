export type JsonPrimitive = string | number | boolean | null;

export interface FileReference {
  $file: string;
  $range?: { start: number; length: number };
}

export type JsonValue = JsonPrimitive | FileReference | { [key: string]: JsonValue } | JsonValue[];

export type WorkflowLifecycle = "draft" | "active" | "archived";

export type WorkflowStepKind =
  | "request"
  | "transform"
  | "call"
  | "wait"
  | "wait_for_event"
  | "branch"
  | "parallel";

export interface DomainStepBase {
  id: string;
  kind: WorkflowStepKind;
  on_error?: "fail" | "continue" | undefined;
  data_selector?: string | undefined;
  timeout_ms?: number | undefined;
  for_each?: string | undefined;
  for_each_concurrency?: number | undefined;
}

export interface DomainRequestStep extends DomainStepBase {
  kind: "request";
  method?:
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS"
    | "LIST"
    | "SELECT"
    | "INSERT"
    | "UPDATE"
    | "CALL"
    | undefined;
  url?: string | undefined;
  path?: string | undefined;
  connector_id?: string | undefined;
  headers?: Record<string, unknown> | string | undefined;
  query?: Record<string, string | number | boolean> | undefined;
  body?: JsonValue | undefined;
  graphql?: { variables?: Record<string, unknown> | undefined } | undefined;
  mcp?: { arguments?: Record<string, JsonValue> | undefined } | undefined;
  report_delivery?: { to?: unknown; from?: unknown } | undefined;
}

export interface DomainTransformStep extends DomainStepBase {
  kind: "transform";
  expression?: string | undefined;
  language?: "javascript" | "readability" | "html-to-markdown" | "structured-data" | undefined;
}

export interface DomainCallStep extends DomainStepBase {
  kind: "call";
  workflow_id?: string | undefined;
  workflow_slug?: string | undefined;
  input?: JsonValue | undefined;
}

export interface DomainWaitStep extends DomainStepBase {
  kind: "wait";
  duration_ms: number;
}

export interface DomainWaitForEventStep extends DomainStepBase {
  kind: "wait_for_event";
  event_name: string;
  timeout_ms: number;
  on_timeout?: string | undefined;
}

export interface DomainBranchStep extends DomainStepBase {
  kind: "branch";
  when: string;
  then_steps: string[];
  else_steps?: string[] | undefined;
}

export interface DomainParallelStep extends DomainStepBase {
  kind: "parallel";
  branches: string[][];
}

export type DomainStepDef =
  | DomainRequestStep
  | DomainTransformStep
  | DomainCallStep
  | DomainWaitStep
  | DomainWaitForEventStep
  | DomainBranchStep
  | DomainParallelStep;

export interface DomainWorkflowRuntime {
  stdlib_version?: string | undefined;
}

export interface DomainWorkflowSpecField {
  name: string;
  description?: string | undefined;
}

export interface DomainWorkflowSpec {
  goal: string | null;
  inputs: DomainWorkflowSpecField[];
  outputs: DomainWorkflowSpecField[];
  delivery: {
    channel: string;
    destination?: string | undefined;
    description?: string | undefined;
  } | null;
  conventions_applied: Array<{ skill_id?: string | undefined; note: string }>;
  evidence: Array<{ source: string; locator: string }>;
  open_questions: string[];
  origin: "person" | "chat" | "derived";
}

export type DomainWorkflowTrigger =
  | { kind: "request" }
  | {
      kind: "webhook";
      source: string;
      events: string[];
      verify: "stripe-signature" | "github-hmac" | "none";
    }
  | {
      kind: "schedule";
      cron: string;
      tz: string;
      execution_mode?: "dev" | "prod" | undefined;
    };

export interface DomainWorkflowDef {
  name: string;
  steps: DomainStepDef[];
  slug?: string | undefined;
  description?: string | undefined;
  timeout_ms?: number | undefined;
  input_schema?: Record<string, unknown> | undefined;
  input_schema_sample?: unknown;
  output_schema?: Record<string, unknown> | undefined;
  output_transform?: string | undefined;
  output_transform_function?: string | undefined;
  validation_expression?: string | undefined;
  validation_function?: string | undefined;
  runtime?: DomainWorkflowRuntime | undefined;
  trigger?: DomainWorkflowTrigger | undefined;
}
