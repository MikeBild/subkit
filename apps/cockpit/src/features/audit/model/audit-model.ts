import type { components } from "@cli-core/engine-api/openapi";

type AuditEntry = components["schemas"]["AuditEntry"];
export type AuditKind =
  | "approval"
  | "run"
  | "connector"
  | "device"
  | "workspace"
  | "chat"
  | "server"
  | "update"
  | "inbox";

import type { Tone } from "@ui/atoms/pill";
export const AUDIT_KINDS: readonly AuditKind[] = [
  "approval",
  "run",
  "connector",
  "device",
  "workspace",
  "chat",
  "server",
  "update",
  "inbox",
];

const BY_RESOURCE: Record<string, AuditKind> = {
  execution: "run",
  workflow: "run",
  task: "run",
  task_run: "run",
  schedule: "run",
  connector: "connector",
  connection: "connector",
  credential: "connector",
  device: "device",
  session: "device",
  api_key: "device",
  oauth_client: "device",
  portal_token: "device",
  tenant: "workspace",
  membership: "workspace",
  user: "workspace",
  role: "workspace",
  group: "workspace",
  invitation: "workspace",
  system_account: "workspace",
  conversation: "chat",
  settings: "server",
  setting: "server",
  budget: "server",
  branding: "server",
  release: "update",
  package: "update",
  installation: "update",
  intake_item: "inbox",
  intake_proposal: "inbox",
  knowledge_source: "inbox",
  skill: "inbox",
  skill_candidate: "inbox",
  file: "inbox",
};

export function auditKind(e: Pick<AuditEntry, "action" | "resource_type">): AuditKind {
  if (/approv|grant|authority|permission|admission/i.test(e.action)) return "approval";
  return BY_RESOURCE[e.resource_type] ?? (e.action.startsWith("update") ? "update" : "server");
}

const KIND_TONE: Record<AuditKind, Tone> = {
  approval: "info",
  run: "success",
  connector: "warning",
  device: "neutral",
  workspace: "neutral",
  chat: "neutral",
  server: "neutral",
  update: "neutral",
  inbox: "neutral",
};

export function auditTone(e: Pick<AuditEntry, "action" | "resource_type" | "result">): Tone {
  if (e.result === "denied" || e.result === "error") return "danger";
  return KIND_TONE[auditKind(e)];
}

export function auditQuery(
  search: string,
  linkParams: Record<string, string>,
  scopeParams: Record<string, string>,
): Record<string, string> {
  const params = new URLSearchParams(search);
  const extra: Record<string, string> = {};
  for (const key of [
    "result",
    "correlation_id",
    "workflow_id",
    "execution_id",
    "conversation_id",
    "task_id",
  ]) {
    const v = params.get(key);
    if (v) extra[key] = v;
  }
  return { ...scopeParams, ...linkParams, ...extra };
}

export function highlightedEntry(search: string): string | null {
  const v = new URLSearchParams(search).get("entry");
  return v && /^[0-9a-zA-Z-]{8,64}$/.test(v) ? v : null;
}
