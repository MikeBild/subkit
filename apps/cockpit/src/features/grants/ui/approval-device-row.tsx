import { StatusDot } from "@ui/atoms/status-dot";
import { Checkbox } from "@/components/cockpit/patterns";
import type { ApprovalDevice } from "@/features/grants/model/device-approval";
import { useI18n } from "@/lib/i18n-context";

export function ApprovalDeviceRow({
  device,
  checked,
  disabled,
  onCheckedChange,
}: {
  device: ApprovalDevice;
  checked: boolean;
  disabled: boolean;
  onCheckedChange(checked: boolean): void;
}) {
  const { t } = useI18n();
  const name = device.label ?? t("authority.device.unnamed");
  return (
    <div data-testid="authority-device">
      <label className="flex min-h-8 items-center gap-2 text-sm" htmlFor="authority-device-run">
        <Checkbox
          id="authority-device-run"
          checked={checked}
          disabled={disabled || device.elsewhere}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          data-testid="authority-device-run"
        />
        <span className="leading-5">{t("authority.device.mayRun", { device: name })}</span>
        <StatusDot tone={device.online ? "success" : "neutral"} />
      </label>
      <p
        role="status"
        className="mt-2 h-10 pl-6 text-xs text-muted-foreground sm:h-5"
        data-testid="authority-device-status"
      >
        {device.elsewhere
          ? t("authority.device.elsewhere", { device: name })
          : !checked
            ? t("authority.device.required")
            : device.waiting
              ? t("authority.device.waiting")
              : null}
      </p>
    </div>
  );
}
