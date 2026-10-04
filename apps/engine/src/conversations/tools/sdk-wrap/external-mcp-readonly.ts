import type { NegotiatedServerCapabilities } from "../../../mcp/client/pool.ts";
import type { RemoteCall } from "../../../mcp/client/remote-call.ts";
import type { PaletteOperationSpec } from "./external-mcp-tools.ts";

const CURSOR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    cursor: {
      type: "string",
      description: "Opaque pagination cursor returned as next_cursor by a previous call.",
    },
  },
  additionalProperties: false,
};

function optionalCursor(args: Record<string, unknown>): string | undefined {
  return typeof args.cursor === "string" && args.cursor.length > 0 ? args.cursor : undefined;
}

export function readOnlyPaletteSpecs(
  namespace: string,
  capabilities: NegotiatedServerCapabilities | null,
): PaletteOperationSpec[] {
  if (!capabilities) return [];
  const specs: PaletteOperationSpec[] = [];

  if (capabilities.resources) {
    specs.push({
      suffix: "list_resources",
      target: "resources/list",
      description: `List the resources the external MCP server ${namespace} offers. Read-only: it retrieves a catalogue and changes nothing. Returns { resources, next_cursor }; pass next_cursor back as cursor for the following page.`,
      inputSchema: CURSOR_SCHEMA,
      toCall: (args) => {
        const cursor = optionalCursor(args);
        return {
          ok: true,
          call: { operation: "list_resources", ...(cursor !== undefined ? { cursor } : {}) },
        };
      },
    });
    specs.push({
      suffix: "list_resource_templates",
      target: "resources/templates/list",
      description: `List the resource URI templates the external MCP server ${namespace} offers, such as a parameterised path with {placeholders}. Read-only: it retrieves a catalogue and changes nothing. Returns { resource_templates, next_cursor }; pass next_cursor back as cursor for the following page.`,
      inputSchema: CURSOR_SCHEMA,
      toCall: (args) => {
        const cursor = optionalCursor(args);
        return {
          ok: true,
          call: {
            operation: "list_resource_templates",
            ...(cursor !== undefined ? { cursor } : {}),
          },
        };
      },
    });
    specs.push({
      suffix: "read_resource",
      target: "resources/read",
      description: `Read one resource from the external MCP server ${namespace} by URI. Read-only: it retrieves contents and changes nothing. Get URIs from ${namespace}'s list_resources, or fill in a template from its list_resource_templates. A URI that neither lists is not a resource of this server.`,
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "The resource URI to read, exactly as listed." },
        },
        required: ["uri"],
        additionalProperties: false,
      },
      toCall: (args) => {
        const uri = args.uri;
        if (typeof uri !== "string" || uri.length === 0) {
          return { ok: false, error: "uri is required and must be a non-empty string" };
        }
        return { ok: true, call: { operation: "read_resource", uri } };
      },
    });
  }

  if (capabilities.prompts) {
    specs.push({
      suffix: "list_prompts",
      target: "prompts/list",
      description: `List the prompts the external MCP server ${namespace} offers. Read-only: it retrieves a catalogue and changes nothing. Returns { prompts, next_cursor }; pass next_cursor back as cursor for the following page.`,
      inputSchema: CURSOR_SCHEMA,
      toCall: (args) => {
        const cursor = optionalCursor(args);
        return {
          ok: true,
          call: { operation: "list_prompts", ...(cursor !== undefined ? { cursor } : {}) },
        };
      },
    });
    specs.push({
      suffix: "get_prompt",
      target: "prompts/get",
      description: `Render one prompt from the external MCP server ${namespace}. Read-only: it returns prompt messages and changes nothing. Get names and argument names from ${namespace}'s list_prompts.`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The prompt name, exactly as listed." },
          arguments: {
            type: "object",
            description: "Prompt arguments. The protocol carries them as strings.",
            additionalProperties: true,
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      toCall: (args) => {
        const name = args.name;
        if (typeof name !== "string" || name.length === 0) {
          return { ok: false, error: "name is required and must be a non-empty string" };
        }
        const supplied = args.arguments;
        if (supplied !== undefined && (typeof supplied !== "object" || supplied === null)) {
          return { ok: false, error: "arguments must be an object when supplied" };
        }
        const call: RemoteCall = {
          operation: "get_prompt",
          prompt: name,
          arguments: (supplied as Record<string, unknown> | undefined) ?? {},
        };
        return { ok: true, call };
      },
    });
  }

  return specs;
}
