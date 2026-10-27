import { z } from "@hono/zod-openapi";
import { getConnector } from "../../connectors/service.ts";
import {
  hasInProgressWorkflowDraft,
  startNewWorkflowDraft,
  withWorkflowDraft,
} from "../authoring-state.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { fetchServicePackage } from "./fetch-connector-self-description.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { resolveSavedWorkflow } from "./open-workflow-draft.ts";

const inputSchema = z
  .object({
    connector_id: z.string().uuid().optional(),
    workflow_slug: z.string().min(1).max(128),
    prefix: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
  })
  .openapi("PrepareServicePackageWorkflowToolInput");

function userMessage(ctx: ToolContext, english: string, german: string) {
  return ctx.locale === "en" ? english : german;
}

export const prepareServicePackageWorkflowTool: ConversationTool = {
  name: "prepare_service_package_workflow",
  description:
    "When the user asks to set up an optional service, prepare one verified workflow from its connector as a draft for review. Explain simply that the setup is prepared but not switched on yet; keep technical package and validation details in expandable details. This never activates it or grants execution rights. Then follow the normal review flow.",
  use_case:
    "Set up an optional integration published by an HTTP connector when the user asks to install one of its workflows.",
  requires_skill: "workflow-authoring",
  important_notes: [
    "The workflow package must be same-origin, checksum-verified, schema-valid, and bind every request to the selected tenant connector.",
    "An existing unsaved workflow draft or an existing saved workflow with the requested slug is never overwritten.",
    "The result is only an in-memory draft. Inspect and validate it, preview it when allowed, then save it as an inactive version through the existing human review flow.",
  ],
  inputSchema,
  category: "draft_write",
  authoring_resource: "workflow",
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
    const current = ctx.getDraft();
    if (ctx.workflow_id || hasInProgressWorkflowDraft(current)) {
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
    const existing = await resolveSavedWorkflow(ctx, args.workflow_slug);
    if (existing) {
      return {
        ok: false,
        error_code: "workflow_already_exists",
        message: userMessage(
          ctx,
          "A workflow for this part already exists. Open it to review an update; nothing was replaced.",
          "Für diesen Teil gibt es bereits einen Ablauf. Öffne ihn, um ein Update zu prüfen. Es wurde nichts ersetzt.",
        ),
        next_best_actions: ["open_workflow_draft", "get_workflow"],
        data: { workflow_id: existing.id, slug: existing.slug },
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
    const preview = await fetchServicePackage(ctx, connector, args.prefix);
    if (!preview.ok) return preview;
    const data = preview.data as {
      package: { id: string; version: string };
      artifacts: Array<{ name: string; body: string }>;
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
        message: "the verified workflow artifact could not be read",
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
    const definition = candidate as Record<string, unknown>;
    const workflow: WorkflowDraftDocument = {
      name: String(definition.name),
      slug: String(definition.slug),
      ...(typeof definition.description === "string"
        ? { description: definition.description }
        : {}),
      ...(typeof definition.execution_privacy === "string"
        ? {
            execution_privacy:
              definition.execution_privacy as WorkflowDraftDocument["execution_privacy"],
          }
        : {}),
      steps: definition.steps as Array<Record<string, unknown>>,
      ...(definition.input_schema && typeof definition.input_schema === "object"
        ? { input_schema: definition.input_schema as Record<string, unknown> }
        : {}),
      ...(definition.output_schema && typeof definition.output_schema === "object"
        ? { output_schema: definition.output_schema as Record<string, unknown> }
        : {}),
      ...(Array.isArray(definition.response_filters)
        ? {
            response_filters:
              definition.response_filters as WorkflowDraftDocument["response_filters"],
          }
        : {}),
      ...(typeof definition.timeout_ms === "number" ? { timeout_ms: definition.timeout_ms } : {}),
      ...(Array.isArray(definition.edges)
        ? { edges: definition.edges as NonNullable<WorkflowDraftDocument["edges"]> }
        : {}),
      ...(definition.trigger && typeof definition.trigger === "object"
        ? { trigger: definition.trigger as NonNullable<WorkflowDraftDocument["trigger"]> }
        : {}),
    };
    const next = withWorkflowDraft(
      startNewWorkflowDraft(current, "service_package_workflow_prepared"),
      workflow,
      "service_package_workflow_prepared",
    );
    await ctx.setDraft(next);
    return {
      ok: true,
      data: {
        workflow: { name: workflow.name, slug: workflow.slug, step_count: workflow.steps.length },
        package: data.package,
        install_state: "inactive_draft",
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
