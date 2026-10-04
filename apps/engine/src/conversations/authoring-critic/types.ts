import { z } from "zod";

export const REPAIRS_CAP = 5;
export const REPAIR_LENGTH_CAP = 400;
export const RATIONALE_LENGTH_CAP = 800;

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
    return {
      ...r,
      ...(repairs !== undefined ? { repairs } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
    };
  },
  z.object({
    passed: z.boolean(),
    repairs: z.array(z.string().min(1).max(REPAIR_LENGTH_CAP)).max(REPAIRS_CAP),
    rationale: z.string().min(1).max(RATIONALE_LENGTH_CAP),
  }),
);

export type AuthoringCriticVerdict = z.infer<typeof AuthoringCriticVerdictSchema>;

export const CriticRejectedDetailsSchema = z.object({
  repairs: z.array(z.string().min(1).max(REPAIR_LENGTH_CAP)).max(REPAIRS_CAP),
  rationale: z.string().min(1).max(RATIONALE_LENGTH_CAP),
  gating_reason: z.string().optional(),
});

export type CriticRejectedDetails = z.infer<typeof CriticRejectedDetailsSchema>;
