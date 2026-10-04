import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface WorkflowStepSnapshot {
  id: string;
  name: string;
  kind: string;
  status: StepStatus;
  input?: unknown;
  output?: unknown;
  error?: string | null;
}

export interface WorkflowRunSnapshot {
  id: string;
  status: StepStatus;
  payload?: unknown;
  steps: WorkflowStepSnapshot[];
  transform?: { expression?: string; result?: unknown; error?: string | null } | null;
}

export type StepCarouselTab = "payload" | "steps" | "transform";

export interface StepCarouselProps {
  run: WorkflowRunSnapshot;
  active: StepCarouselTab;
  onTab: (tab: StepCarouselTab) => void;
  activeStep?: number;
  onActiveStepChange?: (i: number) => void;
  onAbort?: () => void;
}

const TABS: StepCarouselTab[] = ["payload", "steps", "transform"];

export function StepCarousel({
  run,
  active,
  onTab,
  activeStep = 0,
  onActiveStepChange,
  onAbort,
}: StepCarouselProps): React.ReactElement {
  const tokens = useTheme();
  const [internalStep, setInternalStep] = useState(activeStep);
  const stepIdx = onActiveStepChange ? activeStep : internalStep;
  const setStep = (n: number): void => {
    if (onActiveStepChange) onActiveStepChange(n);
    else setInternalStep(n);
  };

  useInput((_input, key) => {
    if (key.tab) {
      const i = TABS.indexOf(active);
      onTab(TABS[(i + 1) % TABS.length] as StepCarouselTab);
      return;
    }
    if (active === "steps") {
      if (key.leftArrow) setStep(Math.max(0, stepIdx - 1));
      if (key.rightArrow) setStep(Math.min(run.steps.length - 1, stepIdx + 1));
    }
    if (key.escape) onAbort?.();
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        {TABS.map((t) => (
          <Box key={t} marginRight={2}>
            <Text
              color={t === active ? tokens.accent.primary : tokens.severity.dim}
              bold={t === active}
            >
              {t === active ? `[${t}]` : t}
            </Text>
          </Box>
        ))}
        <Text color={tokens.severity.dim}>· tab cycles · ←/→ steps · esc cancels</Text>
      </Box>
      <Box marginTop={1}>
        {active === "payload" ? <PayloadView payload={run.payload} /> : null}
        {active === "steps" ? <StepsView run={run} stepIdx={stepIdx} /> : null}
        {active === "transform" ? <TransformView run={run} /> : null}
      </Box>
    </Box>
  );
}

function PayloadView({ payload }: { payload: unknown }): React.ReactElement {
  const tokens = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={tokens.severity.dim}>payload:</Text>
      <Box paddingLeft={2}>
        <Text color={tokens.emphasis.strong}>{prettyJson(payload)}</Text>
      </Box>
    </Box>
  );
}

function StepsView({
  run,
  stepIdx,
}: {
  run: WorkflowRunSnapshot;
  stepIdx: number;
}): React.ReactElement {
  const tokens = useTheme();
  const step = run.steps[stepIdx];
  if (!step) {
    return <Text color={tokens.severity.dim}>no steps yet ({run.steps.length} total)</Text>;
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={tokens.severity.dim}>
          step {stepIdx + 1}/{run.steps.length}{" "}
        </Text>
        <Text color={tokens.emphasis.strong}>{step.name}</Text>
        <Text color={tokens.severity.dim}> ({step.kind}) </Text>
        <StatusBadge status={step.status} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={tokens.severity.dim}>input:</Text>
        <Box paddingLeft={2}>
          <Text color={tokens.emphasis.normal}>{prettyJson(step.input)}</Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={tokens.severity.dim}>output:</Text>
        <Box paddingLeft={2}>
          <Text color={step.status === "failed" ? tokens.severity.error : tokens.emphasis.normal}>
            {step.error ? step.error : prettyJson(step.output)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function TransformView({ run }: { run: WorkflowRunSnapshot }): React.ReactElement {
  const tokens = useTheme();
  if (!run.transform) {
    return <Text color={tokens.severity.dim}>no transform on this workflow</Text>;
  }
  return (
    <Box flexDirection="column">
      {run.transform.expression ? (
        <Box flexDirection="column">
          <Text color={tokens.severity.dim}>expression:</Text>
          <Box paddingLeft={2}>
            <Text color={tokens.accent.secondary}>{run.transform.expression}</Text>
          </Box>
        </Box>
      ) : null}
      {run.transform.error ? (
        <Box marginTop={1}>
          <Text color={tokens.severity.error}>error: {run.transform.error}</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text color={tokens.severity.dim}>result:</Text>
          <Box paddingLeft={2}>
            <Text color={tokens.emphasis.strong}>{prettyJson(run.transform.result)}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function StatusBadge({ status }: { status: StepStatus }): React.ReactElement {
  const tokens = useTheme();
  const map: Record<StepStatus, { color: string; label: string }> = {
    pending: { color: tokens.severity.dim, label: "pending" },
    running: { color: tokens.severity.info, label: "running" },
    succeeded: { color: tokens.badge.ok, label: "ok" },
    failed: { color: tokens.badge.fail, label: "failed" },
    skipped: { color: tokens.severity.dim, label: "skipped" },
  };
  const { color, label } = map[status];
  return (
    <Text color={color} bold>
      [{label}]
    </Text>
  );
}

function prettyJson(v: unknown): string {
  if (v === undefined) return "(no data)";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
