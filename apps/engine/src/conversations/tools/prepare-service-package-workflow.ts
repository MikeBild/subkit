import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { getConnector } from "../../connectors/service.ts";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { prepareWorkflowSave } from "../../workflows/prepare-save.ts";
import { annotateRuntime } from "../../workflows/runtime-annotation.ts";
import { findPackageWorkflowProvenance } from "../../workflows/service-package-provenance.ts";
import { WORKFLOW_DEF_FIELD_KEYS, WorkflowDefSchema } from "../../workflows/types.ts";
import {
  hasInProgressWorkflowDraft,
  startNewWorkflowDraft,
  withWorkflowDraft,
} from "../authoring-state.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { fetchServicePackage } from "./fetch-connector-self-description.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { openWorkflowDraftTool, resolveSavedWorkflow } from "./open-workflow-draft.ts";
import { checkToolPermission } from "./permission-gate.ts";

const inputSchema = z
  .object({
    connector_id: z.string().uuid().optional(),
    action: z.enum(["install", "update"]).default("install"),
    workflow_slug: z.string().min(1).max(128),
    expected_version: z.number().int().positive().optional(),
    prefix: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
  })
  .refine((input) => input.action !== "update" || input.expected_version !== undefined, {
    message: "updates require the version that was reviewed",
  })
  .openapi("PrepareServicePackageWorkflowToolInput");

function userMessage(ctx: ToolContext, english: string, german: string) {
  return ctx.locale === "en" ? english : german;
}

