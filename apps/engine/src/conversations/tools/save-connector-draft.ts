import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { createConnector } from "../../connectors/service.ts";
import { conversations } from "../../db/schema/index.ts";
import { analyzeConversationAttachments } from "../../llm/flows/analyze-conversation-attachments.ts";
import { logger } from "../../logging/logger.ts";
import { withConnectorPersisted, withConnectorValidation } from "../authoring-state.ts";
import { toCreateConnectorInput, validateConnectorDraft } from "../connector-draft.ts";
import {
  buildGateError,
  buildPersistencePayload,
  missingFreshCheckpoints,
} from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("SaveConnectorDraftToolInput");

export const saveConnectorDraftTool: ConversationTool = {
  name: "save_connector_draft",
  description:
    "Persist the current connector draft as a real connector after validation and probing. Use this only when the draft is ready to save.",
  inputSchema,
  category: "tenant_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    inputSchema.parse(rawArgs);
    const draft = ctx.getDraft();
    const connector = draft.connector;
    const validation = validateConnectorDraft(connector ?? null);
    if (!connector) {
      return {
        ok: false,
        data: buildGateError(draft, {
          error_code: "connector_missing",
          message: "start a connector draft before saving it",
          recommended_mode: "connector",
        }),
      };
    }
    if (!validation.ok) {
      const nextDraft = withConnectorValidation(
        draft,
        { ...connector, validation },
        false,
        "Connector draft is invalid and cannot be persisted yet.",
        "connector_save_blocked",
      );
      await ctx.setDraft(nextDraft);
      return {
        ok: false,
        data: buildGateError(nextDraft, {
          error_code: "validation_failed",
          message: "connector draft is invalid",
          stale_checkpoints: ["connector_validated"],
          recommended_mode: "connector",
          extra: {
            validation,
          },
        }),
      };
    }
    const staleCheckpoints = missingFreshCheckpoints(draft, [
      "connector_inspected",
      "connector_validated",
      "connector_probed",
    ]);
    const requiresProbe =
      connector.driver === "http" ||
      connector.driver === "graphql" ||
      connector.driver === "postgres" ||
      connector.driver === "s3";
    const blocking_reasons = [
      ...(draft.summary?.blocked_by ?? []).filter(
        (reason) =>
          reason === "inspect_connector_draft" ||
          reason === "validate_connector_draft" ||
          reason === "probe_connector_draft" ||
          reason.startsWith("missing:"),
      ),
    ];
    if (
      staleCheckpoints.length > 0 ||
      (requiresProbe && connector.latest_probe?.ok !== true) ||
      blocking_reasons.some((reason) => reason.startsWith("missing:"))
    ) {
      return {
        ok: false,
        data: buildGateError(draft, {
          error_code: "connector_not_ready",
          message: "connector save is blocked until inspection, validation, and probe are fresh",
          stale_checkpoints: staleCheckpoints,
          blocking_reasons,
          recommended_mode: "connector",
          extra: {
            validation,
            latest_probe: connector.latest_probe ?? null,
          },
        }),
      };
    }
    if (requiresProbe && connector.latest_probe?.ok !== true) {
      return {
        ok: false,
        data: buildGateError(draft, {
          error_code: "connector_not_ready",
          message: "probe the connector draft successfully before saving it",
          stale_checkpoints: ["connector_probed"],
          recommended_mode: "connector",
          extra: {
            latest_probe: connector.latest_probe ?? null,
          },
        }),
      };
    }
    const saved = await createConnector(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.actor_id,
        input: toCreateConnectorInput(connector),
      },
      ctx.db,
    );
    await ctx.db
      .update(conversations)
      .set({
        target_connector_id: saved.id,
        updated_at: new Date(),
      })
      .where(eq(conversations.id, ctx.conversation_id));

    // Attachment-driven endpoint extraction. Best-effort: failures here
    // never block the save — the connector is already persisted, and a
    // missing endpoint registry is recoverable from a later analyse step.
    let analysis: { source_format: string; confidence: number; endpoint_count: number } | null =
      null;
    try {
      const result = await analyzeConversationAttachments({
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        db: ctx.db,
        connector_id: saved.id,
      });
      if (result) {
        analysis = {
          source_format: result.source_format,
          confidence: result.confidence,
          endpoint_count: result.endpoints.length,
        };
      }
    } catch (err) {
      logger.warn({
        module: "save-connector-draft",
        action: "document_analysis_failed",
        tenant_id: ctx.tenant_id,
        connector_id: saved.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const nextDraft = withConnectorPersisted(
      draft,
      {
        ...connector,
        validation,
        saved_connector_id: saved.id,
      },
      {
        kind: "connector",
        id: saved.id,
        slug: saved.slug,
        name: saved.display_name,
        version_id: null,
        version: null,
        environment: saved.environment,
        saved_at: new Date().toISOString(),
      },
      "connector_saved",
    );
    await ctx.setDraft(nextDraft);
    return {
      ok: true,
      data: {
        ...buildPersistencePayload(nextDraft, {
          resource_kind: "connector",
          resource_id: saved.id,
        }),
        connector: {
          id: saved.id,
          slug: saved.slug,
          display_name: saved.display_name,
          environment: saved.environment,
          driver: saved.driver,
        },
        ...(analysis ? { document_analysis: analysis } : {}),
      },
    };
  },
};
