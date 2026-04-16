// Skills → MCP prompts.
//
// Skills are hand-authored LLM-context records; each active skill becomes
// an MCP prompt named `skill.<id-slice>` with the skill title as the
// description. `prompts/get` returns the body as a single user message
// followed by each example (if any) as assistant messages.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  type Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { and, desc, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { skills } from "../../db/schema/index.ts";
import { can } from "../../rbac/evaluator.ts";

const PREFIX = "skill.";

function toName(id: string): string {
  // Keep the full uuid so ids are unambiguous.
  return `${PREFIX}${id}`;
}

export interface RegisterPromptsParams {
  server: Server;
  db: Db;
  principal: ResolvedPrincipal;
}

export function registerPromptsCapability(p: RegisterPromptsParams): void {
  const { server, db, principal } = p;

  server.registerCapabilities({ prompts: { listChanged: false } });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, principal.tenant_id), eq(skills.lifecycle, "active")))
      .orderBy(desc(skills.created_at));
    const prompts: Prompt[] = rows.map((r) => ({
      name: toName(r.id),
      description: r.title,
    }));
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const name = req.params.name;
    if (!name.startsWith(PREFIX)) throw new Error(`unknown prompt: ${name}`);
    const id = name.slice(PREFIX.length);
    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, principal.tenant_id), eq(skills.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`prompt not found: ${id}`);
    // Pass-2 C6: gate prompt reads on `skill:read`.
    const decision = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission: "skill:read",
      resource: { type: "skill", id: row.id },
    });
    if (!decision.allow) {
      const err = new Error(decision.reason ?? "permission_denied") as Error & {
        code?: number;
      };
      err.code = -32001;
      throw err;
    }
    const examples: unknown[] = Array.isArray(row.examples) ? row.examples : [];
    const messages: Array<{
      role: "user" | "assistant";
      content: { type: "text"; text: string };
    }> = [
      {
        role: "user",
        content: { type: "text", text: row.body },
      },
    ];
    for (const ex of examples) {
      messages.push({
        role: "assistant",
        content: {
          type: "text",
          text: typeof ex === "string" ? ex : JSON.stringify(ex),
        },
      });
    }
    return {
      description: row.title,
      messages,
    };
  });
}
