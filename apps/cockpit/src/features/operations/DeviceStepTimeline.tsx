import type { DeviceAction } from "@shared/device/actions.ts";
import { Pill } from "@ui/atoms/pill";
import { ActivityLine } from "@ui/molecules/activity-line";
import {
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Hourglass,
  Image,
  LogIn,
  type LucideIcon,
  MousePointerClick,
  PenLine,
  SquareMousePointer,
} from "lucide-react";
import { tenantContentHref } from "@/api/tenant-context";
import { useI18n } from "@/lib/i18n-context";
import { type DeviceStepRecord, deviceStepRows } from "./device-steps-model";

const ICONS: Record<DeviceAction, LucideIcon> = {
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

export function DeviceStepTimeline({
  steps,
  executionId,
  testId = "device-steps",
}: {
  steps: readonly DeviceStepRecord[];
  executionId: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const rows = deviceStepRows(steps, executionId);
  if (rows.length === 0) return null;
  return (
    <ol aria-label={t("runs.device.title")} className="flex flex-col" data-testid={testId}>
      {rows.map((row, index) => {
        const label = t(`runs.device.action.${row.action}`);
        return (
          <li key={row.id} data-testid={`${testId}-${index}`}>
            <ActivityLine icon={ICONS[row.action]} className="flex-nowrap">
              <span className="min-w-0 flex-1 truncate" title={`${label} · ${row.target}`}>
                {label} · <span className="font-mono">{row.target}</span>
              </span>
              <Pill tone={row.tone} className="shrink-0">
                {t(`runs.device.state.${row.state}`)}
              </Pill>
            </ActivityLine>
            {row.thumbnail ? (
              <a
                href={tenantContentHref(row.thumbnail)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-7 mb-2 inline-block rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`${testId}-${index}-thumbnail`}
              >
                <img
                  src={tenantContentHref(row.thumbnail)}
                  alt={t("runs.device.thumbnail")}
                  loading="lazy"
                  className="h-16 w-auto rounded-md"
                />
              </a>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
