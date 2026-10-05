import { z } from "@hono/zod-openapi";
import {
  approveDiscoveryArtifact,
  getDiscoveryArtifact,
  listDiscoveryArtifacts,
} from "../../../discovery/service.ts";
import type { ConversationTool, ToolResult } from "../index.ts";

const ListInput = z
  .object({
    run_id: z.string().uuid(),
    kind: z.enum(["connector", "skill", "knowledge_source"]).optional(),
    status: z.enum(["proposed", "approved", "rejected", "superseded"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .openapi("ListDiscoveryArtifactsInput");

const GetInput = z.object({ id: z.string().uuid() }).openapi("GetDiscoveryArtifactInput");

const ApproveInput = z.object({ id: z.string().uuid() }).openapi("ApproveDiscoveryArtifactInput");

export const listDiscoveryArtifactsTool: ConversationTool = {
  name: "list_discovery_artifacts",
  description:
    "List proposals produced by a discovery run — connectors, skills, knowledge sources extracted from uploaded artifacts.",
  use_case:
    "After uploading a spec / docs / code sample via @file: or via the discovery flow, list what the engine auto-proposed so you can triage with the operator before calling approve_discovery_artifact.",
  important_notes: [
    "Scoped to a single `run_id`; call list_discovery_runs (via engine-client) if you need to find recent runs.",
    "Status defaults to all — filter with {status:'proposed'} when looking for work items.",
    "Ordered newest-first; hard cap 200.",
  ],
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof ListInput>): Promise<ToolResult> {
    const rows = await listDiscoveryArtifacts(
      {
        tenant_id: ctx.tenant_id,
        run_id: args.run_id,
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.status ? { status: args.status } : {}),
        limit: args.limit,
        offset: args.offset,
      },
      ctx.db,
    );
    return {
      ok: true,
      data: {
        persistence: "none" as const,
        artifacts: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          title: r.title,
          description: r.description,
          confidence: r.confidence,
          materialized_id: r.materialized_id,
          materialized_type: r.materialized_type,
          created_at: r.created_at,
        })),
      },
    };
  },
};

export const getDiscoveryArtifactTool: ConversationTool = {
  name: "get_discovery_artifact",
  description: "Fetch a single discovery artifact including its draft + evidence excerpts.",
  use_case:
    "Call before approving to inspect what the engine auto-proposed. The `draft` field is a complete CreateConnectorInput / CreateSkillInput / KnowledgeDraft ready to materialise.",
  important_notes: [
    "Evidence carries file_ids + excerpts — use them to cite the source to the operator before asking for approval.",
    "Returns null-equivalent (`artifact_not_found`) when the id is invalid for this tenant.",
  ],
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof GetInput>): Promise<ToolResult> {
    const row = await getDiscoveryArtifact(ctx.tenant_id, args.id, ctx.db);
    if (!row) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: { code: "artifact_not_found", message: "no discovery artifact with that id" },
        },
      };
    }
    return {
      ok: true,
      data: {
        persistence: "none" as const,
        artifact: row,
      },
    };
  },
};

export const approveDiscoveryArtifactTool: ConversationTool = {
  name: "approve_discovery_artifact",
  description:
    "Approve a proposed discovery artifact (connector / skill / knowledge source). Records the human decision; materialisation is performed by downstream tools.",
  use_case:
    "After the operator has reviewed a proposed artifact via get_discovery_artifact, flip it to approved. This is a human gate — only call after `ask_user_confirm` returns confirmed=true.",
  important_notes: [
    "Artifact must be in `proposed` status; already-approved / rejected rows return `already_materialized` or `not_found`.",
    "Approval alone does NOT create the downstream row — a follow-up call (start_connector_from_description or start_connector_from_template / propose_skill / knowledge upsert) materialises the draft.",
    "Writes an audit entry under action=discovery.artifact_approved.",
  ],
  inputSchema: ApproveInput,
  category: "tenant_write",
  async execute(ctx, args: z.infer<typeof ApproveInput>): Promise<ToolResult> {
    const result = await approveDiscoveryArtifact(
      {
        tenant_id: ctx.tenant_id,
        artifact_id: args.id,
        actor_id: ctx.actor_id,
      },
      ctx.db,
    );
    if (!result) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: "already_materialized",
            message: "artifact not in `proposed` status (may be missing or already resolved)",
          },
        },
      };
    }
    return {
      ok: true,
      data: {
        persistence: "saved" as const,
        resource_type: "discovery_artifact",
        resource_id: args.id,
        materialized_id: result.materialized_id,
        materialized_type: result.materialized_type,
      },
    };
  },
};

export const discoveryTools: ConversationTool[] = [
  listDiscoveryArtifactsTool,
  getDiscoveryArtifactTool,
  approveDiscoveryArtifactTool,
];
