import { classifyHttpSideEffect, type SideEffect } from "@shared/index.ts";
import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import {
  AuditAction,
  type AuditActorType,
  ToolPolicyChangedMetadataSchema,
} from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { conversations } from "../db/schema/index.ts";
import type { PermissionMode, ToolModeRule, ToolPolicies, ToolPolicyMode } from "../tools/types.ts";
import { workflowInputObjectKeys } from "../workflows/run-input.ts";
import { isDangerousTool } from "./dangerous-tools.ts";

export interface ToolPolicyAuditCtx {
  actor_type: AuditActorType;
  actor_id: string | null;
  request_source: "api" | "cli" | "scheduler" | "mcp" | "webhook" | "tool-chain" | "ui";
}

type PolicyCategory = "draft_write" | "tenant_read" | "tenant_write";

const NO_CONFIRM_OVERRIDE_TOOLS = ["save_workflow_draft", "save_connector_draft"] as const;
const noConfirmOverrideTools = new Set<string>(NO_CONFIRM_OVERRIDE_TOOLS);

export function eligibleNoConfirmTools(): string[] {
  return [...NO_CONFIRM_OVERRIDE_TOOLS];
}

function canSetNoConfirmOverride(toolName: string, mode: ToolPolicyMode | null): boolean {
  return mode !== "no_confirm" || noConfirmOverrideTools.has(toolName);
}

export function canSetConversationToolPolicy(
  toolName: string,
  mode: ToolPolicyMode | null,
): boolean {
  return (
    mode === null ||
    mode === "confirm_before_execution" ||
    (mode === "no_confirm" && canSetNoConfirmOverride(toolName, mode))
  );
}

const AUTO_PREPARATION_WRITES: ReadonlyMap<string, PolicyCategory> = new Map([
  ["save_workflow_draft", "draft_write"],
  ["create_knowledge_source", "tenant_write"],
  ["analyze_knowledge_source", "tenant_write"],
  ["export_diagnostic_context", "tenant_write"],
  ["export_tenant_package", "tenant_write"],
]);

export async function getToolPolicies(
  db: Db,
  tenant_id: string,
  conversation_id: string,
): Promise<ToolPolicies> {
  const rows = await db
    .select({ tool_policies: conversations.tool_policies })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .limit(1);
  const raw = (rows[0]?.tool_policies ?? {}) as Record<string, unknown>;
  const out: ToolPolicies = {};
  for (const [k, v] of Object.entries(raw)) {
    if ((v === "no_confirm" && canSetNoConfirmOverride(k, v)) || v === "confirm_before_execution") {
      out[k] = v;
    }
  }
  return out;
}

export async function setToolPolicies(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  policies: Record<string, ToolPolicyMode | null>,
  audit: ToolPolicyAuditCtx,
): Promise<void> {
  for (const [toolName, mode] of Object.entries(policies)) {
    if (!canSetConversationToolPolicy(toolName, mode)) {
      throw new Error(`tool_policy_mode_not_allowed:${toolName}`);
    }
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ tool_policies: conversations.tool_policies })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
      .limit(1)
      .for("update");
    if (!row) return;
    const raw = (row.tool_policies ?? {}) as Record<string, unknown>;
    const next: ToolPolicies = {};
    for (const [k, v] of Object.entries(raw)) {
      if (
        (v === "no_confirm" && canSetNoConfirmOverride(k, v)) ||
        v === "confirm_before_execution"
      ) {
        next[k] = v;
      }
    }
    const changes = Object.entries(policies).map(([toolName, mode]) => ({
      toolName,
      mode,
      priorMode: next[toolName] ?? null,
    }));
    for (const { toolName, mode } of changes) {
      if (mode === null) delete next[toolName];
      else next[toolName] = mode;
    }
    await tx
      .update(conversations)
      .set({ tool_policies: next })
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
    for (const { toolName, mode, priorMode } of changes) {
      const metadata = ToolPolicyChangedMetadataSchema.parse({
        tool: toolName,
        mode: mode ?? null,
        prior_mode: priorMode,
        request_source: audit.request_source,
      });
      await auditAwait(
        {
          tenant_id,
          actor_type: audit.actor_type,
          actor_id: audit.actor_id,
          action: AuditAction.TOOL_POLICY_CHANGED,
          resource_type: "conversation",
          resource_id: conversation_id,
          result: "success",
          metadata,
        },
        tx,
      );
    }
  });
}

