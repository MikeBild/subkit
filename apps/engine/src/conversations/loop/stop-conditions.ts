interface StepShapeWithToolName {
  toolResults: ReadonlyArray<{ toolName: string; output?: unknown }>;
}

interface StepShape {
  toolResults: ReadonlyArray<{ output?: unknown }>;
}

export function isAutomationReviewCard(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const envelope = output as {
    ok?: unknown;
    error_code?: unknown;
    data?: { kind?: unknown; presentation?: unknown };
    kind?: unknown;
    presentation?: unknown;
  };
  if (envelope.ok === false || envelope.error_code) return false;
  const data = envelope.data ?? envelope;
  return (
    data.kind === "workflow_automation_review" && data.presentation === "automation_readiness_card"
  );
}

export const automationReviewStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<StepShapeWithToolName>;
}): boolean =>
  steps
    .at(-1)
    ?.toolResults.some(
      (result) =>
        result.toolName === "review_workflow_automation" && isAutomationReviewCard(result.output),
    ) ?? false;

export const MAX_STALLED_REPAIR_PREVIEWS = 3;

export const committedStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<StepShapeWithToolName>;
}): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((r) => {
    if (r.toolName !== "save_workflow_draft") return false;
    const output = r.output;
    if (!output || typeof output !== "object") return false;
    const record = output as Record<string, unknown>;
    const data = record.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const dataRecord = data as Record<string, unknown>;
      if (dataRecord.already_persisted === true || dataRecord.version_changed === false) {
        return false;
      }
    }
    return typeof record.committed_workflow_id === "string";
  });
};

export const abstainedStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<StepShapeWithToolName>;
}): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((r) => {
    if (r.toolName !== "cannot_help") return false;
    const output = r.output;
    if (!output || typeof output !== "object") return true;
    return (output as { ok?: unknown }).ok !== false;
  });
};

export const pausedStopCondition = ({ steps }: { steps: ReadonlyArray<StepShape> }): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((result) => {
    const output = result.output;
    return !!output && typeof output === "object" && "pause" in (output as Record<string, unknown>);
  });
};

function dryRunData(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== "object") return null;
  const data = (output as { data?: unknown }).data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return output as Record<string, unknown>;
}

function isRepairBlocked(data: Record<string, unknown>): boolean {
  return data.requires_repair === true || data.classification === "needs_repair";
}

function blockingFingerprint(output: unknown): string | null {
  const data = dryRunData(output);
  if (!data || !isRepairBlocked(data)) return null;

  const parts: string[] = [];

  const judge = data.judge;
  if (judge && typeof judge === "object") {
    const j = judge as { verdict?: unknown; missing?: unknown };
    if (typeof j.verdict === "string") parts.push(`verdict:${j.verdict}`);
    if (Array.isArray(j.missing)) {
      const missing = j.missing
        .filter((m): m is string => typeof m === "string")
        .slice()
        .sort();
      parts.push(`missing:[${missing.join("|")}]`);
    }
  }

  const warnings = data.warnings;
  if (Array.isArray(warnings)) {
    const codes = warnings
      .map((w) => (w && typeof w === "object" ? (w as { code?: unknown }).code : undefined))
      .filter((c): c is string => typeof c === "string")
      .slice()
      .sort();
    if (codes.length > 0) parts.push(`warnings:[${codes.join("|")}]`);
  }

  return parts.length > 0 ? parts.join(";") : "requires_repair";
}

export const noProgressRepairStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<StepShapeWithToolName>;
}): boolean => {
  const fingerprints: Array<string | null> = [];
  for (const step of steps) {
    for (const r of step.toolResults) {
      if (r.toolName !== "dry_run_workflow") continue;
      fingerprints.push(blockingFingerprint(r.output));
    }
  }
  if (fingerprints.length < MAX_STALLED_REPAIR_PREVIEWS) return false;

  const last = fingerprints[fingerprints.length - 1];
  if (last == null) return false;
  let run = 0;
  for (let i = fingerprints.length - 1; i >= 0; i--) {
    if (fingerprints[i] === last) run++;
    else break;
  }
  return run >= MAX_STALLED_REPAIR_PREVIEWS;
};
