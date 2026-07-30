// Read-only palette adapters over a remote MCP server's resources and
// prompts.
//
// A remote MCP server offers three things: tools, resources and prompts.
// Only the first reached the chat palette, so a server whose whole value
// is a document catalogue was invisible to the model even while connected.
// These adapters close that, as four synthetic entries per server —
// `list_resources`, `read_resource`, `list_prompts`, `get_prompt`.
//
// THEY ARE READS BY THE ENGINE'S OWN KNOWLEDGE, NOT BY THE SERVER'S.
// Each adapter is pinned to one wire method that the specification defines
// as a retrieval, and none of them can reach `tools/call` — that is a fact
// about the code here, not a claim a remote made about itself. This is the
// one place a read/write distinction over MCP is safe to draw, which is
// exactly why `classifyMcpToolSideEffect` refuses to draw it from a
// server's `readOnlyHint`.
//
// MINTED ONLY WHERE DECLARED. An adapter appears only when the server's
// negotiated capabilities include the matching capability. Offering the
// model `read_resource` against a tools-only server would put an entry in
// the palette whose every call is a protocol error, and the model would
// spend turns discovering that.
//
// THEY STILL ASK. These go through the same governed pipeline and the same
// confirm gate as a remote tool call: `isDangerousTool` keys on the `mcp_`
// prefix and there is deliberately no carve-out for a name the engine
// happens to have minted. A carve-out is a real security decision — it
// would have to be keyed on adapter identity and defended against a
// server that names a TOOL `read_resource` — and it is not one this change
// makes.

import type { NegotiatedServerCapabilities } from "../../../mcp/client/pool.ts";
import type { RemoteCall } from "../../../mcp/client/remote-call.ts";
import type { PaletteOperationSpec } from "./external-mcp-tools.ts";

/** Free-text `cursor` argument shared by the two list adapters. */
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

/**
 * The adapters a server has earned, given what it declared.
 *
 * `capabilities` is `null` when the client could not be asked what the
 * server serves. That mints nothing: an unanswered question is not a yes,
 * and the cost of guessing wrong is a palette entry that cannot work.
 */
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
      suffix: "read_resource",
      target: "resources/read",
      description: `Read one resource from the external MCP server ${namespace} by URI. Read-only: it retrieves contents and changes nothing. Get URIs from ${namespace}'s list_resources.`,
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
        // Refused rather than coerced: `String(undefined)` would send the
        // remote the literal "undefined" and the failure would arrive as
        // the server's puzzled error rather than ours.
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
