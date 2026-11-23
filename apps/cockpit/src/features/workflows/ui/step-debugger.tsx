import type { components } from "@cli-core/engine-api/openapi";
import { useState } from "react";
import { absolute, runHref } from "@/app/links";
import { TextAreaField } from "@/components/cockpit/form-field";
import {
  ActionButton,
  CodeBlock,
  FactList,
  Section,
  SegmentedControl,
  StatusBadge,
  TechnicalDetails,
} from "@/components/cockpit/patterns";
import { type StepDebugRun, useStepDebug } from "@/features/workflows/hooks/step-debug";
import {
  debugErrorText,
  type LastRunScope,
  outputSummary,
  ownScopeDraft,
  parseOwnScope,
  type ScopeGapReason,
  type StepDebugInputMode,
  type StepDebugPhase,
  scopeFromLastRun,
  stepDebugActive,
  stepDebugStoppable,
} from "@/features/workflows/model/step-debug";
import { previewRefusalKey } from "@/features/workflows/model/workflow-preview";
import { maskIdentifiers } from "@/features/workflows/model/workflow-steps";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

type Schemas = components["schemas"];

const GAP_KEYS: Record<ScopeGapReason, TranslationKey> = {
  not_run: "stepDebug.gap.notRun",
  not_finished: "stepDebug.gap.notFinished",
  held: "stepDebug.gap.held",
  too_large: "stepDebug.gap.tooLarge",
  no_output: "stepDebug.gap.noOutput",
};

const PHASE_KEYS: Record<Exclude<StepDebugPhase, "idle">, TranslationKey> = {
  starting: "stepDebug.phase.starting",
  waiting: "stepDebug.phase.waiting",
  running: "stepDebug.phase.running",
  succeeded: "stepDebug.phase.succeeded",
  held: "stepDebug.phase.held",
  failed: "stepDebug.phase.failed",
  stopped: "stepDebug.phase.stopped",
  uncertain: "stepDebug.phase.uncertain",
  refused: "stepDebug.phase.refused",
};

const PHASE_BADGE: Record<Exclude<StepDebugPhase, "idle">, string> = {
  starting: "queued",
  waiting: "queued",
  running: "running",
  succeeded: "succeeded",
  held: "pending",
  failed: "failed",
  stopped: "aborted",
  uncertain: "uncertain",
  refused: "failed",
};