export async function setToolPolicy(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  toolName: string,
  mode: ToolPolicyMode | null,
  audit: ToolPolicyAuditCtx,
): Promise<void> {
  await setToolPolicies(db, tenant_id, conversation_id, { [toolName]: mode }, audit);
}

export function effectiveMode(
  toolName: string,
  policies: ToolPolicies,
  defaultMode: ToolPolicyMode,
): ToolPolicyMode {
  const override = policies[toolName];
  return override && canSetConversationToolPolicy(toolName, override) ? override : defaultMode;
}

export function defaultModeForCategory(
  category: "draft_write" | "tenant_read" | "tenant_write",
): ToolPolicyMode {
  return category === "tenant_write" ? "confirm_before_execution" : "no_confirm";
}

interface ToolPolicyDefinition {
  defaultMode?: ToolPolicyMode;
  neverGate?: boolean;
  computeModeFromInput?: (input: unknown) => ToolPolicyMode | null;
  computeDangerFromInput?: (input: unknown) => boolean;
  credentialFields?: ReadonlyArray<string>;
  buildPendingOutput?: (input: unknown) => Record<string, unknown> | null;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readPath(input: unknown, path: string): unknown {
  let cursor: unknown = input;
  for (const segment of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

export function hasInlineCredential(input: unknown, paths: ReadonlyArray<string>): boolean {
  for (const path of paths) {
    if (isNonEmptyString(readPath(input, path))) return true;
  }
  return false;
}

export function buildPendingOutputForTool(
  tool: string,
  input: unknown,
): Record<string, unknown> | null {
  const def = TOOL_POLICIES[tool];
  if (!def?.buildPendingOutput) return null;
  return def.buildPendingOutput(input) ?? null;
}

function pickFields(input: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const obj = asObj(input);
  for (const f of fields) {
    if (obj[f] !== undefined) out[f] = obj[f];
  }
  return out;
}

function callConnectorSideEffect(input: unknown): SideEffect {
  const obj = asObj(input);
  if (typeof obj.sql === "string") {
    return classifyHttpSideEffect({
      override: obj.allow_writes === true ? "write" : null,
      sql: { query: obj.sql },
    });
  }
  const body = asObj(obj.body);
  if (typeof body.query === "string" || typeof body.operation === "string") {
    return classifyHttpSideEffect({
      graphql: {
        operation:
          body.operation === "query" ||
          body.operation === "mutation" ||
          body.operation === "subscription"
            ? body.operation
            : null,
        query: typeof body.query === "string" ? body.query : null,
      },
    });
  }
  const method = typeof obj.method === "string" ? obj.method.toUpperCase() : "GET";
  return classifyHttpSideEffect({ method, s3: method === "LIST" });
}

function forcesWorkflowSave(input: unknown): boolean {
  return asObj(input).force_commit === true;
}

export const TOOL_POLICIES: Readonly<Record<string, ToolPolicyDefinition>> = {
  load_skill: {
    defaultMode: "no_confirm",
    neverGate: true,
  },
  save_learning: {
    defaultMode: "no_confirm",
    neverGate: true,
  },
  propose_workflow_repair: {
    defaultMode: "no_confirm",
    neverGate: true,
  },
  run_workflow: {
    defaultMode: "no_confirm",
    computeModeFromInput: () => "no_confirm",
    buildPendingOutput: (input) => {
      const obj = asObj(input);
      return {
        workflow: obj.workflow ?? null,
        version_id: obj.version_id ?? null,
        environment: obj.environment ?? null,
        ...(obj.input !== undefined ? { input_keys: workflowInputObjectKeys(obj.input) } : {}),
      };
    },
  },
  discard_intake_items: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => {
      const obj = asObj(input);
      const ids = Array.isArray(obj.item_ids) ? obj.item_ids : [];
      return { item_count: ids.length, item_ids: ids };
    },
  },
  restore_intake_item: { computeModeFromInput: () => "no_confirm" },
  move_intake_item: { computeModeFromInput: () => "no_confirm" },
  set_default_intake_category: { computeModeFromInput: () => "no_confirm" },
  create_intake_proposal: { computeModeFromInput: () => "no_confirm" },
  revise_intake_proposal: { computeModeFromInput: () => "no_confirm" },
  approve_patch_candidate: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["candidate_id", "kind", "scope"]),
  },
  approve_skill_candidate: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => {
      const obj = asObj(input);
      const ids = [
        ...new Set([
          ...(Array.isArray(obj.candidate_ids) ? obj.candidate_ids : []),
          ...(obj.candidate_id !== undefined ? [obj.candidate_id] : []),
        ]),
      ];
      return ids.length === 1 && obj.candidate_id !== undefined && obj.candidate_ids === undefined
        ? { candidate_id: obj.candidate_id }
        : { candidate_count: ids.length, candidate_ids: ids };
    },
  },
  reject_skill_candidate: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => {
      const obj = asObj(input);
      const ids = Array.isArray(obj.candidate_ids) ? obj.candidate_ids : [];
      return {
        candidate_count: ids.length,
        candidate_ids: ids,
        ...(obj.reason !== undefined ? { reason: obj.reason } : {}),
      };
    },
  },
  approve_discovery_artifact: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["artifact_id", "kind", "title"]),
  },
  resolve_capability_gap: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["id", "note"]),
  },
  delete_workflow: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["workflow_id", "slug"]),
  },
  delete_connector: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["connector_id", "slug"]),
  },
  delete_knowledge_source: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["knowledge_source_id"]),
  },
  delete_subscription: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["subscription_id"]),
  },
  revoke_api_key: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["api_key_id", "prefix"]),
  },
  revoke_portal_token: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["portal_token_id", "prefix"]),
  },
  update_tenant_branding: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => {
      const obj = asObj(input);
      const logos = asObj(obj.logos);
      const summarize = (theme: "light" | "dark") => {
        const operation = asObj(logos[theme]);
        return {
          operation: operation.operation ?? null,
          ...(operation.operation === "replace"
            ? {
                mime_type: operation.mime_type ?? null,
                content_base64_length:
                  typeof operation.content_base64 === "string"
                    ? operation.content_base64.length
                    : null,
              }
            : {}),
        };
      };
      return {
        revision: obj.revision ?? null,
        display_name: obj.display_name ?? null,
        subtitle: obj.subtitle ?? null,
        palette: obj.palette ?? null,
        logos: { light: summarize("light"), dark: summarize("dark") },
      };
    },
  },
  reset_tenant_branding: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["revision"]),
  },
  test_rbac_expression: { defaultMode: "no_confirm" },
  suggest_connector_templates: { defaultMode: "no_confirm" },
  start_connector_from_template: { defaultMode: "no_confirm" },
  start_connector_from_description: { defaultMode: "no_confirm" },
  inspect_connector_draft: { defaultMode: "no_confirm" },
  update_connector_draft: {
    defaultMode: "no_confirm",
    credentialFields: [
      "config.api_key",
      "config.token",
      "config.access_token",
      "config.auth_value",
      "config.password",
    ],
  },
  validate_connector_draft: { defaultMode: "no_confirm" },
  inspect_workflow_draft: { defaultMode: "no_confirm" },
  inspect_authoring_context: { defaultMode: "no_confirm" },
  export_diagnostic_context: { defaultMode: "no_confirm" },
  export_tenant_package: { defaultMode: "no_confirm" },
  apply_package_import: {
    defaultMode: "confirm_before_execution",
    computeDangerFromInput: () => true,
    buildPendingOutput: (input) => pickFields(input, ["file_id", "expected_plan_digest"]),
  },
  dry_run_step: { defaultMode: "no_confirm" },
  dry_run_transform: { defaultMode: "no_confirm" },
  dry_run_workflow: {
    defaultMode: "no_confirm",
    computeModeFromInput: () => "no_confirm",
  },
  validate_draft: { defaultMode: "no_confirm" },
  save_workflow_draft: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => {
      const obj = asObj(input);
      return {
        kind: "save_workflow_draft",
        ...(obj.workflow_slug !== undefined ? { workflow_slug: obj.workflow_slug } : {}),
        ...(obj.connector_slug !== undefined ? { connector_slug: obj.connector_slug } : {}),
      };
    },
    computeModeFromInput: (input) =>
      forcesWorkflowSave(input) ? "confirm_before_execution" : null,
    computeDangerFromInput: forcesWorkflowSave,
  },
  restore_workflow_version: {
    defaultMode: "confirm_before_execution",
    computeDangerFromInput: () => true,
  },
  author_workflow: { defaultMode: "no_confirm" },
  edit_workflow_patch: { defaultMode: "no_confirm" },
  open_workflow_draft: { defaultMode: "no_confirm" },
  save_connector_draft: {
    defaultMode: "confirm_before_execution",
    computeModeFromInput: (input) => {
      const credential = asObj(input).credential;
      if (credential && typeof credential === "object") {
        return "confirm_before_execution";
      }
      return null;
    },
    buildPendingOutput: (input) => {
      const credential = asObj(input).credential;
      if (credential && typeof credential === "object") {
        const mode = (credential as { mode?: unknown }).mode;
        if (typeof mode === "string") {
          return { kind: "save_connector_draft", credential_mode: mode };
        }
      }
      return { kind: "save_connector_draft" };
    },
  },
  authenticate_oauth: {
    defaultMode: "confirm_after_execution",
    buildPendingOutput: (input) => {
      const connectorId = asObj(input).connector_id;
      return {
        kind: "authenticate_oauth",
        ...(typeof connectorId === "string" ? { connector_id: connectorId } : {}),
      };
    },
  },
  call_connector: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) =>
      callConnectorSideEffect(input) === "write" || asObj(input).response_mode === "full"
        ? "confirm_before_execution"
        : "no_confirm",
    computeDangerFromInput: (input) => callConnectorSideEffect(input) === "write",
  },
  web_search: { defaultMode: "confirm_before_execution" },
  probe_connector: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) => {
      const probe = asObj(input);
      return probe.response_mode === "full" || callConnectorSideEffect(input) === "write"
        ? "confirm_before_execution"
        : "no_confirm";
    },
    computeDangerFromInput: (input) => callConnectorSideEffect(input) === "write",
  },
  probe_connector_draft: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) =>
      asObj(input).response_mode === "full" || callConnectorSideEffect(input) === "write"
        ? "confirm_before_execution"
        : "no_confirm",
  },
};

