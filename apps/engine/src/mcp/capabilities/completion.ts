import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { skills, workflows, workflowVersions } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { can } from "../../rbac/evaluator.ts";

const SubkitCompleteRequestSchema = z
  .object({
    method: z.literal("completion/complete"),
    params: z
      .object({
        ref: z.union([
          z.object({ type: z.literal("ref/prompt"), name: z.string() }),
          z.object({ type: z.literal("ref/resource"), uri: z.string() }),
          z.object({ type: z.literal("ref/tool"), name: z.string() }),
        ]),
        argument: z.object({
          name: z.string(),
          value: z.string(),
        }),
        context: z.object({ arguments: z.record(z.string(), z.string()).optional() }).optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const TOOL_PREFIX = "wf_";
const PROMPT_PREFIX = "skill_";
const COMPLETION_LIMIT = 100;

interface SkillArgument {
  name: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

function extractTopLevelProperties(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const obj = schema as { type?: unknown; properties?: unknown };
  if (obj.type !== "object") return [];
  if (!obj.properties || typeof obj.properties !== "object") return [];
  return Object.keys(obj.properties as Record<string, unknown>);
}

function filterByPrefix(names: string[], prefix: string): string[] {
  if (!prefix) return names.slice(0, COMPLETION_LIMIT);
  const lower = prefix.toLowerCase();
  return names.filter((n) => n.toLowerCase().startsWith(lower)).slice(0, COMPLETION_LIMIT);
}

interface RegisterCompletionParams {
  server: Server;
  db: Db;
  principal: ResolvedPrincipal;
}

export function registerCompletionCapability(p: RegisterCompletionParams): void {
  const { server, db, principal } = p;

  server.registerCapabilities({ completions: {} });

  server.setRequestHandler(SubkitCompleteRequestSchema, async (req) => {
    const { ref, argument } = req.params;
    logger.debug({
      module: "mcp",
      action: "mcp.completion.complete",
      msg: "mcp completion/complete called",
      ref_type: ref.type,
      argument_name: argument.name,
    });

    if (ref.type === "ref/resource") {
      return { completion: { values: [], total: 0, hasMore: false } };
    }

    if (ref.type === "ref/prompt") {
      if (!ref.name.startsWith(PROMPT_PREFIX)) {
        return { completion: { values: [], total: 0, hasMore: false } };
      }
      const id = ref.name.slice(PROMPT_PREFIX.length);
      const rows = await db
        .select({ arguments: skills.arguments })
        .from(skills)
        .where(and(eq(skills.tenant_id, principal.tenant_id), eq(skills.id, id)))
        .limit(1);
      const row = rows[0];
      if (!row) return { completion: { values: [], total: 0, hasMore: false } };
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "skill:read",
        resource: { type: "skill", id },
        quiet: true,
      });
      if (!decision.allow) return { completion: { values: [], total: 0, hasMore: false } };
      const args = Array.isArray(row.arguments) ? (row.arguments as SkillArgument[]) : [];
      const names = args
        .filter((a): a is SkillArgument => typeof a?.name === "string")
        .map((a) => a.name);
      const matched = args.find(
        (a): a is SkillArgument => typeof a?.name === "string" && a.name === argument.name,
      );
      if (matched?.enum && Array.isArray(matched.enum)) {
        const filtered = filterByPrefix(matched.enum, argument.value);
        return {
          completion: {
            values: filtered,
            total: matched.enum.length,
            hasMore: false,
          },
        };
      }
      const enumValues: string[] = [];
      for (const a of args) {
        if (Array.isArray(a?.enum)) {
          for (const v of a.enum) if (typeof v === "string") enumValues.push(v);
        }
      }
      const candidate = Array.from(new Set([...names, ...enumValues]));
      const filtered = filterByPrefix(candidate, argument.value);
      return {
        completion: {
          values: filtered,
          total: candidate.length,
          hasMore: false,
        },
      };
    }

    if (ref.type === "ref/tool") {
      const name = ref.name;
      if (!name.startsWith(TOOL_PREFIX)) {
        return { completion: { values: [], total: 0, hasMore: false } };
      }
      const slug = name.slice(TOOL_PREFIX.length);
      const wfRows = await db
        .select({
          id: workflows.id,
          current_version_id: workflows.current_version_id,
        })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, principal.tenant_id),
            eq(workflows.slug, slug),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1);
      const wf = wfRows[0];
      if (!wf?.current_version_id) {
        return { completion: { values: [], total: 0, hasMore: false } };
      }
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "workflow:read",
        resource: { type: "workflow", id: wf.id },
        quiet: true,
      });
      if (!decision.allow) return { completion: { values: [], total: 0, hasMore: false } };
      const versionRows = await db
        .select({ dag: workflowVersions.dag })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, principal.tenant_id),
            eq(workflowVersions.id, wf.current_version_id),
          ),
        )
        .limit(1);
      const dag = versionRows[0]?.dag as { input_schema?: unknown } | null;
      const properties = extractTopLevelProperties(dag?.input_schema);
      const filtered = filterByPrefix(properties, argument.value);
      return {
        completion: {
          values: filtered,
          total: properties.length,
          hasMore: false,
        },
      };
    }

    return { completion: { values: [], total: 0, hasMore: false } };
  });
}

export const __test__ = { extractTopLevelProperties, filterByPrefix };
