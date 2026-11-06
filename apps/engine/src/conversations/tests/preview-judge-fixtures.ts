import { afterAll, beforeAll, beforeEach } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

export const uuid = createDeterministicUuidFactory(0x10d_6e);

export let ctx: ConversationTestCtx;

export interface JudgeEnvelope {
  auto_committed?: boolean;
  classification?: string;
  judge?: { verdict: string; reason: string; missing?: string[]; next_action?: string };
  judge_done?: {
    committed_as_is?: boolean;
    escalate?: boolean;
    attempts?: number;
    missing?: string[];
    next_action?: string;
  };
  error_code?: string;
  warnings?: Array<{ code: string; message: string }>;
  next_best_actions?: string[];
}

export function makeCtx(
  initial: DraftDocument,
  opts?: {
    surface?: ToolContext["surface"];
    permission_mode?: ToolContext["permission_mode"];
  },
): ToolContext & { current: () => DraftDocument } {
  let draft = initial;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: uuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    ...(opts?.surface ? { surface: opts.surface } : {}),
    ...(opts?.permission_mode ? { permission_mode: opts.permission_mode } : {}),
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
    current: () => draft,
  };
}

export const GOAL =
  "Email me the DigitalOcean resources per project: include project names and droplet specs (CPU, memory, disk).";

export function usePreviewJudgeSetup(): void {
  beforeAll(async () => {
    ctx = await createConversationTestCtx("preview-judge");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    resetMockProvider();
  });
}
