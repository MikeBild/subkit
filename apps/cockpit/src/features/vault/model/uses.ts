import type { TranslationKey } from "@/lib/i18n";

export interface UsageLine {
  purpose: TranslationKey;
  origin: string | null;
  outcome: TranslationKey | null;
}

const PURPOSE_KEYS: Readonly<Record<string, TranslationKey>> = {
  sign_in: "vault.use.purpose.signIn",
  pay: "vault.use.purpose.pay",
};

const OUTCOME_KEYS: Readonly<Record<string, TranslationKey>> = {
  pending: "vault.use.outcome.pending",
  running: "vault.use.outcome.running",
  submitted: "vault.use.outcome.submitted",
  uncertain: "vault.use.outcome.uncertain",
  failed: "vault.use.outcome.failed",
  refused: "vault.use.outcome.refused",
};

function hostOf(origin: unknown): string | null {
  if (typeof origin !== "string" || origin === "") return null;
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function usageLine(entry: {
  action: string;
  metadata: Readonly<Record<string, unknown>>;
}): UsageLine | null {
  const purpose = entry.metadata.purpose;
  if (typeof purpose !== "string" || !(purpose in PURPOSE_KEYS)) return null;
  const outcome = entry.metadata.outcome;
  return {
    purpose: PURPOSE_KEYS[purpose] ?? "vault.use.purpose.signIn",
    origin: hostOf(entry.metadata.origin),
    outcome: typeof outcome === "string" ? (OUTCOME_KEYS[outcome] ?? null) : null,
  };
}

export function usageTone(entry: { metadata: Readonly<Record<string, unknown>> }) {
  const outcome = entry.metadata.outcome;
  if (outcome === "submitted") return "ok" as const;
  if (outcome === "uncertain" || outcome === "refused") return "warn" as const;
  if (outcome === "failed") return "error" as const;
  return "neutral" as const;
}
