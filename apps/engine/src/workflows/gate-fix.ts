import { z } from "@hono/zod-openapi";
import {
  type ReportDeliveryBoundary,
  ReportDeliveryBoundarySchema,
} from "./report-delivery-boundary.ts";

const GATE_FIXERS = ["use_utf8_encoder", "declare_report_delivery"] as const;
export const GateFixerSchema = z.enum(GATE_FIXERS);
export type GateFixer = z.infer<typeof GateFixerSchema>;

const GateFixOpSchema = z
  .object({
    op: z.enum(["replace", "add"]),
    path: z.enum(["/expression", "/report_delivery"]),
    value: z.unknown(),
  })
  .strict();
export type GateFixOp = z.infer<typeof GateFixOpSchema>;

export const GateFixPatchSchema = z
  .object({
    fixer: GateFixerSchema,
    step_id: z.string().min(1),
    subject_step_id: z.string().min(1),
    ops: z.array(GateFixOpSchema).length(1),
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

const BINARY_ENCODER = /(?<![\w$.])sk\.base64UrlEncode\(/g;
const RAW_REFERENCE = /^\$\{scope\.([A-Za-z0-9_-]+)(?:\.data)?\.raw\}$/;

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

export function planReportDeliveryDeclaration(
  definition: unknown,
  subject_step_id: string,
  observed: unknown,
): GateFixPlan | null {
  const boundary = ReportDeliveryBoundarySchema.safeParse(
    observed && typeof observed === "object" ? { kind: "gmail_report", ...observed } : observed,
  );
  const subject = stepById(definition, subject_step_id);
  if (!boundary.success || subject?.kind !== "request" || subject.method !== "POST") return null;
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

export function replanGateFix(definition: unknown, patch: GateFixPatch): GateFixPlan | null {
  if (patch.fixer === "use_utf8_encoder")
    return planUtf8EncoderFix(definition, patch.subject_step_id);
  const declared = patch.ops[0];
  if (declared?.path !== "/report_delivery") return null;
  return planReportDeliveryDeclaration(definition, patch.subject_step_id, declared.value);
}

export function applyGateFixOps(step: Step, ops: GateFixOp[]): Step {
  const next = { ...step };
  for (const op of ops) next[op.path.slice(1)] = op.value;
  return next;
}
