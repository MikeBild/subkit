"use client";

import { Badge } from "@ui/atoms/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/atoms/collapsible";
import { cn } from "@ui/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { CheckCircleIcon, ChevronDownIcon, CircleIcon, ClockIcon, XCircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { humaniseToolName } from "@/lib/tool-presentation";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose w-full min-w-0 rounded-lg border", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  outcomeKey?: TranslationKey | null;
  logTail?: string | null;
  elapsedMs?: number | null;
} & Omit<ComponentProps<typeof CollapsibleTrigger>, "children" | "type"> &
  (
    | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
    | {
        type: DynamicToolUIPart["type"];
        state: DynamicToolUIPart["state"];
        toolName: string;
      }
  );

const statusLabels: Record<ToolPart["state"], TranslationKey> = {
  "approval-requested": "tool.status.approvalRequested",
  "approval-responded": "tool.status.approvalResponded",
  "input-available": "tool.status.inputAvailable",
  "input-streaming": "tool.status.inputStreaming",
  "output-available": "tool.status.outputAvailable",
  "output-denied": "tool.status.outputDenied",
  "output-error": "tool.status.outputError",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="text-warning" />,
  "approval-responded": <CheckCircleIcon className="text-accent" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="text-success" />,
  "output-denied": <XCircleIcon className="text-warning" />,
  "output-error": <XCircleIcon className="text-destructive" />,
};

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function presentationValue(value: unknown, hidden: string): unknown {
  if (typeof value === "string") return value.replace(UUID, hidden);
  if (Array.isArray(value)) return value.map((item) => presentationValue(item, hidden));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) => !/(^id$|_id$|^tenant_|uuid|token|secret|password|credential|csrf)/i.test(key),
      )
      .map(([key, item]) => [key, presentationValue(item, hidden)]),
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export const ToolHeader = ({
  className,
  title,
  outcomeKey,
  logTail,
  elapsedMs,
  type: _type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const { t } = useI18n();
  const actionName = title ?? (toolName ? humaniseToolName(toolName) : t("tool.action"));
  const statusWord = t(outcomeKey ?? statusLabels[state]);

  return (
    <CollapsibleTrigger
      className={cn("flex w-full items-center justify-between gap-4 p-3", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium text-sm">{actionName}</span>
        <Badge className="shrink-0 gap-1.5 rounded-full text-xs" variant="secondary">
          {statusIcons[state]}
          {statusWord}
        </Badge>
        {logTail ? (
          <span className="hidden min-w-0 truncate text-muted-foreground text-xs sm:inline">
            {logTail}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {typeof elapsedMs === "number" ? (
          <span className="tabular-nums text-muted-foreground text-xs">
            {formatElapsed(elapsedMs)}
          </span>
        ) : null}
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </div>
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "flex flex-col gap-4 p-4 text-popover-foreground outline-none data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <LocalizedToolInput className={className} input={input} {...props} />
);

function LocalizedToolInput({ className, input, ...props }: ToolInputProps) {
  const { t } = useI18n();
  return (
    <div className={cn("grid gap-2 overflow-hidden", className)} {...props}>
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("tool.parameters")}
      </h4>
      <div className="rounded-md bg-muted/50">
        <pre className="max-w-full whitespace-pre-wrap break-all p-3 font-mono text-xs">
          {JSON.stringify(presentationValue(input, t("tool.referenceHidden")), null, 2)}
        </pre>
      </div>
    </div>
  );
}

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  const { t } = useI18n();
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <pre className="max-w-full whitespace-pre-wrap break-all p-3 font-mono text-xs">
        {JSON.stringify(presentationValue(output, t("tool.referenceHidden")), null, 2)}
      </pre>
    );
  } else if (typeof output === "string") {
    Output = (
      <pre className="max-w-full whitespace-pre-wrap break-all p-3 font-mono text-xs">{output}</pre>
    );
  }

  return (
    <div className={cn("grid gap-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {t(errorText ? "tool.error" : "tool.result")}
      </h4>
      <div
        className={cn(
          "min-w-0 overflow-hidden rounded-md text-xs [&_table]:w-full [&_table]:table-fixed",
          errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
