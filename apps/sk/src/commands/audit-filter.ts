type AuditFilterArg =
  | "action"
  | "actor"
  | "actor-type"
  | "api-key-id"
  | "session-id"
  | "access-type"
  | "oauth-client-id"
  | "request-source"
  | "origin-source"
  | "execution-source"
  | "correlation-id"
  | "resource-type"
  | "resource-types"
  | "resource-id"
  | "result"
  | "trace-id"
  | "execution-id"
  | "conversation-id"
  | "workflow-id";

type AuditFilterArgs = Partial<Record<AuditFilterArg, string | undefined>>;

export function auditFilterQuery(args: AuditFilterArgs): Record<string, string> {
  const fields: ReadonlyArray<[keyof AuditFilterArgs, string]> = [
    ["action", "action"],
    ["actor", "actor_id"],
    ["actor-type", "actor_type"],
    ["api-key-id", "api_key_id"],
    ["session-id", "session_id"],
    ["access-type", "access_type"],
    ["oauth-client-id", "oauth_client_id"],
    ["request-source", "request_source"],
    ["origin-source", "origin_source"],
    ["execution-source", "execution_source"],
    ["correlation-id", "correlation_id"],
    ["resource-type", "resource_type"],
    ["resource-types", "resource_types"],
    ["resource-id", "resource_id"],
    ["result", "result"],
    ["trace-id", "trace_id"],
    ["execution-id", "execution_id"],
    ["conversation-id", "conversation_id"],
    ["workflow-id", "workflow_id"],
  ];
  const query: Record<string, string> = {};
  for (const [arg, parameter] of fields) {
    const value = args[arg];
    if (value) query[parameter] = value;
  }
  return query;
}
