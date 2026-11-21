import type { TaskGrantPreview, TaskGrantRecord, TaskGrantWorkflow } from "./task-grant-model";

export const TASK_ID = "10000000-0000-4000-8000-000000000001";
export const TENANT = "00000000-0000-4000-8000-000000000001";
export const BANK = "20000000-0000-4000-8000-000000000001";
export const BOOKS = "20000000-0000-4000-8000-000000000002";
export const MAIL = "20000000-0000-4000-8000-000000000003";
export const WF_MATCH = "30000000-0000-4000-8000-000000000001";
export const WF_QUOTE = "30000000-0000-4000-8000-000000000002";
export const WF_REPORT = "30000000-0000-4000-8000-000000000003";
export const VERSION_QUOTE = "40000000-0000-4000-8000-000000000002";
export const AUTHORITY_REPORT = "50000000-0000-4000-8000-000000000003";
export const GRANT_ID = "60000000-0000-4000-8000-000000000001";
export const FINGERPRINT = "f".repeat(64);
export const DIGEST_MATCH = "a".repeat(64);
export const DIGEST_QUOTE = "b".repeat(64);
export const DIGEST_REPORT = "c".repeat(64);

type Manifest = NonNullable<TaskGrantWorkflow["effect_manifest"]>;

function effect(
  step_id: string,
  connector_id: string,
  kind: "read" | "write" | "destructive" | "unknown",
): Manifest["effects"][number] {
  return {
    tenant_id: TENANT,
    step_id,
    connector_id,
    driver: "http",
    environment: "prod",
    request_digest: "d".repeat(64),
    target: "https://api.example.test/items",
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    operation: kind === "read" ? "GET" : "POST",
    effect: kind,
  } as Manifest["effects"][number];
}

export function manifest(
  workflow_id: string,
  effects: Manifest["effects"],
  issues: Manifest["issues"] = [],
): Manifest {
  return {
    schema_version: 1,
    tenant_id: TENANT,
    workflow_id,
    workflow_version_id: VERSION_QUOTE,
    workflow_digest: "e".repeat(64),
    execution_environment: "prod",
    execution_options_digest: "c".repeat(64),
    effects,
    issues,
  } as Manifest;
}

export function workflow(overrides: Partial<TaskGrantWorkflow> = {}): TaskGrantWorkflow {
  return {
    workflow_id: WF_MATCH,
    workflow_version_id: "40000000-0000-4000-8000-000000000001",
    name: "Zahlungsabgleich",
    effect_manifest_digest: DIGEST_MATCH,
    effect_manifest: manifest(WF_MATCH, [
      effect("read-bank", BANK, "read"),
      effect("book", BOOKS, "write"),
    ]),
    blocked_reason: null,
    covering_authority: null,
    may_grant: true,
    ...overrides,
  };
}

export const QUOTE = workflow({
  workflow_id: WF_QUOTE,
  workflow_version_id: VERSION_QUOTE,
  name: "Angebot erstellen",
  effect_manifest_digest: DIGEST_QUOTE,
  effect_manifest: manifest(WF_QUOTE, [effect("send", MAIL, "write")]),
  blocked_reason: "workflow_not_repeatable",
});

export const REPORT = workflow({
  workflow_id: WF_REPORT,
  workflow_version_id: "40000000-0000-4000-8000-000000000003",
  name: "Wochenbericht",
  effect_manifest_digest: DIGEST_REPORT,
  effect_manifest: manifest(WF_REPORT, [effect("read-books", BOOKS, "read")]),
  covering_authority: { id: AUTHORITY_REPORT, valid_until: null, remaining_runs: null },
});

export function liveGrant(overrides: Partial<TaskGrantRecord> = {}): TaskGrantRecord {
  return {
    id: GRANT_ID,
    task_id: TASK_ID,
    fingerprint: FINGERPRINT,
    environment: "prod",
    valid_from: "2026-11-01T08:00:00.000Z",
    valid_until: null,
    max_runs: null,
    reserved_runs: 0,
    created_by: "70000000-0000-4000-8000-000000000001",
    created_at: "2026-11-01T08:00:00.000Z",
    revoked_at: null,
    revoked_by: null,
    workflow_authority_ids: [],
    ...overrides,
  };
}

export function preview(
  overrides: Partial<Omit<TaskGrantPreview, "workflows">> & {
    workflows?: TaskGrantWorkflow[];
  } = {},
): TaskGrantPreview {
  return {
    task_id: TASK_ID,
    fingerprint: FINGERPRINT,
    environment: "prod",
    grantable: true,
    schedule: {
      schedule_cron: "0 7 * * *",
      schedule_timezone: "Europe/Berlin",
      schedule_run_at: null,
    },
    connectors: [
      { connector_id: MAIL, name: "Postfach", access: "read-write" },
      { connector_id: BOOKS, name: "Buchhaltung", access: "read-only" },
    ],
    web_search: false,
    workflow_run_limit_shared_with_other_triggers: true,
    live_grant: null,
    ...overrides,
    workflows: overrides.workflows ?? [workflow(), QUOTE, REPORT],
  };
}

export const CONNECTOR_NAMES: ReadonlyMap<string, string> = new Map([
  [BANK, "Bank"],
  [BOOKS, "Buchhaltung"],
  [MAIL, "Postfach"],
]);
