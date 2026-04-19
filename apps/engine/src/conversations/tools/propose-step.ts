// propose_step — append a step to the draft and validate.
//
// The tool keeps a permissive zod inputSchema so the SDK always invokes
// our execute body. Strict validation runs inside via the workflow
// validator, and we craft a rich error payload (valid_kinds,
// required_fields_for_kind, example_for_kind) so the model can
// self-correct on the next iteration instead of guessing shapes.

import { z } from "@hono/zod-openapi";
import { type ValidationError, validateWorkflowDef } from "../../workflows/validator.ts";
import type { DraftDocument } from "../types.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    step: z.record(z.string(), z.unknown()),
  })
  .openapi("ProposeStepToolInput");

const VALID_KINDS = [
  "request",
  "transform",
  "call",
  "wait",
  "branch",
  "parallel",
  "loop",
  "tool",
] as const;
type ValidKind = (typeof VALID_KINDS)[number];

const REQUIRED_FIELDS_PER_KIND: Record<ValidKind, string[]> = {
  request: ["id", "kind", "(url OR connector_id)"],
  transform: ["id", "kind", "expression"],
  call: ["id", "kind", "(workflow_id OR workflow_slug)"],
  wait: ["id", "kind", "duration_ms"],
  branch: ["id", "kind", "when", "then_steps"],
  parallel: ["id", "kind", "branches"],
  loop: ["id", "kind", "over", "body"],
  tool: ["id", "kind", "image"],
};

const EXAMPLE_PER_KIND: Record<ValidKind, Record<string, unknown>> = {
  request: {
    id: "fetch_user",
    kind: "request",
    method: "GET",
    url: "https://api.example.com/users/{{ trigger.user_id }}",
  },
  transform: {
    id: "shape_payload",
    kind: "transform",
    expression: "{ name: $.user.name, email: $.user.email }",
    language: "jsonata",
  },
  call: {
    id: "run_subflow",
    kind: "call",
    workflow_slug: "send-welcome-email",
    input: { email: "{{ shape_payload.email }}" },
  },
  wait: { id: "cooldown", kind: "wait", duration_ms: 5000 },
  branch: {
    id: "approve_or_reject",
    kind: "branch",
    when: "{{ approval.outcome == 'approved' }}",
    then_steps: ["notify_approved"],
    else_steps: ["notify_rejected"],
  },
  parallel: {
    id: "fanout",
    kind: "parallel",
    branches: [["fetch_user"], ["fetch_orders"]],
  },
  loop: {
    id: "for_each_order",
    kind: "loop",
    over: "{{ orders }}",
    body: ["process_order"],
    item_var: "order",
  },
  tool: {
    id: "convert_pdf",
    kind: "tool",
    image: "ghcr.io/example/pdf2text:1.0",
    cmd: ["--in", "/work/in.pdf", "--out", "/work/out.txt"],
  },
};

const DESCRIPTION = [
  "Append (or replace by id) one step in the draft workflow and validate.",
  "REQUIRED: each step has `id` (unique string) and `kind` (one of: request, transform, call, wait, branch, parallel, loop, tool).",
  "Do NOT use `type`, `@type`, or invented kinds (`trigger.*`, `flow.*`, `util.*`). Those will fail.",
  "Examples:",
  '- request: {"id":"fetch","kind":"request","method":"GET","url":"https://api.example.com/x"}',
  '- transform: {"id":"shape","kind":"transform","expression":"{ name: $.user.name }","language":"jsonata"}',
  '- branch: {"id":"gate","kind":"branch","when":"{{ x }}","then_steps":["a"],"else_steps":["b"]}',
  '- wait: {"id":"sleep","kind":"wait","duration_ms":5000}',
  "Returns ok=false with errors + valid_kinds + example_for_kind when the step is malformed; call propose_step again with the fixed shape.",
].join(" ");

function detectAttemptedKind(step: Record<string, unknown>): {
  attempted_kind: string | null;
  used_wrong_key: boolean;
} {
  if (typeof step.kind === "string") {
    return { attempted_kind: step.kind, used_wrong_key: false };
  }
  // Common LLM mistakes: `type`, `@type`, `step_type`. Surface them so the
  // model immediately understands which field name to use.
  for (const wrongKey of ["type", "@type", "step_type", "stepType"] as const) {
    const v = (step as Record<string, unknown>)[wrongKey];
    if (typeof v === "string") return { attempted_kind: v, used_wrong_key: true };
  }
  return { attempted_kind: null, used_wrong_key: false };
}

function isValidKind(k: string | null): k is ValidKind {
  return k !== null && (VALID_KINDS as readonly string[]).includes(k);
}

function buildErrorPayload(
  step: Record<string, unknown>,
  errors: ValidationError[],
  stepId: string | null,
): Record<string, unknown> {
  const { attempted_kind, used_wrong_key } = detectAttemptedKind(step);
  const validKind = isValidKind(attempted_kind) ? attempted_kind : null;
  const messageParts: string[] = ["step invalid"];
  if (used_wrong_key) {
    messageParts.push("you used the wrong key — the discriminator is `kind`, not `type` / `@type`");
  } else if (attempted_kind && !validKind) {
    messageParts.push(
      `\`${attempted_kind}\` is not a valid kind — pick one of: ${VALID_KINDS.join(", ")}`,
    );
  } else if (!attempted_kind) {
    messageParts.push(`missing required \`kind\` field — pick one of: ${VALID_KINDS.join(", ")}`);
  } else {
    messageParts.push(
      "fix the listed errors and call propose_step again (this tool is idempotent by id)",
    );
  }
  return {
    errors,
    step_id: stepId,
    attempted_kind,
    used_wrong_key,
    valid_kinds: [...VALID_KINDS],
    ...(validKind ? { required_fields_for_kind: REQUIRED_FIELDS_PER_KIND[validKind] } : {}),
    example_for_kind: validKind ? EXAMPLE_PER_KIND[validKind] : EXAMPLE_PER_KIND.request,
    message: messageParts.join(" — "),
  };
}

export const proposeStepTool: ConversationTool = {
  name: "propose_step",
  description: DESCRIPTION,
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = structuredClone(ctx.getDraft()) as DraftDocument;
    const stepId = typeof args.step.id === "string" ? (args.step.id as string) : undefined;
    if (stepId) {
      const existing = draft.steps.findIndex((s) => s.id === stepId);
      if (existing >= 0) {
        draft.steps[existing] = args.step;
      } else {
        draft.steps.push(args.step);
      }
    } else {
      draft.steps.push(args.step);
    }
    const validation = validateWorkflowDef(draft);
    if (!validation.ok) {
      return {
        ok: false,
        data: buildErrorPayload(args.step, validation.errors, stepId ?? null),
      };
    }
    await ctx.setDraft(draft);
    return {
      ok: true,
      data: {
        steps: draft.steps.length,
        step_id: stepId ?? null,
        step_type: typeof args.step.kind === "string" ? args.step.kind : null,
        replaced: stepId !== undefined && draft.steps.findIndex((s) => s.id === stepId) >= 0,
        last_step_id: draft.steps[draft.steps.length - 1]?.id ?? null,
      },
    };
  },
};
