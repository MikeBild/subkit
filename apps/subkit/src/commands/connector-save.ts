import { reportCommandError } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import pc from "picocolors";
import type { CreateConnectorBody, UpdateConnectorBody } from "../engine-client/connectors.ts";
import type { EngineClient } from "../engine-client.ts";
import {
  connectorDisplayName,
  connectorPatchBody,
  connectorPatchDraft,
} from "../lib/connector-patch.ts";
import { renderIntent, renderSummary, renderTaskList } from "../render/index.ts";
import type { ConnectorSummary } from "../render/types.ts";
import { makeClient } from "./command-runtime.ts";
import { credentialHint, parseCredentialFile } from "./connector-credential-file-model.ts";
import {
  type ConnectorCheckOutcome,
  connectorCheckFailure,
  connectorCheckPlan,
} from "./connector-save-model.ts";
import { readDefinitionFile } from "./definition-file.ts";

type ConnectorSavePlan =
  | { action: "create"; body: CreateConnectorBody; draft: () => CreateConnectorBody; name: string }
  | {
      action: "patch";
      id: string;
      body: UpdateConnectorBody;
      draft: () => CreateConnectorBody;
      name: string;
    };

async function connectorSavePlan(
  client: EngineClient,
  target: { action: "create" } | { action: "patch"; id: string },
  path: string,
): Promise<ConnectorSavePlan> {
  if (target.action === "create") {
    const body = await readDefinitionFile<CreateConnectorBody>(path);
    return { action: "create", body, draft: () => body, name: body.name };
  }
  const file = await readDefinitionFile<UpdateConnectorBody>(path);
  const current = await client.getConnector(target.id);
  const body = connectorPatchBody(current, file);
  return {
    action: "patch",
    id: target.id,
    body,
    draft: () => connectorPatchDraft(current, body),
    name: body.name ?? connectorDisplayName(current),
  };
}

export async function saveConnectorFromFile(
  target: { action: "create" } | { action: "patch"; id: string },
  args: Record<string, unknown>,
): Promise<void> {
  const client = makeClient();
  const jsonMode = Boolean(args.json);
  try {
    const plan = await connectorSavePlan(client, target, String(args.file));
    const { body, name } = plan;
    const skip = Boolean(args["skip-checks"]);
    const unsavedOutcome: ConnectorCheckOutcome =
      plan.action === "create" ? { created: false } : { updated: false };
    await renderIntent(
      {
        kind: "connector",
        action: plan.action === "patch" ? "Update" : "Create",
        ...(name ? { name } : {}),
        ...(typeof body.template_slug === "string" ? { template_slug: body.template_slug } : {}),
      },
      { jsonMode },
    );

    let probe: ConnectorSummary["probe"];
    if (!skip) {
      const verdict = await client.validateConnectorDraft(plan.draft());
      if (!verdict.ok) {
        const validateDetail = verdict.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ");
        await renderTaskList(
          [
            { id: "validate", label: "Validate", status: "failed", detail: validateDetail },
            { id: "probe", label: "Probe", status: "pending" },
            { id: "save", label: "Save", status: "pending" },
          ],
          { jsonMode },
        );
        if (jsonMode) {
          printJson(
            connectorCheckFailure(unsavedOutcome, "validate", validateDetail, {
              issues: verdict.issues.map(({ path, message }) => ({ path, message })),
            }),
          );
        }
        process.exit(1);
      }

      const checks = connectorCheckPlan(
        plan.action,
        plan.action === "create" ? plan.body.driver : undefined,
        skip,
      );
      if (checks === "defer_mcp_probe") {
        await renderTaskList(
          [
            { id: "validate", label: "Validate", status: "succeeded" },
            {
              id: "probe",
              label: "Probe",
              status: "warning",
              detail:
                "skipped — an mcp connector is probed after it is saved: `subkit connectors probe <id>`",
            },
            { id: "save", label: "Save", status: "pending" },
          ],
          { jsonMode },
        );
      } else if (checks === "probe_draft" && plan.action === "create") {
        const credential = args.credential
          ? parseCredentialFile(await readDefinitionFile<unknown>(String(args.credential)))
          : undefined;
        const result = await client.probeConnectorDraft({
          connector: plan.body,
          ...(credential ? { credential } : {}),
        });
        probe = { ok: result.ok };
        if (!result.ok) {
          const probeDetail = result.detail ?? result.error_code ?? "probe returned not-ok";
          await renderTaskList(
            [
              { id: "validate", label: "Validate", status: "succeeded" },
              {
                id: "probe",
                label: "Probe",
                status: "failed",
                detail: credentialHint(result) ?? probeDetail,
              },
              { id: "save", label: "Save", status: "pending" },
            ],
            { jsonMode },
          );
          if (jsonMode) {
            printJson(
              connectorCheckFailure(unsavedOutcome, "probe", probeDetail, { probe: result }),
            );
          }
          process.exit(64);
        }
      }
    } else if (!jsonMode) {
      process.stderr.write(
        `${pc.yellow("warning:")} --skip-checks active; no validate or probe was run\n`,
      );
    }

    const saved =
      plan.action === "create"
        ? await client.createConnector(plan.body)
        : await client.patchConnector(plan.id, plan.body);
    printJson(saved);

    await renderSummary(
      {
        kind: "connector",
        action: plan.action === "patch" ? "Updated" : "Created",
        id: saved.id,
        slug: saved.slug,
        ...(typeof saved.template_slug === "string" ? { template_slug: saved.template_slug } : {}),
        ...(probe ? { probe } : {}),
      },
      { jsonMode },
    );

    if (!jsonMode) {
      const next = saved.auth_type.startsWith("oauth")
        ? `subkit auth --connector-id ${saved.id}`
        : `subkit connectors get ${saved.id}`;
      process.stderr.write(`\n${pc.dim("Next:")} ${next}\n`);
    }
  } catch (err) {
    reportCommandError(err, { json: jsonMode });
  }
}
