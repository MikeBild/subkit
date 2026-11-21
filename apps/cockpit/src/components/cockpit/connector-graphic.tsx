import { FileKey, KeyRound, LockOpen, UserCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { TemplateSignIn } from "@/components/cockpit/create-template-model";
import { STATUS_DOT, type StatusTone } from "@/components/cockpit/patterns";
import type { ServiceIdentity } from "@/lib/service-icons";
import { cn } from "@/lib/utils";
import { ServiceIcon, SubKitMark } from "./service-icon";

const WAY_ICON: Record<TemplateSignIn, ReactNode> = {
  account: <UserCheck />,
  key: <KeyRound />,
  none: <LockOpen />,
  machine: <FileKey />,
  elsewhere: <KeyRound />,
};

const TONE_TEXT: Record<StatusTone, string> = {
  ok: "text-success-ink",
  info: "text-muted-foreground",
  warn: "text-warning-ink",
  error: "text-destructive",
};

export function ConnectionGraphic({
  workspace,
  service,
  serviceName,
  serviceLine,
  way,
  wayLabel,
  tone,
  stateLine,
  testId = "connector-graphic",
}: {
  workspace: string;
  service: ServiceIdentity;
  serviceName: string;
  serviceLine: string | null;
  way: TemplateSignIn;
  wayLabel: string;
  tone: StatusTone;
  stateLine: string;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"
      data-slot="connection-graphic"
      data-tone={tone}
      data-testid={testId}
    >
      <div className="flex items-center gap-3 rounded-lg border bg-background p-3 sm:w-52">
        <SubKitMark />
        <div className="min-w-0">
          <div className="text-sm font-medium">SubKit</div>
          <div className="truncate text-xs text-muted-foreground">{workspace}</div>
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center gap-1 py-1">
        <span
          className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-0.5 text-xs [&_svg]:size-3.5 [&_svg]:text-muted-foreground"
          data-testid={`${testId}-way`}
        >
          {WAY_ICON[way]}
          {wayLabel}
        </span>
        <div
          aria-hidden="true"
          className={cn(
            "w-full",
            tone === "error"
              ? "h-0 border-t-2 border-dashed border-destructive"
              : cn("h-0.5 rounded", STATUS_DOT[tone]),
          )}
          data-slot="connection-line"
        />
        <span className={cn("text-xs", TONE_TEXT[tone])} data-testid={`${testId}-state`}>
          {stateLine}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-3 rounded-lg border bg-background p-3 sm:w-64">
        <ServiceIcon service={service} tile="md" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{serviceName}</div>
          {serviceLine ? (
            <div className="truncate text-xs text-muted-foreground">{serviceLine}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
