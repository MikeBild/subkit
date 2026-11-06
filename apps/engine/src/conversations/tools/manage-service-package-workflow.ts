import { z } from "@hono/zod-openapi";
import { getConnector } from "../../connectors/service.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { loadWorkflowHead } from "../../workflows/lookup.ts";
import { updateWorkflowMetadata } from "../../workflows/service.ts";
import { findPackageWorkflowProvenance } from "../../workflows/service-package-provenance.ts";
import type { ConversationTool, ToolContext } from "./index.ts";
import { checkToolPermission } from "./permission-gate.ts";
import { prepareServicePackageWorkflowTool } from "./prepare-service-package-workflow.ts";

const inputSchema = z
  .object({
    action: z.enum(["update", "archive"]),
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid(),
    expected_version: z.number().int().positive(),
  })
  .openapi("ManageServicePackageWorkflowInput");

function message(
  ctx: ToolContext,
  key:
    | "archived"
    | "archive_failed"
    | "changed"
    | "connector_denied"
    | "missing"
    | "local_changes"
    | "not_managed",
) {
  const copy = {
    archived: ["The service workflow was archived.", "Der Dienstablauf wurde archiviert."],
    archive_failed: [
      "The service workflow couldn't be archived. Nothing was changed.",
      "Der Dienstablauf konnte nicht archiviert werden. Es wurde nichts geändert.",
    ],
    connector_denied: [
      "You don't have access to the service connection behind this workflow.",
      "Du hast keinen Zugriff auf die Verbindung, zu der dieser Ablauf gehört.",
    ],
    changed: [
      "This workflow changed since it was reviewed. Read it again before continuing.",
      "Dieser Ablauf wurde seit der Prüfung geändert. Lies ihn erneut, bevor du fortfährst.",
    ],
    missing: [
      "I couldn't find the saved workflow to manage.",
      "Den gespeicherten Ablauf konnte ich nicht finden.",
    ],
    local_changes: [
      "Someone changed this workflow locally. I left it unchanged.",
      "Dieser Ablauf wurde lokal geändert und bleibt unverändert.",
    ],
    not_managed: [
      "This workflow isn't an unchanged copy from the selected service, so I left it alone.",
      "Dieser Ablauf ist keine unveränderte Vorlage des ausgewählten Dienstes und bleibt unangetastet.",
    ],
  } as const;
  return ctx.locale === "en" ? copy[key][0] : copy[key][1];
}

export const manageServicePackageWorkflowTool: ConversationTool = {
  name: "manage_service_package_workflow",
  description:
    "Prepare an update or archive an unchanged workflow from an optional HTTP service package. Updates remain inactive drafts for the normal review flow. Local changes and unrelated workflows are preserved.",
  use_case: "Update or remove a workflow installed from a self-describing service package.",
  important_notes: [
    "Only a signed-in person can manage these workflows.",
    "Updates use the package's verified definition and still require the normal workflow review and activation steps.",
    "Archiving is allowed only when the saved workflow still matches the installed package version.",
  ],
  inputSchema,
  category: "tenant_write",
  chat_only: true,
  permission: {
    action: "workflow:write",
    resourceType: "workflow",
    resourceIdArg: "workflow_id",
  },
  async execute(ctx, rawArgs) {
    const args = inputSchema.parse(rawArgs);
    if (ctx.principal?.kind !== "user" || ctx.principal.auth_source?.kind !== "browser_session") {
      return {
        ok: false,
        error_code: "user_confirmation_required",
        message:
          ctx.locale === "en"
            ? "A signed-in person must approve this change."
            : "Eine angemeldete Person muss diese Änderung freigeben.",
      };
    }
    const loaded = await loadWorkflowHead(ctx.db, ctx.tenant_id, args.workflow_id);
    if (!loaded) {
      return {
        ok: false,
        error_code: "workflow_not_found",
        message: message(ctx, "missing"),
      };
    }
    const { workflow, head, head_version_id: headVersionId } = loaded;
    if (!head || head.version !== args.expected_version) {
      return {
        ok: false,
        error_code: "service_package_workflow_version_changed",
        message: message(ctx, "changed"),
        data: { workflow_id: workflow.id, current_version: head?.version ?? null },
        next_best_actions: ["get_workflow", "manage_service_package_workflow"],
      };
    }
    const provenance = await findPackageWorkflowProvenance(
      ctx.db,
      ctx.tenant_id,
      workflow.id,
      (source) =>
        source.workflow_slug === workflow.slug &&
        (args.connector_id === undefined || source.connector_id === args.connector_id),
    );
    if (!provenance) {
      return {
        ok: false,
        error_code: "service_package_workflow_not_managed",
        message: message(ctx, "not_managed"),
        data: { workflow_id: workflow.id },
      };
    }
    const connectorAccess = await checkToolPermission(
      ctx,
      { action: "connector:read", resourceType: "connector", resourceIdArg: "connector_id" },
      { connector_id: provenance.connector_id },
    );
    if (!connectorAccess.allow) {
      return {
        ok: false,
        error_code: "permission_denied",
        message: message(ctx, "connector_denied"),
        data: { permission: connectorAccess.permission, reason: connectorAccess.reason },
      };
    }
    if (args.action === "update") {
      return await prepareServicePackageWorkflowTool.execute(ctx, {
        action: "update",
        connector_id: provenance.connector_id,
        prefix: provenance.prefix,
        workflow_slug: workflow.slug,
        expected_version: head.version,
      });
    }
    const connector = await getConnector(ctx.tenant_id, provenance.connector_id, ctx.db);
    if (connector?.driver !== "http") {
      return {
        ok: false,
        error_code: "service_package_workflow_not_managed",
        message: message(ctx, "not_managed"),
        data: { workflow_id: workflow.id },
      };
    }
    if (workflowJsonDigest(head.dag) !== provenance.installed_hash) {
      return {
        ok: false,
        error_code: "service_package_workflow_local_changes",
        message: message(ctx, "local_changes"),
        data: { workflow_id: workflow.id, current_version: head.version },
        next_best_actions: ["get_workflow", "open_workflow_draft"],
      };
    }
    if (workflow.lifecycle === "archived") {
      return {
        ok: true,
        data: {
          workflow_id: workflow.id,
          version: head.version,
          lifecycle: "archived",
          message:
            ctx.locale === "en"
              ? "This service workflow is already archived."
              : "Dieser Dienstablauf ist bereits archiviert.",
        },
      };
    }
    const archived = await updateWorkflowMetadata(
      {
        tenant_id: ctx.tenant_id,
        id: workflow.id,
        lifecycle: "archived",
        ...(headVersionId ? { expected_head_version_id: headVersionId } : {}),
        actor_id: ctx.principal.id,
        actor_type: "user",
      },
      ctx.db,
    );
    if (!archived.workflow) {
      const after = await loadWorkflowHead(ctx.db, ctx.tenant_id, workflow.id);
      const changed = (after ? after.head_version_id : undefined) !== headVersionId;
      return changed
        ? {
            ok: false,
            error_code: "service_package_workflow_version_changed",
            message: message(ctx, "changed"),
            data: { workflow_id: workflow.id },
            next_best_actions: ["get_workflow", "manage_service_package_workflow"],
          }
        : {
            ok: false,
            error_code: "workflow_archive_failed",
            message: message(ctx, "archive_failed"),
            data: { workflow_id: workflow.id, errors: archived.errors },
          };
    }
    return {
      ok: true,
      data: {
        workflow_id: workflow.id,
        version: head.version,
        lifecycle: archived.workflow.lifecycle,
        message: message(ctx, "archived"),
      },
    };
  },
};
