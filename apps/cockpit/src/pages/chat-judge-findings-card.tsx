import { ChevronRight, CircleCheck, TriangleExclamationPoint } from "lucide-react";
import { useState } from "react";
import { Button, ChatCard, Chip, StatusBadge } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import {
  type ChatInstruction,
  type ChatJudgeFindings,
  type FindingState,
  findingsInstruction,
  openFindings,
} from "./chat-preview-cards";
import { ChatCardTitle, ChatWorkflowMention } from "./chat-sensitive-preview-card";

function FindingRow({
  index,
  finding,
  state,
  disabled,
  onFix,
  onKeep,
  testId,
}: {
  index: number;
  finding: string;
  state: FindingState;
  disabled: boolean;
  onFix: () => void;
  onKeep: () => void;
  testId: string;
}) {
  const { t } = useI18n();
  const rowId = `${testId}-row-${index}`;
  const settled = state !== "open";
  const Icon = state === "handed" ? CircleCheck : TriangleExclamationPoint;
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b py-2 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
      data-testid={rowId}
      data-state={state}
    >
      <div className={cn("flex min-w-0 flex-1 flex-col", settled && "opacity-60")}>
        <div className="flex min-h-7 min-w-0 items-start gap-2 py-0.5">
          <Icon
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0",
              state === "handed"
                ? "text-success-ink"
                : state === "kept"
                  ? "text-muted-foreground"
                  : "text-warning-ink",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 font-medium break-words",
              state === "kept" && "line-through",
            )}
            data-testid={`${rowId}-text`}
          >
            {finding}
          </span>
          {settled ? (
            <Chip className="text-muted-foreground" testId={`${rowId}-state`}>
              {t(state === "handed" ? "chat.findings.handed" : "chat.findings.kept")}
            </Chip>
          ) : null}
        </div>
        <details className="group/details pl-6" data-testid={`${rowId}-details`}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground sm:min-h-7 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 transition-transform group-open/details:rotate-90 motion-reduce:transition-none"
            />
            {t("chat.findings.details")}
          </summary>
          <p className="break-words pb-1 text-xs text-muted-foreground">{finding}</p>
        </details>
      </div>
      {settled ? null : (
        <div className="flex flex-col gap-2 sm:shrink-0 sm:flex-row">
          <Button
            size="sm"
            className="w-full sm:w-auto"
            disabled={disabled}
            onClick={onFix}
            data-testid={`${rowId}-fix`}
          >
            {t("chat.findings.fix")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="w-full sm:w-auto"
            disabled={disabled}
            onClick={onKeep}
            data-testid={`${rowId}-keep`}
          >
            {t("chat.findings.keep")}
          </Button>
        </div>
      )}
    </li>
  );
}

export function ChatJudgeFindingsCard({
  findings,
  disabled,
  onInstruction,
  testId = "chat-judge-findings-card",
}: {
  findings: ChatJudgeFindings;
  disabled: boolean;
  onInstruction: (instruction: ChatInstruction) => void;
  testId?: string;
}) {
  const { t, tn } = useI18n();
  const [states, setStates] = useState<Record<number, FindingState>>({});
  const readable = (value: string) =>
    hideTechnicalIdentifiers(value, t("tool.referenceHiddenInline"));
  const open = openFindings(findings.missing, states);
  const settle = (indexes: readonly number[], state: FindingState) =>
    setStates((current) => {
      const next = { ...current };
      for (const index of indexes) next[index] = state;
      return next;
    });
  const handOff = (indexes: readonly number[]) => {
    const selected = indexes.flatMap((index) => {
      const finding = findings.missing[index];
      return finding ? [finding] : [];
    });
    if (selected.length === 0) return;
    settle(indexes, "handed");
    onInstruction(findingsInstruction(t, findings.workflow, selected));
  };
  return (
    <ChatCard
      testId={testId}
      title={
        <ChatCardTitle
          title={t(
            findings.verdict === "failed" ? "chat.findings.titleFailed" : "chat.findings.title",
          )}
          mention={
            <ChatWorkflowMention workflow={findings.workflow} testId={`${testId}-workflow`} />
          }
        />
      }
      line={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge
            state={findings.verdict === "failed" ? "failed" : "warn"}
            label={t(
              findings.verdict === "failed"
                ? "chat.findings.verdictFailed"
                : "chat.findings.verdictPartial",
            )}
            testId={`${testId}-verdict`}
          />
          {findings.reason ? (
            <span className="min-w-0 break-words text-foreground" data-testid={`${testId}-reason`}>
              {readable(findings.reason)}
            </span>
          ) : null}
        </span>
      }
      secondary={
        <span
          className="mr-auto self-center text-xs text-muted-foreground"
          data-testid={`${testId}-count`}
        >
          {open.length > 0 ? tn("chat.findings.open", open.length) : t("chat.findings.allSettled")}
        </span>
      }
      action={
        open.length > 0 ? (
          <Button
            className="w-full sm:w-auto"
            disabled={disabled}
            onClick={() => handOff(open)}
            data-testid={`${testId}-fix-all`}
          >
            {t("chat.findings.fixAllAction")}
          </Button>
        ) : null
      }
    >
      <ul className="flex min-w-0 flex-col border-t" data-testid={`${testId}-rows`}>
        {findings.missing.map((finding, index) => (
          <FindingRow
            key={`${index}-${finding}`}
            index={index}
            finding={readable(finding)}
            state={states[index] ?? "open"}
            disabled={disabled}
            onFix={() => handOff([index])}
            onKeep={() => settle([index], "kept")}
            testId={testId}
          />
        ))}
      </ul>
    </ChatCard>
  );
}
