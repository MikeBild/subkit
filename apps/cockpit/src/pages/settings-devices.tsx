import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, Pill } from "@ui/components/proto/Pill";
import { AppWindow, Monitor } from "lucide-react";
import { useState } from "react";
import {
  getCurrentCockpitInstallation,
  revokeCockpitInstallation,
} from "@/api/cockpit-installations";
import { installationId } from "@/app/installation-context";
import { Button, ConfirmDialog, IconTile } from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { formatDate, formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  canRevokeDevice,
  type DeviceRow,
  deviceRevocation,
  deviceRows,
} from "@/pages/settings-devices-model";

export function DeviceList({
  rows,
  askingFromDevice,
  onRevoke,
}: {
  rows: readonly DeviceRow[];
  askingFromDevice: boolean;
  onRevoke(row: DeviceRow): void;
}) {
  const { t, locale } = useI18n();
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="settings-devices-empty">
        {t("settings.devices.empty")}
      </p>
    );
  return (
    <Panel className="px-4 py-1">
      <ul className="divide-y" data-testid="settings-devices-list">
        {rows.map((device, index) => {
          const Icon = device.kind === "desktop" ? Monitor : AppWindow;
          const revocation = deviceRevocation(device);
          return (
            <li
              key={device.id}
              className="flex flex-wrap items-center gap-3 py-3"
              data-testid={`settings-device-${index}`}
              data-kind={device.kind}
              data-current={device.current ? "true" : "false"}
            >
              <IconTile size="sm">
                <Icon />
              </IconTile>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="[overflow-wrap:anywhere]">{device.name}</span>
                  {device.current ? (
                    <span data-testid="settings-device-current">
                      <Pill tone="success">{t("settings.devices.current")}</Pill>
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  <span className="sr-only">
                    {t(
                      device.kind === "desktop"
                        ? "settings.devices.kind.desktop"
                        : "settings.devices.kind.webApp",
                    )}
                    {": "}
                  </span>
                  {t("settings.devices.created", { date: formatDate(locale, device.created_at) })}
                  {device.last_used_at
                    ? ` · ${t("settings.devices.lastUsed", {
                        when: formatRelativeTime(locale, device.last_used_at),
                      })}`
                    : null}
                </p>
              </div>
              {canRevokeDevice(device, askingFromDevice) ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onRevoke(device)}
                  data-testid={`settings-device-revoke-${index}`}
                >
                  {t(revocation.verb)}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function DevicesArea() {
  const { t } = useI18n();
  const client = useQueryClient();
  const askingFromDevice = installationId() !== null;
  const [target, setTarget] = useState<DeviceRow | null>(null);
  const installations = useQuery({
    queryKey: ["cockpit-installation"],
    queryFn: getCurrentCockpitInstallation,
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: (row: DeviceRow) => revokeCockpitInstallation(row.id),
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
    onSuccess: async (_done, row) => {
      setTarget(null);
      if (row.current) {
        window.location.reload();
        return;
      }
      await client.invalidateQueries({ queryKey: ["cockpit-installation"] });
    },
  });
  if (!installations.data) return null;
  const rows = deviceRows(installations.data.installations, t);
  const revocation = target ? deviceRevocation(target) : null;
  return (
    <section className="flex flex-col gap-3" data-testid="settings-area-devices">
      <p className="text-sm text-muted-foreground">
        {t(askingFromDevice ? "settings.devices.helpOnDevice" : "settings.devices.help")}
      </p>
      <DeviceList rows={rows} askingFromDevice={askingFromDevice} onRevoke={setTarget} />
      {target && revocation ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          object={target.name}
          verb={t(revocation.verb)}
          consequence={t(revocation.consequence)}
          destructive
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate(target)}
          testId="settings-device-revoke-dialog"
        />
      ) : null}
    </section>
  );
}
