import { logger } from "../../logging/logger.ts";
import { CriticRejectedDetailsSchema } from "./types.ts";

export interface RecentToolCallRow {
  tool: string;
  output: unknown;
}

export interface PriorFailure {
  step_id: string;
  error: string;
}

interface ExpandResult {
  entries: PriorFailure[];
  hadCriticReject: boolean;
}

const MAX_ENTRIES = 5;

export function expandPriorFailuresFromToolCalls(
  rows: ReadonlyArray<RecentToolCallRow>,
): ExpandResult {
  const entries: PriorFailure[] = [];
  let hadCriticReject = false;
  for (const row of rows) {
    if (entries.length >= MAX_ENTRIES) break;
    const output = row.output as Record<string, unknown> | null;
    if (!output || typeof output !== "object") continue;

    if (output.critic_rejection !== undefined) {
      const parsed = CriticRejectedDetailsSchema.safeParse(output.critic_rejection);
      if (!parsed.success) {
        logger.warn({
          module: "conversations",
          action: "critic.details_malformed",
          msg: "critic_rejection advisory failed CriticRejectedDetailsSchema; row dropped + signal suppressed",
          error: parsed.error.issues.map((i) => i.path.join(".")).join(","),
        });
        continue;
      }
      const repairs = parsed.data.repairs;
      if (repairs.length === 0) {
        continue;
      }
      hadCriticReject = true;
      for (const repair of repairs) {
        entries.push({ step_id: "critic", error: repair });
        if (entries.length >= MAX_ENTRIES) break;
      }
      continue;
    }

    if (output.ok !== false && typeof output.error_code !== "string") continue;
    const code = typeof output.error_code === "string" ? output.error_code : "tool_failed";
    const nbaRaw = output.next_best_actions;
    const nba = Array.isArray(nbaRaw)
      ? nbaRaw.filter((x): x is string => typeof x === "string")
      : [];
    const message =
      typeof output.message === "string"
        ? output.message
        : typeof (output as { error?: unknown }).error === "string"
          ? (output as { error: string }).error
          : "";
    const nbaSuffix = nba.length > 0 ? ` — try next: ${nba.join(", ")}` : "";
    entries.push({
      step_id: row.tool,
      error: `${row.tool} failed (${code}): ${message}${nbaSuffix}`,
    });
  }
  return { entries, hadCriticReject };
}
