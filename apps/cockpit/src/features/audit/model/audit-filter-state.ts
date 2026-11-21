import {
  type AuditScope,
  auditCorrelationFromUrl,
  initialAuditFilter,
  normalizedAuditScope,
} from "@/features/audit/model/audit-entries";
import { localDateTimeInput, utcChoiceForInstant } from "./audit-timeline-model";

export type Source =
  | "api"
  | "cli"
  | "scheduler"
  | "mcp"
  | "webhook"
  | "tool-chain"
  | "ui"
  | "chat"
  | "queue";
export const SOURCES: readonly Source[] = [
  "ui",
  "chat",
  "cli",
  "mcp",
  "api",
  "webhook",
  "scheduler",
  "tool-chain",
  "queue",
];
export const ACCESS_TYPES = [
  "api_key",
  "browser_session",
  "mcp_oauth",
  "token_exchange",
  "external_bearer",
  "task_run",
  "portal_token",
] as const;
export type AccessType = (typeof ACCESS_TYPES)[number];
export interface FilterState {
  scope: AuditScope;
  resourceType: string;
  resourceId: string;
  resourceQuery: string;
  actorType: string;
  actorId: string;
  apiKeyId: string;
  sessionId: string;
  accessType: string;
  oauthClientId: string;
  originSource: string;
  executionSource: string;
  executionId: string;
  conversationId: string;
  workflowId: string;
  taskId: string;
  taskRunId: string;
  result: string;
  action: string;
  traceId: string;
  correlationId: string;
  from: string;
  to: string;
  fromChoice: string;
  toChoice: string;
  fromInstant: string;
  toInstant: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validUrlUuid(value: string | null): string {
  return value && UUID.test(value) ? value : "";
}
export function auditFilterFromSearch(search: string, now: number, zone: string): FilterState {
  const linked = initialAuditFilter(search, now);
  const params = new URLSearchParams(search);
  const accessType = params.get("access_type");
  const oauthClientId = params.get("oauth_client_id");
  const actorType = params.get("actor_type");
  const validActorType =
    ["user", "system_account", "system", "unknown"].find((candidate) => candidate === actorType) ??
    "";
  const originSource = params.get("origin_source");
  const executionSource = params.get("execution_source");
  const result = params.get("result");
  const action = linked.actions.join(",");
  return {
    scope: normalizedAuditScope(linked.scope ?? "all", action, validActorType),
    resourceType: linked.resourceType ?? "",
    resourceId: linked.resourceId ?? "",
    resourceQuery: linked.resourceId ?? "",
    actorType: validActorType,
    actorId: validUrlUuid(params.get("actor_id")),
    apiKeyId: validUrlUuid(params.get("api_key_id")),
    sessionId: validUrlUuid(params.get("session_id")),
    accessType: ACCESS_TYPES.find((access) => access === accessType) ?? "",
    oauthClientId:
      oauthClientId !== null && /^[a-zA-Z0-9._:-]{1,128}$/.test(oauthClientId) ? oauthClientId : "",
    originSource: SOURCES.find((source) => source === originSource) ?? "",
    executionSource: SOURCES.find((source) => source === executionSource) ?? "",
    executionId: validUrlUuid(params.get("execution_id")),
    conversationId: validUrlUuid(params.get("conversation_id")),
    workflowId: validUrlUuid(params.get("workflow_id")),
    taskId: validUrlUuid(params.get("task_id")),
    taskRunId: validUrlUuid(params.get("task_run_id")),
    result: ["success", "denied", "error"].find((candidate) => candidate === result) ?? "",
    action,
    traceId: linked.traceId ?? "",
    correlationId: auditCorrelationFromUrl(search) ?? "",
    from: localDateTimeInput(linked.tsFrom, zone),
    to: localDateTimeInput(linked.tsTo, zone),
    fromChoice: utcChoiceForInstant(linked.tsFrom, zone),
    toChoice: utcChoiceForInstant(linked.tsTo, zone),
    fromInstant: linked.tsFrom ?? "",
    toInstant: linked.tsTo ?? "",
  };
}
export const EMPTY: Readonly<FilterState> = {
  scope: "all",
  resourceType: "",
  resourceId: "",
  resourceQuery: "",
  actorType: "",
  actorId: "",
  apiKeyId: "",
  sessionId: "",
  accessType: "",
  oauthClientId: "",
  originSource: "",
  executionSource: "",
  executionId: "",
  conversationId: "",
  workflowId: "",
  taskId: "",
  taskRunId: "",
  result: "",
  action: "",
  traceId: "",
  correlationId: "",
  from: "",
  to: "",
  fromChoice: "",
  toChoice: "",
  fromInstant: "",
  toInstant: "",
};
