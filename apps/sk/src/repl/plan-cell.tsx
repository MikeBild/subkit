import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

export type PlanStepStatus =
  | "succeeded"
  | "running"
  | "in_progress"
  | "pending"
  | "queued"
  | "failed"
  | "skipped"
  | "warning"
  | "unknown";

export interface PlanStep {
  id: string;
  label: string;
  status: PlanStepStatus;
  detail?: string;
}

interface PlanCardProps {
  title?: string;
  steps: ReadonlyArray<PlanStep>;
}

export const STATUS_GLYPH: Record<PlanStepStatus, string> = {
  succeeded: "✔",
  running: "⬢",
  in_progress: "⬢",
  pending: "☐",
  queued: "☐",
  failed: "✗",
  skipped: "−",
  warning: "⚠",
  unknown: "·",
};

const STATUS_COLOR: Record<PlanStepStatus, "green" | "cyan" | "gray" | "red" | "yellow"> = {
  succeeded: "green",
  running: "cyan",
  in_progress: "cyan",
  pending: "gray",
  queued: "gray",
  failed: "red",
  skipped: "gray",
  warning: "yellow",
  unknown: "gray",
};

const PlanCardImpl: React.FC<PlanCardProps> = ({ title, steps }) => {
  return (
    <Box flexDirection="column" marginTop={1}>
      {title ? (
        <Box>
          <Text color="cyan">▤ </Text>
          <Text bold>{title}</Text>
          <Text color="gray">
            {" · "}
            {steps.length} step{steps.length === 1 ? "" : "s"}
          </Text>
        </Box>
      ) : null}
      {steps.map((step) => {
        const glyph = STATUS_GLYPH[step.status];
        const color = STATUS_COLOR[step.status];
        const isDim = step.status === "skipped" || step.status === "succeeded";
        return (
          <Box key={`plan-${step.id}`}>
            <Text
              color={color}
              dimColor={isDim}
              bold={step.status === "running" || step.status === "in_progress"}
            >
              {glyph}
            </Text>
            <Text> {step.label}</Text>
            {step.detail ? (
              <Text color="gray" dimColor>
                {" · "}
                {step.detail}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
};

export const PlanCard = memo(PlanCardImpl);
PlanCard.displayName = "PlanCard";

export function detectPlanSteps(output: unknown): PlanStep[] | null {
  if (!output || typeof output !== "object") return null;
  const obj = output as Record<string, unknown>;
  const candidate =
    (Array.isArray(obj.steps) && obj.steps) ||
    (Array.isArray(obj.step_outputs) && obj.step_outputs) ||
    (Array.isArray(obj.step_traces) && obj.step_traces) ||
    null;
  if (!candidate) return null;
  const steps: PlanStep[] = [];
  for (let i = 0; i < candidate.length; i++) {
    const raw = candidate[i];
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id =
      (typeof r.step_id === "string" && r.step_id) ||
      (typeof r.id === "string" && r.id) ||
      (typeof r.name === "string" && r.name) ||
      `step-${i}`;
    const label =
      (typeof r.step_id === "string" && r.step_id) ||
      (typeof r.name === "string" && r.name) ||
      (typeof r.label === "string" && r.label) ||
      id;
    const rawStatus =
      (typeof r.status === "string" && r.status) ||
      (typeof r.state === "string" && r.state) ||
      "unknown";
    const status = normalizeStatus(rawStatus);
    const duration =
      typeof r.duration_ms === "number"
        ? `${r.duration_ms}ms`
        : typeof r.duration_ms === "string"
          ? r.duration_ms
          : null;
    steps.push({
      id: String(id),
      label: String(label),
      status,
      ...(duration ? { detail: duration } : {}),
    });
  }
  return steps.length > 0 ? steps : null;
}

function normalizeStatus(raw: string): PlanStepStatus {
  const r = raw.toLowerCase();
  if (r === "succeeded" || r === "success" || r === "ok" || r === "done") return "succeeded";
  if (r === "failed" || r === "error" || r === "rejected") return "failed";
  if (r === "running" || r === "in_progress" || r === "in-progress") return "running";
  if (r === "pending" || r === "queued" || r === "scheduled") return "pending";
  if (r === "skipped" || r === "noop") return "skipped";
  if (r === "partial" || r === "partial_success" || r === "warning") return "warning";
  return "unknown";
}