function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function StepDebuggerView({
  testId,
  position,
  lastRun,
  mode,
  onMode,
  ownText,
  onOwnText,
  ownError,
  run,
  onRun,
}: {
  testId: string;
  position: number;
  lastRun: LastRunScope;
  mode: StepDebugInputMode;
  onMode(mode: StepDebugInputMode): void;
  ownText: string;
  onOwnText(text: string): void;
  ownError: "not_json" | "not_object" | null;
  run: Pick<
    StepDebugRun,
    "phase" | "executionId" | "step" | "error" | "refusal" | "stopping" | "stopFailed" | "stop"
  >;
  onRun(): void;
}) {
  const { t } = useI18n();
  const { phase } = run;
  const active = stepDebugActive(phase);
  const reused = Object.keys(lastRun.scope).length;
  const summary =
    phase === "succeeded" || phase === "held" ? outputSummary(run.step?.output_preview) : null;
  const failure = phase === "failed" || phase === "uncertain" ? debugErrorText(run.error) : null;
  const refusalKey = previewRefusalKey(run.refusal?.code ?? null);
  const output = raw(run.step?.output_preview) ?? raw(run.step?.result_preview);
  const request = raw(run.step?.request_meta);
  return (
    <Section label={t("stepDebug.title")} testId={testId}>
      <p className="text-sm text-muted-foreground">{t("stepDebug.writesHeld")}</p>
      {position > 0 ? (
        <SegmentedControl
          value={mode}
          onValueChange={(next) => {
            if (next === "last_run" || next === "own") onMode(next);
          }}
          label={t("stepDebug.input")}
          testId={`${testId}-input`}
          options={[
            {
              value: "last_run",
              label: t("stepDebug.input.lastRun"),
              testId: `${testId}-input-last-run`,
            },
            { value: "own", label: t("stepDebug.input.own"), testId: `${testId}-input-own` },
          ]}
        />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid={`${testId}-first`}>
          {t("stepDebug.lastRun.first")}
        </p>
      )}
      {position > 0 && mode === "last_run" ? (
        <div className="flex flex-col gap-2 text-sm" data-testid={`${testId}-last-run`}>
          <p>
            {t(reused > 0 ? "stepDebug.lastRun.ready" : "stepDebug.lastRun.none", {
              count: reused,
              total: position,
            })}
          </p>
          {reused > 0 && lastRun.gaps.length > 0 ? (
            <div className="text-muted-foreground" data-testid={`${testId}-gaps`}>
              <p>{t("stepDebug.gaps")}</p>
              <ul className="list-disc pl-5">
                {lastRun.gaps.map((gap) => (
                  <li key={gap.step}>
                    <span className="break-all font-mono text-xs">{gap.step}</span>
                    {" · "}
                    {t(GAP_KEYS[gap.reason])}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {position > 0 && mode === "own" ? (
        <TextAreaField
          id={`${testId}-own`}
          label={t("stepDebug.own.label")}
          help={t("stepDebug.own.help")}
          value={ownText}
          onChange={onOwnText}
          rows={8}
          mono
          error={
            ownError
              ? t(ownError === "not_json" ? "stepDebug.own.notJson" : "stepDebug.own.notObject")
              : null
          }
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {stepDebugStoppable(phase) ? (
          <ActionButton
            variant="destructive"
            size="sm"
            pending={run.stopping}
            onClick={run.stop}
            testId={`${testId}-stop`}
          >
            {t("stepDebug.stop")}
          </ActionButton>
        ) : (
          <ActionButton
            variant="primary"
            size="sm"
            pending={phase === "starting"}
            disabled={active}
            onClick={onRun}
            testId={`${testId}-run`}
          >
            {t("workflow.testStep")}
          </ActionButton>
        )}
        {phase === "idle" ? null : (
          <StatusBadge
            state={PHASE_BADGE[phase]}
            label={phase === "held" ? t("workflow.preview.held") : undefined}
            testId={`${testId}-status`}
          />
        )}
      </div>
      {run.stopFailed ? (
        <p className="text-sm text-destructive" data-testid={`${testId}-stop-failed`}>
          {t("stepDebug.stopFailed")}
        </p>
      ) : null}
      {phase === "idle" ? null : (
        <div
          className="flex flex-col gap-3 rounded-lg border p-3 text-sm"
          aria-live="polite"
          data-testid={`${testId}-result`}
        >
          <p className="font-medium">{t(PHASE_KEYS[phase])}</p>
          {refusalKey ? <p data-testid={`${testId}-refusal`}>{t(refusalKey)}</p> : null}
          {failure ? (
            <p className="[overflow-wrap:anywhere]" data-testid={`${testId}-failure`}>
              {maskIdentifiers(failure.split("\n")[0] ?? "")}
            </p>
          ) : null}
          {summary?.kind === "empty" ? (
            <p className="text-muted-foreground">{t("stepDebug.result.empty")}</p>
          ) : null}
          {summary?.kind === "list" ? (
            <p>{t("stepDebug.result.list", { count: summary.count })}</p>
          ) : null}
          {summary?.kind === "text" ? (
            <p className="[overflow-wrap:anywhere]">{summary.text}</p>
          ) : null}
          {summary?.kind === "record" ? (
            <>
              <FactList
                items={summary.fields.map((field) => ({
                  label: field.name,
                  value: <span className="[overflow-wrap:anywhere]">{field.value}</span>,
                }))}
                testId={`${testId}-fields`}
              />
              {summary.more > 0 ? (
                <p className="text-muted-foreground">
                  {t("stepDebug.result.more", { count: summary.more })}
                </p>
              ) : null}
            </>
          ) : null}
          {phase === "uncertain" && run.executionId ? (
            <a
              href={absolute(runHref(run.executionId))}
              className="underline underline-offset-4"
              data-testid={`${testId}-open-run`}
            >
              {t("stepDebug.openRun")}
            </a>
          ) : null}
          {output || request || run.refusal || (failure && run.error) ? (
            <TechnicalDetails testId={`${testId}-technical`}>
              {run.refusal ? (
                <CodeBlock
                  label={t("workflow.preview.error")}
                  code={
                    run.refusal.code
                      ? `${run.refusal.code}\n${run.refusal.message}`
                      : run.refusal.message
                  }
                  testId={`${testId}-refusal-raw`}
                />
              ) : null}
              {failure ? (
                <CodeBlock
                  label={t("workflow.preview.error")}
                  code={raw(run.error) ?? failure}
                  testId={`${testId}-error-raw`}
                />
              ) : null}
              {output ? (
                <CodeBlock
                  label={t("stepDebug.raw")}
                  code={output}
                  lang="json"
                  testId={`${testId}-raw`}
                />
              ) : null}
              {request ? (
                <CodeBlock
                  label={t("stepDebug.request")}
                  code={request}
                  lang="json"
                  testId={`${testId}-request`}
                />
              ) : null}
            </TechnicalDetails>
          ) : null}
        </div>
      )}
    </Section>
  );
}

export function StepDebugger({
  testId,
  stepId,
  step,
  stepIds,
  runSteps,
}: {
  testId: string;
  stepId: string;
  step: Schemas["ExecutionRunStep"];
  stepIds: readonly string[];
  runSteps: readonly Schemas["ExecutionStep"][];
}) {
  const run = useStepDebug(stepId);
  const lastRun = scopeFromLastRun(stepIds, stepId, runSteps);
  const [mode, setMode] = useState<StepDebugInputMode>("last_run");
  const [ownText, setOwnText] = useState<string | null>(null);
  const [ownError, setOwnError] = useState<"not_json" | "not_object" | null>(null);
  const text = ownText ?? ownScopeDraft(lastRun.scope);
  const position = Math.max(0, stepIds.indexOf(stepId));
  return (
    <StepDebuggerView
      testId={testId}
      position={position}
      lastRun={lastRun}
      mode={mode}
      onMode={setMode}
      ownText={text}
      onOwnText={(next) => {
        setOwnText(next);
        setOwnError(null);
      }}
      ownError={ownError}
      run={run}
      onRun={() => {
        if (position === 0 || mode === "last_run") {
          run.start(step, lastRun.scope);
          return;
        }
        const own = parseOwnScope(text);
        if (!own.ok) {
          setOwnError(own.reason);
          return;
        }
        run.start(step, own.scope);
      }}
    />
  );
}
