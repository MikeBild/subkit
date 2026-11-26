import { reportCommandError } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import pc from "picocolors";
import type { EngineClient, RunExecutionResponse } from "../engine-client.ts";
import { hookApprovalNoticeFor } from "../lib/hook-approval.ts";
import {
  createBodyFor,
  parseBinds,
  recipeWorkflowSource,
  SOLUTIONS_VERTICAL,
  templateRecipeRef,
  templateRecipeWorkflowSource,
  type WorkflowSource,
} from "../lib/recipe-source.ts";
import {
  environmentMismatchHint,
  invalidRunEnvironmentMessage,
  parseRunEnvironment,
} from "../lib/run-environment.ts";
import { formatAutomationReadiness } from "../render/automation-readiness.ts";
import { renderIntent, renderSummary, renderTaskList } from "../render/index.ts";
import type { PlanStep, WorkflowSummary } from "../render/types.ts";
import { makeClient } from "./command-runtime.ts";

import { intentFromBody, workflowDefinition } from "./workflow-file-model.ts";
import { previewWarningDetail } from "./workflow-save-model.ts";

async function loadWorkflowSource(
  client: EngineClient,
  args: Record<string, unknown>,
): Promise<WorkflowSource> {
  if (args["from-recipe"]) {
    const binds = parseBinds(args.bind);
    const reference = String(args["from-recipe"]);
    const templateRef = templateRecipeRef(reference);
    const knownConnectors = async () =>
      (await client.listConnectors({ limit: 1000 })).items.map((item) => ({
        id: String(item.id),
        slug: String(item.slug),
        template_slug: typeof item.template_slug === "string" ? item.template_slug : null,
      }));
    if (templateRef) {
      const recipe = await client.getConnectorTemplateRecipe(
        templateRef.template,
        templateRef.recipe,
      );
      const connectors =
        (recipe.required_connectors ?? []).length > 0 ? await knownConnectors() : [];
      return templateRecipeWorkflowSource(templateRef.template, recipe, binds, connectors);
    }
    const [pack, connectors] = await Promise.all([
      client.getRecipePack(SOLUTIONS_VERTICAL),
      Object.keys(binds).length > 0 ? knownConnectors() : Promise.resolve([]),
    ]);
    return recipeWorkflowSource(pack, reference, binds, connectors);
  }
  const { readFileSync } = await import("node:fs");
  return {
    body: JSON.parse(readFileSync(String(args.file), "utf8")) as Record<string, unknown>,
    previewInput: undefined,
    recipe: null,
  };
}

export async function saveWorkflow(
  target: { kind: "create" } | { kind: "update"; id: string },
  args: Record<string, unknown>,
): Promise<void> {
  const client = makeClient();
  const jsonMode = Boolean(args.json);
  try {
    {
      const source = await loadWorkflowSource(client, args);
      let body = workflowDefinition(source.body);
      const skip = Boolean(args["skip-checks"]);
      const intent = intentFromBody(body);
      intent.action = target.kind === "create" ? "Create" : "Update";
      await renderIntent(intent, { jsonMode });

      let previewExecutionId: string | undefined;
      let explicitInput: unknown;
      if (args.input) {
        try {
          explicitInput = JSON.parse(args.input as string);
        } catch {
          process.stderr.write("invalid JSON for --input\n");
          process.exit(1);
        }
      }

      if (target.kind === "create") {
        body = workflowDefinition(createBodyFor(source, explicitInput));
      }

      if (!skip) {
        const validation = await client.validateWorkflowDraft(body);
        if (!validation.ok) {
          const firstErr = (validation.errors ?? [])[0];
          const detail = firstErr ? `${firstErr.path}: ${firstErr.message}` : "validation failed";
          const phases: PlanStep[] = [
            { id: "validate", label: "Validate", status: "failed", detail },
            { id: "preview", label: "Preview", status: "pending" },
            { id: "save", label: "Save", status: "pending" },
          ];
          await renderTaskList(phases, { jsonMode });
          process.exit(1);
        }

        const input: unknown = args.input ? explicitInput : source.previewInput;

        const environment = parseRunEnvironment(args.environment);
        if (!environment) {
          process.stderr.write(`${invalidRunEnvironmentMessage(args.environment)}\n`);
          process.exit(1);
        }
        const preview: RunExecutionResponse = await client.runExecution(
          {
            source: "draft",
            definition: body,
            ...(input !== undefined ? { input } : {}),
            request_source: "cli",
          },
          { environment },
        );

        const previewWarnings = (preview.warnings ?? []) as ReadonlyArray<{
          step_key?: string;
          code?: string;
          message?: string;
        }>;

        if (preview.status !== "succeeded") {
          const phases: PlanStep[] = [
            { id: "validate", label: "Validate", status: "succeeded" },
            {
              id: "preview",
              label: "Preview",
              status: "failed",
              detail: `status=${preview.status}`,
            },
            { id: "save", label: "Save", status: "pending" },
          ];
          await renderTaskList(phases, { jsonMode });
          const mismatchHint = environmentMismatchHint(preview, environment);
          if (mismatchHint && !jsonMode) process.stderr.write(`${mismatchHint}\n`);
          process.exit(1);
        }

        if (previewWarnings.length > 0) {
          const phases: PlanStep[] = [
            { id: "validate", label: "Validate", status: "succeeded" },
            {
              id: "preview",
              label: "Preview",
              status: "warning",
              detail: previewWarningDetail(previewWarnings),
            },
            { id: "save", label: "Save", status: "pending" },
          ];
          await renderTaskList(phases, { jsonMode });
        }

        previewExecutionId = preview.execution_id;
      } else if (!jsonMode) {
        process.stderr.write(
          `${pc.yellow("warning:")} --skip-checks active; no validate or preview was run\n`,
        );
      }

      const created = await (target.kind === "create"
        ? client.createWorkflow(body)
        : client.updateWorkflow(target.id, body));
      printJson(created);

      const summary: WorkflowSummary = {
        kind: "workflow",
        id: created.id ?? "(unknown)",
        version: created.current_version ?? 1,
        name: created.name ?? intent.name,
        trigger: intent.trigger,
        action: target.kind === "create" ? "Created" : "Updated",
        ...(previewExecutionId ? { preview_execution_id: previewExecutionId } : {}),
      };
      await renderSummary(summary, { jsonMode });
      if (!jsonMode) process.stderr.write(formatAutomationReadiness(created.automation_readiness));
      if (!jsonMode && target.kind === "create" && intent.trigger?.kind === "webhook" && created.id)
        process.stderr.write(await hookApprovalNoticeFor(client, created.id));

      if (!jsonMode && summary.id !== "(unknown)") {
        process.stderr.write(
          `\n${pc.dim("Next:")} subkit workflows run ${summary.id} --follow\n` +
            `${pc.dim("Tip:")} subkit workflows invoke-snippet ${summary.id} --lang node\n`,
        );
      }
    }
  } catch (err) {
    reportCommandError(err, { json: jsonMode });
  }
}
