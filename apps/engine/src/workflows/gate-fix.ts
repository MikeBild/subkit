// Deterministic repairs for a step an approval gate refused.
//
// A fixer never asks a model. It reads the saved definition, decides whether
// the refusal has exactly one mechanical cause it can name, and computes the
// operations that remove it. The same functions decide eligibility when a
// workflow is diagnosed and re-decide it when a person previews, prepares or
// approves the candidate, so what is shown is what lands — and a definition
// that moved in between yields no plan instead of a guess.

import { z } from "@hono/zod-openapi";
import {
  type ReportDeliveryBoundary,
  ReportDeliveryBoundarySchema,
} from "./report-delivery-boundary.ts";

export const GATE_FIXERS = ["use_utf8_encoder", "declare_report_delivery"] as const;
export const GateFixerSchema = z.enum(GATE_FIXERS);
export type GateFixer = z.infer<typeof GateFixerSchema>;

/** One JSON-patch-shaped operation on the anchor step. Closed per fixer. */
export const GateFixOpSchema = z
  .object({
    op: z.enum(["replace", "add"]),
    path: z.enum(["/expression", "/report_delivery"]),
    value: z.unknown(),
  })
  .strict();
export type GateFixOp = z.infer<typeof GateFixOpSchema>;

/** The `patch` body of a `gate_fix` proposal. */
export const GateFixPatchSchema = z
  .object({
    fixer: GateFixerSchema,
    /** The step the operations rewrite (the anchor). */
    step_id: z.string().min(1),
    /** The step the gate refused. Differs from `step_id` when the cause sits
     *  upstream, as an encoder in a transform feeding a report e-mail. */
    subject_step_id: z.string().min(1),
    ops: z.array(GateFixOpSchema).length(1),
    /** The run whose recorded observation a declaration is copied from. */
    source_execution_id: z.string().uuid().optional(),
  })
  .strict();
export type GateFixPatch = z.infer<typeof GateFixPatchSchema>;

export interface GateFixPlan {
  step_id: string;
  ops: GateFixOp[];
}

type Step = Record<string, unknown>;

function stepsOf(definition: unknown): Step[] {
  const steps = (definition as { steps?: unknown } | null)?.steps;
  return Array.isArray(steps)
    ? steps.filter((step): step is Step => !!step && typeof step === "object")
    : [];
}

function stepById(definition: unknown, step_id: string): Step | undefined {
  return stepsOf(definition).find((step) => step.id === step_id);
}

// `sk.base64UrlEncode(` as its own identifier: not preceded by an identifier
// character or a dot (so `xsk.` and `a.sk.` do not count), and followed
// directly by the call parenthesis — `sk.base64UrlEncodeUtf8(` never matches.
const BINARY_ENCODER = /(?<![\w$.])sk\.base64UrlEncode\(/g;
// The report body is exactly one whole-string reference to a transform's raw
// output — nothing in front of it, nothing after it.
const RAW_REFERENCE = /^\$\{scope\.([A-Za-z0-9_-]+)(?:\.data)?\.raw\}$/;

/**
 * Swap the binary encoder for the UTF-8 one when a report e-mail's message is
 * built by exactly one `sk.base64UrlEncode(` call in exactly one JavaScript
 * transform, and the e-mail sends that transform's `raw` unchanged.
 *
 * The binary encoder maps each UTF-16 code unit to one byte, so an umlaut in a
 * subject or body becomes a byte that is not UTF-8 and the gate refuses the
 * message. Anything less exact — two encoders, a template around the
 * reference, a non-JavaScript transform — is not a mechanical fix and gets no
 * plan; it has to be authored.
 */
export function planUtf8EncoderFix(
  definition: unknown,
  subject_step_id: string,
): GateFixPlan | null {
  const subject = stepById(definition, subject_step_id);
  if (subject?.kind !== "request") return null;
  const body = subject.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const raw = (body as Record<string, unknown>).raw;
  if (keys.length !== 1 || typeof raw !== "string") return null;
  const reference = RAW_REFERENCE.exec(raw);
  const source = reference ? stepById(definition, reference[1] as string) : undefined;
  if (source?.kind !== "transform") return null;
  if (source.language !== undefined && source.language !== "javascript") return null;
  const expression = source.expression;
  if (typeof expression !== "string") return null;
  const matches = expression.match(BINARY_ENCODER) ?? [];
  if (matches.length !== 1) return null;
  return {
    step_id: source.id as string,
    ops: [
      {
        op: "replace",
        path: "/expression",
        value: expression.replace(BINARY_ENCODER, "sk.base64UrlEncodeUtf8("),
      },
    ],
  };
}

/**
 * Declare the recipient a successful inspection of this very step observed.
 * The value is copied from the recorded observation, never from the source of
 * a transform; the runtime still compares every real message against it.
 */
export function planReportDeliveryDeclaration(
  definition: unknown,
  subject_step_id: string,
  /** The observed addresses and content type; `kind` is implied. */
  observed: unknown,
): GateFixPlan | null {
  const boundary = ReportDeliveryBoundarySchema.safeParse(
    observed && typeof observed === "object" ? { kind: "gmail_report", ...observed } : observed,
  );
  const subject = stepById(definition, subject_step_id);
  if (!boundary.success || subject?.kind !== "request" || subject.method !== "POST") return null;
  // A declaration the observation contradicts is replaced by what was observed;
  // one that already says exactly that leaves nothing to repair.
  const declared = ReportDeliveryBoundarySchema.safeParse(subject.report_delivery);
  if (declared.success && sameBoundary(declared.data, boundary.data)) return null;
  return {
    step_id: subject_step_id,
    ops: [
      {
        op: subject.report_delivery === undefined ? "add" : "replace",
        path: "/report_delivery",
        value: boundary.data,
      },
    ],
  };
}

function sameBoundary(a: ReportDeliveryBoundary, b: ReportDeliveryBoundary): boolean {
  return (
    a.kind === b.kind && a.to === b.to && a.from === b.from && a.content_type === b.content_type
  );
}

/** Re-plan a stored fix against a definition and say whether it still holds. */
export function replanGateFix(definition: unknown, patch: GateFixPatch): GateFixPlan | null {
  if (patch.fixer === "use_utf8_encoder")
    return planUtf8EncoderFix(definition, patch.subject_step_id);
  const declared = patch.ops[0];
  if (declared?.path !== "/report_delivery") return null;
  return planReportDeliveryDeclaration(definition, patch.subject_step_id, declared.value);
}

/** Apply a plan's single operation to the anchor step, returning a copy. */
export function applyGateFixOps(step: Step, ops: GateFixOp[]): Step {
  const next = { ...step };
  for (const op of ops) next[op.path.slice(1)] = op.value;
  return next;
}
