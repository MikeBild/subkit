// Tool-policy storage + resolver.
//
// A policy maps a tool name (e.g. `run_workflow`) to an enforcement mode:
//   - "no_confirm"              — tool executes immediately
//   - "confirm_before_execution" — loop auto-injects ask_user_confirm
//                                  before dispatch
//   - "confirm_after_execution"  — tool runs, result is staged until
//                                  the user confirms (via interaction_log)
//
// Policies live on `conversations.tool_policies` (jsonb). The loop
// reads them once per turn; write tools can stage their own confirmation
// via the confirmation state machine when no policy forces one.

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversations } from "../db/schema/index.ts";

export type ToolPolicyMode = "no_confirm" | "confirm_before_execution" | "confirm_after_execution";

export interface ToolPolicies {
  [toolName: string]: ToolPolicyMode;
}

export async function getToolPolicies(db: Db, conversation_id: string): Promise<ToolPolicies> {
  const rows = await db
    .select({ tool_policies: conversations.tool_policies })
    .from(conversations)
    .where(eq(conversations.id, conversation_id))
    .limit(1);
  const raw = (rows[0]?.tool_policies ?? {}) as Record<string, unknown>;
  const out: ToolPolicies = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === "no_confirm" || v === "confirm_before_execution" || v === "confirm_after_execution") {
      out[k] = v;
    }
  }
  return out;
}

export async function setToolPolicy(
  db: Db,
  conversation_id: string,
  toolName: string,
  mode: ToolPolicyMode | null,
): Promise<void> {
  const current = await getToolPolicies(db, conversation_id);
  if (mode === null) {
    delete current[toolName];
  } else {
    current[toolName] = mode;
  }
  await db
    .update(conversations)
    .set({ tool_policies: current })
    .where(eq(conversations.id, conversation_id));
}

export function effectiveMode(
  toolName: string,
  policies: ToolPolicies,
  defaultMode: ToolPolicyMode,
): ToolPolicyMode {
  return policies[toolName] ?? defaultMode;
}

/**
 * Default mode by tool category. Reads/draft work default to no_confirm;
 * tenant_write default to confirm_before_execution.
 */
export function defaultModeForCategory(
  category: "draft_write" | "tenant_read" | "tenant_write",
): ToolPolicyMode {
  return category === "tenant_write" ? "confirm_before_execution" : "no_confirm";
}

// ---------------------------------------------------------------------------
// Per-tool dynamic policies (mirror the reference repo's TOOL_POLICIES
// map). Each entry can either state a flat `defaultMode`, or supply a
// `computeModeFromInput` hook to upgrade the mode based on the actual
// arguments (e.g. prod environment, sensitive credentials present,
// mutating HTTP method). `resolveToolMode` threads these together:
//
//   1. per-conversation override (`conversations.tool_policies` jsonb)
//   2. `computeModeFromInput` hook
//   3. category default
// ---------------------------------------------------------------------------

interface ToolPolicyDefinition {
  defaultMode?: ToolPolicyMode;
  computeModeFromInput?: (input: unknown) => ToolPolicyMode | null;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const TOOL_POLICIES: Readonly<Record<string, ToolPolicyDefinition>> = {
  run_workflow: {
    defaultMode: "confirm_before_execution",
    computeModeFromInput: (input) => {
      // Dev-environment runs default to auto; prod requires confirm.
      const env = asObj(input).environment;
      if (env === "dev") return "no_confirm";
      return "confirm_before_execution";
    },
  },
  approve_patch_candidate: { defaultMode: "confirm_before_execution" },
  approve_skill_candidate: { defaultMode: "confirm_before_execution" },
  approve_discovery_artifact: { defaultMode: "confirm_before_execution" },
  // Reads: auto. test_rbac_expression is a read-only probe.
  test_rbac_expression: { defaultMode: "no_confirm" },
  // Draft mutations auto-execute — they stage changes that commit_draft
  // later explicitly confirms via ask_user_confirm.
  propose_step: { defaultMode: "no_confirm" },
  propose_connector: { defaultMode: "no_confirm" },
  propose_skill: { defaultMode: "no_confirm" },
  update_param: { defaultMode: "no_confirm" },
  connect_steps: { defaultMode: "no_confirm" },
  dry_run_step: { defaultMode: "no_confirm" },
  dry_run_transform: { defaultMode: "no_confirm" },
  validate_draft: { defaultMode: "no_confirm" },
  commit_draft: { defaultMode: "confirm_before_execution" },
  build_workflow: { defaultMode: "no_confirm" },
  // web_search leaves the tenant perimeter — confirm by default.
  web_search: { defaultMode: "confirm_before_execution" },
  // probe_connector does an external HTTP call but produces no side
  // effect beyond the vendor's read surface. Dev + GET/HEAD auto; any
  // other combination (write verbs or prod env) requires confirm.
  probe_connector: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) => {
      const obj = asObj(input);
      const method = typeof obj.method === "string" ? obj.method.toUpperCase() : "GET";
      const env = obj.environment;
      if (env === "prod") return "confirm_before_execution";
      if (method !== "GET" && method !== "HEAD") return "confirm_before_execution";
      return "no_confirm";
    },
  },
};

/**
 * Full mode-resolution stack: per-conversation override → dynamic
 * compute-from-input → category-default. Called from `sdk-wrap.ts`
 * before every tool dispatch.
 */
export function resolveToolMode(args: {
  tool: string;
  category: "draft_write" | "tenant_read" | "tenant_write";
  input: unknown;
  overrides: ToolPolicies;
}): ToolPolicyMode {
  const { tool, category, input, overrides } = args;
  if (overrides[tool]) return overrides[tool];
  const def = TOOL_POLICIES[tool];
  if (def?.computeModeFromInput) {
    const computed = def.computeModeFromInput(input);
    if (computed) return computed;
  }
  if (def?.defaultMode) return def.defaultMode;
  return defaultModeForCategory(category);
}
