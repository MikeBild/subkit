import { type DeviceAction, deviceAction } from "@shared/device/actions.ts";
import { Button } from "@ui/atoms/button";
import { IconTile } from "@ui/atoms/icon-tile";
import { Pill, type Tone } from "@ui/atoms/pill";
import { Skel } from "@ui/atoms/skeleton";
import { cn } from "@ui/lib/utils";
import { ActivityLine } from "@ui/molecules/activity-line";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { ToolApprovalCard } from "@ui/organisms/tool-approval-card";
import {
  type Check,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  Globe,
  Hourglass,
  Image,
  LogIn,
  MousePointerClick,
  PenLine,
  ShieldAlert,
  Square,
  SquareMousePointer,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { screenshotSrc } from "../../../shared/live-ipc.ts";
import {
  askRows,
  type LiveSnapshot,
  type StepStatus,
} from "../../../shared/local/live-view-model.ts";
import type { LiveActions } from "../../adapter/index.ts";
import type { Translate } from "../../lib/text.ts";

const icons: Record<DeviceAction, typeof Check> = {
  open: FileSpreadsheet,
  fill: PenLine,
  press: MousePointerClick,
  read: Eye,
  wait: Hourglass,
  download: Download,
  screenshot: Image,
  signin: LogIn,
  focus: SquareMousePointer,
  files: FileText,
};
const tones: Record<StepStatus, Tone> = {
  queued: "neutral",
  running: "info",
  waiting: "warning",
  done: "success",
  refused: "danger",
  failed: "danger",
  stopped: "neutral",
  notRun: "neutral",
};

function Screenshot({ live, t }: { live: LiveSnapshot; t: Translate }) {
  const src = screenshotSrc(live.screenshot);
  return src ? (
    <img src={src} alt={t("live.screenshot")} className="h-full w-full object-contain" />
  ) : (
    <div className="h-full p-4">
      <Skel.Line className="mb-4 h-8" />
      <Skel.Block className="h-3/4" />
    </div>
  );
}

export function LiveView({
  live,
  t,
  actions,
}: {
  live: LiveSnapshot;
  t: Translate;
  actions: LiveActions;
}) {
  const stopRef = useRef<HTMLButtonElement>(null);
  const computer = live.capability === "computer";
  useEffect(() => {
    stopRef.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.metaKey && event.shiftKey) actions.stop();
      else actions.close();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [actions]);
  const rows = live.ask ? askRows(live.ask.confirmation, t("live.field.target")) : null;
  return (
    <section aria-label={t("live.entry")} className="flex min-h-full flex-col bg-background">
      <header className="grid grid-cols-[minmax(0,1fr)_112px_32px] items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="break-words text-sm font-semibold">
            {computer ? t("live.using", { name: live.target }) : live.target}
          </h2>
          <Pill tone="neutral" className="mt-2 h-auto min-h-6 whitespace-normal">
            {t(`live.source.${live.source}`)}
          </Pill>
        </div>
        <div className="flex flex-col items-center gap-1">
          <Button
            ref={stopRef}
            data-testid="live-stop"
            size="sm"
            variant="outline"
            className="w-28 shrink-0"
            disabled={!live.stoppable}
            onClick={actions.stop}
          >
            <Square className="size-4" aria-hidden />
            {t("live.stop")}
          </Button>
          <kbd className="font-mono text-xs text-muted-foreground">{t("live.shortcut")}</kbd>
        </div>
        <Button
          data-testid="live-close"
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={t("live.close")}
          onClick={actions.close}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </header>
      <div className="live-layout flex flex-col gap-4 p-4">
        <div className="min-w-0">
          <div
            className={cn(
              "live-frame relative overflow-hidden rounded-lg border",
              computer && live.status === "running" && "shadow-live",
            )}
          >
            <Screenshot live={live} t={t} />
            <span className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full border bg-background px-2 py-1 text-xs">
              <EyeOff className="size-3" aria-hidden />
              {t("live.redacted")}
            </span>
          </div>
          <h3 className="mt-4 mb-2 text-xs font-semibold text-muted-foreground">
            {t("live.timeline")}
          </h3>
          <ol aria-label={t("live.timeline")} data-testid="live-timeline">
            {live.steps.map((step) => {
              const action = deviceAction(step.kind);
              const label = t(`live.action.${action}`);
              return (
                <li key={step.command_id}>
                  <ActivityLine icon={icons[action]} className="flex-nowrap">
                    <span className="min-w-0 flex-1 truncate" title={`${label} · ${step.target}`}>
                      {label} · <span className="font-mono">{step.target}</span>
                    </span>
                    <Pill tone={tones[step.status]} className="shrink-0">
                      {t(`live.result.${step.status}`)}
                    </Pill>
                  </ActivityLine>
                </li>
              );
            })}
            <li className="min-h-6">
              {live.injection && (
                <ActivityLine icon={ShieldAlert} className="text-warning-ink">
                  <span>{t("live.injection")}</span>
                </ActivityLine>
              )}
            </li>
          </ol>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <div role="status" className="flex items-center gap-3">
            <IconTile icon={computer ? FileSpreadsheet : Globe} size="sm" />
            <span className="text-sm font-medium" data-testid="live-status">
              {t(`live.status.${live.status}`)}
            </span>
          </div>
          <div>
            <p
              role="status"
              className={cn("mb-3 text-sm text-warning-ink", !live.page_changed && "invisible")}
              aria-hidden={!live.page_changed}
            >
              {t("live.pageChanged")}
            </p>
            <div className="flex flex-col items-start gap-3">
              {live.error && <ErrorNotice kind={live.error} testId="live-error" />}
              {rows && (
                <ToolApprovalCard rows={rows} onDecision={actions.decide} testId="live-approval" />
              )}
              {live.status === "handover" && (
                <Button data-testid="live-hand-back" variant="outline" onClick={actions.handBack}>
                  <LogIn className="size-4" aria-hidden />
                  {t("live.handBack")}
                </Button>
              )}
              {live.status === "lost" && <ErrorNotice kind="liveDeviceLost" testId="live-lost" />}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