interface ToolModeDecision {
  mode: ToolPolicyMode;
  rule: ToolModeRule;
}

export function decideToolMode(args: {
  tool: string;
  category: "draft_write" | "tenant_read" | "tenant_write";
  input: unknown;
  overrides: ToolPolicies;
  permission_mode?: PermissionMode | null;
  connector_trust?: boolean;
  execution_data_transfer?: boolean;
}): ToolModeDecision {
  const { tool, category, input, overrides, permission_mode } = args;

  const def = TOOL_POLICIES[tool];
  const isDangerous = isDangerousTool(tool) || (def?.computeDangerFromInput?.(input) ?? false);

  if (def?.credentialFields && hasInlineCredential(input, def.credentialFields)) {
    return { mode: "confirm_before_execution", rule: "inline_credential" };
  }

  if (
    (tool === "call_connector" || tool === "probe_connector" || tool === "probe_connector_draft") &&
    asObj(input).response_mode === "full"
  ) {
    return { mode: "confirm_before_execution", rule: "computed_from_input" };
  }

  if (
    noConfirmOverrideTools.has(tool) &&
    def?.computeModeFromInput?.(input) === "confirm_before_execution"
  ) {
    return { mode: "confirm_before_execution", rule: "computed_from_input" };
  }

  if (args.execution_data_transfer === true) {
    return { mode: "confirm_before_execution", rule: "computed_from_input" };
  }

  if (args.connector_trust === true && permission_mode !== "plan") {
    return { mode: "no_confirm", rule: "connector_trust" };
  }

  if (def?.neverGate && !overrides[tool]) {
    return { mode: "no_confirm", rule: "never_gate" };
  }

  if (permission_mode === "yolo") {
    return { mode: "no_confirm", rule: "permission_mode" };
  }
  if (permission_mode === "auto") {
    const computed = def?.computeModeFromInput?.(input);
    if (computed === "confirm_before_execution") {
      return { mode: computed, rule: "computed_from_input" };
    }
    if (isDangerous) {
      return { mode: "confirm_before_execution", rule: "permission_mode" };
    }
    if (
      category === "tenant_write" &&
      !AUTO_PREPARATION_WRITES.has(tool) &&
      computed !== "no_confirm"
    ) {
      return { mode: "confirm_before_execution", rule: "permission_mode" };
    }
    const override = overrides[tool];
    if (override && override !== "no_confirm") {
      return { mode: override, rule: "conversation_override" };
    }
    return {
      mode: computed ?? "no_confirm",
      rule: computed ? "computed_from_input" : "permission_mode",
    };
  }
  if (permission_mode === "ask" || permission_mode === "plan") {
    if (category === "tenant_write" || isDangerous) {
      return { mode: "confirm_before_execution", rule: "permission_mode" };
    }
  }

  const computed = def?.computeModeFromInput?.(input);
  if (computed === "confirm_before_execution" || isDangerous) {
    return { mode: "confirm_before_execution", rule: "computed_from_input" };
  }
  const override = overrides[tool];
  if (
    permission_mode !== "plan" &&
    override &&
    ((override === "no_confirm" && canSetNoConfirmOverride(tool, override)) ||
      override === "confirm_before_execution")
  ) {
    return { mode: override, rule: "conversation_override" };
  }
  if (computed) return { mode: computed, rule: "computed_from_input" };
  if (def?.defaultMode) return { mode: def.defaultMode, rule: "tool_default" };
  return { mode: defaultModeForCategory(category), rule: "category_default" };
}

