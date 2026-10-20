import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { ToolContext } from "../conversations/tools/index.ts";
import type { Db } from "../db/client.ts";
import { EngineClient } from "../engine-client/index.ts";
import { logger as mcpStubLogger } from "../logging/logger.ts";
import { dispatchTool } from "../tools/dispatcher.ts";
import { getUnifiedRegistry } from "../tools/index.ts";
import type { ToolDescriptor, ToolEnvelope, ToolInvocation } from "../tools/types.ts";
import {
  alwaysLoadTool,
  buildConversationToolMeta,
  buildToolAnnotations,
} from "./capabilities/tool-meta.ts";
import { zodToJsonSchema7 } from "./json-schema.ts";

function zodToMcpSchema(schema: unknown): Tool["inputSchema"] {
  try {
    if (schema && typeof schema === "object" && "parse" in (schema as object)) {
      const json = zodToJsonSchema7(schema as ZodType);
      if (json && typeof json === "object" && (json as { type?: unknown }).type === "object") {
        return json as Tool["inputSchema"];
      }
    }
    if (schema && typeof schema === "object" && (schema as { type?: string }).type === "object") {
      return schema as Tool["inputSchema"];
    }
  } catch {}
  return { type: "object", properties: {} };
}

const TITLE_ACRONYMS: Readonly<Record<string, string>> = {
  oauth: "OAuth",
  rbac: "RBAC",
  graphql: "GraphQL",
  mcp: "MCP",
  llm: "LLM",
  api: "API",
  url: "URL",
  id: "ID",
  sql: "SQL",
  csv: "CSV",
  json: "JSON",
  html: "HTML",
  db: "DB",
  rid: "RID",
};

function titleFromName(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => TITLE_ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function descriptorToMcpTool(d: ToolDescriptor): Tool {
  const tool: Tool = {
    name: d.name,
    title: titleFromName(d.name),
    description: d.description,
    inputSchema: zodToMcpSchema(d.inputSchema),
    annotations: buildToolAnnotations(d.category, d.name),
    execution: {
      taskSupport: d.name.startsWith("conversation_") ? "optional" : "forbidden",
    },
  };
  const baseMeta = buildConversationToolMeta(d.category, d.name);
  const subkitMeta: Record<string, unknown> = { ...baseMeta.subkit };
  if (d.rbac) {
    subkitMeta.required_permissions = [d.rbac.permission, ...(d.rbac.additional_permissions ?? [])];
  }
  if (d.disabled) {
    subkitMeta.disabled = { reason: d.disabled.reason };
  }
  (tool as Tool & { _meta?: Record<string, unknown> })._meta = {
    subkit: subkitMeta,
    ...(alwaysLoadTool(d.name) ? { "anthropic/alwaysLoad": true } : {}),
  };
  return tool;
}

export function listToolsViaRegistry(opts: {
  principal: ResolvedPrincipal;
  mcpMode: "product" | "authoring" | "admin";
  readOnly: boolean;
}): Tool[] {
  const descriptors = getUnifiedRegistry().list({
    surface: "mcp",
    mcpMode: opts.mcpMode,
    readOnly: opts.readOnly,
  });
  return descriptors.map(descriptorToMcpTool);
}

export function envelopeToMcpResponse(envelope: ToolEnvelope): {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
  _meta?: Record<string, unknown>;
} {
  if (envelope.status === "ok") {
    return {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(envelope.data) }],
      ...(envelope.pause ? { _meta: { subkit: { paused: envelope.pause } } } : {}),
    };
  }
  if (envelope.status === "error") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error_code: envelope.error_code,
            message: envelope.message,
            details: envelope.details,
            next_best_actions: envelope.next_best_actions,
          }),
        },
      ],
    };
  }
  if (envelope.status === "needs_confirm") {
    return {
      isError: false,
      content: [
        { type: "text", text: JSON.stringify({ status: "needs_confirm", ...envelope.confirm }) },
      ],
      _meta: { subkit: { confirm: envelope.confirm } },
    };
  }
  if (envelope.status === "paused") {
    return {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(envelope.pause) }],
      _meta: { subkit: { paused: envelope.pause } },
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error_code: "not_available_on_surface",
          reason: envelope.reason,
        }),
      },
    ],
    _meta: { subkit: { not_available_on_surface: { reason: envelope.reason } } },
  };
}

export function buildMcpStubCtx(opts: { db: Db; principal: ResolvedPrincipal }): ToolContext {
  const engineClient = new EngineClient({
    tenant_id: opts.principal.tenant_id,
    actor_id: opts.principal.id,
    actor_type: opts.principal.kind === "user" ? "user" : "system_account",
    db: opts.db,
  });
  const stubConversationId = crypto.randomUUID();
  mcpStubLogger.info({
    module: "mcp",
    action: "mcp.stub_ctx.built",
    msg: "synthetic ToolContext minted for MCP-only dispatch",
    source: "mcp_stub",
    conversation_id: stubConversationId,
    tenant_id: opts.principal.tenant_id,
    principal_id: opts.principal.id,
  });
  return {
    db: opts.db,
    tenant_id: opts.principal.tenant_id,
    conversation_id: stubConversationId,
    actor_id: opts.principal.id,
    principal: opts.principal,
    connector_id: null,
    workflow_id: null,
    surface: "mcp",
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

export async function callToolViaDispatcher(opts: {
  db: Db;
  principal: ResolvedPrincipal;
  mcpMode: "product" | "authoring" | "admin";
  readOnly: boolean;
  invocation: ToolInvocation;
}): Promise<ReturnType<typeof envelopeToMcpResponse>> {
  const envelope = await dispatchTool(
    {
      registry: getUnifiedRegistry(),
      db: opts.db,
      principal: opts.principal,
      buildMcpStubCtx: () => buildMcpStubCtx({ db: opts.db, principal: opts.principal }),
      mcpMode: opts.mcpMode,
      readOnly: opts.readOnly,
      permissionMode: "auto",
    },
    opts.invocation,
  );
  return envelopeToMcpResponse(envelope);
}
