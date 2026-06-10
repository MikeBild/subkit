// Schema barrel — import every table from a single entry point so drizzle-kit
// can discover them. Grouped by domain file.

export * from "./_common.ts";
export * from "./audit.ts";
export * from "./chat.ts";
export * from "./connector_docs.ts";
export * from "./connector_template_credentials.ts";
export * from "./connector_templates.ts";
export * from "./connector-endpoint-schemas.ts";
export * from "./connectors.ts";
export * from "./conversation_elicitations.ts";
export * from "./conversations.ts";
export * from "./conversations-extras.ts";
export * from "./discovery.ts";
export * from "./events.ts";
export * from "./executions.ts";
export * from "./external_call_metering.ts";
export * from "./files.ts";
export * from "./identity.ts";
export * from "./knowledge_sources.ts";
export * from "./llm.ts";
export * from "./mcp_oauth.ts";
export * from "./mcp_oauth_states.ts";
export * from "./mcp_servers.ts";
export * from "./mcp_tasks.ts";
export * from "./notifications.ts";
export * from "./rbac.ts";
export * from "./request_hooks.ts";
export * from "./self_healing_scans.ts";
export * from "./skills.ts";
export * from "./webhooks.ts";
// webhooks-extras is a re-export barrel (same tables); omitted to avoid
// duplicate symbol exports.
export * from "./workflow_run_state.ts";
export * from "./workflow_signals.ts";
export * from "./workflow_waits.ts";
export * from "./workflows.ts";
