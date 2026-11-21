import { shortIdentifier } from "@/lib/core/identifier";

export interface AuthorityHeadlineFacts {
  execution_environment: "dev" | "prod";
  valid_until: string | null;
  max_runs: number | null;
  until_label: string | null;
}

export type AuthorityTranslate = (
  key:
    | "authority.production"
    | "authority.development"
    | "authority.headline.untilRevoked"
    | "authority.headline.until"
    | "authority.headline.runs.unlimited"
    | "authority.headline.runs.one"
    | "authority.headline.runs.other",
  values?: Record<string, string | number>,
) => string;

export function authorityVersionLabel(
  versionId: string,
  versions: ReadonlyMap<string, number>,
): { text: string; full: string | null } {
  const number = versions.get(versionId);
  if (number !== undefined) return { text: `v${number}`, full: versionId };
  const short = shortIdentifier(versionId);
  return { text: short, full: short === versionId ? null : versionId };
}

export function authorityHeadline(facts: AuthorityHeadlineFacts, t: AuthorityTranslate): string {
  return [
    t(facts.execution_environment === "prod" ? "authority.production" : "authority.development"),
    facts.valid_until === null
      ? t("authority.headline.untilRevoked")
      : facts.until_label
        ? t("authority.headline.until", { until: facts.until_label })
        : null,
    facts.max_runs === null
      ? t("authority.headline.runs.unlimited")
      : t(facts.max_runs === 1 ? "authority.headline.runs.one" : "authority.headline.runs.other", {
          max: facts.max_runs,
        }),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