export function autoPreparationProceeds(args: {
  tool: string;
  input: unknown;
  overrides: ToolPolicies;
}): boolean {
  const category = AUTO_PREPARATION_WRITES.get(args.tool);
  if (!category) return false;
  return (
    decideToolMode({
      tool: args.tool,
      category,
      input: args.input,
      overrides: args.overrides,
      permission_mode: "auto",
    }).mode === "no_confirm"
  );
}

export function resolveToolMode(args: {
  tool: string;
  category: "draft_write" | "tenant_read" | "tenant_write";
  input: unknown;
  overrides: ToolPolicies;
  permission_mode?: PermissionMode | null;
}): ToolPolicyMode {
  return decideToolMode(args).mode;
}

type ApprovalMode = "auto" | "approval_before" | "approval_after";

export function getApprovalMode(toolName: string): ApprovalMode {
  if (toolName.startsWith("mcp_")) return "approval_before";
  const def = TOOL_POLICIES[toolName];
  if (!def) return "auto";
  if (def.defaultMode === "confirm_before_execution") return "approval_before";
  if (def.defaultMode === "confirm_after_execution") return "approval_after";
  if (def.computeModeFromInput) return "approval_before";
  return "auto";
}

export const APPROVAL_LABELS: Readonly<Record<ApprovalMode, string>> = {
  auto: "Runs automatically",
  approval_before: "Asks before running",
  approval_after: "Review after run",
};
