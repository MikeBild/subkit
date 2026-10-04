// biome-ignore-all lint/suspicious/noTemplateCurlyInString: placeholder tokens (${engine_url}, ${plaintext_key}) are the literal prompt-surface the model reads — they must appear verbatim in description and notes.

import { z } from "@hono/zod-openapi";
import {
  getVendorRecipe,
  listVendorRecipes,
  recipeFreshness,
} from "../../llm/manifests/vendor-recipes.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    client: z
      .string()
      .min(1)
      .max(80)
      .describe(
        "MCP-client or SDK identifier to look up (e.g. 'codex', 'claude-desktop'). Case-insensitive; spaces and underscores are folded to hyphens.",
      ),
  })
  .openapi("GetVendorRecipeToolInput");

export const getVendorRecipeTool: ConversationTool = {
  name: "get_vendor_recipe",
  description:
    "Fetch the verified MCP config recipe for a specific client (Codex, Claude Desktop, Cursor, Continue, …). Returns the canonical Streamable-HTTP and/or stdio JSON templates, the config-file locations, and a freshness status. Call this BEFORE emitting any config block — do not invent client-specific shapes. If the client is not in the manifest, the result is `{ ok: false, error: 'not_found' }` and you must call `cannot_help(missing_capability: 'vendor_recipe.<client>')` instead of guessing.",
  inputSchema,
  category: "tenant_read" as const,
  use_case:
    "Use whenever the user asks 'how do I connect <X> to subkit?' or 'what's the MCP config for <X>?'. Pair with the `mcp-server-setup` skill for protocol facts. Never substitute this lookup with an inline JSON shape.",
  important_notes: [
    "The recipe is hand-curated and carries a `verified_at` timestamp; operators should warn when `freshness.status === 'warn'` and refuse to use `stale` recipes without human review.",
    "The `${engine_url}` and `${plaintext_key}` tokens in the returned templates are real placeholders: substitute `${engine_url}` from RUNTIME CONTEXT (the assembler does this at build time for skills, but tool outputs pass through verbatim), and substitute `${plaintext_key}` only after `create_api_key` returns a real token. Do NOT emit the template with either token unresolved to the end user.",
    "This tool is read-only — no audit entry is written.",
  ],
  example_input: {
    client: "codex",
  },
  async execute(_ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const recipe = getVendorRecipe(args.client);
    if (!recipe) {
      return {
        ok: false,
        data: {
          error: "not_found",
          requested: args.client,
          available_clients: listVendorRecipes().map((r) => r.client),
          reason:
            "No verified recipe for this client. Call cannot_help(missing_capability: 'vendor_recipe.<client>') instead of inventing a config shape.",
        },
      };
    }
    const freshness = recipeFreshness(recipe);
    return {
      ok: true,
      data: {
        recipe,
        freshness: {
          status: freshness.status,
          age_days: freshness.age_days,
        },
      },
    };
  },
};
