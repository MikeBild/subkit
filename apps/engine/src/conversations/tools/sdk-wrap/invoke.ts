import type { z } from "@hono/zod-openapi";
import { type Tool, tool } from "ai";
import type { Db } from "../../../db/client.ts";
import type { ToolPolicies } from "../../../tools/types.ts";
import { pinAttachmentFileId } from "../../attachments.ts";
import { isCoverCandidate } from "../../instruction-cover/gate.ts";
import { takeBecause, withBecauseField } from "../../instruction-cover/marker.ts";
import type { TurnEvent } from "../../types.ts";
import { decodeAskUserPromptEscapes } from "../ask-user/decode-prompt-escapes.ts";
import { compileDescription } from "../describe.ts";
import type { ConversationTool, ToolContext } from "../index.ts";
import { INTAKE_REVIEW_BLOCKED_WRITES, intakeReviewBlocksWrite } from "./intake-review-guard.ts";
import { runInvocation } from "./invoke/body.ts";
import { jsonSafeModelOutput } from "./json-safe-output.ts";
import type { TurnSignals, WrappedToolOutput } from "./state.ts";

export { INTAKE_REVIEW_BLOCKED_WRITES, intakeReviewBlocksWrite };

export function toInputExamples(
  example: Readonly<Record<string, unknown>> | undefined,
): { inputExamples: Array<{ input: Record<string, unknown> }> } | Record<string, never> {
  if (!example || Object.keys(example).length === 0) return {};
  return { inputExamples: [{ input: { ...example } }] };
}

export function wrapOne(
  inner: ConversationTool,
  ctx: ToolContext,
  signals: TurnSignals,
  events: TurnEvent[],
  db: Db,
  toolPolicies: ToolPolicies,
): Tool<Record<string, unknown>, WrappedToolOutput> {
  const askBeforeWriting = ctx.ask_before_writing === true;
  const quotable = !askBeforeWriting && inner.strict !== true && isCoverCandidate(inner.name);
  const inputSchema = (quotable
    ? withBecauseField(inner.inputSchema)
    : inner.inputSchema) as unknown as z.ZodType<Record<string, unknown>>;
  return tool<Record<string, unknown>, WrappedToolOutput, Record<string, unknown>>({
    description: compileDescription(inner),
    inputSchema,
    toModelOutput: jsonSafeModelOutput,
    ...(inner.strict !== undefined ? { strict: inner.strict } : {}),
    ...toInputExamples(inner.example_input),
    async execute(modelArgs: Record<string, unknown>): Promise<WrappedToolOutput> {
      const taken = takeBecause(modelArgs);
      const decodedArgs = decodeAskUserPromptEscapes(inner.name, taken.args);
      const rawArgs = inner.accepts_attachment_file_id
        ? await pinAttachmentFileId(decodedArgs, {
            db,
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
          })
        : decodedArgs;
      const prevChain = signals.toolChain;
      let release!: () => void;
      signals.toolChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prevChain;
      try {
        return await runInvocation(
          {
            inner,
            ctx,
            signals,
            events,
            db,
            toolPolicies,
            askBeforeWriting,
            release,
            because: quotable ? taken.because : null,
          },
          rawArgs,
        );
      } finally {
        release();
      }
    },
  });
}
