import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  type Prompt,
  type PromptArgument,
} from "@modelcontextprotocol/sdk/types.js";
import { and, desc, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { skills } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { globalEmitter, type PubSubEmitter } from "../../pubsub/emitter.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { can } from "../../rbac/evaluator.ts";
import { paginate } from "./pagination.ts";

const PREFIX = "skill_";
const PROMPT_LIST_CHANGED_DEBOUNCE_MS = 250;

function toName(id: string): string {
  return `${PREFIX}${id}`;
}

interface RegisterPromptsParams {
  server: Server;
  db: Db;
  principal: ResolvedPrincipal;
  emitter?: PubSubEmitter;
}

function toPromptArguments(value: unknown): PromptArgument[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const args = value
    .filter((arg): arg is Record<string, unknown> => Boolean(arg) && typeof arg === "object")
    .filter((arg) => typeof arg.name === "string")
    .map((arg) => ({
      name: arg.name as string,
      ...(typeof arg.description === "string" ? { description: arg.description } : {}),
      ...(typeof arg.required === "boolean" ? { required: arg.required } : {}),
    }));
  return args.length > 0 ? args : undefined;
}

function validatePromptArguments(
  descriptors: PromptArgument[] | undefined,
  values: Record<string, string> | undefined,
): Record<string, string> {
  const declared = new Set((descriptors ?? []).map((arg) => arg.name));
  const provided = values ?? {};
  for (const name of Object.keys(provided)) {
    if (!declared.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt argument: ${name}`);
    }
  }
  for (const arg of descriptors ?? []) {
    if (arg.required && provided[arg.name] === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Missing required prompt argument: ${arg.name}`);
    }
  }
  return provided;
}

function applyPromptArguments(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (match, key: string) => {
    return values[key] ?? match;
  });
}

export function registerPromptsCapability(p: RegisterPromptsParams): void {
  const { server, db, principal } = p;
  const emitter = p.emitter ?? globalEmitter;
  let listChangedTimer: ReturnType<typeof setTimeout> | undefined;

  function schedulePromptListChanged(): void {
    if (listChangedTimer) return;
    listChangedTimer = setTimeout(() => {
      listChangedTimer = undefined;
      void server.sendPromptListChanged().catch((err: unknown) => {
        logger.warn({
          module: "mcp",
          action: "mcp.prompts.list_changed.failed",
          msg: "failed to send mcp prompts list_changed",
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, PROMPT_LIST_CHANGED_DEBOUNCE_MS);
    listChangedTimer.unref?.();
  }

  const offSkillLifecycle = emitter.on("skill.lifecycle", (event: EventEnvelope<unknown>) => {
    if (event.tenant_id !== principal.tenant_id) return;
    schedulePromptListChanged();
  });

  const priorOnClose = server.onclose;
  server.onclose = (): void => {
    offSkillLifecycle();
    if (listChangedTimer) {
      clearTimeout(listChangedTimer);
      listChangedTimer = undefined;
    }
    if (typeof priorOnClose === "function") {
      try {
        priorOnClose();
      } catch {}
    }
  };

  server.registerCapabilities({ prompts: { listChanged: true } });

  server.setRequestHandler(ListPromptsRequestSchema, async (req) => {
    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, principal.tenant_id), eq(skills.lifecycle, "active")))
      .orderBy(desc(skills.created_at));
    const prompts: Prompt[] = rows.map((r) => {
      const args = toPromptArguments(r.arguments);
      return {
        name: toName(r.id),
        title: r.title,
        description: r.title,
        ...(args ? { arguments: args } : {}),
      };
    });
    const page = paginate("prompts/list", prompts, req.params?.cursor);
    return { prompts: page.page, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const name = req.params.name;
    if (!name.startsWith(PREFIX))
      throw new McpError(ErrorCode.InvalidParams, `unknown prompt: ${name}`);
    const id = name.slice(PREFIX.length);
    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, principal.tenant_id), eq(skills.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new McpError(ErrorCode.InvalidParams, `prompt not found: ${id}`);
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
    const argumentDescriptors = toPromptArguments(row.arguments);
    const argumentValues = validatePromptArguments(argumentDescriptors, req.params.arguments);
    const examples: unknown[] = Array.isArray(row.examples) ? row.examples : [];
    const messages: Array<{
      role: "user" | "assistant";
      content: { type: "text"; text: string };
    }> = [
      {
        role: "user",
        content: { type: "text", text: applyPromptArguments(row.body, argumentValues) },
      },
    ];
    for (const ex of examples) {
      const text = typeof ex === "string" ? ex : JSON.stringify(ex);
      messages.push({
        role: "assistant",
        content: {
          type: "text",
          text: applyPromptArguments(text, argumentValues),
        },
      });
    }
    return {
      description: row.title,
      messages,
    };
  });
}
