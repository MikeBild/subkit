import { ErrorNotice } from "@ui/molecules/error-notice";
import { useEffect, useState } from "react";
import { StatusStrip } from "@/components/cockpit/patterns/status-strip";
import { useI18n } from "@/lib/i18n-context";
import { type Connectivity, useConnectivity } from "./connectivity";
import {
  type DesktopBanner,
  type DesktopStatus,
  type DesktopStatusBridge,
  desktopNotice,
  desktopStatusBridgeOf,
  parseDesktopStatus,
} from "./desktop-status-model";

const NONE: DesktopStatus = { banner: null, update: null };

function useDesktopStatus(): { status: DesktopStatus; bridge: DesktopStatusBridge | null } {
  const [status, setStatus] = useState<DesktopStatus>(NONE);
  const [bridge] = useState(() =>
    desktopStatusBridgeOf(
      typeof window === "undefined"
        ? undefined
        : (window as unknown as { subkitDesktop?: unknown }).subkitDesktop,
    ),
  );
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge
      .status()
      .then((value) => {
        if (live) setStatus(parseDesktopStatus(value));
      })
      .catch(() => undefined);
    const stop = bridge.onStatus((value) => setStatus(parseDesktopStatus(value)));
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);
  return { status, bridge };
}

function BannerNotice({
  banner,
  code,
  traceId,
  bridge,
}: {
  banner: DesktopBanner;
  code: string;
  traceId: string | null;
  bridge: DesktopStatusBridge | null;
}) {
  const { t } = useI18n();
  const [asked, setAsked] = useState(false);
  const { ask } = banner;
  const testId = `desktop-status-${banner.kind}`;
  return (
    <>
      <ErrorNotice
        kind={code}
        tone={banner.tone}
        title={banner.title}
        body={banner.body}
        rows={[
          [t("error.code"), code],
          ...(traceId ? [[t("errorRows.request"), traceId] as [string, string]] : []),
        ]}
        testId={testId}
        primary={
          ask
            ? {
                label: t("remedy.admin"),
                testId: `${testId}-ask`,
                onClick: () => {
                  void navigator.clipboard
                    ?.writeText(ask)
                    .then(() => setAsked(true))
                    .catch(() => setAsked(false));
                },
              }
            : undefined
        }
        secondary={
          ask && bridge
            ? {
                label: t("remedy.retry"),
                testId: `${testId}-retry`,
                onClick: () => {
                  setAsked(false);
                  void bridge.recheckServer().catch(() => undefined);
                },
              }
            : undefined
        }
      />
      {ask && (
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {asked ? t("desktop.asked") : null}
        </p>
      )}
    </>
  );
}

export function DesktopStatusBanner() {
  const { status, bridge } = useDesktopStatus();
  const connection = useConnectivity();
  return <DesktopStatusView status={status} connection={connection} bridge={bridge} />;
}

export function DesktopStatusView({
  status,
  connection,
  bridge,
}: {
  status: DesktopStatus;
  connection: Connectivity;
  bridge: DesktopStatusBridge | null;
}) {
  const { t } = useI18n();
  const notice = desktopNotice(status, connection.status);
  if (!notice) return null;
  return (
    <div
      className="shrink-0 border-b border-border/70 px-4 py-2 sm:px-8"
      data-testid="desktop-status"
    >
      {notice.type === "banner" ? (
        <BannerNotice
          banner={notice.banner}
          code={notice.code}
          traceId={connection.traceId}
          bridge={bridge}
        />
      ) : (
        <StatusStrip
          tone="info"
          testId="desktop-status-update"
          line={t(notice.ready ? "desktop.update.ready" : "desktop.update.available", {
            version: notice.version,
          })}
        />
      )}
    </div>
  );
}
