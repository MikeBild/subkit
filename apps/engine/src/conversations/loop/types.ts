import type { streamText, ToolSet } from "ai";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import type { toSystemMessages } from "../../llm/runtime/cache-blocks.ts";
import type { assembleEnhancedPrompt } from "../../llm/runtime/context-assembler.ts";
import type { resolveModelRoute } from "../../llm/runtime/invoke.ts";
import type { StepRouterSignals } from "../../llm/runtime/step-router.ts";
import type { ElicitationBridge } from "../elicitation-bridge.ts";
import type { detectUserIntent } from "../intent-detector.ts";
import type { ConversationReference, resolveReferences } from "../references.ts";
import type { ExecutionToolGateDecision } from "../tools/authoring-palette.ts";
import type { ConversationTool, ToolContext } from "../tools/index.ts";
import type { TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import type { LlmTimeoutError } from "../turn-failure.ts";
import type { DraftDocument, TurnEvent } from "../types.ts";
import type { resolveLanguageModel } from "./model-resolver.ts";
import type { LoadedSkillEntry } from "./skill-recency.ts";

export interface RunLoopParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal?: ResolvedPrincipal | null;
  locale?: "de" | "en";
  connector_id: string | null;
  workflow_id: string | null;
  user_message: string | null;
  user_references?: ConversationReference[] | null;
  step_budget?: number;
  user_memory?: string | null;
  model_override?: string | null;
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  onEvent?: (ev: TurnEvent) => void;
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
  ask_before_writing?: boolean;
  turn_abort_ctrl: AbortController;
  user_message_persisted?: boolean;
  next_suggestion_suppress?: boolean;
  elicitationBridge?: ElicitationBridge;
}

export interface RunLoopResult {
  events: TurnEvent[];
  status: "awaiting_input" | "committed" | "active" | "abandoned" | "exhausted";
  committed_workflow_id?: string;
  pending_elicitation_id?: string;
}

export type ModelRoute = Awaited<ReturnType<typeof resolveModelRoute>>;
export type AssembledPrompt = Awaited<ReturnType<typeof assembleEnhancedPrompt>>;
export type ReferencedEntities = Awaited<ReturnType<typeof resolveReferences>>;
export type WrappedTools = Awaited<ReturnType<typeof wrapTools>>;
export type ToolPolicies = Record<
  string,
  "no_confirm" | "confirm_before_execution" | "confirm_after_execution"
>;

export interface TurnState {
  draft: DraftDocument;
  promptTokensLastCall: number | null;
  turnTokensTotal: number;
  turnInputTokens: number;
  turnCacheReadTokens: number;
  turnCacheCreationTokens: number;
  turnCacheReported: boolean;
  lastStepHadText: boolean;
  handoffSummaryOnly: boolean;
  paletteSkills: string[];
  paletteIntakeItems: boolean;
  cancelled: boolean;
}

export interface TurnBase {
  p: RunLoopParams;
  events: TurnEvent[];
  budget: number;
  engineUrl: string | undefined;
  abort: AbortController;
  usageBefore: number;
  spendBefore: number | null;
  ingestedUserMessage: string | null;
  currentUserText: string;
  referenced: ReferencedEntities;
  detectedIntent: ReturnType<typeof detectUserIntent>;
  workflowIdForTurn: string | null;
  ctx: ToolContext;
  route: ModelRoute;
  seedModel: string;
  stepRouterSignals: StepRouterSignals;
  currentTurn: number;
  loadedEntries: LoadedSkillEntry[];
  toolPolicies: ToolPolicies;
  targetConnectorId: string | null;
}

export interface TurnSkills {
  loadedSkillSlugs: string[];
  loadedSlugMembership: string[];
}

export interface RecentToolCall {
  tool: string;
  output: unknown;
  created_at: Date;
}

export interface TurnPrompt {
  prompt: AssembledPrompt;
  activeConnectorId: string | null;
  recentToolCalls: RecentToolCall[];
}

export interface TurnPalette {
  signals: TurnSignals;
  tools: WrappedTools;
  executionGate: ExecutionToolGateDecision;
  preferredTool: string | null;
  forceNoTools: boolean;
}

export type TurnStopConditions = Parameters<typeof streamText>[0]["stopWhen"];

export interface TurnEnv extends TurnBase, TurnPalette {
  prompt: AssembledPrompt;
  contextCap: number;
  estimatedPromptTokens: number;
  stopWhen: TurnStopConditions;
}

export interface Attempt {
  modelId: string;
  provider: ModelRoute["provider"];
  resolvedModel: Awaited<ReturnType<typeof resolveLanguageModel>>;
  baselineIndex: number;
  systemMessages: ReturnType<typeof toSystemMessages>;
  toolsByName: Record<string, ConversationTool>;
  thinkingThisTurn: boolean;
  turnTools: ToolSet;
  turnBudgetMs: number;
  firstChunkTimeoutMs: number;
  streamStartedAt: number;
  lastStepEnd: number;
  activeStepModel: string;
  turnRepairCount: number;
  capturedError: unknown;
  timeoutError: LlmTimeoutError | null;
}
