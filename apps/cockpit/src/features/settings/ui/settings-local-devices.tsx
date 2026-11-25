import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, Pill } from "@ui/atoms/pill";
import { StatusDot } from "@ui/atoms/status-dot";
import { SettingsRow } from "@ui/molecules/settings-row";
import { Laptop } from "lucide-react";
import { listDevices, revokeDevice } from "@/api/devices";
import { useSession } from "@/app/session";
import {
  Button,
  ConfirmDialog,
  SectionHeading,
  useConfirmTarget,
} from "@/components/cockpit/patterns";
import {
  localSettingsOpener,
  type OpenLocalSettings,
} from "@/features/settings/model/desktop-local-settings";
import { reportFailure } from "@/lib/action-failure";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  CAPABILITY_LABEL,
  countsLine,
  deviceScope,
  type LocalDeviceRow,
  localDeviceRows,
} from "../model/settings-local-devices-model";

export function LocalDeviceList({
  rows,
  onRevoke,
  onManageHere,
}: {
  rows: readonly LocalDeviceRow[];
  onRevoke(row: LocalDeviceRow): void;
  onManageHere?: OpenLocalSettings | null;
}) {
  const { t, tn, locale } = useI18n();
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="settings-local-devices-empty">
        {t("settings.localDevices.empty")}
      </p>
    );
  return (
    <Panel className="divide-y px-4 py-1">
      {rows.map((device, index) => (
        <SettingsRow
          key={device.id}
          icon={Laptop}
          testId={`settings-local-device-${index}`}
          label={
            <span className="flex flex-wrap items-center gap-2">
              <StatusDot tone={device.online ? "success" : "neutral"} />
              <span className="[overflow-wrap:anywhere]">{device.name}</span>
              <span className="sr-only">
                {t(
                  device.online ? "settings.localDevices.online" : "settings.localDevices.offline",
                )}
              </span>
              {device.here ? <Pill tone="success">{t("settings.devices.current")}</Pill> : null}
              {device.own ? null : (
                <Pill tone="neutral">{t("settings.localDevices.notYours")}</Pill>
              )}
            </span>
          }
          hint={[
            countsLine(device.counts, tn),
            ...device.capabilities.map((capability) => t(CAPABILITY_LABEL[capability])),
            ...(device.lastSeen && !device.online
              ? [
                  t("settings.localDevices.lastSeen", {
                    when: formatRelativeTime(locale, device.lastSeen),
                  }),
                ]
              : []),
          ].join(" · ")}
        >
          {device.here && onManageHere ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onManageHere}
              data-testid={`settings-local-device-manage-${index}`}
            >
              {t("settings.localDevices.manageHere")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRevoke(device)}
            data-testid={`settings-local-device-revoke-${index}`}
          >
            {t("settings.devices.revoke")}
          </Button>
        </SettingsRow>
      ))}
    </Panel>
  );
}

export function LocalDevicesQuestion() {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const scope = deviceScope(session.permissions);
  const targetConfirm = useConfirmTarget<LocalDeviceRow>();
  const target = targetConfirm.target;
  const devices = useQuery({
    queryKey: ["devices", scope],
    queryFn: () => listDevices(scope),
    retry: false,
    enabled: session.permissions.includes("device:read"),
  });
  const revoke = useMutation({
    mutationFn: (row: LocalDeviceRow) => revokeDevice(row.id),
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
    onSuccess: async () => {
      targetConfirm.close();
      await client.invalidateQueries({ queryKey: ["devices"] });
    },
  });
  if (!devices.data) return null;
  const rows = localDeviceRows(
    devices.data,
    session.principal.id,
    t("settings.localDevices.unnamed"),
  );
  return (
    <section className="grid gap-2" data-testid="settings-question-local-devices">
      <div>
        <SectionHeading className="text-sm font-semibold">
          {t("settings.localDevices.title")}
        </SectionHeading>
        <p className="text-xs text-muted-foreground">{t("settings.localDevices.help")}</p>
      </div>
      <LocalDeviceList
        rows={rows}
        onRevoke={targetConfirm.ask}
        onManageHere={localSettingsOpener()}
      />
      {target ? (
        <ConfirmDialog
          {...targetConfirm.dialog()}
          object={target.name}
          verb={t("settings.devices.revoke")}
          consequence={t("settings.localDevices.consequence")}
          destructive
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate(target)}
          testId="settings-local-device-revoke-dialog"
        />
      ) : null}
    </section>
  );
}