export const prepareServicePackageWorkflowTool: ConversationTool = {
  name: "prepare_service_package_workflow",
  description:
    "When the user asks to set up or update an optional service workflow, prepare its verified definition as a draft for review. Explain simply that the setup is prepared but not switched on yet; keep technical package and validation details in expandable details. This never activates it or grants execution rights. Then follow the normal review flow.",
  use_case:
    "Set up an optional integration published by an HTTP connector when the user asks to install one of its workflows.",
  requires_skill: "workflow-authoring",
  important_notes: [
    "The workflow package must be same-origin, checksum-verified, schema-valid, and bind every request to the selected tenant connector.",
    "An existing unsaved draft is never overwritten. Installation never replaces a saved workflow. Updates require the exact reviewed version, package provenance and an unchanged saved definition.",
    "The result is only an in-memory draft. Inspect and validate it, preview it when allowed, then save it as an inactive version through the existing human review flow.",
  ],
  inputSchema,
  category: "draft_write",
  authoring_resource: "workflow",
  permission: {
    action: "workflow:write",
    resourceType: "workflow",
    resolveResourceId: async () => "*",
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connector_id = args.connector_id ?? ctx.connector_id ?? undefined;
    if (!connector_id) {
      return {
        ok: false,
        error_code: "no_connector_in_scope",
        message: userMessage(
          ctx,
          "Choose the service connection you want to set up first.",
          "Wähle zuerst die Verbindung aus, die du einrichten möchtest.",
        ),
        next_best_actions: ["find_connector", "list_connectors"],
        data: {},
      };
    }
    if (
      args.action === "update" &&
      (ctx.principal?.kind !== "user" || ctx.principal.auth_source?.kind !== "browser_session")
    ) {
      return {
        ok: false,
        error_code: "user_confirmation_required",
        message: userMessage(
          ctx,
          "A signed-in person must approve this update.",
          "Eine angemeldete Person muss dieses Update freigeben.",
        ),
      };
    }
    const current = ctx.getDraft();
    if (ctx.workflow_id && args.action !== "update" && !hasInProgressWorkflowDraft(current)) {
      return {
        ok: false,
        error_code: "conversation_bound_to_workflow",
        message: userMessage(
          ctx,
          "This conversation belongs to the setup it already saved. Start a new conversation for the next part.",
          "Diese Unterhaltung gehört zu der Einrichtung, die sie bereits gespeichert hat. Starte für den nächsten Teil eine neue Unterhaltung.",
        ),
        next_best_actions: [],
        data: { bound_workflow_id: ctx.workflow_id, current_slug: current.workflow.slug ?? null },
      };
    }
    if (hasInProgressWorkflowDraft(current)) {
      return {
        ok: false,
        error_code: "workflow_draft_in_progress",
        message: userMessage(
          ctx,
          "Finish reviewing the current setup first. Then I can prepare the next part.",
          "Schließe zuerst die aktuelle Einrichtung ab. Danach kann ich den nächsten Teil vorbereiten.",
        ),
        next_best_actions: ["inspect_workflow_draft", "save_workflow_draft"],
        data: { current_slug: current.workflow.slug ?? null },
      };
    }
    const connector = await getConnector(ctx.tenant_id, connector_id, ctx.db);
    if (!connector) {
      return {
        ok: false,
        error_code: "connector_not_found",
        message: userMessage(
          ctx,
          "That service connection is no longer available. Choose another connection and try again.",
          "Diese Verbindung ist nicht mehr verfügbar. Wähle eine andere Verbindung und versuche es erneut.",
        ),
        next_best_actions: ["list_connectors", "get_connector"],
        data: { connector_id },
      };
    }
    const connectorAccess = await checkToolPermission(
      ctx,
      { action: "connector:read", resourceType: "connector", resourceIdArg: "connector_id" },
      { connector_id: connector.id },
    );
    if (!connectorAccess.allow) {
      return {
        ok: false,
        error_code: "permission_denied",
        message: userMessage(
          ctx,
          "You don't have access to this service connection.",
          "Du hast keinen Zugriff auf diese Verbindung.",
        ),
        data: { permission: connectorAccess.permission, reason: connectorAccess.reason },
      };
    }
    const preview = await fetchServicePackage(ctx, connector, args.prefix);
    if (!preview.ok) return preview;
    const data = preview.data as {
      package: { id: string; version: string };
      prefix: string;
      artifacts: Array<{ name: string; body: string; sha256: string }>;
    };
    const artifact = data.artifacts.find((item) => item.name === "workflows");
    if (!artifact) {
      return {
        ok: false,
        error_code: "package_has_no_workflows",
        message: userMessage(
          ctx,
          "This service does not currently offer setup steps here.",
          "Dieser Dienst bietet hier zurzeit keine Einrichtungsschritte an.",
        ),
        data: { package: data.package },
      };
    }
    let envelope: { workflows?: unknown[] };
    try {
      envelope = JSON.parse(artifact.body) as { workflows?: unknown[] };
    } catch {
      return {
        ok: false,
        error_code: "package_workflow_artifact_invalid",
        message: userMessage(
          ctx,
          "This service setup could not be read. Nothing was changed.",
          "Diese Einrichtung ließ sich nicht lesen. Es wurde nichts geändert.",
        ),
        data: { package: data.package },
      };
    }
    const candidate = envelope.workflows?.find(
      (workflow) =>
        workflow &&
        typeof workflow === "object" &&
        "slug" in workflow &&
        workflow.slug === args.workflow_slug,
    );
    if (!candidate || typeof candidate !== "object") {
      return {
        ok: false,
        error_code: "package_workflow_not_found",
        message: userMessage(
          ctx,
          "I couldn't find that part of the service setup.",
          "Diesen Teil der Einrichtung konnte ich beim Dienst nicht finden.",
        ),
        data: {
          package: data.package,
          available_workflows: envelope.workflows
            ?.filter((workflow): workflow is Record<string, unknown> =>
              Boolean(workflow && typeof workflow === "object"),
            )
            .map((workflow) => workflow.slug)
            .filter((slug): slug is string => typeof slug === "string"),
        },
      };
    }
    const parsedCandidate = WorkflowDefSchema.safeParse(candidate);
    if (!parsedCandidate.success) {
      return {
        ok: false,
        error_code: "package_workflow_artifact_invalid",
        message: userMessage(
          ctx,
          "This service setup could not be checked. Nothing was changed.",
          "Diese Einrichtung ließ sich nicht prüfen. Es wurde nichts geändert.",
        ),
        data: { package: data.package },
      };
    }
    const validation = await prepareWorkflowSave(parsedCandidate.data, ctx.tenant_id, ctx.db, {
      destinationTier: "tokens",
    });
    if (!validation.ok) {
      return {
        ok: false,
        error_code: "package_workflow_not_ready",
        message: userMessage(
          ctx,
          "This service setup needs a change before it can be reviewed. Nothing was saved.",
          "Diese Einrichtung muss vor der Prüfung angepasst werden. Es wurde nichts gespeichert.",
        ),
        data: {
          package: data.package,
          workflow_slug: args.workflow_slug,
          issues: validation.issues,
        },
      };
    }
    const packageDefinitionHash = workflowJsonDigest(annotateRuntime(validation.workflow));
    const existing = await resolveSavedWorkflow(ctx, args.workflow_slug);
    let updateExisting = false;
    if (args.action === "update" && !existing) {
      return {
        ok: false,
        error_code: "service_package_workflow_not_found",
        message: userMessage(
          ctx,
          "I couldn't find the saved service workflow to update.",
          "Den gespeicherten Dienstablauf für das Update konnte ich nicht finden.",
        ),
        next_best_actions: ["list_workflows"],
      };
    }
    if (existing) {
      const [workflowHead] = await ctx.db
        .select({
          draft_version_id: workflows.draft_version_id,
          current_version_id: workflows.current_version_id,
        })
        .from(workflows)
        .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, existing.id)))
        .limit(1);
      const savedVersionId = workflowHead?.draft_version_id ?? workflowHead?.current_version_id;
      const [saved] = savedVersionId
        ? await ctx.db
            .select({ dag: workflowVersions.dag, version: workflowVersions.version })
            .from(workflowVersions)
            .where(
              and(
                eq(workflowVersions.tenant_id, ctx.tenant_id),
                eq(workflowVersions.workflow_id, existing.id),
                eq(workflowVersions.id, savedVersionId),
              ),
            )
            .limit(1)
        : [];
      if (args.action === "update") {
        const provenance = await findPackageWorkflowProvenance(
          ctx.db,
          ctx.tenant_id,
          existing.id,
          (source) =>
            source.package_id === data.package.id &&
            source.connector_id === connector.id &&
            source.workflow_slug === existing.slug,
        );
        if (!provenance) {
          return {
            ok: false,
            error_code: "service_package_workflow_not_managed",
            message: userMessage(
              ctx,
              "This workflow wasn't set up from this service package, so I left it alone. You can set up the service version separately and archive this one after reviewing it.",
              "Dieser Ablauf wurde nicht aus diesem Dienstpaket eingerichtet und bleibt daher unangetastet. Du kannst die Dienstversion separat einrichten und diesen Ablauf nach Prüfung archivieren.",
            ),
            data: { workflow_id: existing.id },
          };
        }
        if (!saved || saved.version !== args.expected_version) {
          return {
            ok: false,
            error_code: "service_package_workflow_version_changed",
            message: userMessage(
              ctx,
              "This workflow changed since it was reviewed. Read it again before updating.",
              "Dieser Ablauf wurde seit der Prüfung geändert. Lies ihn erneut, bevor du ihn aktualisierst.",
            ),
            data: { workflow_id: existing.id, current_version: saved?.version ?? null },
            next_best_actions: ["get_workflow", "prepare_service_package_workflow"],
          };
        }
        if (workflowJsonDigest(saved.dag) !== provenance.installed_hash) {
          return {
            ok: false,
            error_code: "service_package_workflow_local_changes",
            message: userMessage(
              ctx,
              "Someone changed this workflow locally. The service update was not applied.",
              "Dieser Ablauf wurde lokal geändert. Das Dienstupdate wurde nicht übernommen.",
            ),
            data: { workflow_id: existing.id, current_version: saved.version },
            next_best_actions: ["get_workflow", "open_workflow_draft"],
          };
        }
        if (provenance.installed_hash === packageDefinitionHash) {
          return {
            ok: true,
            data: {
              workflow: { name: existing.name, slug: existing.slug },
              workflow_id: existing.id,
              version: saved.version,
              package: data.package,
              install_state: "already_current",
              review_required: false,
              next_best_actions: ["get_workflow"],
            },
          };
        }
        updateExisting = true;
      } else if (saved && workflowJsonDigest(saved.dag) === packageDefinitionHash) {
        return {
          ok: true,
          data: {
            workflow: { name: existing.name, slug: existing.slug },
            workflow_id: existing.id,
            version: saved.version,
            package: data.package,
            install_state: "already_matches_package",
            review_required: false,
            next_best_actions: ["get_workflow"],
          },
        };
      }
      if (!updateExisting) {
        return {
          ok: false,
          error_code: "workflow_already_exists",
          message: userMessage(
            ctx,
            "A workflow with this setup name already exists and differs from the service copy. It was left unchanged.",
            "Ein Ablauf mit diesem Einrichtungsnamen ist bereits vorhanden und unterscheidet sich von der Dienstvorlage. Er blieb unverändert.",
          ),
          next_best_actions: ["open_workflow_draft", "get_workflow"],
          data: { workflow_id: existing.id, slug: existing.slug },
        };
      }
    }
    const definition: Record<string, unknown> = {};
    const validated = parsedCandidate.data as Record<string, unknown>;
    for (const key of WORKFLOW_DEF_FIELD_KEYS) {
      if (validated[key] !== undefined) definition[key] = validated[key];
    }
    const rawEdges = (candidate as Record<string, unknown>).edges;
    if (Array.isArray(rawEdges)) definition.edges = rawEdges;
    const workflow = {
      ...definition,
      name: parsedCandidate.data.name,
      slug: args.workflow_slug,
      steps: parsedCandidate.data.steps as Array<Record<string, unknown>>,
      service_package_source: {
        package_id: data.package.id,
        package_version: data.package.version,
        connector_id: connector.id,
        workflow_slug: args.workflow_slug,
        prefix: data.prefix,
        artifact_hash: artifact.sha256,
        definition_hash: packageDefinitionHash,
      },
    } as WorkflowDraftDocument;
    let base = startNewWorkflowDraft(current, "service_package_workflow_prepared");
    if (updateExisting && existing) {
      const opened = await openWorkflowDraftTool.execute(ctx, { workflow: existing.id });
      if (!opened.ok) return opened;
      base = ctx.getDraft();
    }
    const next = withWorkflowDraft(base, workflow, "service_package_workflow_prepared");
    await ctx.setDraft(next);
    return {
      ok: true,
      data: {
        workflow: {
          name: workflow.name,
          slug: workflow.slug,
          step_count: workflow.steps.length,
          input_schema: workflow.input_schema ?? null,
        },
        ...(updateExisting && existing ? { workflow_id: existing.id } : {}),
        package: data.package,
        install_state: updateExisting ? "update_draft" : "inactive_draft",
        review_required: true,
        next_best_actions: [
          "inspect_workflow_draft",
          "validate_draft",
          "dry_run_workflow",
          "save_workflow_draft",
        ],
      },
    };
  },
};
