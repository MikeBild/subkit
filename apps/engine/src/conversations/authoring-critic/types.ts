import { z } from "zod";

export const REPAIRS_CAP = 5;
const REPAIR_LENGTH_CAP = 400;
const RATIONALE_LENGTH_CAP = 800;
export const RUBRIC_CAP = 50;
const RUBRIC_NOTE_CAP = 300;

const CriticRubricStatusSchema = z.enum(["pass", "fail", "n_a"]);

const CriticRubricVerdictItemSchema = z.object({
  rule_id: z.string().min(1).max(80),
  status: CriticRubricStatusSchema,
  note: z.string().max(RUBRIC_NOTE_CAP).default(""),
});

function cappedRubric(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((item) => CriticRubricVerdictItemSchema.safeParse(item).success)
    .slice(0, RUBRIC_CAP)
    .map((item) => {
      const entry = item as { note?: unknown };
      return typeof entry.note === "string" && entry.note.length > RUBRIC_NOTE_CAP
        ? { ...(item as object), note: entry.note.slice(0, RUBRIC_NOTE_CAP) }
        : item;
    });
}

export const AuthoringCriticVerdictSchema = z.preprocess(
  (raw) => {
    if (raw === null || typeof raw !== "object") return raw;
    const r = raw as Record<string, unknown>;
    const repairsRaw = Array.isArray(r.repairs) ? r.repairs : undefined;
    const repairs = repairsRaw
      ?.filter((x): x is string => typeof x === "string" && x.length > 0)
      .slice(0, REPAIRS_CAP)
      .map((s) => (s.length > REPAIR_LENGTH_CAP ? s.slice(0, REPAIR_LENGTH_CAP) : s));
    const rationaleRaw = typeof r.rationale === "string" ? r.rationale : undefined;
    const rationale =
      rationaleRaw !== undefined && rationaleRaw.length > RATIONALE_LENGTH_CAP
        ? rationaleRaw.slice(0, RATIONALE_LENGTH_CAP)
        : rationaleRaw;
    const rubric = cappedRubric(r.rubric);
    return {
      ...r,
      ...(repairs !== undefined ? { repairs } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      ...(rubric !== undefined ? { rubric } : {}),
    };
  },
  z.object({
    passed: z.boolean(),
    repairs: z.array(z.string().min(1).max(REPAIR_LENGTH_CAP)).max(REPAIRS_CAP),
    rationale: z.string().min(1).max(RATIONALE_LENGTH_CAP),
    rubric: z.array(CriticRubricVerdictItemSchema).max(RUBRIC_CAP).default([]),
  }),
);

export type AuthoringCriticVerdict = z.infer<typeof AuthoringCriticVerdictSchema>;

export type CriticRubricStatus = z.infer<typeof CriticRubricStatusSchema> | "unchecked";

export interface CriticRubricItem {
  rule_id: string;
  status: CriticRubricStatus;
  note: string;
}

export const CriticRejectedDetailsSchema = z.object({
  repairs: z.array(z.string().min(1).max(REPAIR_LENGTH_CAP)).max(REPAIRS_CAP),
  rationale: z.string().min(1).max(RATIONALE_LENGTH_CAP),
  gating_reason: z.string().optional(),
});

export type CriticRejectedDetails = z.infer<typeof CriticRejectedDetailsSchema>;
