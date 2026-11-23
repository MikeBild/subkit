import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiCall } from "@/api/call";
import {
  debugStepRow,
  STEP_DEBUG_POLL_MS,
  type StepDebugPhase,
  stepDebugActive,
  stepDebugPhase,
  stepDebugRequest,
} from "@/features/workflows/model/step-debug";
import { type PreviewFailure, previewFailure } from "@/features/workflows/model/workflow-preview";

type Schemas = components["schemas"];

export interface StepDebugRun {
  phase: StepDebugPhase;
  executionId: string | null;
  step: Schemas["ExecutionStep"] | null;
  error: unknown;
  refusal: PreviewFailure | null;
  stopping: boolean;
  stopFailed: boolean;
  start(step: Schemas["ExecutionRunStep"], scope: Record<string, unknown>): void;
  stop(): void;
}

export function useStepDebug(stepId: string): StepDebugRun {
  const [executionId, setExecutionId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: (body: Schemas["ExecutionRunStepBody"]) =>
      apiCall("post", "/v1/executions", { body }),
    onSuccess: (started) => setExecutionId(started.execution_id),
  });
  const phaseOf = (status: string | undefined, held: boolean): StepDebugPhase =>
    stepDebugPhase({
      starting: start.isPending,
      refused: start.isError,
      execution: status ? { status } : null,
      step: held ? { status: "succeeded", held: true } : null,
    });
  const execution = useQuery({
    queryKey: ["step-debug", executionId],
    enabled: executionId !== null,
    queryFn: () => apiCall("get", "/v1/executions/{id}", { path: { id: executionId ?? "" } }),
    refetchInterval: (query) =>
      stepDebugActive(phaseOf(query.state.data?.status ?? start.data?.status, false))
        ? STEP_DEBUG_POLL_MS
        : false,
  });
  const status = executionId ? (execution.data?.status ?? start.data?.status) : undefined;
  const settled = executionId !== null && !stepDebugActive(phaseOf(status, false));
  const steps = useQuery({
    queryKey: ["step-debug", executionId, "steps"],
    enabled: settled,
    queryFn: () => apiCall("get", "/v1/executions/{id}/steps", { path: { id: executionId ?? "" } }),
  });
  const step = settled ? debugStepRow(steps.data?.items ?? [], stepId) : null;
  const stop = useMutation({
    mutationFn: (id: string) => apiCall("post", "/v1/executions/{id}/cancel", { path: { id } }),
    onSuccess: () => execution.refetch(),
  });
  return {
    phase: phaseOf(status, step?.held === true),
    executionId,
    step,
    error: step?.error ?? (execution.data as { error?: unknown } | undefined)?.error ?? null,
    refusal: start.isError ? previewFailure(start.error) : null,
    stopping: stop.isPending,
    stopFailed: stop.isError,
    start(definition, scope) {
      setExecutionId(null);
      stop.reset();
      start.reset();
      start.mutate(stepDebugRequest(definition, scope));
    },
    stop() {
      if (executionId) stop.mutate(executionId);
    },
  };
}
