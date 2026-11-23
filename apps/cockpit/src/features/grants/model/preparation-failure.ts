import { ApiError } from "@/api/client";
import { engineSentence } from "@/lib/engine-sentence";
import type { Translate } from "@/lib/i18n";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

export function preparationFailureLine(error: unknown, t: Translate): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.details;
  if (error.code === "input_schema_violation") return text(error.message);
  if (error.code !== "authority_preparation_failed" || !details) return null;
  const step = text(details.step_id);
  const reason = engineSentence(
    { code: text(details.step_code), text: text(details.reason) },
    t,
  )?.text;
  if (!step) return reason ?? null;
  const where = t("decisions.failing.step", { step });
  return reason ? `${where}: ${reason}` : where;
}
